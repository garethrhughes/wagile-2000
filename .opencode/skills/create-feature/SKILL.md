---
name: create-feature
description: The full feature development cycle as a numbered checklist — from proposal through implementation, review, infosec sign-off, decision logging, and PR. Defines when each agent handoff happens, the dedicated path for infrastructure changes, and how to handle iteration loops.
compatibility: opencode
---

# Create Feature Skill

This skill describes the complete feature development cycle used in this project. Follow
these steps in order for any non-trivial piece of work. Each step maps to a specific skill.

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

## The Full Feature Development Cycle

### Step 1 — Design (Architect skill)

**When:** Before writing any code for a non-trivial change.

Use the **architect** skill to:
1. Determine whether the change warrants a proposal (see the architect skill's "When to Write
   a Proposal" section — note this includes infra-only changes such as new IAM policies,
   network changes, new resources)
2. If yes: write a proposal in `docs/proposals/NNNN-short-title.md`, including the
   **Infrastructure Addendum** if any infra is touched
3. Get the proposal reviewed (share with the team / another agent) and update status to
   `Accepted`
4. Create any ADR(s) that the proposal produces in `docs/decisions/`

**Skip this step only for:** trivial bug fixes, copy changes, or configuration tweaks that
do not affect architecture, module boundaries, schema, infra, or security posture.

**Handoff to Step 2 when:** the proposal status is `Accepted` (or the change is confirmed
as trivial).

---

### Step 2 — Implementation (Developer skill)

**When:** Proposal is accepted (or change is confirmed trivial).

Use the **developer** skill to:
1. Create a new branch: `git checkout -b feature/NNNN-short-title` *(adjust the branch
   naming convention to match your project's standard, or use the convention defined in
   your CLAUDE.md)*
2. Follow the red-green-refactor TDD cycle for every unit of behaviour:
   - Write a failing test first
   - Write the minimum code to make it pass
   - Refactor while keeping tests green
3. Follow all project conventions (thin controllers, typed API client, ConfigService,
   no `any`, no implicit returns, structured logging, validated DTOs)
4. **For infra changes:** edit IaC under `infra/`, run `terraform plan` (or equivalent)
   locally, capture the plan summary for the PR description. Never apply to a shared
   environment from a developer machine
5. Call out any new dependencies (npm packages, Terraform modules, providers) explicitly
   before adding them
6. Run the full test suite before considering the implementation complete

**Handoff to Step 3 when:** all tests pass and the branch is ready for review.

---

### Step 3 — Code Review (Reviewer skill)

**When:** Implementation is complete and tests are green.

Use the **reviewer** skill to:
1. Trace each Acceptance Criterion from the proposal to a covering test
2. Review all staged / branch changes for correctness, security, performance, IaC safety,
   observability, and convention adherence
3. Return a verdict: PASS / PASS WITH COMMENTS / BLOCK

**If BLOCK or Major findings:**
- Return to **Step 2** (developer) to address all Blocker and Major findings
- Re-run the reviewer skill after fixes
- Repeat until the verdict is PASS or PASS WITH COMMENTS

**If PASS or PASS WITH COMMENTS:**
- Acknowledge Minor/Suggestion items (fix or consciously defer)
- Proceed to Step 4

**Handoff to Step 4 when:** reviewer verdict is PASS or PASS WITH COMMENTS with all
Blockers and Majors resolved.

---

### Step 4 — Infosec Sign-Off (Infosec skill)

**When:** Code review has passed AND the change touches any of:

- Authentication, authorisation, or session handling
- User data (read, write, export, deletion)
- Cryptography (encryption, hashing, key management, secrets)
- Logging or audit trails (added, removed, or modified)
- Infrastructure (IAM, network, secrets manager, KMS, public endpoints)
- A new external integration
- A new dependency that handles credentials, crypto, or PII

For pure UI / pure refactor / pure docs changes with none of the above, **skip this step**.

Use the **infosec** skill to:
1. Run the project's compliance review against the diff (e.g. ISO27001 controls if applicable)
2. Verify no plaintext secrets, no over-broad IAM, no PII in logs, no missing auth guards,
   no insecure crypto choices
3. Return a verdict: APPROVED / REQUIRES CHANGES / APPROVED WITH EXCEPTION

**If REQUIRES CHANGES:**
- Return to **Step 2** to fix
- Re-run infosec after fixes
- Document any APPROVED WITH EXCEPTION findings as ADRs in Step 5

**Handoff to Step 5 when:** infosec verdict is APPROVED or APPROVED WITH EXCEPTION
(with exceptions queued for ADR).

---

### Step 5 — Decision Logging (Decision Log skill)

**When:** Implementation is reviewed, infosec-approved, and accepted.

Use the **decision-log** skill to log any significant decisions made during Steps 1–4:
- Technology or library chosen
- Architectural pattern adopted
- Infrastructure topology choice
- Trade-off made between approaches
- Edge case resolution agreed
- Security exception accepted (each one becomes an ADR)
- Proposal accepted (if not already logged in Step 1)

Update any proposals in `docs/proposals/` whose status is still `Draft` or `Under Review`
to `Accepted`, linking the ADR numbers.

**Handoff to Step 6 when:** all relevant ADRs are written and the index is updated.

---

### Step 6 — Pull Request

**When:** Steps 1–5 are complete.

1. Push the branch to remote: `git push -u origin feature/NNNN-short-title`
2. Open a PR targeting `main` (or the project's default branch)
3. In the PR description, include:
   - A summary of what changed and why
   - Link to the accepted proposal (if one exists)
   - Link to any new ADRs created
   - Test coverage summary (new tests added, all passing)
   - For infra changes: the `terraform plan` (or equivalent) summary
   - Infosec verdict (APPROVED / APPROVED WITH EXCEPTION + ADR link)
4. Ensure CI passes (including infra `plan` and any IaC tests)

---

## MCP Tools Available Across the Cycle

The following MCP servers are available to the skills invoked during this workflow. This
section summarises where each is most relevant:

| MCP Server | Most relevant steps | Primary use |
|---|---|---|
| **context7** | Step 1, Step 2 | Look up live framework/provider docs before designing or coding |
| **github** | Step 2, Step 3, Step 6 | Branch/PR operations, CI status checks, diff access for review |
| **filesystem** | Step 1, Step 2, Step 5 | Read/write proposals, ADRs, and source files |
| **semgrep** | Step 2, Step 3, Step 4 | Static analysis — run before handoff at each gate |

Each skill in the cycle is responsible for using these tools appropriately — the guidance
above is a cross-step reference to avoid duplication. See each individual skill for
step-specific instructions.

---

## Iteration Reference

| Situation | Action |
|---|---|
| Reviewer returns BLOCK | Fix all Blockers → re-review (Step 3 → Step 2 → Step 3) |
| Infosec returns REQUIRES CHANGES | Fix → re-run infosec (Step 4 → Step 2 → Step 4) |
| Implementation reveals design flaw | Write a new proposal or amend the existing one (Step 1) before proceeding |
| New dependency needed | Call it out explicitly in Step 2; reviewer checks supply-chain in Step 3; infosec checks crypto/secrets handling in Step 4 |
| Infra-only change | Same flow — proposal must include Infrastructure Addendum; PR must include `plan` output |
| Trivial fix (no design impact, no infra, no security) | Start at Step 2; skip Steps 1 and 4 |
| Bug fix | Write regression test first (TDD red step), then fix (green), then review |
| Security exception accepted | Must be documented as an ADR in Step 5; reference it in the PR |

## Quick Reference

```
Step 1 → architect skill     (propose; include Infra Addendum if relevant)
Step 2 → developer skill     (implement with TDD; capture plan output for infra)
Step 3 → reviewer skill      (code review; loop back to Step 2 if blocked)
Step 4 → infosec skill       (security/compliance sign-off; conditional — see Step 4)
Step 5 → decision-log skill  (log ADRs, update proposal statuses, log any exceptions)
Step 6 → open PR             (include proposal link, ADRs, plan output, infosec verdict)
```
