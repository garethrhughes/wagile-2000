# ── VPC ─────────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "fragile-vpc"
  }
}

# ── Internet Gateway ──────────────────────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "fragile-igw"
  }
}

# ── Public subnet (NAT Gateway lives here) ────────────────────────────────────
# One AZ is sufficient — NAT Gateway is a managed, highly available service.

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.0.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name = "fragile-public-a"
    Tier = "public"
  }
}

# ── NAT Gateway ───────────────────────────────────────────────────────────────
# Allows the private subnets (and the App Runner VPC connector) to initiate
# outbound connections to the internet (e.g. Jira API) while remaining
# unreachable from the internet themselves.

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "fragile-nat-eip"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id

  tags = {
    Name = "fragile-nat"
  }

  depends_on = [aws_internet_gateway.main]
}

# ── Route tables ──────────────────────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "fragile-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name = "fragile-private-rt"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ── Private subnets (2 AZs — required by RDS subnet group) ───────────────────

resource "aws_subnet" "private_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = false

  tags = {
    Name = "fragile-private-a"
    Tier = "private"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = false

  tags = {
    Name = "fragile-private-b"
    Tier = "private"
  }
}

# ── Security group: App Runner VPC connector ──────────────────────────────────
# App Runner attaches this SG to the ENIs it places in the private subnets.

resource "aws_security_group" "apprunner_connector" {
  name        = "fragile-apprunner-connector-sg"
  description = "Security group attached to the App Runner VPC connector ENIs."
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Allow all outbound traffic (RDS + internet via NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "fragile-apprunner-connector-sg"
  }
}

# ── Security group: RDS ───────────────────────────────────────────────────────
# Rules are managed as standalone aws_security_group_rule resources below so
# that external modules (e.g. lambda) can add their own rules without causing
# Terraform to fight over the inline ingress/egress lists.

resource "aws_security_group" "rds" {
  name        = "fragile-rds-sg"
  description = "Allow inbound PostgreSQL from the App Runner VPC connector only."
  vpc_id      = aws_vpc.main.id

  # Inline ingress/egress intentionally omitted — all rules are managed as
  # separate aws_security_group_rule resources. Mixing inline blocks with
  # standalone rules causes Terraform to remove externally-added rules on
  # every apply.

  tags = {
    Name = "fragile-rds-sg"
  }
}

resource "aws_security_group_rule" "rds_ingress_apprunner" {
  type                     = "ingress"
  description              = "PostgreSQL from App Runner VPC connector"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.apprunner_connector.id
  security_group_id        = aws_security_group.rds.id
}

resource "aws_security_group_rule" "rds_egress_all" {
  type              = "egress"
  description       = "Allow all outbound (for RDS patch downloads etc.)"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
}

# ── App Runner VPC connector ──────────────────────────────────────────────────
# Attached to the backend App Runner service so it can reach RDS in the VPC.
# Outbound internet traffic (Jira API etc.) routes via the NAT Gateway.
# The frontend service does NOT use a VPC connector.

resource "aws_apprunner_vpc_connector" "main" {
  vpc_connector_name = "fragile-vpc-connector"

  subnets = [
    aws_subnet.private_a.id,
    aws_subnet.private_b.id,
  ]

  security_groups = [aws_security_group.apprunner_connector.id]

  tags = {
    Name = "fragile-vpc-connector"
  }
}
