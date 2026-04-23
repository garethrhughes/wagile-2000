variable "allowed_cidrs" {
  description = "IPv4 CIDRs permitted through the CloudFront WAF. All other traffic receives HTTP 403."
  type        = list(string)
}
