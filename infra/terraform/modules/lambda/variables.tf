variable "environment" {
  description = "Deployment environment label."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC the Lambda function is placed in."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the Lambda VPC config."
  type        = list(string)
}

variable "rds_endpoint" {
  description = "Hostname of the RDS instance endpoint (without port)."
  type        = string
  sensitive   = true
}

variable "rds_sg_id" {
  description = "ID of the RDS security group — Lambda module adds its own inbound rule."
  type        = string
}

variable "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the DB password."
  type        = string
}
