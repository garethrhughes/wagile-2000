# 0004 — Single-User API Key Auth via Passport HeaderAPIKeyStrategy

**Date:** 2026-04-10
**Status:** Superseded by [Proposal 0009 / ADR-0020](../proposals/0009-remove-api-key-auth.md)
**Deciders:** Project setup team
**Proposal:** N/A

## Context

The dashboard is an internal tool used by a single engineering team. It surfaces Jira
metrics that are already visible to all team members in Jira itself. The primary
security requirement is preventing unauthenticated access from outside the team, not
fine-grained per-user authorisation. Implementing a full OAuth or session-based auth
flow would add significant complexity (token storage, refresh flows, redirect handling,
user management) that is disproportionate to the security need.

## Options Considered

### Option A — API key in `x-api-key` header via Passport HeaderAPIKeyStrategy
- **Summary:** A single shared `APP_API_KEY` environment variable is validated on all
  API routes using Passport's `HeaderAPIKeyStrategy`
- **Pros:**
  - Minimal implementation — no user table, no session store, no token refresh
  - Works seamlessly with the Nest.js / Passport ecosystem already in use
  - Key rotation is a single env-var change and restart
  - Easy to use from scripts, curl, and the frontend fetch client
- **Cons:**
  - Single shared secret — no per-user audit trail
  - Key must be distributed securely to all frontend deployments
  - If the key is leaked, there is no per-user revocation

### Option B — JWT with username/password login
- **Summary:** Users log in with credentials and receive a JWT for subsequent requests
- **Pros:**
  - Per-user audit trail
  - Short-lived tokens reduce window of exposure after key compromise
- **Cons:**
  - Requires a user table, password hashing, and credential management
  - JWT refresh flow adds frontend complexity
  - Disproportionate for a single-team internal tool

### Option C — OAuth 2.0 / OIDC (e.g. via Atlassian or Google)
- **Summary:** Delegate authentication to an identity provider
- **Pros:**
  - No credential management in the application
  - Integrates with existing corporate SSO
- **Cons:**
  - Requires OAuth app registration and redirect URI configuration
  - Session management and token storage still required
  - Significantly more complex to implement and operate
  - Over-engineered for a single-team internal tool

## Decision

> We will validate the `x-api-key` request header against the `APP_API_KEY` environment
> variable using Passport `HeaderAPIKeyStrategy`; all API routes except `/health` and
> `/api-docs` will be guarded by this strategy.

## Rationale

For a single-team internal tool, the shared API key strikes the right balance between
security and simplicity. The Passport integration keeps auth consistent with any future
strategy additions. Unguarded `/health` and `/api-docs` endpoints follow standard
practice for health checks and public API documentation. Options B and C add
complexity that is not justified by the threat model for this tool.

## Consequences

- **Positive:** Minimal implementation overhead; easy to automate and script; key
  rotation is operationally simple
- **Negative / trade-offs:** No per-user audit trail; a compromised key grants full
  access until manually rotated; key must be injected into frontend at build/deploy time
- **Risks:** If the team grows or the dashboard is exposed to a wider audience, this
  approach will need to be replaced with a proper identity solution (see Option C)

## Related Decisions

- [ADR-0007](0007-monorepo-backend-frontend-directories.md) — Auth strategy is
  implemented in the `backend/` NestJS application; the `frontend/` reads the key
  from an environment variable at build time
