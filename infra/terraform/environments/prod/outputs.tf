output "backend_service_arn" {
  description = "The ARN of the backend App Runner service."
  value       = module.apprunner.backend_service_arn
}

output "frontend_service_arn" {
  description = "The ARN of the frontend App Runner service."
  value       = module.apprunner.frontend_service_arn
}

output "backend_service_url" {
  description = "The backend App Runner service URL."
  value       = module.apprunner.backend_service_url
}

output "frontend_service_url" {
  description = "The frontend App Runner service URL."
  value       = module.apprunner.frontend_service_url
}

output "backend_ecr_repository_url" {
  description = "The ECR repository URL for the backend image."
  value       = module.ecr.backend_repository_url
}

output "frontend_ecr_repository_url" {
  description = "The ECR repository URL for the frontend image."
  value       = module.ecr.frontend_repository_url
}

output "rds_endpoint" {
  description = "The RDS instance endpoint hostname."
  value       = module.rds.db_endpoint
  sensitive   = true
}

output "ci_user_arn" {
  description = "The ARN of the CI IAM user."
  value       = module.iam.ci_user_arn
}

output "backend_custom_domain" {
  description = "The custom domain for the backend App Runner service."
  value       = "https://${var.backend_subdomain}.${var.domain_name}"
}

output "frontend_custom_domain" {
  description = "The custom domain for the frontend App Runner service."
  value       = "https://${var.frontend_subdomain}.${var.domain_name}"
}
