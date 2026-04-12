# 0013 — Planning Accuracy Points Metric & Issues Gaps Report

**Date:** 2026-04-12
**Status:** Accepted
**Implemented:** 2026-04-12
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

Two gaps exist in the current planning and visibility tooling:

1. **Planning Accuracy (Feature 1).** The sprint accuracy table in `planning/page.tsx`
   expresses delivery quality solely through `completionRate` (tickets completed ÷
   tickets in sprint). For Scrum boards that carry story-point estimates, this hides
   whether the *volume of work* committed was delivered — a team that completes 8 of 10
   tickets but drops both 8-point stories scores 80% on ticket count but 0% on point
   delivery. A `planningAccuracy` field — points-based for Scrum, ticket-count-based
   for Kanban — gives a richer, comparable signal without replacing the existing
   `completionRate`.

2. **Issues Gaps Report (Feature 2).** There is no cross-board view of hygiene debt:
   work items without epics (unlinked to any initiative) and work items without
   estimates (invisible to capacity planning). Both are active/in-progress issues that
   require action; they currently require manual Jira queries per board to discover.
   A `/gaps` page surfaces them in one place with board-level filtering.

---

## Proposed Solution

### Feature 1 — Planning Accuracy Column

#### 1a. Backend: extend `SprintAccuracy` in `planning.service.ts`

Add three new optional fields to the `SprintAccuracy` interface:

```typescript
export interface SprintAccuracy {
  // ... existing fields unchanged ...
  planningAccuracy: number | null;   // null = no data (0 committed issues/points)
  committedPoints: number | null;    // null = no story points on any committed issue
  completedPoints: number | null;    // null when committedPoints is null
}
```

**Calculation — Scrum boards (story-point path):**

The service already separates `committedKeys` (issues present at sprint start, within
the 5-minute grace period) from `addedKeys`. After this separation, in the same
`calculateSprintAccuracy` method, sum `issue.points` for committed issues and for
committed issues that also appear in `completedKeys`:

```
committedPoints = Σ issue.points for issue in committedKeys
                   (null points treated as 0 for the sum; see fallback rule below)

completedPoints = Σ issue.points for issue in (committedKeys ∩ completedKeys)

planningAccuracy = (committedPoints > 0)
                     ? round(completedPoints / committedPoints × 100, 1)
                     : fallback to ticket-count ratio (see below)
```

**Fallback (zero-points boards):** When `committedPoints === 0` (every committed issue
has `points = null` or `0`), fall back to ticket-count ratio — same numerator/
denominator logic as `completionRate` but restricted to committed issues only:

```
planningAccuracy = (committedKeys.size > 0)
                     ? round(completedCommittedCount / committedKeys.size × 100, 1)
                     : null
```

Where `completedCommittedCount = |committedKeys ∩ completedKeys|`.

Setting `committedPoints = null` and `completedPoints = null` in the fallback case
signals to the frontend that the percentage is ticket-count based (no tooltip needed).

**Key invariant:** Only **committed** issues (not `addedKeys`) appear in the numerator
or denominator of `planningAccuracy`. Issues added mid-sprint represent scope creep,
not planning quality.

**Data access — no new queries needed.** The `boardIssues` array is already loaded
and filtered through `isWorkItem`. Build a map `issueKey → points` alongside the
existing `issueStatusMap`:

```typescript
const issuePointsMap = new Map<string, number | null>(
  boardIssues.map((i) => [i.key, i.points]),
);
```

Critically, use `i.points` (the `JiraIssue` entity column), **not** `sprintId`.
The `committedKeys` set is already computed via the changelog-replay path — no
`WHERE sprintId = X` query is introduced.

**Empty accuracy fallback:** The `emptyAccuracy()` helper must be extended to return
`planningAccuracy: null, committedPoints: null, completedPoints: null`.

**Kanban boards:** The existing `getKanbanQuarters` / `getKanbanWeeks` methods return
`KanbanQuarterSummary` / `KanbanWeekSummary`, not `SprintAccuracy`. The `planningAccuracy`
field is **not** added to Kanban summaries — the Kanban path already has `deliveryRate`
which serves the same semantic for ticket throughput. The new column is Scrum-only.

#### 1b. Backend: `emptyAccuracy` and interface location

The `SprintAccuracy` interface is exported from `planning.service.ts` and re-exported
from the barrel. No migration is required; the three new fields are added in code only.

#### 1c. Frontend: update `SprintAccuracy` type in `api.ts`

```typescript
export interface SprintAccuracy {
  sprintId: string
  sprintName: string
  state: string
  startDate: string | null
  commitment: number
  added: number
  removed: number
  completed: number
  scopeChangePercent: number
  completionRate: number
  planningAccuracy: number | null   // NEW
  committedPoints: number | null    // NEW
  completedPoints: number | null    // NEW
}
```

#### 1d. Frontend: add column to `sprintColumns` in `planning/page.tsx`

Insert after `scopeChangePercent` column, before `completionRate`:

```tsx
{
  key: 'planningAccuracy',
  label: 'Planning Accuracy',
  sortable: true,
  render: (value, row) => {
    if (value === null || value === undefined) return <span className="text-muted">—</span>
    const pct = Number(value)
    const color =
      pct >= 90 ? 'text-green-700 font-semibold'
      : pct >= 70 ? 'text-amber-600 font-semibold'
      : 'text-red-600 font-semibold'
    // Show story-point tooltip when points data is present
    const title =
      row.committedPoints !== null
        ? `${row.completedPoints ?? 0} of ${row.committedPoints} committed points`
        : undefined
    return (
      <span className={color} title={title}>
        {pct.toFixed(1)}%
      </span>
    )
  },
},
```

**Colour bands:** ≥ 90% green, 70–89% amber, < 70% red — consistent with the
"health signal" pattern used in `completionRate` renderers elsewhere on the page.

**Quarter-mode table (`quarterColumns`):** The `QuarterRow` type is computed
client-side in `groupByQuarter()`. This function does not currently aggregate
`plannedAccuracy` from its sprint rows. The quarter-mode table **does not** add the
column in this proposal; aggregating point-based accuracy across sprints requires
a weighted average or a re-fetch from the backend, which is out of scope here. The
column is Scrum sprint-mode only for this proposal.

**Tooltip strategy:** The native HTML `title` attribute on the `<span>` is sufficient
for the hover tooltip displaying the raw points. No new component is needed.

---

### Feature 2 — Issues Gaps Report

#### 2a. New backend module: `GapsModule`

**Files to create:**

```
backend/src/gaps/
  gaps.module.ts
  gaps.controller.ts
  gaps.service.ts
```

**`GapsModule`** imports `TypeOrmModule.forFeature([JiraIssue, JiraSprint, BoardConfig])`.

Register in `AppModule`:

```typescript
import { GapsModule } from './gaps/gaps.module.js';
// In @Module imports array:
GapsModule,
```

#### 2b. `GapsService` — data access pattern

```typescript
export interface GapIssue {
  boardId: string;
  key: string;
  summary: string;
  issueType: string;
  status: string;
  sprintName: string | null;   // resolved from jira_sprints on sprintId
  createdAt: string;           // ISO 8601
  jiraUrl: string;             // ${JIRA_BASE_URL}/browse/${key}
}

export interface GapsResponse {
  missingEpic: GapIssue[];
  missingEstimate: GapIssue[];
}
```

**Design decision — `sprintId` vs changelog replay for current sprint name:**

Unlike `planning.service.ts`, `GapsService` does **not** need historical sprint
membership. The question is: "what sprint is this issue currently in?" For open/active
issues, `jira_issues.sprintId` reflects the last-synced sprint — which for open issues
is the current sprint assignment (the only sprint an open issue can be in at sync time).
Changelog replay is therefore unnecessary here; a simple join/lookup on `jira_sprints`
by `sprintId` is correct and efficient.

**Query approach:** Load all `isWorkItem` issues across all boards in two filtered
passes, joining sprint names. Use `boardConfigRepo` to load all `BoardConfig` rows
up front (one query), then filter in TypeScript to exclude done and cancelled issues
per-board. This avoids a complex multi-board SQL join while remaining correct.

Pseudocode for `getGaps()`:

```typescript
// 1. Load all board configs (keyed by boardId)
const configs = await this.boardConfigRepo.find();
const configMap = new Map(configs.map((c) => [c.boardId, c]));

// 2. Build a union of done + cancelled status names per board
//    (used to exclude issues that are not actionable)

// 3. Load all work-item issues across all boards
const allIssues = (await this.issueRepo.find())
  .filter((i) => isWorkItem(i.issueType));

// 4. Load all sprints (for sprintName resolution)
const allSprints = await this.sprintRepo.find();
const sprintMap = new Map(allSprints.map((s) => [s.id, s.name]));

// 5. Filter and classify
const missingEpic: GapIssue[] = [];
const missingEstimate: GapIssue[] = [];

for (const issue of allIssues) {
  const config = configMap.get(issue.boardId);
  const doneStatuses = config?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
  const cancelledStatuses = config?.cancelledStatusNames ?? ['Cancelled'];
  const excluded = [...doneStatuses, ...cancelledStatuses];

  if (excluded.includes(issue.status)) continue;

  const gap: GapIssue = {
    boardId: issue.boardId,
    key: issue.key,
    summary: issue.summary,
    issueType: issue.issueType,
    status: issue.status,
    sprintName: issue.sprintId ? (sprintMap.get(issue.sprintId) ?? null) : null,
    createdAt: issue.createdAt.toISOString(),
    jiraUrl: `${this.jiraBaseUrl}/browse/${issue.key}`,
  };

  if (issue.epicKey === null) missingEpic.push(gap);
  if (issue.points === null) missingEstimate.push(gap);
}
```

**Note:** An issue can appear in **both** lists (no epic AND no estimate). This is
intentional — both are independent hygiene signals.

**Sorting:** Both arrays sorted by `boardId ASC, createdAt ASC` (oldest gaps first
within each board, boards alphabetically grouped).

**`jiraBaseUrl`:** Injected via `ConfigService`, same pattern as
`sprint-detail.service.ts` which constructs `jiraUrl` as
`${jiraBaseUrl}/browse/${key}`.

#### 2c. `GapsController`

```typescript
@Controller('api/gaps')
export class GapsController {
  constructor(private readonly gapsService: GapsService) {}

  @Get()
  getGaps(): Promise<GapsResponse> {
    return this.gapsService.getGaps();
  }
}
```

Single endpoint, no query parameters in this proposal. Board filtering is handled
client-side on the frontend (all data loaded at once; the volume of open issues without
epics or estimates is not expected to exceed a few hundred rows per board, making
client-side filtering safe).

#### 2d. Frontend: `api.ts` additions

```typescript
export interface GapIssue {
  boardId: string
  key: string
  summary: string
  issueType: string
  status: string
  sprintName: string | null
  createdAt: string
  jiraUrl: string
}

export interface GapsResponse {
  missingEpic: GapIssue[]
  missingEstimate: GapIssue[]
}

export function getGaps(): Promise<GapsResponse> {
  return apiFetch<GapsResponse>('/api/gaps')
}
```

#### 2e. Frontend: new page `frontend/src/app/gaps/page.tsx`

**Page structure:**

```
/gaps
  <header>  "Issues Gaps"  subtitle
  <board filter dropdown>  — All Boards | ACC | BPT | SPS | OCS | DATA | PLAT
  <section A>  Issues without Epics (N)  [collapsible]
    <DataTable columns: Board, Key, Summary, Type, Status, Sprint, Created>
  <section B>  Issues without Estimates (N)  [collapsible]
    <DataTable columns: Board, Key, Summary, Type, Status, Sprint, Story Points, Created>
```

**Board filter:** A controlled `<select>` dropdown (not `BoardChip`, since the user
needs to be able to select "All Boards"). Options built from the unique `boardId`
values in the response or from a hardcoded `ALL_BOARDS` constant. The filter is applied
client-side by filtering the loaded arrays.

**Collapsible sections:** Implemented as local `useState<boolean>` toggles per section.
Default: both open. A chevron icon (`ChevronDown` / `ChevronUp` from `lucide-react`)
toggles them.

**Issue Key column:** Rendered as an `<a href={row.jiraUrl} target="_blank">` link with
`rel="noopener noreferrer"`, consistent with how other pages link out to Jira.

**Sprint column:** Shows `row.sprintName` when set, falls back to `"Backlog"`.

**Story Points column (Table B only):** Always shows `"—"` since all rows have
`points === null` by definition.

**Created column:** Formatted as `toLocaleDateString()` for readability.

**Row count in headers:** `"Issues without Epics (${filteredMissingEpic.length})"`.

**Loading/empty states:** Consistent with existing pages — `<Loader2>` spinner while
loading, `<EmptyState>` when both arrays are empty after filtering.

**`layout.tsx`:** Create `frontend/src/app/gaps/layout.tsx` following the identical
pattern of `planning/layout.tsx` (sets `<title>` metadata via `generateMetadata`).

#### 2f. Frontend: sidebar addition

In `frontend/src/components/layout/sidebar.tsx`, add a Gaps entry to `MAIN_NAV_ITEMS`
after the Planning entry:

```typescript
import { BarChart3, Target, Map, Settings, Timer, RefreshCw, AlertCircle } from 'lucide-react'

const MAIN_NAV_ITEMS: NavItem[] = [
  { label: 'DORA',      href: '/dora',      icon: <BarChart3 className="h-5 w-5" /> },
  { label: 'Cycle Time',href: '/cycle-time', icon: <Timer className="h-5 w-5" /> },
  { label: 'Planning',  href: '/planning',  icon: <Target className="h-5 w-5" /> },
  { label: 'Gaps',      href: '/gaps',      icon: <AlertCircle className="h-5 w-5" /> },  // NEW
  { label: 'Roadmap',   href: '/roadmap',   icon: <Map className="h-5 w-5" /> },
]
```

`AlertCircle` is appropriate for a "hygiene issues" report and is already available in
`lucide-react` (no new npm dependencies).

---

## Migration

**No database migration is required.** All data already exists:

- `JiraIssue.points` (story points) — present in the entity since initial schema
- `JiraIssue.epicKey` — present and nullable
- `JiraIssue.sprintId` — present and nullable
- `JiraSprint` — already has `name` for sprint name resolution
- `BoardConfig.cancelledStatusNames` — already a column (added in a prior proposal)

The changes are pure service/controller/frontend additions.

---

## Data Flow Diagrams

### Feature 1 — Planning Accuracy

```
GET /api/planning/accuracy?boardId=ACC
  │
  └─► PlanningService.getAccuracy()
        │
        └─► calculateSprintAccuracy(sprint)
              │
              ├─ [existing] changelog-replay → committedKeys, addedKeys, completedKeys
              │
              ├─ [NEW] issuePointsMap from boardIssues (i.points, already loaded)
              │
              ├─ [NEW] committedPoints = Σ points for key in committedKeys
              ├─ [NEW] completedPoints = Σ points for key in (committedKeys ∩ completedKeys)
              │
              └─ [NEW] planningAccuracy = committedPoints > 0
                          ? completedPoints / committedPoints × 100
                          : committedKeys.size > 0
                              ? completedCommittedCount / committedKeys.size × 100
                              : null
```

### Feature 2 — Gaps

```
GET /api/gaps
  │
  └─► GapsService.getGaps()
        │
        ├─ boardConfigRepo.find()          → Map<boardId, BoardConfig>
        ├─ issueRepo.find()                → all JiraIssue rows
        ├─ sprintRepo.find()               → Map<sprintId, sprintName>
        │
        └─ single-pass filter loop
              │
              ├─ skip if status ∈ doneStatuses ∪ cancelledStatuses
              ├─ if epicKey === null  → missingEpic[]
              └─ if points === null   → missingEstimate[]

  Response: { missingEpic: GapIssue[], missingEstimate: GapIssue[] }
```

---

## Alternatives Considered

### Alternative A — Add `planningAccuracy` to Kanban summaries too

The Kanban `deliveryRate` (`completed / issuesPulledIn × 100`) is already semantically
equivalent to "planning accuracy" for ticket-count Kanban. Introducing a second field
with the same value under a different name would confuse consumers. The Kanban table
already has `deliveryRate`; Feature 1 adds nothing new there.

Ruled out: unnecessary duplication.

### Alternative B — Server-side board filtering for the Gaps endpoint

Accept a `?boardId=` query parameter and filter in the database query. This reduces
payload size when there are many boards, but adds complexity to the endpoint. Given
the single-user, internal-tool context and the expectation of at most a few hundred
open issues without epics/estimates across all boards, client-side filtering is
simpler and adequate.

Ruled out for now: the endpoint can be extended later if volume becomes an issue.

### Alternative C — Reuse `PlanningService` to compute `planningAccuracy` for the Quarter view

Quarter-mode groups sprint rows client-side. Aggregating `planningAccuracy` across
sprints into a quarter-level percentage would require either:
(a) a weighted average by `committedPoints` (correct but complex), or
(b) a new dedicated backend endpoint.

Ruled out for this proposal: the quarter-mode table is less commonly used, and adding
a weighted average client-side requires surfacing raw numerator/denominator values
(which the proposal already adds as `committedPoints`/`completedPoints`). A follow-up
proposal can extend this when the need is confirmed.

### Alternative D — Separate endpoints for missingEpic and missingEstimate

Two endpoints (`GET /api/gaps/missing-epic`, `GET /api/gaps/missing-estimate`) would
allow independent loading and filtering. In practice both datasets are loaded in a
single pass over the issues table — splitting them into two HTTP calls provides no
backend efficiency gain and doubles the number of loading states on the frontend.

Ruled out: single endpoint is simpler with no trade-off.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No new entities, no migrations. All columns exist. |
| API contract | Additive only | `SprintAccuracy` gains 3 new optional fields. New endpoint `GET /api/gaps`. No existing field is removed or renamed. |
| Frontend | New page + sidebar item + column | New `/gaps` page and layout. One new column in sprint accuracy table. `api.ts` type changes are additive. |
| Tests | New unit tests required | `calculateSprintAccuracy` needs point-sum tests: all points set, some null, all null (fallback), zero committed issues. `GapsService.getGaps()` needs: issue excluded by doneStatus, excluded by cancelledStatus, appears in both lists, sprintName resolved, Backlog when sprintId null. |
| Jira API | No new calls | All data sourced from local Postgres. |
| Performance | Low risk | `GapsService.getGaps()` loads all issues once. Worst case ~5 boards × ~1000 issues each = 5000 rows — well within acceptable range for a single synchronous load. |
| `isWorkItem` consistency | Enforced | Both `PlanningService` (existing) and `GapsService` (new) apply `isWorkItem(i.issueType)` to exclude Epics and Sub-tasks. |

---

## Open Questions

1. **Quarter-mode `planningAccuracy` aggregation.** The quarter-mode table
   (`quarterColumns`) does not get the new column in this proposal. Is there appetite
   to add a weighted-average `planningAccuracy` to quarter rows? This would require
   surfacing `committedPoints` and `completedPoints` numerics from the API (already
   done) and computing a weighted average client-side in `groupByQuarter()`. Low
   effort; deferred for now.

2. **`points === 0` vs `points === null`.** The current entity allows `points = 0` as a
   distinct value from `points = null`. Should `0`-point issues be treated the same as
   null (unestimated) in the Gaps "missing estimate" table? Current proposal treats
   `null`-only as unestimated. Confirm whether `points = 0` is ever meaningfully set in
   Jira (e.g., for sub-tasks) or always represents an oversight.

3. **Cross-board `ALL_BOARDS` constant.** The gaps page builds its board filter from
   the loaded data's `boardId` values, supplemented by the `ALL_BOARDS` constant from
   `@/store/filter-store`. Confirm this constant is kept in sync with board configuration
   and does not need to be fetched dynamically from `GET /api/boards`.

4. **Gaps page — live vs sync-time data.** The report reflects the Postgres snapshot at
   last sync time. Should the page surface a "last synced" timestamp to make this clear?
   A small timestamp note under the section headers would be low effort if desired.

5. **`planningAccuracy` in the `emptyAccuracy` path.** The `emptyAccuracy()` helper
   is also called when `logsByIssue.size === 0` (no sprint changelog at all). In this
   case `planningAccuracy: null` is the correct value, distinct from `0%`. Confirm
   the frontend renders null as `"—"` rather than `"0.0%"` in all table paths.

---

## Phased Implementation Plan

The following ordered tasks are intended for the developer agent. Each task is
independently deployable (backend changes are additive; frontend handles `null`
gracefully).

### Phase 1 — Backend: extend `SprintAccuracy` with planning accuracy points

**Task 1.1** — `backend/src/planning/planning.service.ts`

- Add `planningAccuracy: number | null`, `committedPoints: number | null`,
  `completedPoints: number | null` to the `SprintAccuracy` interface.
- In `calculateSprintAccuracy()`, after the existing committed/added/removed loop:
  - Build `issuePointsMap` from `boardIssues`.
  - Compute `committedPoints` by summing `issuePointsMap.get(key) ?? 0` for each
    key in `committedKeys`. Store as `null` if every committed issue has
    `points === null` (use a flag or check the raw sum).
  - Compute `completedPoints` as the same sum restricted to keys in both
    `committedKeys` and `completedKeys`.
  - Compute `planningAccuracy` using the points path if `committedPoints > 0`,
    otherwise the ticket-count fallback.
- Update `emptyAccuracy()` to include the three new fields as `null`.
- Update the `return` statement in `calculateSprintAccuracy()`.

**Task 1.2** — `backend/src/planning/planning.service.spec.ts`

- Add test cases for the new fields:
  - All committed issues have points: accuracy = completedPoints / committedPoints.
  - Some committed issues have null points: null points contribute 0 to the sums.
  - All committed issues have null points: falls back to ticket-count ratio.
  - Zero committed issues: `planningAccuracy = null`.
  - Committed issues, zero completed: `planningAccuracy = 0`.

### Phase 2 — Frontend: add Planning Accuracy column

**Task 2.1** — `frontend/src/lib/api.ts`

- Extend `SprintAccuracy` interface with the three new fields
  (`planningAccuracy: number | null`, `committedPoints: number | null`,
  `completedPoints: number | null`).

**Task 2.2** — `frontend/src/app/planning/page.tsx`

- In `sprintColumns` (`useMemo`), add the `planningAccuracy` column definition after
  `scopeChangePercent` with the colour-banded render function and `title` tooltip
  (points detail when `committedPoints !== null`).
- No changes to `QuarterRow`, `quarterColumns`, `KanbanQuarterSummary`, or chart data
  arrays are required.

### Phase 3 — Backend: new Gaps module

**Task 3.1** — Create `backend/src/gaps/gaps.service.ts`

- Define and export `GapIssue` and `GapsResponse` interfaces.
- Implement `GapsService` with `getGaps()` method as described in §2b.
- Inject `ConfigService` to read `JIRA_BASE_URL` (same env var used elsewhere).
- Apply `isWorkItem` filter from `../metrics/issue-type-filters.js`.
- Sort both result arrays: `boardId ASC`, then `createdAt ASC`.

**Task 3.2** — Create `backend/src/gaps/gaps.controller.ts`

- Single `@Get()` handler on `@Controller('api/gaps')` delegating to `GapsService`.
- No DTO / validation needed for the parameterless GET endpoint.

**Task 3.3** — Create `backend/src/gaps/gaps.module.ts`

- `TypeOrmModule.forFeature([JiraIssue, JiraSprint, BoardConfig])`.
- Declare controller and provider; no exports needed.

**Task 3.4** — `backend/src/app.module.ts`

- Import `GapsModule` and add to the `imports` array (after `WeekModule`, before
  `HealthModule`, to maintain approximate alphabetical order among feature modules).

**Task 3.5** — Unit tests for `GapsService`

- Issue with `epicKey = null`, active status → appears in `missingEpic`.
- Issue with `points = null`, active status → appears in `missingEstimate`.
- Issue with both → appears in both lists.
- Issue with done status (per `doneStatusNames`) → excluded from both.
- Issue with cancelled status → excluded from both.
- `sprintName` resolved correctly from `sprintMap`; null when `sprintId = null`.

### Phase 4 — Frontend: Gaps page

**Task 4.1** — `frontend/src/lib/api.ts`

- Add `GapIssue`, `GapsResponse` interfaces and `getGaps()` fetch wrapper.

**Task 4.2** — Create `frontend/src/app/gaps/layout.tsx`

- Mirror the pattern of `frontend/src/app/planning/layout.tsx`; set title "Gaps".

**Task 4.3** — Create `frontend/src/app/gaps/page.tsx`

- `'use client'` page using `useState` for board filter, collapse toggles, loading,
  and data.
- Fetch from `getGaps()` on mount.
- Board filter `<select>`: options "All Boards" + sorted unique `boardId` values.
- Two collapsible sections with `ChevronDown`/`ChevronUp` icons.
- `DataTable<GapIssue>` for each section (from `@/components/ui/data-table`).
- Column definitions as specified in §2e.
- Issue Key column: `<a href={row.jiraUrl} target="_blank" rel="noopener noreferrer">`.
- Sprint column render: `row.sprintName ?? 'Backlog'`.
- Created column render: `new Date(row.createdAt).toLocaleDateString()`.
- `<EmptyState>` when both filtered arrays are empty.

**Task 4.4** — `frontend/src/components/layout/sidebar.tsx`

- Import `AlertCircle` from `lucide-react`.
- Add Gaps nav item to `MAIN_NAV_ITEMS` between Planning and Roadmap.

---

## Acceptance Criteria

### Feature 1 — Planning Accuracy

- [ ] `SprintAccuracy` returned by `GET /api/planning/accuracy` includes
      `planningAccuracy`, `committedPoints`, and `completedPoints` fields.

- [ ] For a sprint where all committed issues have story points set:
      `planningAccuracy = round(completedPoints / committedPoints × 100, 1)`.
      Only committed issues (not mid-sprint additions) contribute to the numerator
      and denominator.

- [ ] For a sprint where no committed issues have story points:
      `planningAccuracy` falls back to
      `round(completedCommittedCount / committedKeys.size × 100, 1)`,
      `committedPoints = null`, `completedPoints = null`.

- [ ] For a sprint with zero committed issues: `planningAccuracy = null`,
      `committedPoints = null`, `completedPoints = null`.

- [ ] `emptyAccuracy()` returns `planningAccuracy: null, committedPoints: null,
      completedPoints: null`.

- [ ] The Planning page sprint table renders a "Planning Accuracy" column after
      "Scope Change %", using green (≥ 90%), amber (70–89%), red (< 70%) colour bands.

- [ ] When `committedPoints` is non-null, hovering the planning accuracy value shows
      a tooltip: `"X of Y committed points"`.

- [ ] When `planningAccuracy` is `null`, the cell renders `"—"` (not `"0.0%"`).

- [ ] Kanban summaries (`KanbanQuarterSummary`, `KanbanWeekSummary`) are unchanged.

- [ ] No new database queries are introduced; points are read from the already-loaded
      `boardIssues` array.

### Feature 2 — Gaps Report

- [ ] `GET /api/gaps` returns `{ missingEpic: GapIssue[], missingEstimate: GapIssue[] }`.

- [ ] `missingEpic` contains all `isWorkItem` issues across all boards where
      `epicKey IS NULL` and status is not in `doneStatusNames` or `cancelledStatusNames`.

- [ ] `missingEstimate` contains all `isWorkItem` issues across all boards where
      `points IS NULL` and status is not in `doneStatusNames` or `cancelledStatusNames`.

- [ ] An issue with both `epicKey = null` and `points = null` appears in both lists.

- [ ] `sprintName` is the sprint name from `jira_sprints` joined on `sprintId`.
      When `sprintId` is null, `sprintName` is null.

- [ ] `jiraUrl` is constructed as `${JIRA_BASE_URL}/browse/${key}`.

- [ ] Both arrays are sorted `boardId ASC, createdAt ASC`.

- [ ] A new "Gaps" link (`/gaps`) appears in the sidebar after "Planning".

- [ ] The Gaps page shows two collapsible sections with row counts in their headers.

- [ ] The board filter dropdown allows filtering both tables to a single board.

- [ ] Issue Key links open `jiraUrl` in a new tab.

- [ ] Sprint column shows sprint name or `"Backlog"` when `sprintName` is null.

- [ ] When both filtered arrays are empty, `<EmptyState>` is shown.

- [ ] `lucide-react` `AlertCircle` icon is used for the sidebar entry. No new npm
      dependencies are introduced.
