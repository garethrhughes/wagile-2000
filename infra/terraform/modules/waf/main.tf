terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# WAF scope is CLOUDFRONT — this module must be deployed with a us-east-1
# provider. The calling environment maps: providers = { aws = aws.us_east_1 }
#
# The WebACL ARN is passed to CloudFront distributions in the cdn module;
# no aws_wafv2_web_acl_association resources are needed.

resource "aws_wafv2_ip_set" "allowed" {
  name               = "fragile-allowed-ips"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = var.allowed_cidrs

  tags = {
    Name = "fragile-allowed-ips"
  }
}

resource "aws_wafv2_web_acl" "main" {
  name  = "fragile-ip-allowlist"
  scope = "CLOUDFRONT"

  default_action {
    block {}
  }

  rule {
    name     = "AllowVPN"
    priority = 1

    action {
      allow {}
    }

    statement {
      ip_set_reference_statement {
        arn = aws_wafv2_ip_set.allowed.arn
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "fragile-allow-vpn"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "fragile-ip-allowlist"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "fragile-ip-allowlist"
  }
}
