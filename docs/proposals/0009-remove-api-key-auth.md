# 0009 — Remove API Key Authentication

**Date:** 2026-04-12
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** Supersedes [ADR-0004](../decisions/0004-single-user-api-key-auth.md)

---

## Problem Statement

The dashboard currently requires every frontend request to carry an `X-API-Key` header,
and the frontend enforces entry of that key via an `AuthGate` login screen before rendering
any content. For a single-user internal tool running on a private network, this gate adds
friction without meaningful security benefit: the user must know and type the key on every
new browser session, and the key is stored in `localStorage` in plain text. The tool has
no external users, no sensitive personal data, and no compliance requirement that mandates
authentication. The requirement to maintain `APP_API_KEY` in both the backend `.env` and
the user's browser is pure operational overhead.

---

## Current State

### Backend enforcement (3 files)

| File | Role |
|---|---|
| `backend/src/auth/api-key.strategy.ts` | Passport `HeaderAPIKeyStrategy` — reads `APP_API_KEY` from `ConfigService`, validates the `x-api-key` header on every request |
| `backend/src/auth/api-key-auth.guard.ts` | Thin `AuthGuard('api-key')` wrapper that NestJS `@UseGuards()` decorators reference |
| `backend/src/auth/auth.module.ts` | NestJS module that declares and exports `ApiKeyStrategy`; imported by `AppModule` |

The guard is applied at the **controller class level** (not globally) on every non-health
controller. All eight application controllers carry identical boilerplate:

```typescript
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
```

Affected controllers:
- `backend/src/boards/boards.controller.ts`
- `backend/src/metrics/metrics.controller.ts`
- `backend/src/metrics/cycle-time.controller.ts`
- `backend/src/planning/planning.controller.ts`
- `backend/src/roadmap/roadmap.controller.ts`
- `backend/src/sprint/sprint.controller.ts`
- `backend/src/quarter/quarter.controller.ts`
- `backend/src/week/week.controller.ts`
- `backend/src/sync/sync.controller.ts`

The `HealthController` has no guard and is unaffected.

`backend/src/main.ts` also registers the Swagger API key scheme:

```typescript
.addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
```

### Frontend enforcement (4 files)

| File | Role |
|---|---|
| `frontend/src/store/auth-store.ts` | Zustand store that reads/writes `dashboard_api_key` in `localStorage`; exposes `setApiKey` / `clearApiKey` |
| `frontend/src/lib/api.ts` | `getApiKey()` reads from `localStorage`; `apiFetch()` conditionally sets `x-api-key` header; 401 handler clears the key and reloads the page |
| `frontend/src/components/layout/auth-gate.tsx` | Renders a full-screen login form when `apiKey` is `null`; wraps all page content |
| `frontend/src/components/layout/client-shell.tsx` | Wraps every page in `<AuthGate>` |

The Settings page (`frontend/src/app/settings/page.tsx`) renders an **"API Key" panel**
that allows the user to view, update, and clear the stored key. This section would become
dead UI after removal.

### Tests referencing the API key

| File | What it tests |
|---|---|
| `frontend/src/lib/api.test.ts` | `"attaches x-api-key from localStorage"` — asserts the header is sent when the key is in `localStorage` |
| `frontend/src/store/stores.test.ts` | `useAuthStore` tests (`setApiKey`, `clearApiKey`, persists to `localStorage`) |

### Environment variables

| File | Variable |
|---|---|
| `backend/.env` | `APP_API_KEY=passyword` |
| `backend/.env.example` | `APP_API_KEY=your_dashboard_api_key_here` |

---

## Proposed Solution

Remove the entire API key authentication mechanism from both the backend and frontend.
The backend becomes fully open to any caller on the configured CORS origin. CORS (`FRONTEND_URL`)
remains as the sole network-level constraint, which is already in place in `main.ts`.

### Backend changes

**`backend/src/auth/api-key.strategy.ts`** — Delete the file entirely.

**`backend/src/auth/api-key-auth.guard.ts`** — Delete the file entirely.

**`backend/src/auth/auth.module.ts`** — Delete the file entirely. Remove `AuthModule` from
the `imports` array in `backend/src/app.module.ts`.

**All 9 guarded controllers** — Remove the two lines from each controller class:
```typescript
// Remove these two lines from each controller:
import { ApiKeyAuthGuard } from '../auth/api-key-auth.guard.js';
// (and from decorator section:)
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
```
Also remove `UseGuards` from each controller's `@nestjs/common` import if it is the only
usage of that import (check each controller individually).

**`backend/src/main.ts`** — Remove the `.addApiKey(...)` call from the Swagger
`DocumentBuilder` chain. The `SwaggerModule` / `DocumentBuilder` setup itself is retained.

**`backend/.env` and `backend/.env.example`** — Remove the `APP_API_KEY` line from both
files and the `# App Auth` comment block.

**Packages to consider removing**: `passport`, `passport-headerapikey`, `@nestjs/passport`
are only used for API key auth. Verify no other strategy or guard depends on them before
removing. If they are sole-use, remove from `backend/package.json` and run `npm install`.

### Frontend changes

**`frontend/src/store/auth-store.ts`** — Delete the file entirely.

**`frontend/src/lib/api.ts`** — Remove:
- The `getApiKey()` function
- The `apiKey` variable and the `...(apiKey ? { 'x-api-key': apiKey } : {})` spread in
  `apiFetch()`
- The 401 `localStorage.removeItem` + `window.location.reload()` handler (the 401 path
  can remain as a generic `ApiError` throw, or be removed if the endpoint can no longer
  return 401)

**`frontend/src/components/layout/auth-gate.tsx`** — Delete the file entirely.

**`frontend/src/components/layout/client-shell.tsx`** — Remove the `<AuthGate>` wrapper.
The component simply renders the layout shell (Sidebar + SyncStatus + `children`) without
any authentication gate.

**`frontend/src/app/settings/page.tsx`** — Remove the entire **"API Key"** section
(the `<section>` block from line 205 to 266 in the current file). This includes:
- The `apiKey`, `setApiKey`, `clearApiKey` destructure from `useAuthStore`
- The `showKey` / `newKey` state variables
- The `maskedKey` computed value
- The full API Key `<section>` JSX block

If `useAuthStore` is no longer imported anywhere after this change, the import can be
removed from `settings/page.tsx`.

### Tests

**`frontend/src/lib/api.test.ts`** — Remove or rewrite the
`"attaches x-api-key from localStorage"` test. The remaining tests (`"is a function"`,
`"sends Content-Type header"`, `"throws ApiError on non-OK response"`) are unaffected.

**`frontend/src/store/stores.test.ts`** — Remove the entire `useAuthStore` describe block
(lines 9–35). The `useFilterStore` tests are unaffected.

---

## Alternatives Considered

### Alternative A — Keep the guard but make the key optional (allow empty key)

Allow the backend to accept requests with no `x-api-key` header by changing the strategy's
`validate()` to return `true` when no key is configured.

**Why ruled out:** This is the worst of both worlds — the auth infrastructure stays in the
codebase (dead weight), the frontend `AuthGate` either stays (friction) or is removed
anyway (partial cleanup), and the env-var documentation continues to imply auth is in use.
Full removal is cleaner.

### Alternative B — Replace with network-level protection only (e.g. Tailscale / VPN)

Rely entirely on network access controls to secure the API.

**Why ruled out:** This is effectively what the proposal does at the application layer —
CORS already restricts the origin. Whether a VPN or local network policy is also in use is
an infrastructure concern outside the application's scope. The application does not need to
add further enforcement.

### Alternative C — Replace with IP allowlist middleware

Add NestJS middleware that rejects requests from non-allowlisted IPs.

**Why ruled out:** Adds implementation complexity (middleware, env-var for the allowlist,
IPv6/proxy header handling) without meaningful benefit over CORS for a locally deployed
tool. More brittle than the current approach when developers change networks.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema or migration changes required |
| API contract | Breaking (auth removed) | All routes become publicly accessible on the CORS origin; clients no longer need to send `x-api-key` |
| Frontend | Component + store deletion | `auth-gate.tsx`, `auth-store.ts` deleted; `client-shell.tsx`, `api.ts`, `settings/page.tsx` simplified |
| Tests | 2 test blocks deleted / modified | `api.test.ts` (1 test removed), `stores.test.ts` (1 describe block removed) |
| Jira API | No change | Jira credentials are backend-only env vars; unaffected |
| Packages | Potential removal | `passport`, `@nestjs/passport`, `passport-headerapikey` may be removable if no other auth strategy exists |

---

## Migration / Deployment Notes

1. **Deploy backend first.** Once deployed, the backend no longer validates the `x-api-key`
   header. Any existing frontend instances that still send the old key will continue to work
   (the header is simply ignored by HTTP).

2. **Deploy frontend.** The `AuthGate` is removed; the dashboard loads immediately without
   requiring the user to enter a key.

3. **No data migration.** No database changes are needed.

4. **Remove `APP_API_KEY` from deployment secrets / environment after frontend is deployed.**
   Leaving it in place is harmless but creates confusing documentation.

5. **Inform all local users** to clear `dashboard_api_key` from their browser's `localStorage`
   to avoid stale data. This is cosmetic only — without the frontend code reading it, the key
   in `localStorage` has no effect.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Backend API becomes accessible to anyone on the same network | Medium | Low | CORS is already in place. The data exposed (Jira metrics) is already visible in Jira itself to all team members. |
| `sync` endpoints (`POST /api/sync`, `POST /api/roadmap/sync`) become triggerable without auth | Medium | Low | These are mutation endpoints but cause no data loss. Rate limiting (`ThrottlerModule`, 100 req/60 s) remains in place. For a production deployment at scale, reconsider. |
| `passport`/`@nestjs/passport` removal breaks an undetected secondary use | Low | High | Audit all `import` statements for `passport` before removing packages. The current codebase only uses Passport in the `auth/` directory. |
| Users expect an auth prompt on first load (mental model) | Low | Low | The tool is internal; removing the login screen is a UX improvement, not a regression. |

---

## Acceptance Criteria

- [ ] The backend starts successfully with no `APP_API_KEY` environment variable set.
- [ ] All API routes (`/api/boards`, `/api/metrics`, `/api/sync`, etc.) return 200 with no
      `x-api-key` header present in the request.
- [ ] The frontend loads and renders the full dashboard without displaying any login form.
- [ ] The Settings page contains no "API Key" section.
- [ ] `auth-gate.tsx`, `auth-store.ts`, `api-key-auth.guard.ts`, `api-key.strategy.ts`, and
      `auth.module.ts` are deleted from the repository.
- [ ] The `@ApiSecurity('api-key')` and `@UseGuards(ApiKeyAuthGuard)` decorators are removed
      from all 9 controllers.
- [ ] `apiFetch()` in `api.ts` no longer reads from `localStorage` or appends `x-api-key`.
- [ ] The `"attaches x-api-key from localStorage"` test is removed from `api.test.ts`.
- [ ] The `useAuthStore` describe block is removed from `stores.test.ts`.
- [ ] The remaining test suite passes: `npm run test` on both backend and frontend.
- [ ] `APP_API_KEY` is removed from `backend/.env.example`.
- [ ] CORS continues to function correctly: the backend only accepts requests from the
      configured `FRONTEND_URL` origin.
