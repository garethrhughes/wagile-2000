# ── Auto-scaling configuration ───────────────────────────────────────────────
# Shared by both services. min 1 (not 0) per owner spec — ensures no cold start
# on first request at the cost of ~$3/mo baseline compute.

resource "aws_apprunner_auto_scaling_configuration_version" "main" {
  auto_scaling_configuration_name = "fragile-autoscaling"

  min_size = 1
  max_size = 3

  tags = {
    Name = "fragile-autoscaling"
  }
}

# ── Backend App Runner service ────────────────────────────────────────────────

resource "aws_apprunner_service" "backend" {
  service_name = "fragile-backend"

  source_configuration {
    authentication_configuration {
      access_role_arn = var.backend_execution_role_arn
    }

    image_repository {
      image_identifier      = var.backend_image_uri
      image_repository_type = "ECR"

      image_configuration {
        port = "3001"

        # Plain environment variables (non-sensitive)
        runtime_environment_variables = {
          NODE_ENV     = "production"
          PORT         = "3001"
          DB_PORT      = "5432"
          DB_DATABASE  = "fragile"
          DB_USERNAME  = "postgres"
          # DB_HOST is injected directly because App Runner's secrets block
          # only supports Secrets Manager ARNs and SSM param ARNs, not plain
          # string values from Terraform outputs. We inject the RDS endpoint
          # as a plain env var here — it is not a secret.
          DB_HOST      = var.rds_endpoint
          # FRONTEND_URL is the CORS allowed-origin for the backend. It is not
          # sensitive — injected as a plain variable so it never depends on a
          # manually-updated SSM placeholder value.
          FRONTEND_URL              = var.frontend_url
          DORA_SNAPSHOT_LAMBDA_NAME = var.dora_snapshot_lambda_name
          AWS_REGION                = var.aws_region
          USE_LAMBDA                = "true"
        }

        # Secrets and SSM parameters — App Runner fetches these at runtime.
        # App Runner format: "arn:aws:secretsmanager:..." or "arn:aws:ssm:..."
        # Variable names match exactly what app.module.ts reads via ConfigService.
        runtime_environment_secrets = {
          DB_PASSWORD     = var.db_password_secret_arn
          JIRA_API_TOKEN  = var.jira_api_token_secret_arn
          JIRA_BASE_URL   = var.jira_base_url_param_arn
          JIRA_USER_EMAIL = var.jira_user_email_param_arn
          TIMEZONE        = var.timezone_param_arn
        }
      }
    }

    auto_deployments_enabled = false
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = var.backend_instance_role_arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.main.arn

  network_configuration {
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = var.vpc_connector_arn
    }

    ingress_configuration {
      is_publicly_accessible = true
    }
  }

  observability_configuration {
    observability_enabled = false
  }

  tags = {
    Name = "fragile-backend"
  }
}

# ── Frontend App Runner service ───────────────────────────────────────────────

resource "aws_apprunner_service" "frontend" {
  service_name = "fragile-frontend"

  source_configuration {
    authentication_configuration {
      access_role_arn = var.frontend_execution_role_arn
    }

    image_repository {
      image_identifier      = var.frontend_image_uri
      image_repository_type = "ECR"

      image_configuration {
        port = "3000"

        runtime_environment_variables = {
          NODE_ENV = "production"
          # NEXT_PUBLIC_API_URL is intentionally absent here.
          # Next.js bakes NEXT_PUBLIC_* variables into the JS bundle at docker
          # build time. A runtime env var has no effect — the correct URL must
          # be passed as a --build-arg to `docker build` via `make ecr-push` /
          # `scripts/ecr-push.sh`, which reads it from `terraform output
          # backend_custom_domain`.
          #
          # Force Next.js standalone server to bind on all interfaces.
          # App Runner's container runtime sets HOSTNAME to the internal EC2
          # hostname, overriding the Dockerfile ENV. Explicitly setting it here
          # takes precedence and ensures the health checker can reach the server.
          HOSTNAME = "0.0.0.0"
        }
      }
    }

    auto_deployments_enabled = false
  }

  instance_configuration {
    cpu               = "512"
    memory            = "1024"
    instance_role_arn = var.frontend_instance_role_arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.main.arn

  # Frontend has no VPC dependencies — no VPC connector attached.
  network_configuration {
    egress_configuration {
      egress_type = "DEFAULT"
    }

    ingress_configuration {
      is_publicly_accessible = true
    }
  }

  observability_configuration {
    observability_enabled = false
  }

  tags = {
    Name = "fragile-frontend"
  }
}
