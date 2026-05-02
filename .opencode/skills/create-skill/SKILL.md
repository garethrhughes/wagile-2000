---
name: create-skill
description: Interactively creates or updates OpenCode skills. Asks structured questions about the skill's purpose, responsibilities, workflow, and MCP tool usage, then produces a correctly formatted SKILL.md and registers it in the skills README.
compatibility: opencode
---

# Create Skill

You create and update OpenCode skills. You know the full SKILL.md format, conventions,
and structure of this skills repository. You guide the user through a structured interview
to gather everything needed, then produce a complete, ready-to-use SKILL.md.

---

## Mode Selection

Before asking any questions, determine which mode applies:

- **Create** — the user wants a brand new skill that does not yet exist
- **Update** — the user wants to modify, extend, or rename an existing skill

Ask explicitly if it is not clear from the user's request.

---

## Interview — Create Mode

Ask the following questions. You may ask them in one batch or grouped by theme — do not
drip-feed one question at a time. Wait for answers before generating.

### 1. Identity
- What should the skill be named? (lowercase, hyphen-separated, e.g. `code-review`)
- Write a one-sentence `description` field for the skill frontmatter. What does it do,
  and when should an agent invoke it?

### 2. Purpose & Responsibilities
- What is this skill's primary job? What does it produce or enable?
- What is explicitly **out of scope** — what should it never do?
- Is the skill **read-only** (audit/review style) or does it write/edit files?

### 3. Workflow
- Does this skill follow a step-by-step workflow the agent should execute in order,
  or is it a reference skill (a set of rules/conventions the agent follows while working)?
- If it has a workflow: describe each step, what triggers each step, and what the
  handoff condition is to the next step.
- Are there iteration loops — conditions that send the agent back to an earlier step?

### 4. Output
- What does the skill produce? (files written, verdicts returned, reports generated, etc.)
- Is there a specific output format the skill must follow?

### 5. MCP Tools
- Which of the available MCP servers should this skill use?
  (context7, github, filesystem, semgrep — or none)
- For each: in what specific situations should it be used within this skill?

### 6. Project Context
- Does this skill need a `## Project Context` placeholder that the user fills in per
  project? (Most skills do — only omit for skills that operate on the skills repo itself.)

### 7. Conventions & Rules
- Are there specific rules, constraints, or principles the agent must follow while
  executing this skill? (e.g. "never edit code", "always write a test before implementation",
  "all decisions must be recorded as ADRs")

---

## Interview — Update Mode

Ask:
1. Which skill is being updated? List the available skills if the user is unsure.
2. What specifically should change? (add a section, modify behaviour, add MCP tools,
   rename, restructure workflow, etc.)
3. Read the existing SKILL.md using the filesystem MCP server (or Read tool) before
   proposing any edits — understand the current content fully first.
4. Confirm the intended change with the user before writing.

---

## Generating the SKILL.md

Once you have all the answers, generate the complete file. Do not generate a partial
skeleton and ask the user to fill it in — produce the final, ready-to-use content.

### File Location

```
<skills-root>/<skill-name>/SKILL.md
```

Where `<skills-root>` is the directory containing all skill folders (e.g.
`~/.config/opencode/skills/` for a global install, or `.opencode/skills/` for a
project-local install). If in doubt, read the existing skills to infer the root.

### Required Frontmatter

```yaml
---
name: <skill-name>
description: <one-sentence description — this appears in the skill picker>
compatibility: opencode
---
```

### Required Top-Level Sections

Every skill must have these sections in this order:

1. `# <Skill Name> Skill` — H1 heading with a 2–4 sentence summary of what the agent is
   and what it does
2. `## Project Context` — placeholder block (omit only for skills that operate on the
   skills repo itself, such as `update-skills` and `create-skill`)
3. The skill's substantive content (responsibilities, workflow, rules, output format, etc.)
4. `## MCP Tools` — only if the skill uses one or more MCP servers (see format below)

### `## Project Context` Placeholder Format

```markdown
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

### `## MCP Tools` Section Format

Include one sub-section per MCP server used. Each sub-section must specify:
- **When** to use this tool (specific trigger conditions, not generic advice)
- **What** to do with it (concrete actions, not vague capabilities)

```markdown
## MCP Tools

### context7 — Live Documentation
Use context7 when…

- [specific situation 1]
- [specific situation 2]

### github — [purpose in this skill]
Use the GitHub MCP server to…

### filesystem — [purpose in this skill]
Use the Filesystem MCP server to…

### semgrep — [purpose in this skill]
Use the Semgrep MCP server to…
```

Only include servers that this skill actually uses.

---

### Workflow Step Format

If the skill has a sequential workflow, use this format for each step:

```markdown
### Step N — [Step Name] ([skill or tool used])

**When:** [trigger condition]

[Agent instructions for this step]

**Handoff to Step N+1 when:** [condition]
```

---

### Output Format Section

If the skill returns a structured verdict or report, specify the exact format using a
fenced code block. For example:

```markdown
## Output Format

\```
## Verdict: PASS | PASS WITH COMMENTS | BLOCK

**[Severity]** `path/to/file.ts` (line N)
**Issue:** …
**Fix:** …
\```
```

---

## Updating the README

Which README you update depends on where the skill lives:

- **Skills repo** (the skills root *is* the git repo root — e.g. working directly in
  this `skills` repository): update `README.md` at the skills root. This is the
  README that catalogues every skill.
- **Project repo** (the skills root is nested inside a larger project — e.g.
  `.opencode/skills/` or `.claude/skills/` inside some project): update the
  **project's root `README.md`**, not any README inside the skills folder. Leave
  the skills folder's own README (if any) alone.

To tell which case you're in: if the parent of the skills root contains a `.git`
directory and isn't the skills root itself, you're in a project repo.

In either case, the update is the same:

1. Add a new row to the `## Skills` table (create the table under a `## Skills`
   heading if it does not already exist):
   ```
   | [<skill-name>](<path-to-skill>/SKILL.md) | <one-line description> |
   ```
   Use a path relative to the README being edited.
2. If the skill has a non-obvious usage pattern, add a named subsection under
   `## Usage` following the same style as the existing entries.

For updates to existing skills: check whether the description row in the relevant
README needs to be updated to reflect the change.

---

## Rules

- Never generate a partial SKILL.md and ask the user to complete it. Produce the full file.
- Never omit the `## Project Context` section unless the skill explicitly operates on the
  skills repo itself.
- Never add sections the user did not ask for without noting what was added and why.
- The `description` frontmatter field is what appears in the skill picker — keep it to
  one sentence, active voice, focused on when to use it.
- Read-only skills must say so explicitly in the H1 summary section (e.g. "This skill is
  **read-only**").
- Do not invent MCP tool usage. Only include servers the user confirmed this skill needs.
