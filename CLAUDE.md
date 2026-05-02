# CLAUDE.md — Jira DORA & Planning Metrics Dashboard

## Project Overview

Full-stack internal engineering metrics dashboard. Reads Jira Cloud data and produces DORA
metrics reports, sprint planning accuracy reports, roadmap coverage analysis, cycle time
tracking, sprint gap analysis, and a companion MCP server for AI assistant integration.
Internal use only — no application-level authentication (ADR 0020); access controlled at
infrastructure level via CloudFront WAF IP allowlist (ADR 0034).

---

## Tech Stack

### Backend
| Concern | Choice |
|---|---|
| Framework | NestJS 11 |
| Language | TypeScript 5.7, target ES2023, module nodenext |
| ORM | TypeORM 0.3.28 with PostgreSQL 16 (`pg ^8.19.0`) |
| Auth | None at application layer (ADR 0020 — removed API key auth) |
| API Docs | Swagger (`@nestjs/swagger ^11.2.6`) at `/api-docs` |
| Rate Limiting | `@nestjs/throttler ^6.5.0` — 100 req/min declared in `app.module.ts`; global guard wiring status TBD |
| Scheduler | `@nestjs/schedule ^6.1.1` — cron-based Jira sync |
| Testing | Jest 30 + Supertest 7 + ts-jest |
| Migrations | TypeORM CLI (`npm run migration:run`); files in `backend/src/migrations/` |
| Validation | `class-validator ^0.15.1` + `class-transformer ^0.5.1` + `zod ^4.3.6`; global `ValidationPipe` (`whitelist: true, transform: true`) |
| Logging | NestJS built-in `Logger` (`new Logger(ServiceName.name)`) — no structured/JSON logger |
| HTTP (Jira) | Single `JiraClientService` (native `fetch`); max 5 concurrent, 100ms interval, exponential backoff max 5 retries on HTTP 429 |
| Config | `@nestjs/config` + `ConfigService`; YAML board/roadmap config via `js-yaml` |
| Extra | `@aws-sdk/client-lambda ^3`, `@aws-sdk/client-secrets-manager ^3` |

### Frontend
| Concern | Choice |
|---|---|
| Framework | Next.js 16.2.3 (App Router), React 19.2.3 |
| Language | TypeScript 5, `strict: true` (full umbrella) |
| Styling | Tailwind CSS v4 (CSS-first, no `tailwind.config.js`) |
| State | Zustand 5.0.11 |
| Icons | Lucide React |
| Charts | Recharts 3 |
| Testing | Vitest 4 + React Testing Library 16 + jsdom |
| HTTP | Native `fetch` via typed wrappers in `frontend/src/lib/api.ts` |
| Data fetching | All API calls through `lib/api.ts` typed wrappers — no direct fetch in page components |

### Infrastructure
| Concern | Choice |
|---|---|
| Cloud provider | AWS (ap-southeast-2, Sydney) |
| IaC tool | Terraform (`infra/terraform/`) |
| IaC state backend | S3 + DynamoDB lock (`environments/prod/backend.tf`) |
| Compute | ECS Fargate (ADR 0043 — replaced App Runner) |
| CDN / Access control | CloudFront + WAF IP allowlist (ADR 0033, ADR 0034) |
| Database (prod) | AWS RDS PostgreSQL 16, `storage_encrypted = true`, deletion protection, 7-day backup |
| Secrets | AWS Secrets Manager (DB password, Jira API token) |
| Lambda | AWS Lambda for DORA snapshot post-sync computation (ADR 0040) |
| Container registry | ECR (two repos: backend + frontend) |
| Local dev | Docker Compose — PostgreSQL 16 (`postgres:16-alpine`), db `fragile`, port `5432` |
| Task automation | Makefile |
| Config | `.env` files (never committed); `backend/.env.example` provided; YAML config files gitignored (`.example.yaml` committed) |
| CI/CD | Manual (`make deploy`, `make ecr-push`, `make tf-apply`); only automated workflow is `publish-mcp.yml` |

### Security & Compliance
| Concern | Choice |
|---|---|
| Compliance frameworks | None |
| Encryption at rest | RDS: `storage_encrypted = true`; Secrets Manager for credentials |
| Encryption in transit | CloudFront TLS; WAF IP allowlist as sole access control |
| Data classification | All entities: internal (operational/mirrored Jira data — no PII) |
| Vulnerability scanning | Not configured (no Dependabot, no Snyk, no `npm audit` in CI) |

---

## Repository Structure

```
fragile/
├── apps/
│   └── mcp/                    (MCP server — separate package, published via publish-mcp.yml)
├── backend/
│   ├── config/                 (boards.yaml, roadmap.yaml — gitignored; .example.yaml committed)
│   └── src/
│       ├── boards/             (board config CRUD)
│       ├── config/             (AppConfigModule, ConfigService setup)
│       ├── database/
│       │   └── entities/       (13 TypeORM entities)
│       ├── gaps/
│       ├── health/
│       ├── jira/               (JiraClientService + sync logic)
│       ├── lambda/             (DORA snapshot Lambda handler)
│       ├── metrics/            (DORA calculations)
│       ├── migrations/         (TypeORM migrations)
│       ├── planning/           (sprint accuracy)
│       ├── quarter/
│       ├── roadmap/
│       ├── sprint/
│       ├── sprint-report/
│       ├── sync/
│       ├── week/
│       └── yaml-config/
├── docs/
│   ├── decisions/              (43 ADRs: 0001–0043)
│   └── proposals/              (41 proposals: 0001–0041)
├── frontend/
│   └── src/
│       ├── app/                (Next.js App Router — dora, planning, roadmap, sprint, sprint-report,
│       │                        quarter, week, cycle-time, gaps, settings)
│       ├── components/
│       │   ├── layout/
│       │   └── ui/
│       ├── hooks/
│       ├── lib/                (api.ts, dora-bands.ts, etc.)
│       └── store/
├── infra/
│   └── terraform/
│       ├── environments/prod/
│       └── modules/            (cdn, dns, ecr, ecs, iam, lambda, network, rds, secrets, waf)
├── scripts/
├── .github/
│   ├── agents/
│   └── workflows/
├── docker-compose.yml
├── Makefile
└── CLAUDE.md
```

---

## Architecture Rules

### Backend
- One module per feature domain: `jira`, `metrics`, `planning`, `boards`, `roadmap`, `sprint`, `quarter`, `week`, `gaps`, `sync`
- Controllers are thin — all business logic in services
- All Jira HTTP calls through a single typed `JiraClientService` — never call Jira directly from metric or domain services
- Environment config via `ConfigService` only — direct `process.env` access permitted only in `data-source.ts` (TypeORM CLI) and `lambda/snapshot.handler.ts` (Lambda entry point) — nowhere else
- No hardcoded Jira base URLs, board IDs, or status names — always from config or `BoardConfig`
- No N+1 queries — changelog and sprint data fetched in bulk, not per-issue
- All `find()` calls on `JiraIssue` or `JiraChangelog` require a `where` clause or explicit pagination
- Jira HTTP client: max 5 concurrent requests, 100ms inter-request interval, exponential backoff max 5 retries on HTTP 429
- Sync endpoint is fire-and-forget: returns HTTP 202 immediately (ADR 0036)
- Postgres advisory lock used to serialise sync runs (ADR 0041)
- DORA snapshots pre-computed post-sync: in-process locally, via Lambda in prod (ADR 0040)
- Epics and subtasks excluded from all metrics (ADR 0018)
- Jira field IDs externalised to YAML config (ADR 0021)

### Frontend
- All API calls through `frontend/src/lib/api.ts` typed wrappers — no direct fetch calls in pages or components
- Zustand stores in `frontend/src/store/` — one file per concern
- No direct state mutation outside the store — mutations only via defined actions
- Tailwind v4 only — CSS-first config via `@theme` in `globals.css`; no `tailwind.config.js`
- Components: `ui/`, `layout/` subdirectories
- No logic in page components — delegate to hooks/services

### Infrastructure (IaC)
- All infrastructure declared in `infra/terraform/`; no manual console changes
- State in S3 + DynamoDB lock — never local state in production
- ECS Fargate for compute (ADR 0043); Lambda for async DORA snapshot computation
- CloudFront as sole public entry point (ADR 0033); WAF IP allowlist is the only access control (ADR 0034)
- Secrets passed by reference (Secrets Manager ARNs) — never hardcoded in task definitions
- Multi-stage Docker builds (ADR 0030); Next.js standalone output (ADR 0031)
- YAML config files baked into Docker image at build time; gitignored in repo

### TypeScript
- Frontend: full `strict: true` umbrella — no `any`, no implicit returns
- Backend: individual strict flags (`strictNullChecks`, `noImplicitAny`, `strictBindCallApply`) — not full umbrella
- No `as any` casts in application code

### Observability
- Logging via NestJS built-in `Logger` — ECS stdout captured to CloudWatch Logs
- No structured/JSON logging, no request-ID correlation middleware, no distributed tracing (gaps — see Onboarding Notes)
- Health check: `GET /health` returns `{ status: 'ok', timestamp }`

---

## Security Rules (hard blocks)

- No credentials, tokens, or secrets committed in any file (including `.tfvars`, test fixtures, YAML config)
- `process.env` must not be accessed outside `data-source.ts` and `lambda/snapshot.handler.ts`; all other config via `ConfigService`
- No auth guards required at application layer (ADR 0020) — but all new cloud resources must be covered by WAF/network controls; document any new exposure in a proposal
- No SQL built via string interpolation — use TypeORM query builder or parameterised queries
- No hardcoded Jira base URLs, board IDs, or resource IDs in source
- No IAM policy with `Action: "*"` and `Resource: "*"` combined
- No public RDS / database endpoints (`publicly_accessible = false`)
- Lockfile changes must correspond to an intentional dependency change

---

## DORA Metrics

### Deployment Frequency
- **Signal (priority):** fixVersion with `releaseDate` in range → fallback: transition to done status
- **Done statuses (default):** `Done`, `Closed`, `Released` — configurable per board
- **Bands:** Elite = multiple/day, High = daily–weekly, Medium = weekly–monthly, Low = <monthly

### Lead Time for Changes
- **Calculation:** `issue.createdAt` → first transition to done/released (from changelog); if fixVersion present, use `releaseDate` as endpoint. Output: median and p95 in days. Weekend days excluded (ADR 0024).
- **Bands:** Elite = <1 day, High = 1 day–1 week, Medium = 1 week–1 month, Low = >1 month

### Change Failure Rate (CFR)
- **Calculation:** `(failure issues / total deployments) * 100`
- **Configurable per board (`BoardConfig`):** `failureIssueTypes`, `failureLinkTypes`, `failureLabels`
- **Bands:** Elite = 0–5%, High = 5–10%, Medium = 10–15%, Low = >15%

### MTTR
- **Calculation:** median of `(recoveryDate − failureCreatedDate)` across failure issues in period; uses **calendar hours** (not working hours) per ADR 0025
- **Configurable per board:** `incidentIssueTypes`, `recoveryStatusName`, `incidentLabels`
- **Bands:** Elite = <1 hr, High = <1 day, Medium = <1 week, Low = >1 week

### DORA Snapshots
- Pre-computed post-sync and stored in `DoraSnapshot` entity
- In local dev: computed in-process; in prod: triggers AWS Lambda (ADR 0040)
- Snapshot staleness threshold configurable via `SNAPSHOT_STALE_THRESHOLD_MINUTES` (default 2880 = 48h)

### Band Classifier
Pure functions only, no side effects, no DB calls. Lives in `frontend/src/lib/dora-bands.ts`:
```typescript
export type DoraBand = 'elite' | 'high' | 'medium' | 'low'
export function classifyDeploymentFrequency(deploymentsPerDay: number): DoraBand
export function classifyLeadTime(medianDays: number): DoraBand
export function classifyChangeFailureRate(percentage: number): DoraBand
export function classifyMTTR(medianHours: number): DoraBand
```

---

## Planning Accuracy

| Field | Formula |
|---|---|
| Commitment | Issues in sprint at `startDate` (reconstructed from changelog) |
| Added | Issues added after `startDate` |
| Removed | Issues removed before sprint end |
| Completed | Issues with Done status at sprint end |
| Scope Change % | `(added + removed) / commitment * 100` |
| Completion Rate | `completed / (commitment + added - removed) * 100` |

Sprint membership at start date **must** be reconstructed from changelog entries — Jira does not expose a historical snapshot directly (ADR 0006).

---

## Boards

| Board Key | Type |
|---|---|
| ACC | Scrum |
| BPT | Scrum |
| SPS | Scrum |
| OCS | Scrum |
| DATA | Scrum |
| PLAT | Kanban |

**Kanban (PLAT):**
- No sprints — deployment frequency and lead time use a rolling date window from selected quarter
- Cycle time (first `In Progress` → `Done`) replaces lead time
- Planning accuracy: return HTTP 400 with `"Planning accuracy is not available for Kanban boards"` when `boardType === 'kanban'`; show a notice in the UI

---

## Database Schema

```
BoardConfig          — board settings, done status names, CFR/MTTR rules
DoraSnapshot         — pre-computed DORA metric snapshots
JiraSprint           — id, name, state, startDate, endDate, boardId
JiraIssue            — key, summary, status, issueType, fixVersion, points, sprintId, createdAt, updatedAt
JiraChangelog        — issueKey, fromStatus, toStatus, changedAt
JiraVersion          — id, name, releaseDate, projectKey
JiraFieldConfig      — externalised field ID mappings (per ADR 0021)
JiraIssueLink        — issue-to-issue links
JpdIdea              — Jira Product Discovery ideas
RoadmapConfig        — roadmap configuration
SprintReport         — cached sprint report data
SyncLog              — boardId, syncedAt, issueCount, status
WorkingTimeConfig    — working hours config (hours/day, weekend exclusion)
```

All schema changes via TypeORM CLI migrations. Migrations must implement both `up()` and `down()`.
Never edit generated migration files manually.

---

## API Endpoints

```
GET  /health                            — health check (unguarded)
GET  /api-docs                          — Swagger UI (unguarded)

POST /api/sync                          — trigger full Jira sync (fire-and-forget HTTP 202, ADR 0036)
GET  /api/sync/status                   — last sync time per board

GET  /api/boards                        — list all configured boards
GET  /api/boards/:boardId/config        — get board config
PUT  /api/boards/:boardId/config        — update board config

GET  /api/metrics/dora                  — all 4 DORA metrics (or snapshot if fresh)
  ?boardId=ACC,BPT,...
  &period=sprint|quarter
  &sprintId=123
  &quarter=2025-Q1

GET  /api/metrics/deployment-frequency
GET  /api/metrics/lead-time
GET  /api/metrics/cfr
GET  /api/metrics/mttr

GET  /api/planning/accuracy
  ?boardId=ACC
  &sprintId=123
  &quarter=2025-Q1

GET  /api/planning/sprints
GET  /api/planning/quarters
```

---

## Testing Requirements

### Backend (Jest)
- Unit tests for all metric calculation services (mock Jira fixtures)
- Unit tests for DORA band classification utility
- Integration tests for `/api/metrics/dora` (mock DB)
- Unit tests for planning accuracy calculation
- Test services directly — do not test controllers

### Frontend (Vitest)
- Unit tests for significant UI components
- Unit tests for Zustand stores in isolation
- Unit tests for DORA band classifier
- No test should hit a real network

---

## Design & Proposal Workflow

Write a proposal in `docs/proposals/NNNN-short-kebab-case-title.md` before implementing any:
- New module, service, or significant component
- Module boundary or data flow change
- New Jira API integration point
- Schema change affecting more than one entity
- Cross-cutting concern (caching, error handling strategy, etc.)
- New cloud resource type, network topology change, or new IAM role/policy
- New secret, change to backup/retention, or change to the deployment pipeline

When a proposal is accepted, create the corresponding ADR in `docs/decisions/NNNN-title.md`
and update the proposal status to `Accepted`.

See the `architect` and `decision-log` skills for the exact proposal and ADR formats.

---

## Settled Decisions (do not revisit without a superseding ADR)

| # | Decision |
|---|---|
| 0001 | Jira fix versions are the primary deployment signal; done-status transition is the fallback |
| 0002 | Jira data cached in Postgres — not queried live per request |
| 0003 | CFR and MTTR rules are per-board, stored in `BoardConfig` |
| 0004 | Single-user API key auth *(superseded by 0020)* |
| 0005 | Kanban boards excluded from planning accuracy |
| 0006 | Sprint membership at start date reconstructed from Jira changelog |
| 0007 | Monorepo with `backend/` and `frontend/` directories |
| 0008 | Tailwind CSS v4 with CSS-first configuration — no `tailwind.config.js` |
| 0018 | Epics and subtasks excluded from all metrics calculations |
| 0020 | No application-level authentication — access control at infrastructure layer only |
| 0021 | Jira field IDs externalised to YAML config (`JiraFieldConfig`) |
| 0024 | Weekend days excluded from cycle time and lead time calculations |
| 0025 | MTTR uses calendar hours, not working hours |
| 0030 | Multi-stage Docker builds |
| 0031 | Next.js standalone output |
| 0033 | CloudFront as sole public entry point |
| 0034 | CloudFront WAF IP allowlist as primary access control mechanism |
| 0036 | Sync endpoint is fire-and-forget — returns HTTP 202 immediately |
| 0040 | Lambda invoked post-sync for DORA snapshot computation |
| 0041 | Postgres advisory lock used to serialise concurrent sync runs |
| 0043 | ECS Fargate replaces App Runner for compute |

---

## Edge Cases

| Case | Handling |
|---|---|
| Kanban (PLAT) — no sprints | Use rolling date window from selected quarter; disable planning accuracy |
| Missing fix versions | Fall back to "moved to Done" as deployment signal |
| Partial / active sprints | Include but flag with "Active" badge in UI |
| Empty boards (no data in period) | Show empty state card — not zero values |
| Changelog reconstruction | Reconstruct sprint membership from changelog — do not use current sprint field |
| Jira rate limiting | Exponential backoff, max 5 retries on HTTP 429; max 5 concurrent requests |
| Weekend days | Excluded from cycle time and lead time (ADR 0024) |
| DORA snapshot staleness | Configurable via `SNAPSHOT_STALE_THRESHOLD_MINUTES` (default 2880 min) |
| Concurrent sync runs | Serialised via Postgres advisory lock (ADR 0041) |

---

## Jira Sync

- Scheduled via `@nestjs/schedule` cron — default once daily at midnight
- `POST /api/sync` triggers a manual refresh; returns HTTP 202 immediately (ADR 0036)
- `SyncLog` records each run (boardId, syncedAt, issueCount, status)
- Show last-synced timestamp in UI header
- Jira client: exponential backoff, max 5 retries on HTTP 429; max 5 concurrent requests

---

## Onboarding Notes

*Gaps observed between the current code and the standard rules these skills assume.
Each item is a candidate for a proposal via the `architect` skill, or a backlog ticket.*

- **Auth removed by design (ADR 0020):** All API endpoints lack `@UseGuards()`. Access relies entirely on CloudFront WAF IP allowlist. If the app is ever exposed beyond that boundary, application-level auth must be reinstated.
- **ThrottlerGuard wiring unclear:** `ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])` is declared in `app.module.ts` but no `@UseGuards(ThrottlerGuard)` or `APP_GUARD` provider was found. Verify whether the guard is active; if not, wire it or remove the module.
- **Backend TypeScript not using full `strict: true`:** `backend/tsconfig.json` uses individual flags but omits the umbrella `strict: true`, missing `strictFunctionTypes` and `strictPropertyInitialization`. Recommend aligning with frontend.
- **No structured/JSON logging:** NestJS built-in `Logger` produces unstructured text output. CloudWatch log queries would benefit from structured JSON (e.g. Pino with `pino-pretty` in dev).
- **No request-ID / correlation-ID middleware:** Distributed debugging is difficult without a request ID propagated through logs.
- **No distributed tracing:** No OpenTelemetry, X-Ray, or equivalent instrumentation. A gap if cross-service debugging becomes necessary.
- **No CI/CD deploy pipeline:** Deployments are manual via `make ecr-push && make tf-apply`. A GitHub Actions workflow for automated deploy on merge to main would reduce deployment risk.
- **No dependency vulnerability scanning:** No Dependabot, Snyk, or `npm audit` in CI. Recommend adding `.github/dependabot.yml` for both `backend/` and `frontend/`.
- **Docker Compose DB name mismatch:** `docker-compose.yml` creates `POSTGRES_DB=fragile` but `app.module.ts` defaults `DB_DATABASE` to `'ai_starter'`. Ensure `.env` is set to `DB_DATABASE=fragile` locally; consider aligning the fallback default.
- **YAML config files gitignored:** `boards.yaml` and `roadmap.yaml` are baked into the Docker image at build. New team members need the `.example.yaml` files to bootstrap. Document this in the README or `make` target help text.
