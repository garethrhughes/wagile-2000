variable "domain_name" {
  description = "Root domain name. A Route 53 hosted zone must already exist."
  type        = string
}

variable "frontend_subdomain" {
  description = "Subdomain for the frontend service."
  type        = string
}

variable "backend_subdomain" {
  description = "Subdomain for the backend API service."
  type        = string
}

variable "backend_cloudfront_domain" {
  description = "CloudFront domain name for the backend distribution (e.g. d1234.cloudfront.net)."
  type        = string
}

variable "frontend_cloudfront_domain" {
  description = "CloudFront domain name for the frontend distribution."
  type        = string
}

variable "cloudfront_hosted_zone_id" {
  description = "Route 53 hosted zone ID for CloudFront ALIAS records (Z2FDTNDATAQYW2)."
  type        = string
}
