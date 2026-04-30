# 0001 — Roadmap Accuracy

**Date:** 2026-04-10
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** [ADR-0009](../decisions/0009-roadmap-accuracy-jpd-sync-strategy.md)

---

## Problem Statement

The dashboard currently measures _how much_ work was delivered per sprint (Planning Accuracy)
and _how reliably_ it was delivered (DORA). It has no signal for whether that work was
**aligned to the planned roadmap**. Without this, teams cannot answer: "Did the sprint
contribute to the outcomes we committed to in Jira Product Discovery (JPD)?"

JPD ideas are stored as standard Jira issues in a `product_discovery` project. The link
between a JPD idea and the delivery work is an `issuelinks` entry with type `"Delivers"` /
`"is delivered by"` on the epic. Because the system never syncs JPD data, and because
`jira_issues` does not capture which epic a story belongs to, neither connection can
currently be made. This proposal adds the data pipeline and metric calculation layer
needed to close that gap.

---

## Proposed Solution

### Overview

```
Jira Cloud (JPD project)          Postgres
  /rest/api/3/search/jql  ──────► jpd_ideas  (new)
                                      │
  issuelinks["Delivers"]  ──────► idea_delivery_keys[]  (column on jpd_ideas)
                                      │
jira_issues.epicKey        ◄──── ALTER TABLE jira_issues (new nullable column)
  (fields.parent.key or              │
   customfield_10014)                 │
                                      ▼
                              RoadmapService.getAccuracy()
                                      │
                              GET /api/roadmap/accuracy?boardId=ACC
                                      │
                              frontend/src/app/roadmap/page.tsx
```

Four areas of change are required, each scoped to a minimal blast radius:

1. **New migration** — adds `epic_key` to `jira_issues` and creates two new tables.
2. **Sync changes** — `mapJiraIssue()` captures `epicKey`; new `syncRoadmaps()` fetches JPD ideas; `syncAll()` calls it.
3. **New `roadmap` NestJS module** — `RoadmapService`, `RoadmapController`, and TypeORM entities registered in `AppModule`.
4. **Frontend** — `/roadmap` page, a JPD config section in Settings, and a sidebar nav item.

---

### 1. Database Changes

#### 1a. New column: `jira_issues.epic_key`

```
ALTER TABLE jira_issues
  ADD COLUMN epic_key VARCHAR NULL;
```

`epicKey` is `nullable varchar` because:
- Stories without an epic are valid (orphan work); they contribute to `roadmapCoverage`
  as uncovered issues.
- Sub-tasks whose parent is a story (not an epic) also have a parent key, so the mapper
  must check `fields.parent.fields.issuetype.name === 'Epic'` before trusting the value.

#### 1b. New table: `roadmap_configs`

Stores which JPD project keys to sync. A single internal tool may watch one or more JPD
projects.

```sql
CREATE TABLE roadmap_configs (
  id          SERIAL PRIMARY KEY,
  jpd_key     VARCHAR NOT NULL UNIQUE,   -- e.g. "DISC", "ROADMAP"
  description VARCHAR NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

TypeORM entity: `RoadmapConfig`.

#### 1c. New table: `jpd_ideas`

One row per JPD idea issue. `deliveryIssueKeys` is stored as a `simple-array` column
because the list is small, read-only after sync, and never queried with `ANY()`.

```sql
CREATE TABLE jpd_ideas (
  key                  VARCHAR PRIMARY KEY,   -- e.g. "DISC-42"
  summary              VARCHAR NOT NULL,
  status               VARCHAR NOT NULL,
  jpd_key              VARCHAR NOT NULL,      -- FK-like to roadmap_configs.jpd_key
  delivery_issue_keys  TEXT NULL,             -- simple-array: "ACC-1,ACC-2,BPT-7"
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

TypeORM entity: `JpdIdea`.

`deliveryIssueKeys` contains the **epic keys** that carry a `"Delivers"` outward link
from the idea (or equivalently, the idea key appears in the epic's `issuelinks` as
`"is delivered by"`). Both link directions are normalised during sync.

#### Migration file

`backend/src/migrations/XXXXXXXXX-AddRoadmapTables.ts`

Implements reversible `up()` and `down()`:

- `up`: `ALTER TABLE jira_issues ADD COLUMN epic_key VARCHAR NULL` → `CREATE TABLE roadmap_configs` → `CREATE TABLE jpd_ideas`
- `down`: `DROP TABLE jpd_ideas` → `DROP TABLE roadmap_configs` → `ALTER TABLE jira_issues DROP COLUMN epic_key`

---

### 2. Jira Client Changes (`jira-client.service.ts`)

Two new methods are added. All Jira HTTP calls remain inside `JiraClientService` — no
other service calls Jira directly.

#### 2a. `getJpdIdeas(jpdKey: string, nextPageToken?: string)`

```
GET /rest/api/3/search/jql
  ?jql=project={jpdKey} ORDER BY updated DESC
  &fields=summary,status,issuelinks
  &maxResults=100
  [&nextPageToken=...]
```

Returns `JiraIssueSearchResponse` (existing type — JPD ideas are standard issues).
Pagination is token-based, matching the existing `searchIssues` pattern.

#### 2b. `fields` expansion on existing `getSprintIssues` and `searchIssues`

Both methods must request `parent` in their `fields` list so `mapJiraIssue()` can read
`fields.parent.key`. This is a **non-breaking additive change** to the query string.
Update the field lists:

```
fields=summary,status,issuetype,fixVersions,labels,created,updated,issuelinks,parent
```

A new `JiraParentField` interface is added to `jira.types.ts`:

```typescript
export interface JiraParentField {
  key: string;
  fields: { issuetype: { name: string } };
}
```

And `JiraIssueValue.fields` gains:
```typescript
parent?: JiraParentField;
customfield_10014?: string;  // legacy epic link
```

---

### 3. Sync Changes (`sync.service.ts`)

#### 3a. `mapJiraIssue()` — capture `epicKey`

```typescript
// Prefer modern parent link; fall back to legacy custom field
const parent = raw.fields.parent;
if (parent?.fields?.issuetype?.name === 'Epic') {
  issue.epicKey = parent.key;
} else if (typeof raw.fields['customfield_10014'] === 'string') {
  issue.epicKey = raw.fields['customfield_10014'] as string;
} else {
  issue.epicKey = null;
}
```

This is safe to add without breaking the existing upsert because `epicKey` is nullable.

#### 3b. New `syncRoadmaps()` method

```typescript
async syncRoadmaps(): Promise<void> {
  const configs = await this.roadmapConfigRepo.find();
  for (const cfg of configs) {
    await this.syncJpdProject(cfg.jpdKey);
  }
}
```

`syncJpdProject(jpdKey)` paginates through JPD ideas and for each issue:
1. Extracts `issuelinks` entries where `type.outward === 'Delivers'`
   (outward on the idea → epic) **or** `type.inward === 'is delivered by'`
   (inward on the idea means an epic points at this idea).
2. Collects both `outwardIssue.key` and `inwardIssue.key` values that pass either
   condition into `deliveryIssueKeys`.
3. Upserts into `jpd_ideas` on `key`.

#### 3c. `syncAll()` — call `syncRoadmaps()`

```typescript
async syncAll() {
  // ... existing board loop ...
  await this.syncRoadmaps();   // appended; failures are caught and logged, not thrown
  return { boards: boardIds, results };
}
```

`syncRoadmaps()` errors are **non-fatal** — they are logged as warnings. A board sync
failure must not be caused by a missing JPD project key.

#### 3d. New repositories injected into `SyncService`

`@InjectRepository(RoadmapConfig)`, `@InjectRepository(JpdIdea)` — both added to the
constructor. `SyncModule` imports `TypeOrmModule.forFeature([..., RoadmapConfig, JpdIdea])`.

---

### 4. New `roadmap` NestJS Module

Directory: `backend/src/roadmap/`

```
roadmap/
  roadmap.module.ts
  roadmap.service.ts
  roadmap.controller.ts
```

Registered in `AppModule` imports array alongside existing modules.

#### 4a. `RoadmapService`

Injected repositories: `JiraSprint`, `JiraIssue`, `JpdIdea`, `BoardConfig`.

**Exported interface:**

```typescript
export interface RoadmapSprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  totalIssues: number;           // issues in sprint (excl. epics/sub-tasks)
  coveredIssues: number;         // issues whose epicKey appears in any JpdIdea.deliveryIssueKeys
  uncoveredIssues: number;       // totalIssues - coveredIssues
  roadmapCoverage: number;       // coveredIssues / totalIssues × 100 (0 if total=0)
  linkedCompletedIssues: number; // roadmap-linked issues that reached a done status in-sprint
  roadmapDeliveryRate: number;   // linkedCompletedIssues / coveredIssues × 100 (0 if covered=0)
}
```

**Metric calculation — step by step:**

Given `boardId` (and optional `sprintId` or `quarter` filter):

1. **Resolve sprints** — same logic as `PlanningService.getAccuracy()`: find sprints by
   `boardId`; if `boardType === 'kanban'` return empty array (no sprint concept).

2. **For each sprint**, fetch `JiraIssue[]` where `sprintId = sprint.id AND boardId = boardId`.
   Filter out `issueType IN ('Epic', 'Sub-task')` — epics are the linking unit, not the
   counted unit; sub-tasks double-count story work.

3. **Build the covered set** — load all `JpdIdea` rows and materialise a
   `Set<string>` of every epic key that appears in any idea's `deliveryIssueKeys`:

   ```
   coveredEpicKeys = new Set(
     allJpdIdeas.flatMap(idea => idea.deliveryIssueKeys ?? [])
   )
   ```

   An issue is **covered** if `issue.epicKey !== null && coveredEpicKeys.has(issue.epicKey)`.

4. **Build the completed set** — reuse `BoardConfig.doneStatusNames`. An issue is
   _completed in-sprint_ if its current `status` is in `doneStatusNames`, **or** if a
   `jira_changelogs` entry for that issue has `field = 'status'`, `toValue IN doneStatusNames`,
   and `changedAt BETWEEN sprint.startDate AND (sprint.endDate ?? NOW())`. This mirrors
   `PlanningService`.

   > **Optimisation:** only query changelogs for issues where `status` is not already done.
   > This avoids a changelog fetch for the typical majority that resolved within the sprint.

5. **Compute metrics:**
   ```
   totalIssues         = filteredIssues.length
   coveredIssues       = filteredIssues.filter(isRoadmapLinked).length
   uncoveredIssues     = totalIssues - coveredIssues
   roadmapCoverage     = totalIssues > 0 ? round(coveredIssues / totalIssues * 100, 2) : 0
   linkedCompleted     = filteredIssues.filter(i => isRoadmapLinked(i) && isCompleted(i)).length
   roadmapDeliveryRate = coveredIssues > 0 ? round(linkedCompleted / coveredIssues * 100, 2) : 0
   ```

#### 4b. `RoadmapController`

All routes prefixed `/api/roadmap`. All protected by the existing `AuthGuard`.

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `GET` | `/api/roadmap/accuracy` | `getAccuracy(?boardId, ?sprintId, ?quarter)` | Returns `RoadmapSprintAccuracy[]` |
| `GET` | `/api/roadmap/configs` | `getConfigs()` | Lists `RoadmapConfig[]` |
| `POST` | `/api/roadmap/configs` | `createConfig({ jpdKey, description })` | Adds a JPD project to sync |
| `DELETE` | `/api/roadmap/configs/:id` | `deleteConfig(id)` | Removes by numeric id |
| `POST` | `/api/roadmap/sync` | `triggerSync()` | Runs `syncRoadmaps()` immediately |

`POST /api/roadmap/configs` validates that `jpdKey` is a non-empty string (class-validator
`@IsString()` / `@IsNotEmpty()`). Duplicate keys return `409 Conflict`.

---

### 5. Frontend Changes

#### 5a. `/roadmap` page (`frontend/src/app/roadmap/page.tsx`)

Mirrors the structure of `planning/page.tsx`:

- **Board chip selector** — single-select. Kanban boards (PLAT) show a disabled chip and
  an inline info banner: _"Roadmap accuracy is not available for Kanban boards."_
- **Period toggle** — `Sprint | Quarter`. In quarter mode, per-sprint results are
  aggregated client-side (same pattern as Planning).
- **Two `TrendChart` panels** (reuse the existing `TrendChart` component):
  - _Roadmap Coverage %_ — `roadmapCoverage` per sprint/quarter, colour `#3b82f6`
  - _Roadmap Delivery Rate %_ — `roadmapDeliveryRate` per sprint/quarter, colour `#22c55e`
- **`DataTable`** — columns: Sprint/Quarter, Total Issues, Covered, Uncovered, Coverage %, Delivery Rate %
  - Row colouring: coverage < 50 % → `bg-red-50`; 50–79 % → `bg-amber-50`; ≥ 80 % → none
- **Empty state** — if no JPD config exists (`GET /api/roadmap/configs` returns `[]`):
  show `EmptyState` with message _"No roadmap data — add a JPD project key in Settings."_

#### 5b. Settings page — JPD Config section

New `<section>` added below the existing Board Configuration section in
`frontend/src/app/settings/page.tsx`. Contains:

- A read-only list of configured JPD project keys (each with a Delete button).
- An input + "Add" button to call `POST /api/roadmap/configs`.
- A "Sync Roadmaps" button that calls `POST /api/roadmap/sync`.

No new page is required; the existing settings layout absorbs this naturally.

#### 5c. Sidebar nav item

New entry in the `NAV_ITEMS` array in `frontend/src/components/layout/sidebar.tsx`:

```typescript
{ label: 'Roadmap', href: '/roadmap', icon: <Map className="h-5 w-5" /> }
```

Inserted between `Planning` and `Settings`.

#### 5d. `frontend/src/lib/api.ts` additions

```typescript
export interface RoadmapConfig {
  id: number;
  jpdKey: string;
  description: string | null;
  createdAt: string;
}

export interface RoadmapSprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  totalIssues: number;
  coveredIssues: number;
  uncoveredIssues: number;
  roadmapCoverage: number;
  linkedCompletedIssues: number;
  roadmapDeliveryRate: number;
}

export interface RoadmapAccuracyParams {
  boardId: string;
  sprintId?: string;
  quarter?: string;
}

export function getRoadmapAccuracy(params: RoadmapAccuracyParams): Promise<RoadmapSprintAccuracy[]>
export function getRoadmapConfigs(): Promise<RoadmapConfig[]>
export function createRoadmapConfig(body: { jpdKey: string; description?: string }): Promise<RoadmapConfig>
export function deleteRoadmapConfig(id: number): Promise<void>
export function triggerRoadmapSync(): Promise<{ message: string }>
```

---

### 6. Entity Index Update

`backend/src/database/entities/index.ts` gains two new exports:

```typescript
export { RoadmapConfig } from './roadmap-config.entity.js';
export { JpdIdea } from './jpd-idea.entity.js';
```

---

### Data Flow Diagram

```
[CRON / POST /api/roadmap/sync]
        │
        ▼
SyncService.syncRoadmaps()
        │
        ├─ roadmap_configs.find()  →  [{ jpdKey: "DISC" }, ...]
        │
        └─ for each jpdKey:
              JiraClientService.getJpdIdeas(jpdKey, pageToken?)
                      │  /rest/api/3/search/jql?jql=project=DISC&fields=summary,status,issuelinks
                      ▼
              map issuelinks → deliveryIssueKeys[]
              jpd_ideas.upsert()  ← on conflict: key


[GET /api/roadmap/accuracy?boardId=ACC]
        │
        ▼
RoadmapService.getAccuracy("ACC")
        │
        ├─ jira_sprints.find({ boardId:"ACC" })
        ├─ jira_issues.find({ boardId:"ACC", sprintId })
        ├─ jpd_ideas.find()  →  build coveredEpicKeys Set
        ├─ jira_changelogs (conditional, for in-sprint completion)
        └─ BoardConfig.doneStatusNames
                      │
                      ▼
              RoadmapSprintAccuracy[]  →  HTTP JSON
```

---

## Alternatives Considered

### Alternative A — Store delivery links on `jira_issues` directly

Instead of a `jpd_ideas` table, store a boolean column `isRoadmapLinked` on each
`jira_issue` row (set during sync of the epic's `issuelinks`).

**Rejected because:** it collapses the JPD idea identity into a boolean, making it
impossible to later surface which idea a sprint is contributing to, or to compute
per-idea delivery rates. It also requires that epic issues be synced into `jira_issues`
with their full `issuelinks` payload — epics are currently not explicitly synced (they
appear only as parents of stories).

### Alternative B — Query Jira live for JPD links at report time

Skip the `jpd_ideas` table; call `JiraClientService.getJpdIdeas()` on every
`GET /api/roadmap/accuracy` request.

**Rejected because:** JPD projects can have hundreds of ideas. A live query would add
1–5 seconds of latency to every page load, and would consume Jira API rate-limit budget
proportional to dashboard usage rather than sync frequency. Caching in Postgres is
consistent with the pattern used for every other Jira entity.

### Alternative C — Extend `BoardConfig` with JPD project keys

Add a `jpdProjectKey varchar nullable` column to `board_configs` so each delivery board
maps to exactly one JPD project.

**Rejected because:** the relationship is many-to-many in practice — a single JPD
project can cover multiple delivery boards, and a delivery board's epics may be tracked
under multiple JPD projects. A separate `roadmap_configs` table with a simple list of
JPD keys to sync, combined with cross-matching on `deliveryIssueKeys`, handles this
without requiring a join table.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | `ADD COLUMN jira_issues.epic_key`, new tables `roadmap_configs` and `jpd_ideas`. Migration is fully reversible. |
| API contract | Additive | Five new endpoints under `/api/roadmap/*`. No existing endpoints changed. |
| Frontend | New page + settings section + sidebar item | New `roadmap/page.tsx`; additions to `settings/page.tsx` and `sidebar.tsx`; new types in `api.ts`. |
| Tests | New unit tests | `RoadmapService.getAccuracy()` requires unit tests covering: no JPD config, Kanban board, zero epics, partial coverage, 100 % coverage. |
| Jira API | New endpoint | `GET /rest/api/3/search/jql` with `project={jpdKey}` — same endpoint already used by `searchIssues()`. Additional `parent` field added to existing sprint/kanban issue fetches. Rate-limit risk is low: JPD sync runs at most once per daily cron cycle. |
| `SyncService` | Modified | `mapJiraIssue()` updated; `syncAll()` extended; two new repositories injected. No breaking changes to existing callers. |
| `AppModule` | Additive | `RoadmapModule` added to imports array. |

---

## Open Questions

1. **Link type name casing** — Jira link type names are tenant-configurable. The known
   values are `"Delivers"` / `"is delivered by"`, but some instances use `"delivers"` or
   `"Is delivered by"`. Should the sync normalise with a case-insensitive comparison, or
   should the link type name(s) be stored in `RoadmapConfig` as a configurable field?
   _Recommendation: use case-insensitive `.toLowerCase()` comparison in sync; document
   the assumption. If a team reports missed links, the config approach can be added later._

2. **Epic key resolution for sub-tasks** — `fields.parent.key` on a sub-task is its
   parent story, not its grandparent epic. Should the mapper walk up one level (fetch the
   parent story's parent), or should sub-tasks be excluded from roadmap accuracy entirely?
   _Recommendation: exclude `issueType === 'Sub-task'` from the `totalIssues` count, as
   noted above, which sidesteps this problem entirely._

3. **`epicKey` backfill** — Existing `jira_issues` rows will have `epic_key = NULL` until
   the next sync. The first `GET /api/roadmap/accuracy` call after migration will show
   0 % coverage for all historical sprints until a full re-sync occurs. Should the
   proposal include a one-time backfill migration or is a re-sync sufficient?
   _Recommendation: a triggered re-sync (`POST /api/sync`) is sufficient; add a banner
   to the roadmap page that warns when `epicKey` coverage is low (e.g. > 80 % of issues
   have null epicKey for the selected board)._

4. **JPD `projectTypeKey` guard** — Should `JiraClientService.getJpdIdeas()` validate
   that the project returned has `projectTypeKey: "product_discovery"` before syncing,
   or should it trust the operator-supplied key?
   _Recommendation: log a warning if the JQL returns zero results and the project exists
   but is not a JPD project; do not hard-fail, as validation would require an additional
   API call per sync._

---

## Acceptance Criteria

- [ ] Migration `AddRoadmapTables` runs `up` without error on a clean schema and `down`
      restores the original schema completely.
- [ ] `jira_issues.epic_key` is populated for all newly synced issues that have an epic
      parent; issues without an epic parent have `epic_key = NULL`.
- [ ] `GET /api/roadmap/configs` returns `[]` when no JPD configs are stored.
- [ ] `POST /api/roadmap/configs` with `{ "jpdKey": "DISC" }` creates a record; a second
      `POST` with the same key returns `409 Conflict`.
- [ ] `POST /api/roadmap/sync` calls `syncRoadmaps()` and returns a success response even
      when no `roadmap_configs` rows exist (no-op, not an error).
- [ ] After syncing a JPD project, `jpd_ideas` contains one row per idea, with
      `deliveryIssueKeys` correctly populated from both outward and inward `"Delivers"`
      link directions.
- [ ] `GET /api/roadmap/accuracy?boardId=ACC` returns `RoadmapSprintAccuracy[]` with
      correct `roadmapCoverage` and `roadmapDeliveryRate` values for a known test sprint.
- [ ] `GET /api/roadmap/accuracy?boardId=PLAT` returns an empty array (Kanban board).
- [ ] `roadmapCoverage` is `0` when no JPD configs exist (no `jpd_ideas` rows).
- [ ] `roadmapDeliveryRate` is `0` when `coveredIssues = 0` (no divide-by-zero).
- [ ] Sub-tasks (`issueType === 'Sub-task'`) and epics (`issueType === 'Epic'`) are
      excluded from `totalIssues`.
- [ ] The `/roadmap` frontend page renders the two trend charts and data table for a
      scrum board with data.
- [ ] The `/roadmap` frontend page shows the "No roadmap data" empty state when no JPD
      configs are configured.
- [ ] The Settings page JPD Config section allows adding and deleting `RoadmapConfig`
      records, and the "Sync Roadmaps" button triggers a sync.
- [ ] The sidebar nav item "Roadmap" is present and highlights correctly when the route
      is active.
- [ ] All new `RoadmapService` calculation paths have unit test coverage (no JPD config,
      Kanban board, zero covered, partial covered, all covered).
