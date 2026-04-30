# ── ECS Cluster ──────────────────────────────────────────────────────────────
# Single cluster for all Fragile services. Uses Fargate capacity provider only.

resource "aws_ecs_cluster" "this" {
  name = "fragile"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Name = "fragile-ecs-cluster"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ── CloudWatch log groups ─────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/fragile/backend"
  retention_in_days = 30

  tags = {
    Name = "fragile-backend-logs"
  }
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/fragile/frontend"
  retention_in_days = 30

  tags = {
    Name = "fragile-frontend-logs"
  }
}

# ── Backend task definition ───────────────────────────────────────────────────
# NestJS API — 1024 CPU / 2048 MB, port 3001.

resource "aws_ecs_task_definition" "backend" {
  family                   = "fragile-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.backend_task_role_arn

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = var.backend_image_uri
      essential = true

      portMappings = [
        {
          containerPort = 3001
          hostPort      = 3001
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV",                  value = "production" },
        { name = "PORT",                      value = "3001" },
        { name = "DB_PORT",                   value = "5432" },
        { name = "DB_DATABASE",               value = "fragile" },
        { name = "DB_USERNAME",               value = "postgres" },
        { name = "DB_HOST",                   value = var.rds_endpoint },
        { name = "FRONTEND_URL",              value = var.frontend_url },
        { name = "DORA_SNAPSHOT_LAMBDA_NAME", value = var.dora_snapshot_lambda_name },
        { name = "AWS_REGION",                value = var.aws_region },
        { name = "USE_LAMBDA",                       value = "true" },
        { name = "SNAPSHOT_STALE_THRESHOLD_MINUTES", value = "2880" },
      ]

      secrets = [
        { name = "DB_PASSWORD",     valueFrom = var.db_password_secret_arn },
        { name = "JIRA_API_TOKEN",  valueFrom = var.jira_api_token_secret_arn },
        { name = "JIRA_BASE_URL",   valueFrom = var.jira_base_url_param_arn },
        { name = "JIRA_USER_EMAIL", valueFrom = var.jira_user_email_param_arn },
        { name = "TIMEZONE",        valueFrom = var.timezone_param_arn },
      ]

      # wget is used (not curl) because the image is node:22-alpine which has
      # wget but not curl.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Name = "fragile-backend"
  }
}

# ── Backend ECS service ───────────────────────────────────────────────────────

resource "aws_ecs_service" "backend" {
  name                               = "fragile-backend-svc"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.backend.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60

  # Allow Terraform to manage desired count without fighting autoscaling.
  lifecycle {
    ignore_changes = [desired_count]
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.backend_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.backend_target_group_arn
    container_name   = "backend"
    container_port   = 3001
  }

  tags = {
    Name = "fragile-backend"
  }
}

# ── Frontend task definition ──────────────────────────────────────────────────
# Next.js standalone — 512 CPU / 1024 MB, port 3000.

resource "aws_ecs_task_definition" "frontend" {
  family                   = "fragile-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.frontend_task_role_arn

  container_definitions = jsonencode([
    {
      name      = "frontend"
      image     = var.frontend_image_uri
      essential = true

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "HOSTNAME", value = "0.0.0.0" },
        { name = "PORT",     value = "3000" },
      ]

      # wget is used (not curl) because the image is node:22-alpine which has
      # wget but not curl.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.frontend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Name = "fragile-frontend"
  }
}

# ── Frontend ECS service ──────────────────────────────────────────────────────

resource "aws_ecs_service" "frontend" {
  name                               = "fragile-frontend-svc"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.frontend.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60

  lifecycle {
    ignore_changes = [desired_count]
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.frontend_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.frontend_target_group_arn
    container_name   = "frontend"
    container_port   = 3000
  }

  tags = {
    Name = "fragile-frontend"
  }
}

# ── ALB data source ───────────────────────────────────────────────────────────
# Look up the existing ECS Express Gateway ALB so we can output its ARN and
# DNS name for use by the CloudFront VPC Origin and distributions.

data "aws_lb" "express_gateway" {
  tags = {
    AmazonECSManaged = "true"
    Project          = "fragile"
  }

  depends_on = [
    aws_ecs_service.backend,
    aws_ecs_service.frontend,
  ]
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.express_gateway.arn
  port              = 443
}

data "aws_lb_listener" "http" {
  load_balancer_arn = data.aws_lb.express_gateway.arn
  port              = 80
}

# ── ALB listener rules ────────────────────────────────────────────────────────
# Route requests from CloudFront to the correct TG based on the
# X-Fragile-Service custom header injected by each CloudFront distribution.
# These rules live on both the HTTPS (443) and HTTP (80) listeners.

resource "aws_lb_listener_rule" "https_backend" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = var.backend_target_group_arn
  }

  condition {
    http_header {
      http_header_name = "X-Fragile-Service"
      values           = ["backend"]
    }
  }
}

resource "aws_lb_listener_rule" "https_frontend" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = var.frontend_target_group_arn
  }

  condition {
    http_header {
      http_header_name = "X-Fragile-Service"
      values           = ["frontend"]
    }
  }
}

resource "aws_lb_listener_rule" "http_backend" {
  listener_arn = data.aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = var.backend_target_group_arn
  }

  condition {
    http_header {
      http_header_name = "X-Fragile-Service"
      values           = ["backend"]
    }
  }
}

resource "aws_lb_listener_rule" "http_frontend" {
  listener_arn = data.aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = var.frontend_target_group_arn
  }

  condition {
    http_header {
      http_header_name = "X-Fragile-Service"
      values           = ["frontend"]
    }
  }
}
