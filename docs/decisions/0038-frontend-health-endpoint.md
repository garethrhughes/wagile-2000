# 0038 — Dedicated Frontend Health Endpoint for App Runner Health Checks

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

AWS App Runner performs periodic HTTP health checks against a running container to
determine whether it is healthy and eligible to receive traffic. The frontend App Runner
service was previously configured to use `GET /` as its health check path. The root page
is a full server-rendered Next.js page that imports components, executes data-fetching
logic, and returns a complete HTML document. This is a heavyweight operation for a
health check: it exercises the application's hot paths, consumes database/API resources
on every health probe (every 10 seconds), and may return a non-200 status during startup
or when the backend is unreachable.

Additionally, App Runner's container runtime sets the `HOSTNAME` environment variable to
the internal EC2 hostname, overriding the `ENV HOSTNAME=0.0.0.0` in the Dockerfile. This
caused the Next.js standalone server to bind only on the internal hostname, making it
unreachable from App Runner's health checker on `localhost`.

---

## Options Considered

### Option A — Continue using `GET /` as health check path

- **Pros:** No code change required.
- **Cons:** Full page render on every health probe; any backend unavailability causes the
  health check to return a non-200 (reporting the frontend as unhealthy when it is
  actually running); `HOSTNAME` binding issue causes health checks to fail on start.
  Ruled out.

### Option B — Dedicated `GET /api/health` route returning `{ ok: true }` (selected)

- Add a minimal Next.js App Router API route at `frontend/src/app/api/health/route.ts`
  that returns `Response.json({ ok: true })` with no database calls, no Jira API calls,
  and no component rendering.
- Update the App Runner `health_check_configuration` in the `apprunner` Terraform module
  to use `path = "/api/health"`.
- Inject `HOSTNAME = "0.0.0.0"` as a plain runtime environment variable in the App
  Runner service configuration, overriding the container-runtime-set hostname and
  ensuring the Next.js server binds on all interfaces.
- **Pros:** Health check is a no-op from the application's perspective; always returns
  200 if the Node.js process is running; does not trigger backend or Jira calls;
  `HOSTNAME` override ensures the server is reachable by the health checker.
- **Cons:** Adds a new file to the frontend; the health endpoint bypasses any
  middleware that wraps the rest of the app (acceptable — health checks should not
  be gated by auth middleware).

---

## Decision

> A minimal App Router API route `GET /api/health` is added to the frontend. It returns
> `{ ok: true }` with no side effects. The App Runner health check is updated to probe
> this path. `HOSTNAME=0.0.0.0` is injected as a runtime environment variable in the
> App Runner service to override the container runtime's hostname and ensure the
> standalone Next.js server binds on all interfaces.

---

## Rationale

A dedicated health endpoint that does nothing except return 200 is the standard pattern
for container health checks. It cleanly separates "is the process alive" (health check)
from "can the application serve its main function" (functional check). Probing the root
page conflates these concerns: a temporarily unavailable backend would cause the frontend
to be reported unhealthy and be taken out of rotation, even though the frontend container
itself is running correctly.

The `HOSTNAME` override is required because App Runner injects its own `HOSTNAME` env
var that shadows the Dockerfile value, causing the Next.js standalone server to bind on
the internal hostname only. Setting it explicitly in the App Runner runtime environment
takes precedence.

---

## Consequences

### Positive

- App Runner health checks pass as long as the Node.js process is alive, regardless of
  backend availability.
- Health probe load on the frontend is negligible (no rendering, no I/O).
- The `HOSTNAME` fix allows Next.js standalone mode to work correctly on App Runner
  without a custom entrypoint wrapper.

### Negative / Trade-offs

- The health endpoint at `/api/health` is accessible to anyone who can reach the
  CloudFront distribution (including blocked IPs if WAF is misconfigured). It reveals
  nothing sensitive but does confirm the service is running.

### Risks

- If the Next.js App Router middleware is ever configured to intercept all routes
  (including `/api/*`), the health check path may be blocked. Middleware must explicitly
  exclude `/api/health` if any global middleware is introduced.

---

## Related Decisions

- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront + App Runner
  topology that the health check configuration applies to
- [ADR-0031](0031-nextjs-standalone-output.md) — Standalone output mode; the
  `HOSTNAME` binding issue is specific to standalone server behaviour on App Runner
