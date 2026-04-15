# Retrieve the DB password from Secrets Manager at plan time.
# The secret shell is created by the secrets/ module; the actual value is set
# out-of-band by the operator. Terraform reads it here solely to pass it to
# the aws_db_instance resource (never stored in a local value or output).
data "aws_secretsmanager_secret_version" "db_password" {
  secret_id = var.db_password_secret_arn
}

# ── Subnet group ─────────────────────────────────────────────────────────────
# RDS requires a subnet group even for Single-AZ; it must span at least 2 AZs.

resource "aws_db_subnet_group" "main" {
  name        = "fragile-db-subnet-group"
  description = "Subnet group for the Fragile RDS PostgreSQL instance."
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "fragile-db-subnet-group"
  }
}

# ── Parameter group ──────────────────────────────────────────────────────────
# Explicit parameter group to allow future tuning without modifying the default.

resource "aws_db_parameter_group" "main" {
  name        = "fragile-postgres16"
  family      = "postgres16"
  description = "Parameter group for the Fragile PostgreSQL 16 instance."

  tags = {
    Name = "fragile-postgres16"
  }
}

# ── RDS instance ─────────────────────────────────────────────────────────────

resource "aws_db_instance" "main" {
  identifier = "fragile-postgres"

  # Engine
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = "db.t4g.micro"

  # Storage — 20 GB gp3, autoscaling disabled (max_allocated_storage omitted)
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  # Database
  db_name  = "fragile"
  username = "postgres"
  password = data.aws_secretsmanager_secret_version.db_password.secret_string

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_security_group_id]
  publicly_accessible    = false
  multi_az               = false

  # Maintenance
  parameter_group_name    = aws_db_parameter_group.main.name
  auto_minor_version_upgrade = true
  maintenance_window      = "Mon:03:00-Mon:04:00"
  backup_window           = "02:00-03:00"
  backup_retention_period = 7
  copy_tags_to_snapshot   = true

  # Protection
  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "fragile-postgres-final-snapshot"

  tags = {
    Name = "fragile-postgres"
  }
}
