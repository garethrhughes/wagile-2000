# 0035 — NAT Gateway for ECS Fargate Outbound Internet Access

**Date:** 2026-04-23
**Status:** Accepted (platform updated — see ADR-0043)
**Deciders:** Architect Agent

## Context

The backend ECS Fargate tasks run in private subnets and connect to the RDS PostgreSQL
instance directly via the VPC. The backend must also call the Jira Cloud REST API (an
external internet endpoint) during sync operations. Without a NAT Gateway, traffic from
tasks in private subnets can only reach VPC-internal resources; all outbound internet
traffic is dropped.

Prior to this change, the `network` Terraform module only created private subnets with
no internet egress path. This meant the backend could not complete Jira syncs when
running in production (the private subnet configuration provided DB access but blocked
internet egress).

---

## Options Considered

### Option A — Assign public IPs to ECS Fargate tasks

- Set `assign_public_ip = true` on the ECS task `network_configuration` so tasks get
  a public IP and can reach the internet directly.
- **Pros:** No NAT Gateway cost.
- **Cons:** Tasks running in public subnets with public IPs expand the attack surface.
  RDS still needs to be in private subnets, requiring tasks in public subnets to reach
  RDS across a SG rule. Tasks would be directly reachable from the internet on any open
  port. Unacceptable security posture. Ruled out.

### Option B — NAT Gateway in a public subnet (selected)

- Add a public subnet, an Internet Gateway, an Elastic IP, and a NAT Gateway to the
  `network` module. Route the private subnets' default route (`0.0.0.0/0`) through
  the NAT Gateway. Two public subnets (AZ-a and AZ-b) are provisioned — the second
  is also required for ALB placement (ALBs require subnets in at least two AZs).
- **Pros:** The private subnets retain no direct internet exposure; outbound traffic to
  Jira initiates from the NAT Gateway's static EIP; RDS remains in the private subnet
  with no public endpoint; ECS tasks remain in private subnets.
- **Cons:** NAT Gateway has an hourly cost (~$0.059/hr in `ap-southeast-2`) and a
   per-GB data processing charge. For an internal tool syncing Jira data once daily,
  this is on the order of ~$50/month.

### Option C — VPC Endpoint for all external traffic

- Use AWS PrivateLink / VPC Endpoints for all external service communication.
- **Pros:** No NAT Gateway cost; traffic never leaves the AWS network for supported
  services.
- **Cons:** Jira Cloud is not an AWS service and has no PrivateLink endpoint. A VPC
  endpoint for Jira is not possible. Ruled out for this use case.

---

## Decision

> The `network` Terraform module is extended with an Internet Gateway, two public
> subnets (`10.0.0.0/24` in AZ-a, `10.0.3.0/24` in AZ-b), an Elastic IP, and a NAT
> Gateway in AZ-a. The private subnet route tables are updated to route `0.0.0.0/0`
> through the NAT Gateway. Two public subnets are required: one for the NAT Gateway
> and both for ALB multi-AZ placement. One NAT Gateway is sufficient because NAT
> Gateway is a managed, highly available AWS service that does not require multi-AZ
> redundancy on the subnet level.

---

## Rationale

The NAT Gateway is the standard AWS pattern for enabling outbound internet access from
private subnets while keeping inbound access closed. It is the minimum change needed to
restore Jira sync functionality without exposing RDS to the public internet. A single
NAT Gateway in one AZ is sufficient for this use case because the application is an
internal tool; the cost of a second cross-AZ NAT Gateway (~$50/month additional) is not
justified for a low-traffic internal dashboard.

---

## Consequences

### Positive

- The backend ECS tasks can call the Jira Cloud REST API from within the VPC.
- RDS remains in private subnets with no public endpoint.
- The NAT Gateway's EIP provides a predictable source IP for outbound traffic (useful
  if Jira Cloud's IP allowlist needs to include the application's egress address).
- The two public subnets satisfy the ALB multi-AZ placement requirement.

### Negative / Trade-offs

- Estimated cost: ~$50–80/month for the NAT Gateway (hourly charge + data transfer
  for Jira API traffic). This is the dominant infrastructure cost of the deployment.
- The public subnet (`10.0.0.0/24`) is reserved for the NAT Gateway ENI. It has
  `map_public_ip_on_launch = true` but no EC2 instances or other resources should be
  placed in it.

### Risks

- If the NAT Gateway or its EIP is deleted, the backend ECS tasks will
  silently lose internet access. Jira syncs will fail but the service will not crash.
  Monitoring the `SyncLog` table for consecutive sync failures provides detection.
- The EIP consumes an Elastic IP quota slot. AWS accounts have a default limit of 5
  EIPs per region. This is unlikely to be a constraint for this project but should be
  noted for accounts with many existing EIPs.

---

## Related Decisions

- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront / ECS Fargate
  topology that this NAT Gateway sits within
- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Jira data caching strategy that
  requires the backend to make outbound Jira API calls
- [ADR-0043](0043-ecs-fargate-replaces-app-runner.md) — ECS Fargate as the compute
  platform running in the private subnets served by this NAT Gateway
