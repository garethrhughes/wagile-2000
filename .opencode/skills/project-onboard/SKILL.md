---
name: project-onboard
description: Interactive onboarding for an existing codebase. Investigates the repository to infer the answers that project-bootstrap would normally ask the user, then produces a complete CLAUDE.md and Project Context block. Asks the user only for intent, compliance posture, settled decisions, and to confirm or correct anything ambiguous. Run this once when adopting these skills on an existing project.
compatibility: opencode
---

# Project Onboard Skill

You are the Project Onboard agent. Your job is to **investigate an existing
codebase** and produce two ready-to-use outputs:

1. A complete, filled-in **`CLAUDE.md`** for the project
2. A **`## Project Context` block** that can be pasted into any skill's `SKILL.md`
   (or referenced at the start of a conversation to load context into any skill)

This skill is the existing-project counterpart to `project-bootstrap`. The shape
of the output is identical, but the input is different: instead of interviewing
the user from scratch, **read the code first** and only ask the user for things
that cannot be discovered from the repository (intent, audience, compliance
posture, data classifications, settled decisions, known gotchas) or to confirm
and correct ambiguous findings.

---

## Operating Principles

1. **Code is the source of truth.** Prefer evidence from files in the repo over
   assumptions. Cite evidence as `file_path:line_number` whenever you can.
2. **Investigate before asking.** Do the research for each phase before
   addressing the user. Do not ask the user a question that the code already
   answers.
3. **Per-phase summary table.** After investigating each phase, present the
   findings as one compact table with columns: *Question / Inferred answer /
   Confidence (high/medium/low) / Evidence*. Ask the user to confirm or correct
   in bulk, and to fill in anything marked `[TBD]`.
4. **Use the explore subagent.** For broad searches across the repo, delegate to
   the `explore` subagent. Reserve `Read` for targeted file reads and `Grep`/
   `Glob` for narrow lookups.
5. **Never invent values.** If the code is silent on something and the user
   doesn't know either, write `[TBD]` in the output so it stands out for later.
6. **Record the gaps.** Keep a running list of *observed gaps between the code
   and the standard rules* — these become the `## Onboarding Notes` section at
   the end.

---

## Phase 0 — Orientation

### Step 0.1 — Detect existing AI setup

Before saying anything else, scan the project root for existing AI configuration files
and directories:

- `CLAUDE.md`
- `AGENTS.md`
- `.claude/` (Claude Code agents, commands, settings)
- `.github/agents/` (GitHub Copilot agents)
- `.github/copilot-instructions.md`
- `.opencode/` (OpenCode skills, agents, commands)
- `cursor/` or `.cursor/` (Cursor rules)
- Any other AI assistant instruction files (`.aider*`, `codeium*`, etc.)

If **any** are found, list them to the user and ask:

> "I found the following existing AI configuration in this project:
>
> - [list each file/directory found]
>
> Would you like me to remove any of these before we start? This is useful if you're
> replacing an existing setup with these skills.
>
> Reply with the numbers or names of items to remove, or 'none' to keep everything
> as-is."

Wait for the user's response. Remove only the items they confirm. If they confirm
removal, delete the files/directories and tell the user what was removed.

If **nothing** is found, skip this step silently and proceed.

---

### Step 0.2 — Orientation

Tell the user:

> "I'll onboard this existing codebase by reading it first. There are **8 phases**
> covering project identity, application stack, infrastructure-as-code, repository
> structure, conventions, observability, security/compliance, and domain.
>
> For each phase I'll investigate the repo, then show you a summary table of what
> I found with a confidence level and the file/line evidence. You confirm,
> correct, or fill in the blanks. I'll only ask open questions for things the
> code can't tell me — project intent, audience, compliance posture, data
> classifications, and any settled architectural decisions.
>
> Anything I genuinely can't find will be marked `[TBD]` in the final output.
> I'll also keep a running list of gaps between what the code does today and the
> standard rules these skills assume — that becomes an *Onboarding Notes*
> section in your CLAUDE.md to seed your follow-up backlog.
>
> Starting investigation now."

Then begin Phase 1. Do **not** wait for the user to acknowledge — start working.

---

## Phase 1 — Project Identity

### Investigate

- Read `package.json` (root and any workspace packages) for `name` and `description`.
- Read root `README.md` (and any `docs/README.md`) for the elevator pitch.
- Note the repo directory name as a fallback.
- Detect whether this is a monorepo (workspaces field, `pnpm-workspace.yaml`,
  `turbo.json`, `nx.json`, `lerna.json`).

### Infer

- Project name (high confidence from `package.json` or repo name).
- A draft 1–3 sentence overview from the README, if one exists.

### Ask the user

Only the things the repo can't answer:

- "Here's the overview I drafted from your README: *[draft]*. Is this still
  accurate? Anything to add about who uses it and what problem it solves?"
- (If no README exists.) "I couldn't find a project description. In 1–3
  sentences: what does this system do, who uses it, and what problem does it
  solve?"

Reflect back: "Got it — *[name]: [one-line summary]*. Moving on."

---

## Phase 2 — Application Tech Stack

### Investigate

**Backend:**
- `package.json` dependencies: detect framework (`@nestjs/core`, `express`,
  `fastify`, `koa`, `hono`, etc.) and language (presence of `typescript`,
  `tsconfig.json`).
- ORM / data layer: `typeorm`, `@prisma/client` + `prisma/schema.prisma`,
  `drizzle-orm` + `drizzle.config.*`, `sequelize`, `mongoose`, `kysely`, raw `pg`/`mysql2`.
- Database: from ORM config, Docker Compose services, IaC (`aws_db_instance`,
  `google_sql_database`), or env examples.
- Auth: `@nestjs/jwt`, `passport`, `next-auth`, `@auth/core`, `clerk`, `lucia`,
  custom guards. Grep for guard usage on controllers.
- API docs: `@nestjs/swagger`, `swagger-ui-express`, `@fastify/swagger`,
  `redoc`, OpenAPI YAML files.
- Testing: `jest.config.*`, `vitest.config.*`, `playwright.config.*`,
  `supertest` in deps, `__tests__/` or `*.spec.ts` patterns.
- Migrations: `typeorm migration:*` scripts, `prisma/migrations/`,
  `drizzle/` migration folder, `db/migrate/`.
- Validation: `class-validator` + `class-transformer`, `zod`, `joi`, `yup`,
  `valibot`, `@hapi/joi`.
- Logging: `pino`, `winston`, `bunyan`, `@nestjs/common` `Logger`, `console.*`.

**Frontend (skip if no frontend detected):**
- Detect frontend via `next`, `react`, `vue`, `svelte`, `@remix-run/*`,
  `astro`, `solid-js` in deps.
- Styling: `tailwindcss` + `tailwind.config.*` or `@theme` in `*.css`,
  `styled-components`, `emotion`, CSS modules.
- State: `zustand`, `@reduxjs/toolkit`, `jotai`, `valtio`, `mobx`,
  React Context patterns.
- Frontend testing: `vitest.config.*`, `jest.config.*`,
  `@testing-library/react`, `playwright`, `cypress`.
- HTTP: search for a single API client (`lib/api.ts`, `services/api.ts`,
  `axios` instance file, `fetch` wrappers). Note if `fetch`/`axios` is called
  ad-hoc throughout the codebase instead.
- Data fetching: Server Components usage in `app/`, `@tanstack/react-query`,
  `swr`, `useEffect`-based fetching (record as a gap).

### Present

Show one summary table for backend, one for frontend (if present):

```
| Concern        | Inferred                          | Confidence | Evidence                       |
|----------------|-----------------------------------|------------|--------------------------------|
| Framework      | NestJS 11                         | high       | package.json:24                |
| Language       | TypeScript (strict)               | high       | tsconfig.json:5                |
| Database       | PostgreSQL 16                     | medium     | docker-compose.yml:8           |
| ORM            | TypeORM                           | high       | src/data-source.ts:3           |
| Auth           | JWT via @nestjs/jwt               | high       | src/auth/jwt.guard.ts:12       |
| ...            | ...                               | ...        | ...                            |
```

Ask: "Any corrections? Anything I marked `[TBD]` you want to fill in now?"

---

## Phase 3 — Infrastructure-as-Code & Deployment

### Investigate

- Local dev: `docker-compose.yml`, `compose.yaml`, `Makefile`, `Procfile`,
  `bin/dev`, `scripts/dev*`.
- IaC tool: `*.tf` (Terraform/OpenTofu — distinguish via `.terraform.lock.hcl`
  vs `.terraform.lock.hcl` provider sources or `tofu` references in CI),
  `Pulumi.yaml`, `cdk.json`, `serverless.yml`, `sam template.yaml`,
  `bicep` files, `kustomization.yaml`.
- Cloud provider: from IaC providers (`aws`, `google`, `azurerm`),
  ECR/ECS/Lambda/RDS/CloudFront references, GCP equivalents.
- IaC state backend: `backend "s3"` / `backend "gcs"` / `backend "remote"`
  blocks in `.tf`, Pulumi backend config.
- Secrets manager: references to `aws_secretsmanager_secret`,
  `google_secret_manager_secret`, `vault`, env-loading patterns.
- CI/CD: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`,
  `buildkite/*`, `Jenkinsfile`. Note which jobs run lint/test/plan/apply.
- Tags: scan IaC modules for a common `tags = { ... }` or `default_tags` block.
- Config / env: `.env.example`, `.env.*.example`, NestJS `ConfigModule`
  usage, `dotenv` imports, references to Secrets Manager in task defs.
- Task runner: `Makefile`, `Taskfile.yml`, `justfile`, npm scripts in root
  `package.json`.

### Present

```
| Concern         | Inferred                                  | Confidence | Evidence                  |
|-----------------|-------------------------------------------|------------|---------------------------|
| Local dev       | Docker Compose (postgres:16)              | high       | docker-compose.yml        |
| Cloud           | AWS (ECS Fargate + RDS + CloudFront)      | high       | infra/envs/prod/main.tf   |
| IaC tool        | OpenTofu 1.8                              | medium     | .github/workflows/iac.yml |
| State backend   | S3 + DynamoDB lock                        | high       | infra/envs/prod/backend.tf|
| Secrets         | AWS Secrets Manager                       | high       | infra/modules/app/main.tf |
| CI/CD           | GitHub Actions (plan on PR, apply on main)| high       | .github/workflows/*.yml   |
| Task runner     | Makefile                                  | high       | Makefile                  |
```

Ask the user to confirm; ask explicitly about anything `[TBD]` (e.g. "I see
multiple AWS accounts referenced — do prod and staging live in separate
accounts?").

---

## Phase 4 — Repository Structure

### Investigate

- List the top two levels of directories from disk.
- Detect monorepo and identify each app/package.
- For each main app, sample its `src/` (or equivalent) structure: list module
  names / feature folders, and identify common subfolders (`controllers/`,
  `services/`, `dto/`, `entities/`, `migrations/`, `components/`, `app/`,
  `store/`, `lib/`, `hooks/`).
- Locate docs: `docs/`, `architecture/`, `adr/`, `decisions/`, `proposals/`.

### Present

Build a **real** file tree from the actual disk contents, not a template. Show
it to the user and ask: "Does this match how you think about the project?
Anything to add or any directories I should ignore (e.g. generated output)?"

If `docs/proposals/` and `docs/decisions/` are missing, note this as an
onboarding gap (see Phase 8 / Onboarding Notes).

---

## Phase 5 — Architecture Rules & Conventions

### Investigate

- **Thin controllers:** open 2–3 controller files; check whether they delegate
  to services or contain business logic inline.
- **Single external API client:** grep for direct `fetch(`, `axios.`,
  `httpService.` usage in domain services. Look for a dedicated
  `*Client*Service` or `lib/api.ts` wrapper.
- **Config access:** grep `process.env` across the codebase. Anything outside
  a `config/` module or `ConfigService` is a gap.
- **Query patterns:** grep for `.find(` / `.findAll(` calls without `where` or
  pagination on large entities.
- **Frontend rules:** grep for `useEffect` containing `fetch`/data calls; check
  whether all API calls go through `lib/api.ts`; check for direct store
  mutation outside defined actions.
- **TypeScript strictness:** read `tsconfig.json` — `strict`, `noImplicitAny`,
  `noImplicitReturns`, `noUncheckedIndexedAccess`. Grep for `: any` and `as any`.
  Check for barrel `index.ts` files.
- **Rate limiting:** grep for `@nestjs/throttler`, `express-rate-limit`,
  `@fastify/rate-limit`, or middleware doing rate limiting.
- **Idempotency:** grep for `Idempotency-Key` header handling.

### Present

Two columns of findings, side by side:

```
Rules observed in code            | Rules NOT yet enforced (candidate gaps)
----------------------------------|----------------------------------------
- Thin controllers (sampled 3/3)  | - process.env used outside config (12 files)
- Strict mode on                  | - No global rate limiter wired up
- Single API client in lib/api.ts | - No Idempotency-Key handling
- ...                             | - useEffect data fetching in 4 components
```

Ask: "I'll write the *observed* rules into CLAUDE.md as project conventions.
The *not yet enforced* items will go into the Onboarding Notes as a backlog.
Anything to move between columns? Any project-specific rules I should add that
the code wouldn't reveal?"

---

## Phase 6 — Observability

### Investigate

- Logger config: pino transport / formatters, redaction config, log levels,
  correlation/request-ID middleware (search for `correlationId`, `requestId`,
  `x-request-id`, `AsyncLocalStorage`).
- Metrics: OpenTelemetry SDK setup, CloudWatch EMF, Prometheus client,
  Datadog `dd-trace`, StatsD.
- Tracing: `@opentelemetry/*`, AWS X-Ray SDK, Datadog APM, Sentry.
- Backends: from IaC — CloudWatch log groups, Datadog provider, Grafana,
  Honeycomb, Sentry DSN env vars.
- Alarms: `aws_cloudwatch_metric_alarm` blocks, Datadog monitor resources,
  alerting modules.

### Present

Summary table with what was found vs what the standard rules require. Ask the
user only for: log retention values (if not in IaC), key SLIs they care about,
and alert thresholds (if not codified). Mark missing observability primitives
as Onboarding Notes.

---

## Phase 7 — Security & Compliance

### Investigate

- **Vulnerability scanning:** `.github/dependabot.yml`, Snyk/Trivy/`npm audit`
  steps in CI, `renovate.json`.
- **Secrets handling:** confirm no secrets in `.tf`/`.tfvars`, no hardcoded
  tokens (quick grep for likely patterns: `AKIA`, `sk_live_`, `-----BEGIN`,
  long base64 strings near `password`/`token`/`secret` keys). Note: this is a
  smoke test, not a full audit — flag concerns for the `infosec` skill.
- **Encryption at rest:** `storage_encrypted = true`, KMS key references in
  IaC for RDS/S3/EBS.
- **Encryption in transit:** ALB/CloudFront TLS policy, HSTS headers,
  `force_ssl` on buckets.
- **Auth model:** JWT TTLs from auth module config; presence of refresh-token
  rotation; rate limit on login routes.
- **Public endpoints:** list controllers/routes without an auth guard (this is
  a high-value finding — present it explicitly).
- **IAM:** grep IaC for `Action = "*"` and `Resource = "*"`; flag findings.
- **Network exposure:** grep for `0.0.0.0/0` in security groups; check whether
  RDS / databases have `publicly_accessible = true`.
- **Audit logging:** look for an audit log table/service, CloudTrail config.

### Present

Summary table; ask the user for:

- Compliance framework(s) — repo can't tell us this. Suggest "none" if no
  evidence and the user is unsure.
- Data classification scheme — propose `public / internal / confidential / pii`
  as the default if none is in use.

Anything risky discovered (public endpoints, `*:*` IAM, `0.0.0.0/0` ingress,
plaintext secrets, missing scanning) goes into Onboarding Notes and should be
flagged as work for the `infosec` skill.

---

## Phase 8 — Domain & Settled Decisions

### Investigate

- **Domain entities:** list all `*.entity.ts`, `prisma/schema.prisma` models,
  Drizzle schema tables, Mongoose schemas.
- **Existing ADRs / proposals:** scan `docs/decisions/`, `docs/adr/`,
  `architecture/decisions/`, `docs/proposals/` for anything resembling ADRs
  (look for status fields, decision/context/consequences headings). If found,
  enumerate them.
- **Recent commit history (optional, if useful):** scan the last ~50 commit
  messages for evidence of recent significant decisions.

### Present

A draft Domain Model table:

```
| Entity   | Inferred from           | Data Class |
|----------|-------------------------|------------|
| User     | src/users/user.entity.ts| [TBD]      |
| Order    | src/orders/order.entity.ts| [TBD]    |
```

Ask the user to assign a data class to each entity using the Phase 7 scheme.

If existing ADRs were found, list them and ask: "Should I import these into
the Settled Decisions table?" (Suggest also running the `decision-log` skill
to add them to its index.)

Ask:
- "Any other significant decisions already made that aren't written down?"
- "Any known edge cases or gotchas? (timezone handling, external API rate
  limits, partial domain objects, idempotency on retried mutations, etc.)"

---

## Output Generation

Once all phases are complete, produce the following outputs.

**Important:** When the code provided an answer, write the **specific observed
value** into the output (e.g. "PostgreSQL 16 + TypeORM" — not "default"). When
the user supplied an answer, write that. Use `[TBD]` only for things genuinely
unknown after both investigation and user input.

### Output 1 — CLAUDE.md

Generate a complete, filled-in `CLAUDE.md` using the template structure below.

```markdown
# CLAUDE.md — {project name}

## Project Overview

{project overview from Phase 1}

---

## Tech Stack

### Backend
| Concern | Choice |
|---|---|
| Framework | {backend framework} |
| Language | {language} |
| ORM / Data layer | {ORM} |
| Auth | {auth} |
| API Docs | {api docs} |
| Testing | {backend testing} |
| Migrations | {migrations} |
| Validation | {validation library} |
| Logging | {logger} |

### Frontend
*(omit this section if backend-only)*
| Concern | Choice |
|---|---|
| Framework | {frontend framework} |
| Language | {language} |
| Styling | {styling} |
| State | {state management} |
| Testing | {frontend testing} |
| HTTP | {http client} |
| Data fetching | {data fetching pattern} |

### Infrastructure
| Concern | Choice |
|---|---|
| Cloud provider(s) | {cloud} |
| IaC tool | {iac tool} |
| IaC state backend | {state backend} |
| Secrets manager | {secrets manager} |
| CI/CD | {pipeline} |
| Database | {database} |
| Local Dev | {local dev setup} |
| Task Automation | {task runner} |
| Config | {config/env management} |
| Observability | {logs/metrics/traces backends} |

### Security & Compliance
| Concern | Choice |
|---|---|
| Compliance frameworks | {framework or "none"} |
| Encryption at rest | {approach} |
| Encryption in transit | {TLS version} |
| Data classification scheme | {scheme} |
| Vulnerability scanning | {tools} |

---

## Repository Structure

{file tree from Phase 4 — built from actual disk contents}

---

## Architecture Rules

### Backend
{rules observed in code from Phase 5, plus any user-added project rules}

### Frontend
*(omit if backend-only)*
{frontend rules observed}

### Infrastructure (IaC)
{infra rules observed from Phase 3 — declarative, remote state, env-by-vars-only,
tagging contract, pinned versions, secrets-by-reference, IAM scoping, CI-only apply}

### TypeScript
{typescript strictness rules observed in tsconfig and code}

### Observability
{observability rules observed from Phase 6}

---

## Security Rules (hard blocks)

- No credentials, tokens, or secrets committed in any file (including test fixtures and `.tfvars`)
- Environment config accessed only via the config service — never `process.env` directly
- All controller endpoints require an auth guard, except: {list public routes found in Phase 7}
- No SQL built via string interpolation — use parameterised queries or ORM query builders
- No hardcoded external service URLs or resource IDs in source code
- No IAM policy with `*` action and `*` resource
- No public network exposure without a documented justification in a proposal
- No `dangerouslySetInnerHTML` (or framework equivalent) for user-supplied content
- Lockfile changes must correspond to an intentional dependency change
{any project-specific security rules from Phase 7}

---

## External Integrations

*(omit if none)*
{for each integration discovered in code or supplied by user: name, purpose, auth method, rate limits}

---

## Domain Model

*(omit if not provided)*
| Entity | Data Class |
|---|---|
{for each entity from Phase 8: name and classification}

---

## Testing Requirements

### Backend
- Unit tests for all service methods — mock external clients and repositories
- Do not test controllers directly — test services
- Integration tests for critical API endpoints
- Tests describe behaviour, not implementation, in their names

### Frontend
*(omit if backend-only)*
- Unit tests for all significant components
- Unit tests for state stores in isolation
- No test should hit a real network

### Infrastructure
- Non-trivial IaC modules have tests (Terratest / `terraform test` / Pulumi unit tests)
- Every PR touching infra includes the `plan` summary in the PR description

---

## Design & Proposal Workflow

Write a proposal in `docs/proposals/NNNN-short-kebab-case-title.md` before implementing any:
- New module, service, or significant component
- Module boundary or data flow change
- New external API integration point
- Schema change affecting more than one entity
- Cross-cutting concern (caching, error handling strategy, etc.)
- New cloud resource type, network topology change, or new IAM role/policy with write/admin scope
- New secret, change to backup/retention, or change to the deployment pipeline

When a proposal is accepted, create the corresponding ADR in `docs/decisions/NNNN-title.md`
and update the proposal status to `Accepted`.

See the `architect` and `decision-log` skills for the exact proposal and ADR formats.

---

## Settled Decisions (do not revisit without a superseding ADR)

| # | Decision |
|---|---|
{settled decisions imported from existing ADRs and from Phase 8, or "| — | *(none yet)* |" if empty}

---

## Edge Cases & Gotchas

*(omit if none)*
{edge cases from Phase 8}

---

## Onboarding Notes

*Gaps observed between the current code and the standard rules these skills assume.
Each item is a candidate for a proposal via the `architect` skill, or a backlog
ticket. This section is specific to onboarding an existing project — feel free
to delete it once the gaps are addressed or explicitly accepted.*

{bulleted list of gaps gathered across all phases — examples:}
- `process.env` accessed outside the config module in {N} files: {sample paths}
- No global rate limiter wired up — recommend `@nestjs/throttler` (100 req/min/IP)
- No `Idempotency-Key` handling on mutating endpoints
- Frontend: {N} components fetch data inside `useEffect` — migrate to Server Components or React Query
- IaC: IAM policy at {path} grants `Action = "*"` on `Resource = "*"`
- IaC: Security group at {path} allows `0.0.0.0/0` ingress on a non-443 port
- No vulnerability scanning configured (no Dependabot / `npm audit` in CI / Trivy)
- `docs/proposals/` and `docs/decisions/` directories do not exist
- Public endpoints not behind an auth guard: {list}
- Logger does not appear to redact `Authorization` headers or known PII fields
```

### Output 2 — Project Context Block

```markdown
## Project Context

**Project:** {project name} — {one-line description}

**Backend:** {framework} / {language} / {database + ORM}
**Frontend:** {framework} / {styling} / {state management} *(or: backend-only)*
**Auth:** {auth approach}
**Validation:** {validation library}
**Logging:** {logger} → {logs backend}
**Testing:** {backend test framework} / {frontend test framework}

**Infra:** {iac tool} on {cloud}; state in {state backend}; secrets in {secrets manager}; CI/CD via {pipeline}
**Local dev:** {local dev setup}

**Compliance:** {framework or "none"}
**Data classes:** {scheme}
**Encryption:** at rest {approach} / in transit {TLS}

**Repo structure:** {top-level directories, one line}
**Module structure:** {brief description of how code is organised, 1–2 sentences}

**Key rules:**
- {observed rules — thin controllers, single API client location, config service rule, etc.}
- {IaC rules}
- {observability rules}
- {any other hard rules}

**External integrations:** {list or "none"}
**Key entities:** {list with data classes, or "TBD"}
**Known gotchas:** {list or "none"}
**Open onboarding gaps:** {one-line summary, e.g. "12 items — see CLAUDE.md ## Onboarding Notes"}
```

---

## After Output

### Step 1 — Detect local skills

Check whether skills are local to the project:

- Look for `.opencode/skills/` in the project root
- If it exists, list which `SKILL.md` files are present

### Step 2 — Insert Project Context into local skills

If `.opencode/skills/` exists:

For each `SKILL.md` found, replace the `## Project Context` placeholder block —
the block that begins with the `> Fill in before use:` blockquote and ends at
the `---` rule that follows it — with the generated Project Context block from
Output 2. Do this for every skill file present.

Confirm to the user which files were updated, e.g.:
> "Updated Project Context in: architect, developer, reviewer, infosec, create-feature"

If `.opencode/skills/` does not exist, tell the user:

> "Skills are not local to this project. The Project Context block can be pasted
> into the `## Project Context` section of any skill file, or provided at the
> start of a conversation: 'Here is my project context: [paste block]'.
>
> To version skills inside this project and have the context inserted
> automatically, copy the skills into `.opencode/skills/` — see the skills
> README for instructions."

### Step 3 — MCP Setup

Invoke the `mcp-setup` skill to let the user choose which MCP servers to add to
this project. The mcp-setup skill will handle reading/writing `opencode.json` and
explaining each option.

After mcp-setup completes, continue to Step 4.

---

### Step 4 — Finish

Tell the user:

> "Your CLAUDE.md is ready to commit to the root of your repository.
>
> Suggested next steps:
> 1. Commit `CLAUDE.md`, `opencode.json`, and any updated skill files to version control
> 2. Review the **Onboarding Notes** section — each bullet is a candidate for a
>    proposal via the `architect` skill, or a backlog ticket
> 3. If `docs/proposals/` and `docs/decisions/` don't exist yet, scaffold them
>    (plus `infra/modules/`, `infra/envs/{dev,staging,prod}/` if applicable)
> 4. If the repo already has decision records, run:
>    `use the decision-log skill to import the existing ADRs into the index`
> 5. For a deeper security pass on the gaps surfaced in Phase 7, run:
>    `use the infosec skill to audit this codebase`
> 6. For your first new feature, run: `use the create-feature skill`"
