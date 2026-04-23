data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
}

# ── Trust policies ──────────────────────────────────────────────────────────

data "aws_iam_policy_document" "apprunner_build_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "apprunner_tasks_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

# ── App Runner build role (ECR pull) ────────────────────────────────────────
# Used by App Runner itself to pull images from ECR when deploying a new revision.

resource "aws_iam_role" "apprunner_build" {
  name               = "fragile-apprunner-build-role"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_trust.json

  tags = {
    Name = "fragile-apprunner-build-role"
  }
}

resource "aws_iam_role_policy_attachment" "apprunner_build_ecr" {
  role       = aws_iam_role.apprunner_build.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# ── Backend task role ────────────────────────────────────────────────────────
# Grants the running backend container permission to read secrets and SSM params.

resource "aws_iam_role" "backend_task" {
  name               = "fragile-backend-task-role"
  assume_role_policy = data.aws_iam_policy_document.apprunner_tasks_trust.json

  tags = {
    Name = "fragile-backend-task-role"
  }
}

data "aws_iam_policy_document" "backend_task_permissions" {
  # Secrets Manager — DB password and Jira API token
  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      var.db_password_secret_arn,
      var.jira_api_token_secret_arn,
    ]
  }

  # SSM Parameter Store — all non-sensitive config under /fragile/<env>/
  statement {
    sid    = "ReadSSMParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${local.region}:${local.account_id}:parameter${var.ssm_parameter_path_prefix}*",
    ]
  }

  # CloudWatch Logs
  statement {
    sid    = "WriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/apprunner/fragile-backend*"]
  }

  # Lambda invocation — for DORA snapshot post-sync computation
  statement {
    sid    = "InvokeDoraSnapshotLambda"
    effect = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = [var.dora_snapshot_lambda_arn]
  }
}

resource "aws_iam_role_policy" "backend_task" {
  name   = "fragile-backend-task-policy"
  role   = aws_iam_role.backend_task.id
  policy = data.aws_iam_policy_document.backend_task_permissions.json
}

# ── Frontend task role ───────────────────────────────────────────────────────
# The frontend container has no AWS service dependencies at runtime.
# CloudWatch logs only.

resource "aws_iam_role" "frontend_task" {
  name               = "fragile-frontend-task-role"
  assume_role_policy = data.aws_iam_policy_document.apprunner_tasks_trust.json

  tags = {
    Name = "fragile-frontend-task-role"
  }
}

data "aws_iam_policy_document" "frontend_task_permissions" {
  statement {
    sid    = "WriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/apprunner/fragile-frontend*"]
  }
}

resource "aws_iam_role_policy" "frontend_task" {
  name   = "fragile-frontend-task-policy"
  role   = aws_iam_role.frontend_task.id
  policy = data.aws_iam_policy_document.frontend_task_permissions.json
}

# ── CI IAM user ──────────────────────────────────────────────────────────────
# Used by GitHub Actions to push images to ECR and trigger App Runner deployments.
# The owner creates the access key manually in the AWS Console and stores it
# in GitHub Actions secrets — Terraform only defines the user and its permissions.

resource "aws_iam_user" "ci" {
  name = "fragile-ci"
  path = "/ci/"

  tags = {
    Name    = "fragile-ci"
    Purpose = "GitHub Actions CI/CD"
  }
}

data "aws_iam_policy_document" "ci_permissions" {
  # ECR authentication (required before every push)
  statement {
    sid    = "ECRAuthentication"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }

  # ECR push to both repositories
  statement {
    sid    = "ECRPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [
      var.backend_ecr_arn,
      var.frontend_ecr_arn,
    ]
  }

  # App Runner — trigger re-deployment of both services
  statement {
    sid    = "AppRunnerDeploy"
    effect = "Allow"
    actions = [
      "apprunner:UpdateService",
      "apprunner:DescribeService",
      "apprunner:ListServices",
      "apprunner:StartDeployment",
    ]
    resources = ["arn:aws:apprunner:${local.region}:${local.account_id}:service/fragile-*"]
  }
}

resource "aws_iam_policy" "ci" {
  name        = "fragile-ci-policy"
  description = "Permissions for the fragile CI/CD pipeline (ECR push + App Runner deploy)."
  policy      = data.aws_iam_policy_document.ci_permissions.json
}

resource "aws_iam_user_policy_attachment" "ci" {
  user       = aws_iam_user.ci.name
  policy_arn = aws_iam_policy.ci.arn
}
