# 0033 — CloudFront Distributions as the Public Entry Point for Both Services

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

Both the backend (NestJS on App Runner) and the frontend (Next.js on App Runner) need to
be reachable via stable custom domain names (`fragile-api.<domain>` and
`fragile.<domain>`). App Runner provides its own `*.awsapprunner.com` URLs but not
direct custom-domain support with full control over TLS configuration, caching behaviour,
and edge-layer security. A CDN layer is needed to terminate TLS with a customer-owned
certificate, enforce HTTPS, and provide a stable hostname that can have a WAF WebACL
attached.

The previous DNS module pointed Route 53 directly at App Runner's ALIAS target. This
approach did not support ACM certificates (App Runner custom domain association has
different certificate requirements), WAF attachment, or differential caching behaviour
for static vs dynamic content.

---

## Options Considered

### Option A — App Runner built-in custom domains

- App Runner supports custom domain association natively, which provisions a certificate
  and creates the required Route 53 records automatically.
- **Pros:** No CloudFront resources to manage; simpler Terraform.
- **Cons:** Custom domain association creates App Runner-managed certificates that cannot
  have a WAF WebACL attached directly. CloudFront WAF requires the distribution to sit in
  front. Also, the App Runner custom domain flow requires out-of-band certificate
  validation that is harder to automate with Terraform. Ruled out.

### Option B — CloudFront in front of both services (selected)

- A `cdn` Terraform module creates two CloudFront distributions (one per service), issues
  ACM certificates in `us-east-1` (required by CloudFront), validates them via Route 53
  DNS records, and attaches the WAF WebACL ARN from the `waf` module.
- For the **backend**, caching is fully disabled via the `CachingDisabled` managed policy.
  The `AllViewerExceptHostHeader` origin request policy is used so CloudFront forwards all
  headers/query-strings/cookies but substitutes the App Runner origin hostname as the
  `Host` header (App Runner rejects requests with a `Host` header it does not recognise).
- For the **frontend**, static assets under `/_next/static/*` use the `CachingOptimized`
  managed policy (1-year TTL, gzip/brotli). All other paths use `CachingDisabled`.
- Route 53 ALIAS records point to the CloudFront distribution domain names (not directly
  to App Runner).
- **Pros:** WAF attachment is supported; TLS configuration is fully controlled; static
  asset caching reduces App Runner load and improves page-load performance; stable entry
  point for all future edge-layer changes.
- **Cons:** ACM certificates must be in `us-east-1` regardless of the deployment region
  (`ap-southeast-2`); requires a second provider alias in Terraform. CloudFront adds a
  small amount of latency for non-cached requests (typically <5 ms from Australia to
  AWS edge PoPs).

### Option C — Application Load Balancer

- Place an ALB in front of App Runner via the VPC connector.
- **Pros:** ALB WAF support in any region; familiar setup.
- **Cons:** App Runner is not an ALB target type; this would require ECS or EC2 instead.
  Incompatible with the existing App Runner deployment. Ruled out.

---

## Decision

> Both the backend and frontend App Runner services are fronted by CloudFront distributions
> managed by a `cdn` Terraform module. The backend distribution uses no caching and the
> `AllViewerExceptHostHeader` origin request policy to forward all request attributes while
> presenting the App Runner origin URL as the `Host` header. The frontend distribution
> caches `/_next/static/*` with a 1-year TTL and disables caching for all other paths.
> Route 53 ALIAS records point to the CloudFront domain names.

---

## Rationale

CloudFront is the only practical way to attach a WAF WebACL (CloudFront scope) to both
services while also supporting custom domain names with customer-managed ACM certificates.
The `AllViewerExceptHostHeader` policy is essential for the backend: App Runner's routing
is hostname-based and rejects requests where the `Host` header does not match the App
Runner service URL. Using the `CachingDisabled` managed policy for API traffic means
CloudFront is purely a pass-through for dynamic requests, preserving API semantics.

The differential caching strategy for the frontend (cached statics, uncached pages) is
appropriate because Next.js includes a content hash in `/_next/static/` paths, making
long-lived caching safe, while server-rendered pages must never be served stale.

---

## Consequences

### Positive

- WAF IP allowlist (ADR-0034) can be attached to both distributions.
- TLS 1.2+ is enforced at the CloudFront layer; App Runner's own TLS settings are a
  secondary layer.
- Static asset caching reduces origin requests and improves perceived performance for
  repeat visitors.
- The DNS module is simplified: it now creates ALIAS records pointing to CloudFront
  domain names rather than managing App Runner custom domain associations.

### Negative / Trade-offs

- ACM certificate issuance requires the `us-east-1` provider alias in Terraform. Any
  engineer applying Terraform must have IAM permissions in both `ap-southeast-2` and
  `us-east-1`.
- CloudFront distributions take 5–15 minutes to deploy globally; `terraform apply` runs
  will be slow during initial provisioning.
- CloudFront adds a per-request cost (approximately $0.009–$0.012 per 10k HTTPS requests
  from Australia). For an internal tool with low traffic this is negligible.

### Risks

- The `AllViewerExceptHostHeader` origin request policy is identified by a hardcoded AWS
  managed policy UUID (`b689b0a8-...`). If AWS ever changes this UUID, the Terraform
  configuration will fail to find the policy. This should be monitored at each Terraform
  upgrade cycle.
- CloudFront caches 5xx responses for a short period by default. If the backend enters an
  error state, cached error responses may briefly be served to users.

---

## Related Decisions

- [ADR-0034](0034-cloudfront-waf-ip-allowlist.md) — WAF WebACL attached to these
  CloudFront distributions as the sole access-control layer
- [ADR-0035](0035-nat-gateway-for-apprunner-outbound-internet.md) — NAT Gateway that
  allows the VPC-attached backend to reach Jira through the private network topology
  that coexists with this CDN layer
