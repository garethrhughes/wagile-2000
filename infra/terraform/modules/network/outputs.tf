output "vpc_id" {
  description = "The ID of the VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "List of public subnet IDs (one per AZ)."
  value       = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "List of private subnet IDs (one per AZ, used by RDS subnet group and ECS tasks)."
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

output "private_subnet_a_id" {
  description = "ID of the first private subnet (AZ a)."
  value       = aws_subnet.private_a.id
}

output "private_subnet_b_id" {
  description = "ID of the second private subnet (AZ b)."
  value       = aws_subnet.private_b.id
}

output "rds_security_group_id" {
  description = "ID of the RDS security group (allows inbound 5432 from ECS backend tasks only)."
  value       = aws_security_group.rds.id
}

output "ecs_backend_security_group_id" {
  description = "ID of the ECS backend task security group."
  value       = aws_security_group.ecs_backend.id
}

output "ecs_frontend_security_group_id" {
  description = "ID of the ECS frontend task security group."
  value       = aws_security_group.ecs_frontend.id
}
