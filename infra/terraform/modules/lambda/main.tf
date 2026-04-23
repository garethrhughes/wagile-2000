# ── Build Lambda zip as part of terraform apply ──────────────────────────────
# The null_resource reruns whenever any TypeScript source file under
# backend/src/lambda/ changes (tracked via sha256 hash of all source files).
# It compiles the backend and produces the zip at a deterministic path.
#
# Requires: node, npm available on the machine running terraform apply.

locals {
  # Resolve path to the repo root relative to this module file.
  # The module lives at infra/terraform/modules/lambda/ — four levels up.
  repo_root = "${path.module}/../../../.."

  lambda_zip_path = "${local.repo_root}/backend/dist/snapshot-worker.zip"

  # Hash of all Lambda source files — used as the null_resource trigger so
  # the build only reruns when relevant source code changes.
  source_hash = sha256(join("", [
    for f in sort(fileset("${local.repo_root}/backend/src", "lambda/**")) :
    filesha256("${local.repo_root}/backend/src/${f}")
  ]))
}

resource "null_resource" "build_lambda" {
  triggers = {
    source_hash = local.source_hash
  }

  provisioner "local-exec" {
    working_dir = local.repo_root
    command     = <<-EOT
      set -e

      echo "==> Installing backend dependencies..."
      npm ci --prefix backend

      echo "==> Compiling TypeScript..."
      npm run build --prefix backend

      echo "==> Packaging Lambda zip..."
      rm -f backend/dist/snapshot-worker.zip
      cd backend
      zip -r dist/snapshot-worker.zip dist/ node_modules/ --quiet
      cd ..

      echo "==> Lambda zip ready at backend/dist/snapshot-worker.zip"
    EOT
  }
}

# ── Lambda execution role ────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "fragile-dora-snapshot-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json

  tags = { Name = "fragile-dora-snapshot-lambda-role" }
}

# Basic execution (CloudWatch Logs) + VPC ENI management
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Secrets Manager: read the DB password secret (same ARN used by App Runner)
data "aws_iam_policy_document" "lambda_secrets" {
  statement {
    sid    = "ReadDBPassword"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [var.db_password_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_secrets" {
  name   = "fragile-dora-snapshot-lambda-secrets"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_secrets.json
}

# ── Lambda security group ────────────────────────────────────────────────────
# Separate from the App Runner VPC connector SG — allows the RDS SG to be
# updated to permit both without coupling the two services.

resource "aws_security_group" "lambda" {
  name        = "fragile-lambda-sg"
  description = "Security group for the DORA snapshot Lambda function."
  vpc_id      = var.vpc_id

  egress {
    description = "Allow all outbound (RDS on 5432, CloudWatch Logs, Secrets Manager)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "fragile-lambda-sg" }
}

# ── RDS inbound rule from Lambda ─────────────────────────────────────────────
# The Lambda module owns its own RDS access rule — avoids modifying the
# network module and keeps Lambda-specific rules co-located here.

resource "aws_security_group_rule" "rds_from_lambda" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.lambda.id
  security_group_id        = var.rds_sg_id
  description              = "PostgreSQL from DORA snapshot Lambda"
}

# ── Lambda function ──────────────────────────────────────────────────────────
# Deployed directly from the local zip file — no S3 bucket required.
# source_code_hash forces an update whenever the zip content changes.

resource "aws_lambda_function" "dora_snapshot" {
  function_name = "fragile-dora-snapshot"
  role          = aws_iam_role.lambda_exec.arn
  package_type  = "Zip"

  filename         = local.lambda_zip_path
  source_code_hash = local.source_hash

  runtime     = "nodejs20.x"
  handler     = "lambda/snapshot.handler.handler"
  timeout     = 120
  memory_size = 512

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DB_HOST     = var.rds_endpoint
      DB_PORT     = "5432"
      DB_USERNAME = "postgres"
      DB_DATABASE = "fragile"
      DB_SSL      = "true"
      # DB_PASSWORD is fetched at runtime from Secrets Manager using the SDK.
      # The Lambda handler reads DB_PASSWORD_SECRET_ARN on cold start, calls
      # SecretsManager.getSecretValue(), and caches the result in module scope.
      DB_PASSWORD_SECRET_ARN = var.db_password_secret_arn
    }
  }

  tags = { Name = "fragile-dora-snapshot" }

  depends_on = [null_resource.build_lambda]
}
