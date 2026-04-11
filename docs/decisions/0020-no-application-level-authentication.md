# 0020 — No Application-Level Authentication; CORS as Sole Access Control

**Date:** 2026-04-12
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0009 — Remove API Key Authentication](../proposals/0009-remove-api-key-auth.md)
**Supersedes:** [ADR-0004 — Single-User API Key Auth via Passport HeaderAPIKeyStrategy](0004-single-user-api-key-auth.md)

## Context

ADR-0004 introduced a shared API key (`APP_API_KEY`) validated on every backend route
via Passport `HeaderAPIKeyStrategy`. The frontend enforced key entry through a full-screen
`AuthGate` login form on first load, storing the key in `localStorage`.

After operating this mechanism the following friction points were identified:

- Users must know and enter the key on every new browser session.
- The key is stored in `localStorage` in plain text — no improvement over having no key.
- The dashboard surfaces Jira metrics that are already visible to all team members
  inside Jira; the data is not sensitive.
- The tool has no external users, no compliance requirement mandating authentication,
  and no per-user access control requirement.
- `passport`, `@nestjs/passport`, and `passport-headerapikey` are production dependencies
  maintained solely to support a mechanism that adds friction without security benefit.

---

## Options Considered

### Option A — Remove all application-level authentication; rely on CORS (selected)

- **Summary:** Delete the Passport strategy, guard, and `AuthModule`. Remove the
  `AuthGate` component and `auth-store` from the frontend. The backend is open to any
  caller on the configured CORS origin (`FRONTEND_URL`).
- **Pros:**
  - Dashboard loads immediately without a login prompt.
  - No `APP_API_KEY` to manage, rotate, or distribute.
  - Removes ~500 lines of auth boilerplate from both backend and frontend.
  - Three npm packages (`passport`, `@nestjs/passport`, `passport-headerapikey`) removed.
  - CORS (`FRONTEND_URL`) is already in place and continues to enforce origin-level access.
- **Cons:**
  - Any process on the same host can call the API without a credential. Acceptable for
    a locally deployed internal tool.
  - If the tool were ever exposed to the public internet without a reverse-proxy firewall,
    the API would be unauthenticated. Mitigation: documented in the Risk table.

### Option B — Keep the guard, make the key optional (empty key bypasses validation)

- **Summary:** When no `APP_API_KEY` env var is set, the strategy returns `true`
  unconditionally.
- **Pros:** Backward-compatible.
- **Cons:** The `AuthGate` login form would remain (or require its own separate removal),
  the auth infrastructure stays as dead weight, and documentation continues to imply
  authentication is in use. Worst of both worlds. Ruled out.

### Option C — Replace with an IP allowlist middleware

- **Summary:** NestJS middleware rejects requests from non-allowlisted IPs.
- **Pros:** Network-level control without a user-facing credential.
- **Cons:** More brittle than CORS (developers change networks; IPv6 / proxy headers add
  edge cases); adds new env-var and implementation complexity without meaningful benefit
  over CORS alone. Ruled out.

---

## Decision

> The dashboard has no application-level authentication. All API routes are open to
> callers from the configured CORS origin (`FRONTEND_URL`). CORS enforcement in
> `backend/src/main.ts` is the sole network-level access control. The `AuthGate`
> login screen, `auth-store`, API key strategy, guard, and `AuthModule` are removed
> entirely.

---

## Rationale

For a single-team internal tool where the data is already visible to all team members
in Jira, the operational overhead of a shared API key exceeds its security benefit.
CORS already limits API access to the configured frontend origin, which is the
appropriate boundary for this deployment model. Removing the mechanism simplifies both
the backend (fewer modules, fewer dependencies) and the frontend (no login gate, no
`localStorage` credential management).

If the tool is ever deployed to a wider audience or exposed publicly, this decision
should be revisited — see Risks below.

---

## Consequences

### Positive

- The dashboard loads immediately on first visit without requiring any credential.
- No `APP_API_KEY` environment variable to provision, rotate, or distribute.
- `auth-gate.tsx`, `auth-store.ts`, `api-key.strategy.ts`, `api-key-auth.guard.ts`,
  and `auth.module.ts` are deleted. `passport`, `@nestjs/passport`, and
  `passport-headerapikey` are removed from `backend/package.json`.
- The Settings page no longer has an "API Key" section.

### Negative / Trade-offs

- Any authenticated process on the same host or network segment can call the API
  without a credential. Existing users' `dashboard_api_key` value in `localStorage`
  becomes stale but harmless (no code reads it after this change).

### Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| API becomes accessible to all callers on the same network | Medium | Low | Data exposed is already visible in Jira to all team members. CORS limits browser-origin access. |
| `POST /api/sync` triggerable without auth | Medium | Low | Rate limiting (`ThrottlerModule`) remains in place. No data-loss risk. |
| Future exposure to public internet | Low | High | If the deployment model changes, add authentication at the reverse-proxy layer or reintroduce an application-level mechanism. |

---

## Implementation

See [Proposal 0009](../proposals/0009-remove-api-key-auth.md) for the complete file
inventory and change list.

**Files deleted:**
- `backend/src/auth/api-key.strategy.ts`
- `backend/src/auth/api-key-auth.guard.ts`
- `backend/src/auth/auth.module.ts`
- `frontend/src/store/auth-store.ts`
- `frontend/src/components/layout/auth-gate.tsx`

**Key files modified:**
- `backend/src/app.module.ts` — `AuthModule` removed
- `backend/src/main.ts` — `.addApiKey(...)` removed from Swagger builder
- All 9 application controllers — `@UseGuards(ApiKeyAuthGuard)` and `@ApiSecurity('api-key')` removed
- `frontend/src/lib/api.ts` — `getApiKey()`, `x-api-key` header, and 401 reload handler removed
- `frontend/src/components/layout/client-shell.tsx` — `<AuthGate>` wrapper removed
- `frontend/src/app/settings/page.tsx` — API Key section removed

---

## Related Decisions

- [ADR-0004](0004-single-user-api-key-auth.md) — The decision this supersedes
- [ADR-0007](0007-monorepo-backend-frontend-directories.md) — Auth was implemented in
  the `backend/` NestJS application; the `auth/` subdirectory is now removed entirely
