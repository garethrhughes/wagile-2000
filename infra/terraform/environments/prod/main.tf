# ============================================================
# Fragile — Production environment
# ============================================================
# Run from this directory:
#
#   terraform init
#   terraform plan -var-file="terraform.tfvars"
#   terraform apply -var-file="terraform.tfvars"
# ============================================================

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "fragile"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ACM certificates for CloudFront and CloudFront-scoped WAF must be in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "fragile"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ── ECR ────────────────────────────────────────────────────
module "ecr" {
  source      = "../../modules/ecr"
  environment = var.environment
}

# ── IAM ────────────────────────────────────────────────────
module "iam" {
  source      = "../../modules/iam"
  environment = var.environment

  backend_ecr_arn  = module.ecr.backend_repository_arn
  frontend_ecr_arn = module.ecr.frontend_repository_arn

  db_password_secret_arn    = module.secrets.db_password_secret_arn
  jira_api_token_secret_arn = module.secrets.jira_api_token_secret_arn

  ssm_parameter_path_prefix = "/fragile/${var.environment}/"

  dora_snapshot_lambda_arn = module.lambda.function_arn
}

# ── Network ────────────────────────────────────────────────
module "network" {
  source      = "../../modules/network"
  environment = var.environment
  aws_region  = var.aws_region
}

# ── Secrets Manager + SSM Parameters ──────────────────────
module "secrets" {
  source      = "../../modules/secrets"
  environment = var.environment
  aws_region  = var.aws_region
}

# ── RDS ────────────────────────────────────────────────────
module "rds" {
  source      = "../../modules/rds"
  environment = var.environment

  subnet_ids            = module.network.private_subnet_ids
  rds_security_group_id = module.network.rds_security_group_id

  db_password_secret_arn = module.secrets.db_password_secret_arn
}

# ── Lambda — DORA snapshot computation ─────────────────────
module "lambda" {
  source      = "../../modules/lambda"
  environment = var.environment

  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  rds_endpoint       = module.rds.db_endpoint
  rds_sg_id          = module.network.rds_security_group_id

  db_password_secret_arn = module.secrets.db_password_secret_arn
}

# ── App Runner ─────────────────────────────────────────────
module "apprunner" {
  source      = "../../modules/apprunner"
  environment = var.environment

  backend_image_uri  = "${module.ecr.backend_repository_url}:${var.backend_image_tag}"
  frontend_image_uri = "${module.ecr.frontend_repository_url}:${var.frontend_image_tag}"

  backend_execution_role_arn  = module.iam.apprunner_build_role_arn
  frontend_execution_role_arn = module.iam.apprunner_build_role_arn
  backend_instance_role_arn   = module.iam.backend_task_role_arn
  frontend_instance_role_arn  = module.iam.frontend_task_role_arn

  vpc_connector_arn = module.network.vpc_connector_arn

  rds_endpoint = module.rds.db_endpoint

  dora_snapshot_lambda_name = module.lambda.function_name
  aws_region                = var.aws_region

  db_password_secret_arn    = module.secrets.db_password_secret_arn
  jira_api_token_secret_arn = module.secrets.jira_api_token_secret_arn

  jira_base_url_param_arn   = module.secrets.jira_base_url_param_arn
  jira_user_email_param_arn = module.secrets.jira_user_email_param_arn
  timezone_param_arn        = module.secrets.timezone_param_arn

  backend_url  = "https://${var.backend_subdomain}.${var.domain_name}"
  frontend_url = "https://${var.frontend_subdomain}.${var.domain_name}"
}

# ── WAF — CloudFront-scoped IP allowlist ───────────────────
# Must be deployed in us-east-1 (CloudFront WAF requirement).
# The WebACL ARN is attached directly to the CloudFront distributions.
module "waf" {
  source = "../../modules/waf"

  providers = {
    aws = aws.us_east_1
  }

  allowed_cidrs = var.allowed_cidrs
}

# ── CDN — ACM + CloudFront ─────────────────────────────────
# Issues ACM certificates in us-east-1, validates them via Route 53,
# and creates CloudFront distributions in front of both App Runner services.
module "cdn" {
  source = "../../modules/cdn"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  domain_name        = var.domain_name
  frontend_subdomain = var.frontend_subdomain
  backend_subdomain  = var.backend_subdomain

  backend_service_url  = module.apprunner.backend_service_url
  frontend_service_url = module.apprunner.frontend_service_url

  web_acl_arn = module.waf.web_acl_arn
}

# ── DNS ────────────────────────────────────────────────────
module "dns" {
  source = "../../modules/dns"

  domain_name        = var.domain_name
  frontend_subdomain = var.frontend_subdomain
  backend_subdomain  = var.backend_subdomain

  backend_cloudfront_domain  = module.cdn.backend_cloudfront_domain
  frontend_cloudfront_domain = module.cdn.frontend_cloudfront_domain
  cloudfront_hosted_zone_id  = module.cdn.cloudfront_hosted_zone_id
}
