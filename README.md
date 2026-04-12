# Fragile

Fragile is a self-hosted engineering metrics dashboard that connects to a Jira Cloud instance
and surfaces DORA metrics, sprint and Kanban planning analytics, cycle time analysis, and
roadmap accuracy tracking. It is designed for small engineering teams who want actionable
delivery data without leaving their existing Jira workflow.

All Jira data is synced into a local PostgreSQL database on demand. Metric calculations run
against the cached data, keeping the UI fast and Jira API usage low. Every aspect of the metric
rules — done statuses, failure issue types, incident definitions, roadmap date field IDs — is
configurable per board through the Settings UI, with no hardcoded assumptions in the codebase.

Fragile is an intentionally simple, single-user internal tool. There is no login screen and no
user management. It is designed to run on a private network or localhost and to be trusted by the
team that operates it.

---

## Screenshots

<!-- Add screenshots here once the UI is stable. Suggested shots:
     - DORA dashboard (all boards, quarter view)
     - Cycle Time scatter plot with percentile cards
     - Sprint Planning table
     - Roadmap Accuracy board breakdown
     - Settings page (board config editor)
-->

---

## Features

### DORA Metrics

The DORA page shows all four DORA metrics — Deployment Frequency, Lead Time for Changes, Change
Failure Rate, and MTTR — at the organisation level and broken down per board. Toggle between week
and quarter views. Each metric card carries a DORA band badge (Elite / Good / Fair / Poor) derived
from the DORA research thresholds, and a board breakdown table allows comparison across projects.

### Cycle Time

The Cycle Time page plots individual issue cycle times on a scatter chart with a trend line. Three
percentile cards (p50, p75, p95) summarise the distribution. Each data point is annotated with its
DORA band. Epics and sub-tasks are excluded from all cycle time calculations. Supports per-board
filtering and week/quarter time range toggles.

### Planning (Sprint)

The Planning page provides a per-sprint breakdown for Scrum boards: issue count, story points,
completion rate, and scope change percentage. Sprint membership history is reconstructed from the
Jira changelog so that issues added or removed mid-sprint are counted accurately. Active sprints
are flagged in the UI.

### Planning (Kanban)

Kanban boards have no sprints. The Planning page adapts to show issues grouped by the week or
quarter in which they first entered the board (board-entry date derived from changelog). Completion
rate and throughput are shown per period. The `dataStartDate` board config field prevents old
backlog issues from inflating Kanban period counts.

### Roadmap Accuracy

The Roadmap page tracks whether delivered issues were backed by an active Jira Product Discovery
(JPD) idea. Two metrics are reported:

- **Roadmap Coverage** — percentage of completed issues that are linked (via epic) to a JPD idea
  that was active during the delivery period.
- **Roadmap Delivery Rate** — percentage of covered issues that were actually completed.

A JPD idea is considered active only during its `startDate`–`targetDate` window. Both dates are
read from tenant-specific Polaris interval custom fields, configured in the Settings UI.

### Settings

The Settings page exposes per-board configuration (done status names, in-progress status names,
failure issue types, failure labels, failure link types, incident types, incident priorities,
recovery statuses, backlog status IDs, and data start date) and per-JPD-project configuration
(start date field ID, target date field ID). Changes are persisted to PostgreSQL and take effect
on the next data request without requiring a restart.

### Sync

A manual sync button in the Settings page triggers a full refresh of sprints, issues, changelogs,
versions, and JPD ideas from Jira. Sync status and last-synced timestamps are displayed per board.
Sync history (issue count, status, error messages) is stored in the `sync_logs` table.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | Next.js 16 (App Router), React 19 |
| Frontend language | TypeScript (strict, no semicolons) |
| Styling | Tailwind CSS v4 (CSS-first configuration) |
| Charts | Recharts |
| State management | Zustand |
| Icons | lucide-react |
| Backend framework | NestJS 11 |
| Backend language | TypeScript (strict, semicolons, `.js` ESM imports) |
| ORM | TypeORM |
| Database | PostgreSQL 16 |
| Jira integration | Jira Cloud REST API v3 + Agile API v1 (Basic auth) |
| Task automation | GNU Make |
| Local infrastructure | Docker Compose |

**Default ports:** Frontend `:3000` | Backend `:3001` | PostgreSQL `:5432`

---

## Prerequisites

- **Node.js 20 or later** (both backend and frontend)
- **PostgreSQL 16** — Docker is the simplest path (see Quick Start); an existing PostgreSQL
  instance works equally well
- **Docker** (optional, but recommended for running PostgreSQL locally)
- **A Jira Cloud account** with:
  - At least one Jira Software project (Scrum or Kanban)
  - An API token (see [Jira Setup](#jira-setup))
  - Optionally, one or more Jira Product Discovery projects for roadmap accuracy

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/your-org/fragile.git
cd fragile
```

### 2. Start PostgreSQL

Using Docker (recommended):

```bash
docker run -d \
  --name fragile-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=fragile \
  -p 5432:5432 \
  postgres:16-alpine
```

Or use the provided Docker Compose file (database name defaults to `ai_starter` — edit
`docker-compose.yml` and `backend/.env` if you want to rename it):

```bash
docker compose up -d
```

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and fill in your Jira credentials and board project keys:

```dotenv
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_USER_EMAIL=you@yourorg.com
JIRA_API_TOKEN=your_jira_api_token
JIRA_BOARD_IDS=PROJ1,PROJ2,PROJ3
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=fragile
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### 4. Configure the frontend

```bash
cp frontend/.env.example frontend/.env
```

`frontend/.env` only needs one variable:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### 5. Install dependencies

```bash
make install
```

Or manually:

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 6. Run database migrations

The backend must be compiled before migrations can run because `data-source.ts` references
compiled output in `dist/`.

```bash
make migrate
```

Or manually:

```bash
cd backend && npm run build && npm run migration:run
```

### 7. Start the development servers

Open two terminals:

```bash
# Terminal 1 — backend (NestJS, port 3001)
make dev-api

# Terminal 2 — frontend (Next.js, port 3000)
make dev-web
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 8. Trigger the first sync

Navigate to **Settings** in the sidebar and click **Sync now**. The initial sync may take a
minute or two depending on the number of issues and boards. Subsequent syncs are incremental.

---

## Makefile Reference

| Target | Description |
|---|---|
| `make install` | Install npm dependencies for both backend and frontend |
| `make up` | Start PostgreSQL via Docker Compose |
| `make down` | Stop Docker Compose |
| `make migrate` | Build backend and run TypeORM migrations |
| `make seed` | Seed default board configurations |
| `make dev-api` | Start NestJS in watch mode (port 3001) |
| `make dev-web` | Start Next.js dev server (port 3000) |
| `make test-api` | Run backend Jest test suite |
| `make test-web` | Run frontend Vitest test suite |
| `make sync` | Trigger a manual Jira data sync via `POST /api/sync` |
| `make start` | Start Docker, backend, and frontend together |
| `make stop` | Kill running servers and stop Docker Compose |
| `make clean` | Wipe the database volume and re-run migrations |
| `make reset` | Full rebuild: stop everything, delete node_modules and dist, reinstall, remigrate |

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_BASE_URL` | Yes | — | Jira Cloud base URL, e.g. `https://yourorg.atlassian.net` |
| `JIRA_USER_EMAIL` | Yes | — | Email address associated with the Jira API token |
| `JIRA_API_TOKEN` | Yes | — | Jira API token (see [Jira Setup](#jira-setup)) |
| `JIRA_BOARD_IDS` | Yes | — | Comma-separated Jira project keys, e.g. `ACC,BPT,SPS` |
| `DB_HOST` | No | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_USERNAME` | No | `postgres` | PostgreSQL username |
| `DB_PASSWORD` | No | `postgres` | PostgreSQL password |
| `DB_DATABASE` | No | `fragile` | PostgreSQL database name |
| `PORT` | No | `3001` | Port the NestJS server listens on |
| `FRONTEND_URL` | No | `http://localhost:3000` | Allowed CORS origin for the frontend |

### Frontend (`frontend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:3001` | Base URL of the backend API |

---

## Jira Setup

### Permissions required

The Jira account used for the API token needs the following permissions on each project:

- **Browse projects** — to read issues and sprints
- **View development tools** — to read changelogs and fix versions
- If using Jira Product Discovery: **View ideas** on each JPD project

A read-only service account is recommended for production deployments.

### Obtaining a Jira API token

1. Log in to [https://id.atlassian.com](https://id.atlassian.com).
2. Navigate to **Security** > **API tokens**.
3. Click **Create API token**, give it a label (e.g. `fragile`), and copy the token.
4. Paste the token into `JIRA_API_TOKEN` in `backend/.env`.
5. Set `JIRA_USER_EMAIL` to the email address of the account that owns the token.

### Finding project keys

Project keys are the uppercase prefix before issue numbers (e.g. `ACC` in `ACC-123`). They
appear in the URL when you open a Jira project: `https://yourorg.atlassian.net/jira/software/projects/ACC/boards`.

Set `JIRA_BOARD_IDS` to a comma-separated list of the project keys you want to track,
for example `ACC,BPT,SPS,OCS,DATA,PLAT`.

### Board type detection

Board type (Scrum vs Kanban) is stored in the `BoardConfig` entity. After the first sync you can
update `boardType` for each board through the Settings UI or directly in the database.

- **Scrum boards** support sprint-based Planning metrics.
- **Kanban boards** use changelog-derived board-entry dates for Planning metrics. Sprint Planning
  metrics are not available for Kanban boards.

### Configuring JPD date fields

Roadmap accuracy depends on reading start and target dates from JPD ideas. These dates are stored
in tenant-specific Polaris interval custom fields (type `jira.polaris:interval`). The field IDs
differ between Jira tenants and must be configured manually:

1. In the Jira admin, go to **Project settings** > **Fields** for your JPD project and note the
   custom field IDs for the start date and target date interval fields. Field IDs look like
   `customfield_10056`.
2. Alternatively, fetch any JPD idea via the API and inspect the field keys in the response to
   identify which field holds the interval data.
3. In Fragile, go to **Settings** > **Roadmap configs** and enter the field IDs for each JPD
   project. Fragile will read `{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}` from those fields and
   use `start` as `startDate` and `end` as `targetDate`.

### Roadmap accuracy: delivery issue links

For an issue to count as roadmap-covered, it must be linked to an Epic that is in turn linked to
a JPD idea via a delivery issue link. Fragile recognises the following link type names by default:

- `is implemented by` / `implements`
- `is delivered by` / `delivers`

These link types are created automatically when you connect Jira Software delivery tickets to JPD
ideas using the native **Delivery** panel in JPD. No custom configuration is required for the
link types themselves.

---

## Configuration Guide

All configuration is managed through the **Settings** page at `/settings`.

### Board configuration

Each board listed in `JIRA_BOARD_IDS` has an editable configuration block. The fields are:

| Field | Description | Default |
|---|---|---|
| **Board type** | `scrum` or `kanban` | `scrum` |
| **Done status names** | Status names that count as "deployed / complete" for Deployment Frequency and Lead Time | `Done, Closed, Released` |
| **In-progress status names** | First transition to one of these statuses marks cycle time start | `In Progress` |
| **Failure issue types** | Issue types that contribute to Change Failure Rate | `Bug, Incident` |
| **Failure labels** | Issue labels that flag a failure | `regression, incident, hotfix` |
| **Failure link types** | Issue link type names that indicate a deployment caused a failure | `is caused by, caused by` |
| **Incident issue types** | Issue types used to identify incidents for MTTR | `Bug, Incident` |
| **Incident priorities** | Priorities that qualify an issue as an incident | `Critical` |
| **Incident labels** | Labels used to identify incidents | _(empty)_ |
| **Recovery statuses** | Status names that indicate an incident is resolved (MTTR end) | `Done, Resolved` |
| **Backlog status IDs** | Status IDs representing the pre-board backlog state (Kanban only) | _(empty)_ |
| **Data start date** | ISO date (`YYYY-MM-DD`) — Kanban issues that entered the board before this date are excluded from flow metrics | _(none)_ |

### Roadmap configuration

Each Jira Product Discovery project that you want to use for roadmap accuracy tracking needs a
configuration entry. The fields are:

| Field | Description |
|---|---|
| **JPD project key** | The project key of the JPD project, e.g. `ROADMAP` |
| **Description** | Optional human-readable label |
| **Start date field ID** | Custom field ID for the interval field used as the idea start date |
| **Target date field ID** | Custom field ID for the interval field used as the idea target date |

---

## Architecture

### Project structure

```
fragile/
├── backend/                    # NestJS 11 API server (port 3001)
│   ├── src/
│   │   ├── boards/             # Board config CRUD (controller + service)
│   │   ├── database/
│   │   │   └── entities/       # TypeORM entity classes
│   │   ├── health/             # GET /health (unguarded)
│   │   ├── jira/               # Typed Jira API client — all Jira HTTP calls live here
│   │   ├── metrics/            # DORA metrics and cycle time services + controllers
│   │   ├── migrations/         # TypeORM migration files (reversible up + down)
│   │   ├── planning/           # Sprint and Kanban planning services + controllers
│   │   ├── quarter/            # Quarter detail view service
│   │   ├── roadmap/            # Roadmap accuracy service + controller
│   │   ├── sprint/             # Sprint detail view service
│   │   ├── sync/               # Jira sync orchestration service + controller
│   │   ├── week/               # Week detail view service
│   │   ├── app.module.ts
│   │   ├── data-source.ts      # TypeORM DataSource (used by migration CLI)
│   │   └── main.ts
│   ├── .env                    # Backend environment variables (not committed)
│   └── package.json
├── frontend/                   # Next.js 16 app (port 3000)
│   ├── src/
│   │   ├── app/                # Next.js App Router pages
│   │   │   ├── dora/           # DORA metrics dashboard
│   │   │   ├── cycle-time/     # Cycle time scatter plot
│   │   │   ├── planning/       # Sprint + Kanban planning
│   │   │   ├── roadmap/        # Roadmap accuracy
│   │   │   └── settings/       # Board and roadmap config
│   │   ├── components/         # Shared React components
│   │   │   └── layout/         # Sidebar, shell
│   │   ├── lib/                # Typed API client, utility functions
│   │   └── store/              # Zustand state stores
│   ├── .env                    # Frontend environment variables (not committed)
│   └── package.json
├── docs/
│   ├── decisions/              # Architecture Decision Records (ADRs)
│   └── proposals/              # Design proposals (written before implementation)
├── docker-compose.yml
├── Makefile
└── README.md
```

### Key design decisions

All Jira API calls are routed through a single typed `JiraClient` service in `backend/src/jira/`.
No metric service or controller calls Jira directly. This keeps the integration surface contained
and makes the services independently testable.

Calculation logic lives entirely in NestJS services. Controllers only handle request parsing,
response shaping, and delegation to services. No business logic appears in controllers.

Board configuration (done status names, failure rules, incident rules) is stored in the
`board_configs` table and loaded at runtime. Nothing metric-related is hardcoded.

Epics and sub-tasks are excluded from all metric calculations at the query layer. This is enforced
in the sync service and in all metric service queries.

Sprint membership history for Scrum boards is reconstructed from the `jira_changelogs` table
(field: `Sprint`). Jira does not expose a point-in-time snapshot of sprint membership, so
changelog replay is the authoritative source.

For the full rationale behind each of these decisions, see the ADRs in `docs/decisions/`.

---

## Data Model

The following TypeORM entities form the core data model. All entities map to snake_case table
names in PostgreSQL.

| Entity | Table | Key fields | Purpose |
|---|---|---|---|
| `BoardConfig` | `board_configs` | `boardId` (PK) | Per-board metric rules and status configuration |
| `JiraIssue` | `jira_issues` | `key` (PK), `boardId`, `sprintId`, `epicKey`, `issueType`, `status`, `statusId`, `points`, `labels`, `createdAt` | Snapshot of each Jira issue |
| `JiraSprint` | `jira_sprints` | `id` (PK), `boardId`, `state`, `startDate`, `endDate` | Sprint metadata for Scrum boards |
| `JiraChangelog` | `jira_changelogs` | `id` (PK, auto), `issueKey`, `field`, `fromValue`, `toValue`, `changedAt` | Full field-change history; used for sprint membership reconstruction and cycle time |
| `JiraVersion` | `jira_versions` | `id` (PK), `projectKey`, `releaseDate`, `released` | Fix versions / releases; primary deployment signal for Deployment Frequency |
| `JiraIssueLink` | `jira_issue_links` | `id` (PK, auto), `sourceIssueKey`, `targetIssueKey`, `linkTypeName`, `isInward` | Issue-to-issue links; used for CFR causal links and roadmap delivery links |
| `JpdIdea` | `jpd_ideas` | `key` (PK), `jpdKey`, `deliveryIssueKeys`, `startDate`, `targetDate`, `syncedAt` | JPD idea snapshots with delivery epic links and active date window |
| `RoadmapConfig` | `roadmap_configs` | `id` (PK, auto), `jpdKey` (unique), `startDateFieldId`, `targetDateFieldId` | Per-JPD-project custom field IDs for extracting idea dates |
| `SyncLog` | `sync_logs` | `id` (PK, auto), `boardId`, `syncedAt`, `issueCount`, `status`, `errorMessage` | Audit trail of sync runs per board |

---

## Migrations

Migration files live in `backend/src/migrations/`. All migrations have reversible `up` and `down`
methods.

```bash
# Run all pending migrations
cd backend && npm run build && npm run migration:run

# Revert the most recent migration
cd backend && npm run migration:revert

# Generate a new migration from entity changes
cd backend && npm run migration:generate -- src/migrations/DescriptiveName
```

> The migration CLI uses `dist/` paths, so `npm run build` must be run before `migration:run`
> or `migration:revert`.

---

## Contributing

Design decisions in this project follow a proposal-then-ADR workflow:

1. **Before implementing** any significant change — a new module, a schema change affecting
   multiple entities, a new Jira API integration point, or a cross-cutting concern — write a
   proposal in `docs/proposals/` using the template and naming convention described in that
   directory's README.

2. **After the proposal is accepted**, record the decision as an Architecture Decision Record in
   `docs/decisions/`. ADRs are immutable once written; superseded decisions are marked as such
   and linked to the replacement ADR.

3. Calculation logic belongs in services, not controllers. All Jira HTTP calls belong in
   `JiraClient`, not in any other service. Board configuration must come from the database, not
   from environment variables or hardcoded values.

4. TypeScript is strict mode throughout. The backend uses semicolons and `.js` extension ESM
   imports. The frontend uses no semicolons. Match the style of the file you are editing.

5. Migrations must be reversible. Every `up` must have a corresponding `down`.

Pull requests are welcome. Please open an issue or discussion first for any change that would
affect the data model, the Jira sync strategy, or the metric calculation logic.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
