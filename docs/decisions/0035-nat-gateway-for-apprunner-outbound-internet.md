# 0035 — NAT Gateway for App Runner Outbound Internet Access

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The backend App Runner service uses a VPC connector attached to the private subnets so
it can reach the RDS PostgreSQL instance. However, the backend must also call the Jira
Cloud REST API (an external internet endpoint) during sync operations. Without a NAT
Gateway, traffic from the VPC-attached App Runner service can only reach VPC-internal
resources; all outbound internet traffic is dropped.

Prior to this change, the `network` Terraform module only created private subnets with
no internet egress path. This meant the backend could not complete Jira syncs when
running in production (the VPC connector provided DB access but blocked internet egress).

---

## Options Considered

### Option A — Remove VPC connector (no VPC attachment)

- Run the backend App Runner service without a VPC connector. App Runner's built-in
  internet access provides both Jira API calls and RDS access via a public RDS endpoint.
- **Pros:** No NAT Gateway cost; no additional Terraform resources.
- **Cons:** Requires RDS to have a public endpoint; RDS inbound must be open to App
  Runner's egress IP pool (which is variable and undocumented). Unacceptable security
  posture: the database would be reachable from the public internet. Ruled out.

### Option B — NAT Gateway in a public subnet (selected)

- Add a public subnet, an Internet Gateway, an Elastic IP, and a NAT Gateway to the
  `network` module. Route the private subnets' default route (`0.0.0.0/0`) through
  the NAT Gateway.
- **Pros:** The private subnets retain no direct internet exposure; outbound traffic to
  Jira initiates from the NAT Gateway's static EIP; RDS remains in the private subnet
  with no public endpoint; the VPC connector continues to provide RDS access.
- **Cons:** NAT Gateway has an hourly cost (~$0.059/hr in `ap-southeast-2`) and a
  per-GB data processing charge. For an internal tool syncing Jira data every 30 minutes,
  this is on the order of ~$50/month.

### Option C — VPC Endpoint for all external traffic

- Use AWS PrivateLink / VPC Endpoints for all external service communication.
- **Pros:** No NAT Gateway cost; traffic never leaves the AWS network for supported
  services.
- **Cons:** Jira Cloud is not an AWS service and has no PrivateLink endpoint. A VPC
  endpoint for Jira is not possible. Ruled out for this use case.

---

## Decision

> The `network` Terraform module is extended with an Internet Gateway, a single public
> subnet (`10.0.0.0/24` in AZ-a), an Elastic IP, and a NAT Gateway. The private subnet
> route tables are updated to route `0.0.0.0/0` through the NAT Gateway. One public
> subnet is sufficient because NAT Gateway is a managed, highly available AWS service
> that does not require multi-AZ redundancy on the subnet level.

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

- The backend can call the Jira Cloud REST API from within the VPC.
- RDS remains in private subnets with no public endpoint.
- The NAT Gateway's EIP provides a predictable source IP for outbound traffic (useful
  if Jira Cloud's IP allowlist needs to include the application's egress address).
- The `aws_security_group.apprunner_connector` egress rule comment is updated to
  reflect that it covers both RDS and internet-via-NAT traffic.

### Negative / Trade-offs

- Estimated cost: ~$50–80/month for the NAT Gateway (hourly charge + data transfer
  for Jira API traffic). This is the dominant infrastructure cost of the deployment.
- The public subnet (`10.0.0.0/24`) is reserved for the NAT Gateway ENI. It has
  `map_public_ip_on_launch = true` but no EC2 instances or other resources should be
  placed in it.

### Risks

- If the NAT Gateway or its EIP is deleted, the backend App Runner service will
  silently lose internet access. Jira syncs will fail but the service will not crash.
  Monitoring the `SyncLog` table for consecutive sync failures provides detection.
- The EIP consumes an Elastic IP quota slot. AWS accounts have a default limit of 5
  EIPs per region. This is unlikely to be a constraint for this project but should be
  noted for accounts with many existing EIPs.

---

## Related Decisions

- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront/App Runner topology
  that this NAT Gateway sits within
- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Jira data caching strategy that
  requires the backend to make outbound Jira API calls
