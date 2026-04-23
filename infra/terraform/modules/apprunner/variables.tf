variable "environment" {
  description = "Deployment environment label."
  type        = string
}

# ── Image URIs ────────────────────────────────────────────────────────────────

variable "backend_image_uri" {
  description = "Full ECR image URI for the backend service (including tag)."
  type        = string
}

variable "frontend_image_uri" {
  description = "Full ECR image URI for the frontend service (including tag)."
  type        = string
}

# ── IAM roles ─────────────────────────────────────────────────────────────────

variable "backend_execution_role_arn" {
  description = "ARN of the IAM role App Runner uses to pull the backend image from ECR."
  type        = string
}

variable "frontend_execution_role_arn" {
  description = "ARN of the IAM role App Runner uses to pull the frontend image from ECR."
  type        = string
}

variable "backend_instance_role_arn" {
  description = "ARN of the IAM role granted to the running backend container (task role)."
  type        = string
}

variable "frontend_instance_role_arn" {
  description = "ARN of the IAM role granted to the running frontend container (task role)."
  type        = string
}

# ── Network ───────────────────────────────────────────────────────────────────

variable "vpc_connector_arn" {
  description = "ARN of the App Runner VPC connector (attached to the backend service only)."
  type        = string
}

# ── RDS ───────────────────────────────────────────────────────────────────────

variable "rds_endpoint" {
  description = "Hostname of the RDS instance endpoint (without port)."
  type        = string
  sensitive   = true
}

# ── Secrets / SSM parameter ARNs ─────────────────────────────────────────────

variable "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the DB password."
  type        = string
}

variable "jira_api_token_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the Jira API token."
  type        = string
}

variable "jira_base_url_param_arn" {
  description = "ARN of the SSM parameter for the Jira base URL."
  type        = string
}

variable "jira_user_email_param_arn" {
  description = "ARN of the SSM parameter for the Jira user email."
  type        = string
}

variable "timezone_param_arn" {
  description = "ARN of the SSM parameter for the application timezone."
  type        = string
}

# ── URLs (for cross-service env vars) ────────────────────────────────────────

variable "backend_url" {
  description = "The stable backend custom domain URL (e.g. https://api.example.com). Set as NEXT_PUBLIC_API_URL on the frontend."
  type        = string
}

variable "frontend_url" {
  description = "The stable frontend custom domain URL (e.g. https://dashboard.example.com). Used for informational purposes."
  type        = string
}
