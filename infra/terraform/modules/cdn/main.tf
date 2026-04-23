terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

# ── Hosted zone lookup ────────────────────────────────────────────────────────

data "aws_route53_zone" "main" {
  name         = "${var.domain_name}."
  private_zone = false
}

# ── ACM certificates (must be in us-east-1 for CloudFront) ───────────────────

resource "aws_acm_certificate" "backend" {
  provider          = aws.us_east_1
  domain_name       = "${var.backend_subdomain}.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "fragile-backend-cert"
  }
}

resource "aws_acm_certificate" "frontend" {
  provider          = aws.us_east_1
  domain_name       = "${var.frontend_subdomain}.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "fragile-frontend-cert"
  }
}

# ── DNS validation records ────────────────────────────────────────────────────
# for_each is keyed by dvo.domain_name — our own input, known at plan time.
# No two-phase apply needed.

resource "aws_route53_record" "backend_validation" {
  for_each = {
    for dvo in aws_acm_certificate.backend.domain_validation_options :
    dvo.domain_name => dvo
  }

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_route53_record" "frontend_validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options :
    dvo.domain_name => dvo
  }

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "backend" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.backend.arn
  validation_record_fqdns = [for r in aws_route53_record.backend_validation : r.fqdn]
}

resource "aws_acm_certificate_validation" "frontend" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for r in aws_route53_record.frontend_validation : r.fqdn]
}

# ── CloudFront — backend API ──────────────────────────────────────────────────
# Caching is fully disabled. All methods, headers, query strings, and cookies
# are forwarded so the API behaves identically to a direct connection.

resource "aws_cloudfront_distribution" "backend" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = ["${var.backend_subdomain}.${var.domain_name}"]
  web_acl_id      = var.web_acl_arn

  origin {
    origin_id   = "apprunner-backend"
    domain_name = replace(var.backend_service_url, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "apprunner-backend"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    # CachingDisabled managed policy — no caching at the edge for API traffic.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # AllViewerExceptHostHeader — forwards all headers, query strings, and
    # cookies except Host. CloudFront then sends the App Runner origin URL as
    # the Host header, which App Runner recognises. Sending the viewer's Host
    # (e.g. fragile.<your-domain>) causes App Runner to return 404
    # because it only serves its own default *.awsapprunner.com hostname.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.backend.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name = "fragile-backend-cdn"
  }
}

# ── CloudFront — frontend ─────────────────────────────────────────────────────
# Default behaviour: caching disabled (Next.js standalone is a Node server).
# Static assets under /_next/static/* get long-lived caching since Next.js
# includes a content hash in those paths.

resource "aws_cloudfront_distribution" "frontend" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = ["${var.frontend_subdomain}.${var.domain_name}"]
  web_acl_id      = var.web_acl_arn

  origin {
    origin_id   = "apprunner-frontend"
    domain_name = replace(var.frontend_service_url, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Static assets — hashed filenames mean content never changes at a given URL.
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "apprunner-frontend"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    # CachingOptimized managed policy — 1 year TTL, gzip/brotli compression.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Everything else — server-rendered, no caching.
  default_cache_behavior {
    target_origin_id       = "apprunner-frontend"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = {
    Name = "fragile-frontend-cdn"
  }
}
