---
name: decision-log
description: Captures and maintains architectural and technical decisions in docs/decisions/ using the ADR format. Keeps the decision index up to date. Triggered whenever a technology is chosen, a pattern is adopted, a trade-off is made, or a proposal is accepted.
compatibility: opencode
---

# Decision Log Skill

You capture, format, and maintain architectural and technical decisions made during
development. You write in the ADR (Architecture Decision Record) format and keep a running
log in `docs/decisions/` so the team has a traceable history of why the system is built the
way it is.

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

## When to Log a Decision

Log a decision whenever any of the following occur:
- A technology, library, or framework is chosen or rejected
- An architectural pattern is adopted or explicitly avoided
- A domain-specific calculation approach is finalised
- A trade-off is made between simplicity and flexibility
- An external API limitation forces a workaround
- A configuration approach is chosen (per-entity rules vs global defaults)
- An edge case resolution is agreed
- A security or auth approach is confirmed
- A proposal in `docs/proposals/` is accepted

## ADR File Naming Convention

```
docs/decisions/NNNN-short-kebab-case-title.md
```

Example: `docs/decisions/0001-cache-external-data-in-postgres.md`

Increment NNNN sequentially from the highest existing number. Start at 0001.

## ADR Format

```markdown
# NNNN — Decision Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by [NNNN]
**Deciders:** [list of people or agents involved]
**Proposal:** link to docs/proposals/ file if this decision originated from a proposal

## Context

What is the problem or situation that requires a decision? Include any relevant
constraints — technical, operational, or business. Keep this to 3–5 sentences.

## Options Considered

### Option A — [Name]
- **Summary:** One sentence description
- **Pros:** bullet list
- **Cons:** bullet list

### Option B — [Name]
- **Summary:** One sentence description
- **Pros:** bullet list
- **Cons:** bullet list

*(Add further options as needed)*

## Decision

State the chosen option in one sentence. Example:
> We will cache external API data in Postgres rather than querying live per request.

## Rationale

2–4 sentences explaining why this option was chosen over the alternatives.
Reference specific constraints from the Context section.

## Consequences

- **Positive:** what this decision enables or simplifies
- **Negative / trade-offs:** what this decision costs or constrains
- **Risks:** anything that could cause this decision to be revisited

## Related Decisions

- Links to other ADRs that are affected by or influenced this decision
```

## Your Workflow

When asked to log a decision:
1. List `docs/decisions/` to identify the next available NNNN
2. Create the file at `docs/decisions/NNNN-title.md` using the format above
3. Set Status to `Accepted` unless explicitly told otherwise
4. Add a one-line entry to `docs/decisions/README.md` in the decision index table

## Decision Index Format (docs/decisions/README.md)

```markdown
# Decision Log

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-cache-external-data-in-postgres.md) | Cache external data in Postgres | Accepted | YYYY-MM-DD |
```

## MCP Tools

### filesystem — ADR File Operations
Use the Filesystem MCP server to:

- List `docs/decisions/` to find the highest existing NNNN before creating a new ADR
- Read existing ADRs to check for related decisions to link
- Write new ADR files directly to `docs/decisions/NNNN-title.md`
- Update the decision index at `docs/decisions/README.md`
- Read `docs/proposals/` to locate the originating proposal when logging an accepted decision

---

## When Reviewing Code

Flag any implementation that contradicts an existing ADR. Reference the ADR number in your
comment. Example:

> "This hardcodes the database host as `localhost` — ADR-0002 specifies all external
> connection details must come from `ConfigService`. Please load from config."
