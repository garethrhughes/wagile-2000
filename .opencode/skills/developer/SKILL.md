---
name: developer
description: Writes production-quality TypeScript and Infrastructure-as-Code using TDD (red-green-refactor). Follows project conventions exactly — thin controllers, typed API clients, ConfigService-only env access, strict TypeScript, declarative infra with pinned versions and remote state.
compatibility: opencode
---

# Developer Skill

You write production-quality TypeScript and Infrastructure-as-Code. You follow the project
conventions exactly and do not introduce new dependencies (npm packages, Terraform modules,
provider versions) without calling them out explicitly.

## Project Context

**Project:** Fragile — Internal Jira DORA & Planning Metrics Dashboard (NestJS backend + Next.js frontend + MCP server)

**Backend:** NestJS 11 / TypeScript 5.7 ES2023 / PostgreSQL 16 + TypeORM 0.3.28
**Frontend:** Next.js 16.2.3 App Router / Tailwind CSS v4 (CSS-first) / Zustand 5
**Auth:** None at application layer (ADR 0020 — WAF IP allowlist at CloudFront is sole access control)
**Validation:** class-validator + class-transformer + zod; global ValidationPipe (whitelist, transform)
**Logging:** NestJS built-in Logger → CloudWatch Logs (ECS stdout)
**Testing:** Jest 30 + Supertest 7 (backend) / Vitest 4 + React Testing Library 16 (frontend)

**Infra:** Terraform on AWS ap-southeast-2; state in S3 + DynamoDB lock; secrets in AWS Secrets Manager; CI/CD manual (make ecr-push + make tf-apply); only publish-mcp.yml is automated
**Local dev:** Docker Compose (postgres:16-alpine, db=fragile, port 5432); task runner: Makefile

**Compliance:** None
**Data classes:** All entities internal (mirrored Jira operational data — no PII)
**Encryption:** at rest RDS storage_encrypted=true + Secrets Manager / in transit CloudFront TLS

**Repo structure:** `backend/` (NestJS), `frontend/` (Next.js), `apps/mcp/` (MCP server), `infra/terraform/`, `docs/decisions/` (43 ADRs), `docs/proposals/` (41 proposals)
**Module structure:** One NestJS module per domain (jira, metrics, planning, boards, roadmap, sprint, quarter, week, gaps, sync); thin controllers delegating to services; single JiraClientService for all Jira HTTP calls; frontend API calls only via `frontend/src/lib/api.ts`

**Key rules:**
- ConfigService only for env access; `process.env` permitted only in `data-source.ts` (TypeORM CLI) and `lambda/snapshot.handler.ts`
- All Jira HTTP through `JiraClientService` (max 5 concurrent, 100ms interval, exponential backoff max 5 retries on 429)
- Sync endpoint fire-and-forget HTTP 202 (ADR 0036); Postgres advisory lock for concurrent sync (ADR 0041)
- DORA snapshots pre-computed post-sync: in-process locally, Lambda in prod (ADR 0040)
- Epics and subtasks excluded from all metrics (ADR 0018); weekend days excluded from lead time/cycle time (ADR 0024); MTTR uses calendar hours (ADR 0025)
- No hardcoded Jira URLs, board IDs, or resource IDs; Jira field IDs in YAML config (ADR 0021)
- All new cloud resources must be behind WAF/network controls; document new exposure in proposal
- No IAM `Action:*` + `Resource:*`; no public RDS endpoints; no secrets in source or tfvars
- IaC: declarative Terraform, remote state, ECS Fargate (ADR 0043), CloudFront sole entry point (ADR 0033)
- Frontend: full strict TypeScript; backend: individual strict flags (not umbrella strict:true — gap)

**External integrations:** Jira Cloud REST API (via JiraClientService); AWS Lambda (DORA snapshot computation); AWS Secrets Manager (credentials at runtime)
**Key entities:** BoardConfig, DoraSnapshot, JiraIssue, JiraChangelog, JiraSprint, JiraVersion, JiraFieldConfig, JiraIssueLink, JpdIdea, RoadmapConfig, SprintReport, SyncLog, WorkingTimeConfig — all internal data class
**Known gotchas:** Docker Compose DB=fragile but app.module.ts defaults to 'ai_starter' — set DB_DATABASE=fragile in .env; YAML config files gitignored, baked into Docker image at build; ThrottlerGuard wiring status unverified
**Open onboarding gaps:** 9 items — see CLAUDE.md ## Onboarding Notes
---

## Test-Driven Development (TDD)

**All implementation work must follow the red-green-refactor cycle. Do not write production
code before a failing test exists for it.** This applies to TypeScript, infrastructure
modules, and any other production artefact for which a testing tool exists.

### Workflow

1. **Red** — Write a test that describes the desired behaviour. Run it and confirm it fails
   for the right reason (not a compile error, but an assertion failure).
2. **Green** — Write the minimum production code required to make that test pass. Do not
   over-engineer at this step.
3. **Refactor** — Clean up the implementation and tests (naming, duplication, structure)
   while keeping all tests green. Run the full test suite after every refactor step.

Repeat for each unit of behaviour. Never skip the Red step — if the test passes before you
write the implementation, the test is wrong.

### TDD Rules

- Write tests in the same commit as the feature code they cover — never defer tests
- Each test must have a single, clear assertion of one behaviour
- Test file must exist and compile (with the new test failing) before the implementation
  file is created or modified
- When fixing a bug, write a regression test that reproduces the bug first, then fix it
- Do not test controllers directly — test services
- Mock all external dependencies (API clients, ORM repositories) in unit tests
- **Test names describe behaviour, not implementation** (`returns empty array when user
  has no orders`, not `calls repository.find`)
- **No shared mutable state between tests.** Each test sets up and tears down its own fixtures
- **Snapshot tests** only for stable, intentional output (e.g. generated SQL, generated
  Terraform plan). Never for UI components — use semantic queries instead

## TypeScript Conventions

- Strict mode throughout — no `any`, no implicit returns
- Prefer explicit return types on all exported functions and class methods
- Use `unknown` instead of `any` when the type is genuinely unknown, then narrow it
- Prefer `type` aliases for unions/intersections; use `interface` for object shapes that may
  be extended
- **`readonly` by default** on class fields, interface properties, and arrays/tuples where
  mutation isn't required
- **Discriminated unions over optional flags** for state representation
- **`as const` object literals + derived union type** instead of `enum`
- **`satisfies` operator** for config objects rather than type assertions
- **No barrel files (`index.ts` re-exports)** at module boundaries unless explicitly
  justified — they hurt tree-shaking and create import cycles

## Backend Conventions (NestJS)

- One module per feature domain — no cross-domain imports except through explicit interfaces
- Controllers are thin: validate input, call a service, return the result — nothing else
- All environment config via `ConfigService` — never `process.env` directly
- All external API calls through a single typed client class — never call external APIs
  directly from domain services
- ORM entities use decorators; migrations generated via ORM CLI, never edited manually
- Migrations must implement both `up()` and `down()` — and you must test the down path
  locally before merging
- External HTTP calls must implement retry logic with exponential backoff on rate-limit
  responses (429) — the exact retry count should follow the limit defined in your Project Context
- **Every external HTTP call has an explicit timeout** — default 5s, override only with
  justification
- Apply auth guards to all controller endpoints except explicitly public routes (e.g. health,
  API docs)
- No hardcoded external URLs, IDs, or credentials — always read from `ConfigService`
- No N+1 queries — fetch related data in bulk; no per-item fetches in loops
- All unbounded queries require a `where` clause or explicit pagination
- **DTOs validated at the boundary** with the project's validation library (e.g.
  class-validator / Zod) — never trust raw `req.body`
- **Idempotency keys** on any endpoint that mutates state and may be retried by clients

## Frontend Conventions (Next.js / React)

- All API calls go through a single typed wrapper in `lib/api.ts` — no raw `fetch` calls
  scattered across components
- State management stores live in `store/` — one file per concern; mutations only through
  defined actions, never direct state mutation
- No business logic in page components — delegate to services, custom hooks, or stores
- Components with large data tables use `useMemo` for derived calculations
- Styling via the project's configured CSS framework only — do not introduce inline styles
  or a second styling system
- **Server Components by default** in App Router; Client Components only when interactivity
  or a browser API requires it (and called out in the PR description)
- **No `useEffect` for data fetching** — use Server Components, route handlers, or a query
  library (React Query / SWR)
- **Error and loading states are mandatory**, not optional, for any async UI
- **Accessibility baseline**: semantic HTML, keyboard navigation works, no positive
  `tabindex`, all interactive elements have accessible names

## Infrastructure-as-Code Conventions

These rules apply when editing anything in `infra/` (or the equivalent directory defined
in your Project Context).

### General
- Use the IaC tool defined in Project Context (Terraform / OpenTofu / Pulumi / CDK).
  Do not mix tools within the same repo
- **Module structure**: one module per logical resource group; modules are versioned;
  root configs only compose modules and pass variables
- **No applies from a developer machine against shared environments.** `plan` is fine
  locally; `apply` to dev/staging/prod runs only via CI with the locked state backend
- **`plan` output goes in the PR.** Paste the resource summary into the PR description
- **Provider and module versions pinned**: `~>` for minor on providers, exact pin for
  modules from registries

### Variables & outputs
- Every variable is typed, has a `description`, and has `validation` blocks where the
  domain is constrained
- No untyped variables (`variable "x" {}`)
- Outputs expose only what downstream modules actually need
- **Outputs never contain secrets** — reference the secrets manager ID instead

### Resources
- Prefer `for_each` over `count` — `count`-indexed resources are destroyed and recreated
  when the list order changes
- Avoid using `count`/`for_each` keys derived from values that may change at runtime
- Every resource carries the standard tags from Project Context
- Stateful resources (databases, volumes, persistent disks) have `prevent_destroy` lifecycle
  rules unless intentionally ephemeral

### Secrets & identity
- Secrets are never written to `.tf`, `.tfvars`, plan output, or state outputs
- Secrets are referenced by ARN/ID from the secrets manager and resolved at runtime
- IAM policies start from deny; resource-level scoping is required
- No `*` action on `*` resource — ever

### Tests
- Use the IaC test framework defined in Project Context (Terratest / `terraform test` /
  Pulumi unit tests) for any non-trivial module
- Same TDD discipline applies: write the assertion first

## Observability

- **Structured logging only** — no `console.log` in production paths. Use the logger
  defined in Project Context
- Logger is injected, with request/correlation ID propagated through async context
- Log levels: `error` (actionable), `warn` (degraded), `info` (state change), `debug`
  (diagnostic)
- Log at boundaries: request in, request out, external call in, external call out
- **Never log secrets, tokens, full Authorization headers, or PII**
- Errors are thrown/caught with enough context to diagnose without a debugger — include
  the operation, the relevant identifiers (not values), and the upstream error

## Testing Requirements

### Backend (using the framework defined in your Project Context)
- Unit tests for all service methods
- Mock external API clients and ORM repositories
- Do not test controllers directly — test services
- Integration tests for critical API endpoints using a mock or in-memory DB

### Frontend (using the framework defined in your Project Context)
- Unit tests for all significant components
- Unit tests for state stores in isolation
- No test should hit a real network

### Infrastructure
- Non-trivial modules have tests
- All PRs touching infra include `plan` output

### Coverage
- Coverage is a *consequence*, not a target. Don't write tests to hit a number.
- But: any service method without a test is a defect. Any non-trivial infra module
  without a test is a defect.

## MCP Tools

### context7 — Live Documentation
Use context7 to retrieve up-to-date documentation whenever you are:

- Implementing against a framework or library API (NestJS, Next.js, TypeORM, Tailwind, etc.)
- Writing IaC that references a provider resource or data source (AWS, GCP, Azure)
- Unsure of the correct method signature, config option, or decorator for the version in use

Add `use context7` to your lookups before writing implementation code that depends on
external API contracts. Do not guess at API shapes from training data — always verify
against live docs, especially for framework features that change across minor versions.

### github — Branch & PR Operations
Use the GitHub MCP server to:

- Create and push branches when starting a new feature (`feature/NNNN-short-title`)
- Open pull requests targeting the project's default branch
- Check CI status on a branch before considering implementation complete
- Read existing PRs to understand what is already in flight before starting work

### filesystem — Source File Operations
Use the Filesystem MCP server for direct file reads and writes when the standard editor
tools are insufficient — for example:

- Reading a large set of related files (migrations, IaC modules) to understand a pattern
  before writing new code
- Verifying generated output (compiled JS, plan files, test snapshots) that is not part
  of the active editor session

### semgrep — Static Analysis
Use the Semgrep MCP server to run static analysis scans before marking implementation
complete. This catches common security and quality issues early — before the reviewer and
infosec steps:

- Run a scan on any new service or controller file before committing
- Pay particular attention to injection risks, secrets in code, and missing validation
- Address any High or Critical findings before handoff to the reviewer skill

---

## New Dependencies & Supply Chain

Always call out any new package, Terraform module, or provider being added. State:

1. What it does
2. Why the existing stack cannot satisfy the need
3. Whether it is `dependency` / `devDependency` (npm) or pinned version (Terraform)
4. License (must be MIT / Apache-2.0 / BSD / ISC unless explicitly justified)
5. Maintenance status (last release within 12 months; >1M weekly downloads for npm,
   or clearly justified niche)

Run the project's audit command (`npm audit --omit=dev` / `pnpm audit` /
`tofu providers lock`) before adding.

The lockfile is committed and authoritative. Lockfile changes that don't correspond to
an intentional dependency change are a red flag (possible supply-chain compromise).

Never silently add packages, modules, or providers.
