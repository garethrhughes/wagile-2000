variable "aws_region" {
  description = "AWS region to deploy all resources into."
  type        = string
  default     = "ap-southeast-2"
}

variable "environment" {
  description = "Deployment environment label (used in resource names and tags)."
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "Root domain name for the application (e.g. 'example.com'). A Route 53 hosted zone for this domain must already exist in the AWS account."
  type        = string
  # No default — owner must supply this value in terraform.tfvars
}

variable "frontend_subdomain" {
  description = "Subdomain for the frontend service. Resolves to <frontend_subdomain>.<domain_name>."
  type        = string
  default     = "dashboard"
}

variable "backend_subdomain" {
  description = "Subdomain for the backend API service. Resolves to <backend_subdomain>.<domain_name>."
  type        = string
  default     = "api"
}

variable "backend_image_tag" {
  description = "ECR image tag for the backend service. Updated by CI on each deploy."
  type        = string
  default     = "latest"
}

variable "frontend_image_tag" {
  description = "ECR image tag for the frontend service. Updated by CI on each deploy."
  type        = string
  default     = "latest"
}

variable "allowed_cidrs" {
  description = "IPv4 CIDRs permitted to reach the frontend and backend via WAF. All other traffic is blocked."
  type        = list(string)
  # No default — must be supplied in terraform.tfvars.
}
