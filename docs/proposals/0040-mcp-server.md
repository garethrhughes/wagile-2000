# 0040 — MCP Server for Fragile

**Date:** 2026-04-29
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** _(none yet — to be created on acceptance)_

## Problem Statement

Fragile exposes a rich set of engineering metrics through its REST API, but consuming
that API requires a human to navigate the dashboard UI or manually craft HTTP requests.
AI assistants and agents (Copilot, Claude, Cursor, custom agentic workflows) cannot
discover or invoke these capabilities without bespoke integration code written per-tool.

The Model Context Protocol (MCP) provides a standardised interface — tools, resources,
and prompts — that any MCP-compatible AI client can negotiate with at runtime. Adding an
MCP server to Fragile would allow AI assistants to: answer natural-language questions
about deployment health ("how is BPT doing this quarter?"), inspect board configuration,
and cross-reference sprint accuracy against DORA performance — without any custom
integration per client.

Fragile is already an internal tool whose data is fully cached in Postgres; the MCP layer
adds a read-only surface over that data without changing the underlying calculation logic.
Without this proposal, AI-driven queries against Fragile will remain ad-hoc curl commands
or manual copy-paste, limiting the value of the investment in the metrics engine.

## Proposed Solution

### Overview

Introduce a new npm package, `@fragile.app/mcp`, as a standalone Node.js process
(TypeScript, ESM) that:

1. Embeds the MCP SDK (`@modelcontextprotocol/sdk`) and exposes tools, resources, and
   prompt templates exclusively via the **stdio transport**.
2. Calls into the existing `apps/api` backend exclusively via its **REST API over HTTP**
   — it does not import NestJS services directly or share a database connection.
3. Authenticates to `apps/api` using the same internal API key mechanism used by the
   frontend (passed as static environment variables `API_BASE_URL` and `API_KEY`).
4. Is published to npm under the `@fragile.app` organisation and consumed by MCP clients
   via `npx @fragile.app/mcp`.

This approach keeps the MCP server decoupled from the NestJS module graph. It runs
locally via `npx` with zero installation and requires no changes to the backend codebase.

### Why a separate npm package, not a NestJS module?

The MCP SDK uses its own async I/O event loop and stdio transport abstractions that sit
awkwardly inside NestJS's lifecycle model. Embedding MCP inside `apps/api` would
complicate startup, health checks, and transport configuration. A thin standalone
process that delegates all business logic to `apps/api` via HTTP is simpler to deploy,
easier to test in isolation, and consistent with how the frontend consumes the API.
Publishing to npm means any developer can run it without cloning the repository.

### Package structure

```
apps/mcp/
├── package.json          # name: @fragile.app/mcp, type: module, bin: fragile-mcp
├── tsconfig.json         # extends root, ESM output, strict
├── src/
│   ├── index.ts          # entry point: start stdio server
│   ├── server.ts         # McpServer setup: registers all tools, resources & prompts
│   ├── client.ts         # Typed HTTP wrapper around apps/api REST endpoints
│   ├── tools/
│   │   ├── dora.ts       # get_dora_metrics, get_dora_trend, get_snapshot_status
│   │   ├── planning.ts   # get_planning_accuracy, list_sprints, list_quarters
│   │   ├── cycle-time.ts # get_cycle_time, get_cycle_time_trend
│   │   ├── roadmap.ts    # get_roadmap_accuracy
│   │   ├── boards.ts     # list_boards, get_board_config
│   │   ├── sync.ts       # get_sync_status
│   │   ├── sprint.ts     # get_sprint_detail, get_sprint_report
│   │   └── gaps.ts       # get_hygiene_gaps, get_unplanned_done
│   ├── resources/
│   │   └── boards.ts     # boards:// resource listing board metadata
│   └── prompts/
│       └── index.ts      # all MCP prompt templates
└── test/
    ├── tools/dora.test.ts
    └── client.mock.ts    # mock client for unit tests
```

### Transport

The MCP server uses **stdio only**. It is spawned as a subprocess by the MCP client
(Claude Desktop, Cursor, Copilot agent mode, or any other MCP-compatible host). There is
no HTTP/SSE listener. This is the correct transport for a locally-installed developer
tool and is consistent with how the majority of published MCP servers operate.

### Data flow

```
AI Client (Claude Desktop / Copilot / Cursor / etc.)
  │  MCP tool call (JSON-RPC over stdio)
  ▼
@fragile.app/mcp  (MCP server subprocess, spawned by client)
  │  HTTP GET with Authorization: Bearer <API_KEY>
  ▼
apps/api  (NestJS REST API, port 3001)
  │  TypeORM queries (Postgres-backed, data already cached)
  ▼
PostgreSQL 16
```

No Jira API calls are made from the MCP server. All data is served from the Postgres
cache maintained by the existing sync infrastructure.

### Authentication

`apps/api` has no application-level authentication (ADR-0020). The MCP server therefore
needs no API key forwarding in the current deployment. However, a `API_KEY` env var is
wired through `client.ts` as an `Authorization` header so that if API key auth is
re-introduced (see Proposal 0009) the MCP server requires only a config change, not a
code change.

`apps/mcp` itself does not add a second authentication layer. Access control is enforced
at the network boundary (the same WAF/CloudFront IP allowlist that protects `apps/api`).
For stdio transport, the security boundary is the local machine on which the MCP server
runs — identical to how CLI tools like `gh` work.

---

## npm Package & Distribution

### Package identity

| Field | Value |
|---|---|
| **npm package name** | `@fragile.app/mcp` |
| **npm organisation** | `@fragile.app` (already created) |
| **`bin` entry** | `fragile-mcp` → `dist/index.js` |
| **Intended invocation** | `npx @fragile.app/mcp` |

### `package.json` key fields

```json
{
  "name": "@fragile.app/mcp",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "fragile-mcp": "./dist/index.js"
  },
  "files": ["dist"],
  "engines": { "node": ">=20" }
}
```

### MCP client configuration

Users add the following stanza to their MCP client config. For Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fragile": {
      "command": "npx",
      "args": ["-y", "@fragile.app/mcp"],
      "env": {
        "API_BASE_URL": "https://api.your-fragile-domain.com",
        "API_KEY": "optional-if-auth-re-enabled"
      }
    }
  }
}
```

For Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "fragile": {
      "command": "npx",
      "args": ["-y", "@fragile.app/mcp"],
      "env": {
        "API_BASE_URL": "https://api.your-fragile-domain.com"
      }
    }
  }
}
```

`-y` skips the interactive install prompt. `npx` will cache the package after the first
run; subsequent invocations start in under a second.

### Publish workflow — `.github/workflows/publish-mcp.yml`

The package is published to npm via GitHub Actions on every push to `main` that changes
files under `apps/mcp/`. The workflow uses the GitHub repo as a trusted publisher (npm
provenance) so that the package's origin is cryptographically verifiable.

Key workflow steps:

```yaml
name: Publish @fragile.app/mcp

on:
  push:
    branches: [main]
    paths: ['apps/mcp/**']

permissions:
  contents: read
  id-token: write   # required for npm provenance

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
        working-directory: apps/mcp
      - run: npm run build
        working-directory: apps/mcp
      - run: npm publish --provenance --access public
        working-directory: apps/mcp
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The `--provenance` flag instructs npm to attach a signed SLSA provenance attestation
to the published package, linking it to this GitHub repository and commit SHA. The
`id-token: write` permission is required for the OIDC token exchange that backs
provenance generation. `NPM_TOKEN` is a granular access token stored as a GitHub
Actions secret, scoped to publish `@fragile.app/mcp` only.

Version bumping (manual `npm version patch/minor/major` in `apps/mcp/`) is the trigger;
the workflow does not auto-bump versions.

---

## MCP Tools Design

Each tool is registered with `server.tool(name, description, zodSchema, handler)`.
All handlers call `client.ts` helpers and return a structured `text` or `json` content
block. Errors from `apps/api` (4xx, 5xx) are re-raised as MCP `CallToolError` with the
HTTP status and message included. The MCP server is **read-only** — no tool causes a
write or mutation in `apps/api`.

### DORA Metrics

#### `get_dora_metrics`
Get aggregated org-level or per-board DORA metrics for a calendar quarter.

| | |
|---|---|
| **Calls** | `GET /api/metrics/dora/aggregate` |
| **Input** | `boardId?: string` (comma-separated, e.g. `"ACC,BPT"`), `quarter?: string` (e.g. `"2026-Q2"`) |
| **Output** | `OrgDoraResult`: period label, org-level deployment frequency / lead time / CFR / MTTR with bands, per-board breakdowns |
| **Notes** | Returns HTTP 202 / pending message if snapshot not yet computed; MCP handler surfaces this as an informational text result, not an error |

#### `get_dora_trend`
Get DORA metrics across multiple consecutive quarters to show trajectory.

| | |
|---|---|
| **Calls** | `GET /api/metrics/dora/trend` |
| **Input** | `boardId?: string`, `limit?: number` (default 6) |
| **Output** | `TrendResponse` (array of `OrgDoraResult` sorted by period start) |
| **Notes** | Useful for prompts like "is our deployment frequency improving?" |

#### `get_snapshot_status`
Check whether DORA snapshots have been computed for each board.

| | |
|---|---|
| **Calls** | `GET /api/metrics/dora/snapshot/status` |
| **Input** | _(none)_ |
| **Output** | Array of `{ boardId, snapshotType, computedAt, ageSeconds, stale }` |

### Planning Accuracy

#### `get_planning_accuracy`
Get sprint planning accuracy metrics (commitment, added, removed, completed, scope change
%, completion rate) for a Scrum board sprint or quarter.

| | |
|---|---|
| **Calls** | `GET /api/planning/accuracy` |
| **Input** | `boardId: string`, `sprintId?: string`, `quarter?: string` |
| **Output** | Planning accuracy breakdown per sprint or aggregated per quarter |
| **Notes** | Returns HTTP 400 for Kanban boards; MCP handler re-raises as a descriptive error |

#### `list_sprints`
List available sprints for a board (name, state, dates).

| | |
|---|---|
| **Calls** | `GET /api/planning/sprints?boardId=` |
| **Input** | `boardId: string` |
| **Output** | Array of sprint summaries |

#### `list_quarters`
List all quarters derived from sprint data across all boards.

| | |
|---|---|
| **Calls** | `GET /api/planning/quarters` |
| **Input** | _(none)_ |
| **Output** | Array of quarter strings (`YYYY-QN`) |

### Cycle Time

#### `get_cycle_time`
Get cycle time observations and percentiles (median, p95) for a board and period.

| | |
|---|---|
| **Calls** | `GET /api/cycle-time/:boardId` |
| **Input** | `boardId: string`, `quarter?: string`, `issueType?: string` |
| **Output** | `CycleTimeResponse`: percentiles, observations, band |

#### `get_cycle_time_trend`
Get cycle time trend across multiple periods.

| | |
|---|---|
| **Calls** | `GET /api/cycle-time/trend` |
| **Input** | `boardId?: string`, `mode?: "quarters" \| "sprints"`, `limit?: number` |
| **Output** | `CycleTimeTrendResponse` |

### Sprint Detail & Reports

#### `get_sprint_detail`
Get an annotated ticket-level breakdown for a specific sprint (classification: committed,
added, removed, completed, carry-over).

| | |
|---|---|
| **Calls** | `GET /api/sprints/:boardId/:sprintId/detail` |
| **Input** | `boardId: string`, `sprintId: string` |
| **Output** | Per-issue breakdown with classification labels |
| **Notes** | This is the most information-dense tool — AI agents can use it to answer "why did the team miss their commitment?" |

#### `get_sprint_report`
Get the composite sprint report with scoring and recommendations for a sprint.

| | |
|---|---|
| **Calls** | `GET /api/sprint-report/:boardId/:sprintId` |
| **Input** | `boardId: string`, `sprintId: string`, `refresh?: boolean` |
| **Output** | Composite score, band ratings, recommendations |

### Roadmap

#### `get_roadmap_accuracy`
Get roadmap coverage accuracy: how many JPD ideas had linked issues completed within
their target quarter.

| | |
|---|---|
| **Calls** | `GET /api/roadmap/accuracy` |
| **Input** | `boardId?: string`, `quarter?: string`, `sprintId?: string` |
| **Output** | Per-epic/idea coverage metrics |

### Boards

#### `list_boards`
List all configured boards with their type (scrum/kanban) and key settings.

| | |
|---|---|
| **Calls** | `GET /api/boards` |
| **Input** | _(none)_ |
| **Output** | Array of `BoardConfig` summaries |

#### `get_board_config`
Get the full configuration for a single board (done status names, CFR/MTTR rules, etc.).

| | |
|---|---|
| **Calls** | `GET /api/boards/:boardId/config` |
| **Input** | `boardId: string` |
| **Output** | Full `BoardConfig` entity |
| **Notes** | Read-only. Board config mutation is excluded from scope (see below). |

### Sync

#### `get_sync_status`
Check when each board was last synced and whether any sync is in progress.

| | |
|---|---|
| **Calls** | `GET /api/sync/status` |
| **Input** | _(none)_ |
| **Output** | Per-board sync log entries (`boardId`, `syncedAt`, `status`, `issueCount`) |

### Gaps

#### `get_hygiene_gaps`
List issues in active sprints that are missing an epic link or story points.

| | |
|---|---|
| **Calls** | `GET /api/gaps` |
| **Input** | _(none)_ |
| **Output** | Per-board gap lists |

#### `get_unplanned_done`
List issues resolved in a period that were never planned (never boarded, for Scrum never
in a sprint).

| | |
|---|---|
| **Calls** | `GET /api/gaps/unplanned-done` |
| **Input** | `boardId?: string`, `quarter?: string`, `sprintId?: string` |
| **Output** | Per-board unplanned completions |

---

## MCP Resources

MCP resources expose static or semi-static data that AI clients can include in their
context window. Two resources are proposed:

### `boards://list`
A machine-readable summary of all configured boards (boardId, boardType, doneStatusNames).
Backed by `GET /api/boards`. Updated on every call (not cached in the MCP process).

### `boards://{boardId}/config`
Full configuration for a single board. URI template; backed by
`GET /api/boards/{boardId}/config`.

Resources are intentionally narrow — they duplicate the `list_boards` / `get_board_config`
tools. Resources give clients a way to inject board metadata passively into context;
tools give clients a way to query it actively. Both are cheap (fast DB lookup).

---

## MCP Prompt Templates

MCP prompts are pre-canned, parameterised workflows registered with
`server.prompt(name, description, argsSchema, handler)`. When an AI client requests a
prompt, the MCP server calls the relevant tools in sequence and returns a structured
message array that the client presents to its LLM as a filled-in prompt. This lets
users invoke complex multi-tool reports with a single natural-language command such as
"run the DORA health report" rather than assembling the result themselves.

All prompts are implemented in `apps/mcp/src/prompts/index.ts`.

---

### `dora_health_report`

**Description:** Generate a full DORA health report across all boards for a given quarter,
including org-level metric bands, per-board breakdowns, and a trend comparison against
the previous quarter.

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `quarter` | `string` | No | Target quarter in `YYYY-QN` format. Defaults to the current quarter. |

**Tools orchestrated:**

1. `list_boards` — enumerate configured boards so the report names them correctly
2. `get_dora_metrics` — org aggregate for `quarter`
3. `get_dora_trend` — last 4 quarters (to provide trajectory context)
4. `get_sync_status` — surface data freshness alongside the metrics

**Output shape:** A `user`-role message containing a Markdown report with sections:
- **Period** — quarter label and date range
- **Org-level summary** — deployment frequency, lead time, CFR, MTTR with band labels
  (elite / high / medium / low) and raw values
- **Board breakdown** — per-board table of all four metrics
- **Trend** — sparkline-style text summary of the last 4 quarters (improving /
  declining / stable per metric)
- **Data freshness** — last sync time per board; flag if any board is stale (> 2 hours)

---

### `sprint_retrospective`

**Description:** Produce a sprint retrospective summary for a given board and sprint,
covering planning accuracy, ticket-level classification, scope changes, and
recommendations.

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `boardId` | `string` | Yes | Board identifier (e.g. `ACC`) |
| `sprintId` | `string` | Yes | Sprint ID |

**Tools orchestrated:**

1. `get_sprint_report` — composite score, band ratings, recommendations
2. `get_sprint_detail` — ticket-level classification (committed / added / removed /
   completed / carry-over)
3. `get_planning_accuracy` — commitment vs. completed count and points, scope change %,
   completion rate for the sprint

**Output shape:** A `user`-role message containing a Markdown report with sections:
- **Sprint summary** — name, dates, composite score and band
- **Planning accuracy** — commitment, added, removed, completed, scope change %,
  completion rate
- **Ticket breakdown** — table of issues with classification label and story points
- **Scope changes** — issues added or removed mid-sprint with labels
- **Carry-overs** — issues not completed, to track in the next sprint
- **Recommendations** — verbatim from `get_sprint_report`

---

### `release_readiness`

**Description:** Assess whether a Scrum board is ready for a release at the end of the
current or a specified sprint. Combines deployment health, hygiene gaps, unplanned work,
and sprint completion rate.

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `boardId` | `string` | Yes | Board identifier |
| `sprintId` | `string` | No | Sprint ID. Defaults to the most recent completed sprint for the board. |

**Tools orchestrated:**

1. `list_sprints` — resolve `sprintId` if omitted; confirm the sprint is complete
2. `get_sprint_report` — overall score and any blocking recommendations
3. `get_planning_accuracy` — completion rate for the sprint
4. `get_hygiene_gaps` — unresolved gaps (missing epics, missing estimates) in the sprint
5. `get_unplanned_done` — unplanned completions in the sprint (signal of process bypass)
6. `get_dora_metrics` — CFR and MTTR for the board in the sprint's quarter (risk signal)

**Output shape:** A `user`-role message containing a Markdown report with:
- **Readiness verdict** — Ready / Caution / Not Ready, with a one-sentence rationale
- **Sprint completion** — completion rate and scope change %
- **Quality signals** — CFR and MTTR bands for the quarter
- **Hygiene gaps** — count and list of issues with missing epics or estimates
- **Unplanned work** — count of never-boarded issues resolved in the sprint
- **Blocking issues** — any sprint report recommendations flagged as high severity

---

### `quarterly_planning_review`

**Description:** Review planning accuracy and delivery performance across all Scrum boards
for a given quarter, suitable for an engineering leadership retrospective.

**Arguments:**

| Argument | Type | Required | Description |
|---|---|---|---|
| `quarter` | `string` | No | Target quarter in `YYYY-QN` format. Defaults to the most recently completed quarter. |

**Tools orchestrated:**

1. `list_boards` — identify all Scrum boards (Kanban boards return HTTP 400 for planning
   accuracy and are skipped with a note)
2. `list_quarters` — validate the requested quarter exists in the data
3. `get_planning_accuracy` — per-board accuracy for the quarter (called once per Scrum board)
4. `get_dora_metrics` — org aggregate for the quarter (delivery health context)
5. `get_roadmap_accuracy` — org-level roadmap coverage for the quarter
6. `get_unplanned_done` — cross-board unplanned completions for the quarter

**Output shape:** A `user`-role message containing a Markdown report with:
- **Quarter summary** — date range, boards covered
- **Planning accuracy by board** — table: board, commitment points, completion rate,
  scope change %, band
- **Org delivery health** — DORA aggregate bands for the quarter
- **Roadmap coverage** — % of JPD ideas with linked issues completed within target quarter
- **Unplanned work** — cross-board count and breakdown of never-boarded completions
- **Observations** — a bulleted list of notable patterns (e.g. boards with >20% scope
  change, boards with low completion rate alongside elite DORA scores)

---

## Excluded from Scope

The following capabilities are intentionally excluded from the initial MCP surface:

| Endpoint | Reason for exclusion |
|---|---|
| `POST /api/sync` | The MCP server is read-only. Sync triggering is a write operation that causes Jira API load and must remain a human-initiated action via the dashboard UI. |
| `PUT /api/boards/:boardId/config` | Mutating board config (CFR/MTTR rules, done statuses) has significant downstream impact on metric results. Requiring a human to make this change via the settings UI is a deliberate guard rail. |
| `POST/PATCH/DELETE /api/roadmap/configs` | Roadmap JPD config management is rare, manual, and consequential. Same guard-rail argument. |
| `GET /api/quarters/:boardId/:quarter/detail` | Ticket-level quarter detail is high-volume (hundreds of rows). Included at the tool level only on explicit agent request; excluded from resources to avoid bloating context. Revisit if there is clear demand. |
| `GET /api/weeks/:boardId/:week/detail` | Same reasoning as quarter detail. |
| Direct DB or service access | The MCP server must never bypass `apps/api`. All queries go through REST. |

---

## Alternatives Considered

### Alternative A — MCP module inside `apps/api` (NestJS module)

Embedding an MCP NestJS module would allow direct service injection, avoiding the HTTP
round-trip. However, the MCP SDK's stdio transport reads from `process.stdin` and writes
to `process.stdout`, which conflicts with NestJS's HTTP server on the same process. SSE
transport could coexist, but it adds a second HTTP listener to the NestJS app, complicating
health checks and port assignments. The coupling between the MCP lifecycle and NestJS's
bootstrap sequence adds fragility. The HTTP round-trip overhead within a local deployment
is negligible (< 5 ms loopback).

**Ruled out:** Transport conflicts and lifecycle coupling outweigh the minor efficiency gain.

### Alternative B — GraphQL or tRPC layer consumed by MCP

Some projects add a typed query layer (tRPC, GraphQL) and build MCP on top of it. Fragile
already has a complete REST API; adding a second query protocol solely to serve the MCP
layer introduces unnecessary complexity and maintenance surface. The REST API's typed
DTOs are sufficient for the MCP tool schemas.

**Ruled out:** Adds a new protocol dependency with no benefit over the existing REST layer.

### Alternative C — Single tool that proxies arbitrary REST calls

Exposing a single `call_api` tool that accepts a method, path, and body and proxies it to
`apps/api` would require zero maintenance. However, it provides no discoverability,
produces no useful schema for AI clients, and would allow agents to invoke destructive
mutations (board config changes, deletes). Named, typed tools with explicit input schemas
are both safer and more useful for AI clients.

**Ruled out:** Unsafe and unergonomic for AI clients.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No direct DB access from the MCP server; no schema changes |
| API contract | Additive (none to `apps/api`) | MCP server consumes existing endpoints; no new endpoints required |
| Frontend | None | `apps/web` is unaffected |
| Tests | New unit tests in `apps/mcp/test/` | Mock HTTP client; no integration tests against live DB required |
| Jira API | No new calls | All data served from Postgres cache |
| Infrastructure | New npm package | Published to npm via GitHub Actions; no new AWS services or containers required |
| CI/CD | New workflow | `.github/workflows/publish-mcp.yml` added; `NPM_TOKEN` secret required in GitHub repo |
| `apps/api` | None | No changes to NestJS code |

---

## Open Questions

All open questions from the draft have been resolved by product owner decisions recorded
below. No open questions remain; implementation may proceed.

| # | Question | Resolution |
|---|---|---|
| 1 | stdio vs SSE as primary transport? | **stdio only.** SSE is not supported. |
| 2 | Rate limiting strategy for agentic loops? | **Not a concern for this use case.** Removed. |
| 3 | Include MCP prompt templates in this proposal? | **Yes.** Four prompt templates are specified above. |
| 4 | Docker image vs npm publish? | **npm publish** via `@fragile.app/mcp` on the `@fragile.app` org. Docker image not required. |
| 5 | Should sync trigger be included as a write tool? | **No.** The MCP server is read-only. `trigger_sync` is excluded. |

---

## Acceptance Criteria

- [ ] `apps/mcp/` package exists in the monorepo with `package.json` (`name: "@fragile.app/mcp"`, `bin: { "fragile-mcp": "./dist/index.js" }`), `tsconfig.json`, and `README.md` documenting setup for Claude Desktop and Cursor using `npx @fragile.app/mcp`
- [ ] All 16 tools listed above are implemented and registered with the MCP server (note: `trigger_sync` is excluded — the server is read-only)
- [ ] Both `boards://list` and `boards://{boardId}/config` resources are implemented
- [ ] All four prompt templates (`dora_health_report`, `sprint_retrospective`, `release_readiness`, `quarterly_planning_review`) are implemented and registered
- [ ] stdio transport works end-to-end: a Claude Desktop or Cursor MCP config using `npx -y @fragile.app/mcp` can invoke `list_boards` and `get_dora_metrics` and receive valid JSON responses
- [ ] No HTTP/SSE transport listener — the process does not bind to any port
- [ ] All `apps/api` HTTP calls go through `apps/mcp/src/client.ts` — no direct Jira or DB calls from MCP code
- [ ] The MCP server makes only `GET` requests to `apps/api` — no `POST`, `PUT`, `PATCH`, or `DELETE` calls anywhere in the MCP codebase
- [ ] `API_BASE_URL` and `API_KEY` are read via environment variables, never hardcoded
- [ ] Unit tests exist for every tool handler, using a mock `client.ts`; all tests pass
- [ ] `apps/api` (NestJS) code is unchanged — zero modifications to `apps/api/src/`
- [ ] Kanban planning accuracy 400 is surfaced as a descriptive MCP error (not an unhandled exception)
- [ ] 202 Pending snapshot response is surfaced as an informational MCP text result (not an error)
- [ ] TypeScript strict mode — no `any`, no `ts-ignore`
- [ ] `npm run build` in `apps/mcp/` produces a runnable `dist/index.js` with the `fragile-mcp` bin entry executable
- [ ] `.github/workflows/publish-mcp.yml` exists and publishes to npm with `--provenance --access public` on push to `main` when `apps/mcp/**` files change
- [ ] The `NPM_TOKEN` secret is documented in the repository's contributing guide or `apps/mcp/README.md`
- [ ] `npm info @fragile.app/mcp` returns the published package after the first successful workflow run
