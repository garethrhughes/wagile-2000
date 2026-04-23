output "web_acl_arn" {
  description = "ARN of the WAFv2 WebACL."
  value       = aws_wafv2_web_acl.main.arn
}

output "ip_set_arn" {
  description = "ARN of the WAFv2 IP set (add CIDRs here to expand access)."
  value       = aws_wafv2_ip_set.allowed.arn
}
