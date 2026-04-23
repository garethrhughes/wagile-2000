output "function_arn" {
  description = "ARN of the DORA snapshot Lambda function."
  value       = aws_lambda_function.dora_snapshot.arn
}

output "function_name" {
  description = "Name of the DORA snapshot Lambda function."
  value       = aws_lambda_function.dora_snapshot.function_name
}

output "lambda_sg_id" {
  description = "ID of the Lambda security group."
  value       = aws_security_group.lambda.id
}
