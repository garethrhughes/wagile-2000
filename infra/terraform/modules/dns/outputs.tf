output "backend_fqdn" {
  description = "Fully-qualified domain name for the backend service."
  value       = aws_route53_record.backend.fqdn
}

output "frontend_fqdn" {
  description = "Fully-qualified domain name for the frontend service."
  value       = aws_route53_record.frontend.fqdn
}
