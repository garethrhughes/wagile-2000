# 0034 — CloudFront-Scoped WAF IP Allowlist as Sole Access-Control Layer

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The application is an internal engineering tool. Access should be restricted to known
networks (e.g. a corporate VPN or office CIDR ranges) rather than being open to the
public internet. ADR-0020 removed application-level authentication; the CORS approach
documented there is insufficient on its own for an internet-facing deployment because
CORS is a browser hint only and does not block non-browser clients.

A network-layer access control is needed that sits in front of both the frontend and
backend services and is enforced at the edge before requests reach App Runner.

---

## Options Considered

### Option A — Security Group / NACl on App Runner

- Restrict inbound traffic to allowed CIDRs at the VPC network layer.
- **Pros:** Infrastructure-level enforcement; no per-request cost.
- **Cons:** App Runner does not expose security group controls on the public-facing
  ingress. VPC connectors only apply to outbound traffic from the service. Ruled out.

### Option B — Application-level API key authentication

- Require a header token on every request, validated by the backend.
- **Pros:** No infrastructure dependency; works for any deployment.
- **Cons:** The frontend is a separate Next.js App Runner service that cannot share
  a session or API key with the browser in a secure way without a proper authentication
  layer. ADR-0020 explicitly superseded API key auth. Ruled out.

### Option C — AWS WAF WebACL with IP allowlist attached to CloudFront (selected)

- A `waf` Terraform module creates an `aws_wafv2_ip_set` with allowed CIDRs and an
  `aws_wafv2_web_acl` with scope `CLOUDFRONT`. The default action is `block`; the only
  allow rule matches the IP set.
- Both CloudFront distributions (backend and frontend) reference the WebACL ARN via
  `web_acl_id`.
- The WAF and its WebACL must be provisioned in `us-east-1` (CloudFront WAF requirement).
- **Pros:** All HTTP/HTTPS traffic is evaluated at the CloudFront edge before reaching
  App Runner; non-browser clients are blocked at the network layer; no application code
  changes required; allowed CIDRs are managed in Terraform variables (`allowed_cidrs`).
- **Cons:** CloudFront WAF resources must live in `us-east-1` regardless of the primary
  deployment region; requires the same `us-east-1` provider alias already introduced
  for ACM certificates (ADR-0033). WAF adds a per-request cost (~$0.60/million requests
  plus a fixed WebACL charge of ~$5/month).

---

## Decision

> A CloudFront-scoped WAF WebACL with a default-block action and a single IP-allowlist
> rule (`AllowVPN`) is attached to both CloudFront distributions. Allowed CIDRs are
> stored in the Terraform `allowed_cidrs` variable. The WAF module is deployed via the
> `aws.us_east_1` provider alias. No application-level authentication is used.

---

## Rationale

CloudFront WAF is the earliest feasible enforcement point for an App Runner deployment.
It evaluates every request at the CloudFront edge (before the request reaches App Runner),
blocking non-browser and browser clients alike from disallowed networks. The CIDR-based
approach is appropriate for an internal tool accessed from known office/VPN networks.
Managing CIDRs in a Terraform variable keeps the allowlist in version control and auditable.

---

## Consequences

### Positive

- All traffic from disallowed IPs is blocked at the CloudFront edge with a 403 response.
  App Runner never receives these requests.
- CloudWatch metrics and sampled request logging are enabled on both the WebACL and the
  `AllowVPN` rule, providing visibility into blocked requests.
- Adding or removing allowed CIDRs requires only a `terraform apply`; no application
  redeployment is needed.

### Negative / Trade-offs

- The WAF IP set and WebACL must be in `us-east-1`. Any engineer applying Terraform must
  have WAF permissions in `us-east-1` in addition to the primary region.
- If the operator's IP changes (e.g. VPN rotation), they are locked out until the
  `allowed_cidrs` variable is updated and Terraform is re-applied.
- The WAF does not inspect request content (no managed rule groups); it is purely an
  IP allowlist. Requests from an allowed IP are fully trusted.

### Risks

- `allowed_cidrs` is stored in `terraform.tfvars`, which is gitignored. If the tfvars
  file is lost, the allowed CIDRs must be reconstructed from the WAF IP set in the
  AWS console.
- A misconfigured or empty `allowed_cidrs` variable would block all access to both
  services. The Terraform `waf` module does not enforce a minimum list length; operators
  must verify the variable before applying.

---

## Related Decisions

- [ADR-0020](0020-no-application-level-authentication.md) — The decision that removed
  application-level auth; this ADR provides the network-layer replacement
- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront distributions to
  which this WAF WebACL is attached
