output "backend_cloudfront_domain" {
  description = "CloudFront domain name for the backend distribution (used as Route 53 ALIAS target)."
  value       = aws_cloudfront_distribution.backend.domain_name
}

output "frontend_cloudfront_domain" {
  description = "CloudFront domain name for the frontend distribution (used as Route 53 ALIAS target)."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

# All CloudFront distributions share the same Route 53 hosted zone ID.
output "cloudfront_hosted_zone_id" {
  description = "Route 53 hosted zone ID for CloudFront ALIAS records (constant across all distributions)."
  value       = "Z2FDTNDATAQYW2"
}
