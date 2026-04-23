variable "environment" {
  description = "Deployment environment label."
  type        = string
}

variable "backend_ecr_arn" {
  description = "ARN of the backend ECR repository (for CI push permissions)."
  type        = string
}

variable "frontend_ecr_arn" {
  description = "ARN of the frontend ECR repository (for CI push permissions)."
  type        = string
}

variable "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the RDS password."
  type        = string
}

variable "jira_api_token_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the Jira API token."
  type        = string
}

variable "ssm_parameter_path_prefix" {
  description = "SSM parameter path prefix the backend task role may read (e.g. '/fragile/prod/')."
  type        = string
}

variable "dora_snapshot_lambda_arn" {
  description = "ARN of the DORA snapshot Lambda function (for lambda:InvokeFunction permission on the backend task role)."
  type        = string
}
