# 0004 — Quarter Detail View

**Date:** 2026-04-10
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** [ADR-0016](../decisions/0016-quarter-detail-view.md)

---

## Problem Statement

The Roadmap page surfaces aggregate quarter-level metrics — issue counts, roadmap
coverage percentages, and delivery rates — but provides no path from a quarter row to
the individual tickets that make up those numbers. A team that sees low roadmap coverage
for Q2 2025 cannot, within the tool, discover which specific issues were uncovered,
which were added after the quarter began, or which were actually completed.

The Sprint Detail View (Proposal 0002) solved this gap for sprint-bounded boards. Kanban
boards and the quarter-mode view of Scrum boards have an equivalent need: a calendar-
period drill-down that shows every issue assigned to a quarter, annotated with the same
richness as the sprint view but adapted to calendar-period semantics (no sprint membership
reconstruction needed; board-entry date determines quarter assignment instead).

Without this feature, the roadmap quarter table is a dead end: aggregate numbers with no
drill-through, requiring teams to leave the dashboard and filter Jira manually.

---

## Proposed Solution

### Overview

```
[Roadmap page — quarter-mode table row click]
                     │
       /quarter/[boardId]/[quarter]   (Next.js page)
                     │
     GET /api/quarters/:boardId/:quarter/detail
                     │
             QuarterDetailService
                     │
    ┌────────────────┴───────────────────────┐
    │                                        │
BoardConfig (1 row)               JiraIssue (N rows, boardId scoped)
JiraChangelog (status-field       JiraChangelog (board-entry date
  + Sprint/status-field,            changelogs, bulk)
  bulk for completedInQuarter)    RoadmapConfig (all rows) + JpdIdea
                                    (for linkedToRoadmap annotation)
```

A new `QuarterModule` owns a `QuarterDetailService` and a thin `QuarterController`. It
follows the same module boundary and dependency rules as `SprintModule` but uses calendar-
period semantics rather than sprint-membership reconstruction.

The frontend page is a new Next.js dynamic route at
`frontend/src/app/quarter/[boardId]/[quarter]/page.tsx`. No new npm packages are
required. No new database migrations are required (all needed data is in existing tables
and the `jira_changelogs(issueKey, field)` index is already added by the Sprint Detail
migration).

---

### 1. Navigation — Entry Point

The single entry point is the Roadmap page in **quarter mode** (`/roadmap`).

#### 1a. Quarter-mode `DataTable` — `quarter` column gains a `<Link>`

In `frontend/src/app/roadmap/page.tsx`, the `quarterColumns` definition (line 380–408)
adds a `render` override to the `quarter` column:

```tsx
// In roadmap/page.tsx — modify quarterColumns definition
{
  key: 'quarter',
  label: 'Quarter',
  sortable: true,
  render: (value) => (
    <Link
      href={`/quarter/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(String(value))}`}
      className="font-medium text-blue-600 hover:underline"
    >
      {String(value)}
    </Link>
  ),
},
```

`selectedBoard` is already available in scope. `value` is the `QuarterRow.quarter`
string (e.g. `"2025-Q2"`). No query parameters are appended to the link URL at
navigation time — the quarter detail page loads roadmap linkage from all configured
`RoadmapConfig` rows automatically (see §4d).

The existing sprint-mode `sprintColumns` remain unchanged. The Kanban board path through
`roadmap/page.tsx` already forces `periodType === 'quarter'` automatically, so this link
applies to both Scrum and Kanban boards.

#### 1b. URL Structure

```
/quarter/[boardId]/[quarter]
```

Examples:
- `/quarter/PLAT/2025-Q2`
- `/quarter/ACC/2026-Q1`

`quarter` is a URL-safe string (`YYYY-QN` format, e.g. `2025-Q2`). `boardId` and
`quarter` are both required path parameters.

The page does **not** appear in the sidebar navigation. `NAV_ITEMS` in
`frontend/src/components/layout/sidebar.tsx` is left unchanged.

#### 1c. Back Navigation

The page renders a back-link to `/roadmap`. Because the entry point is always the
Roadmap page, no `?from=` parameter is needed. The link reads "← Roadmap" and navigates
to `/roadmap`.

---

### 2. Data Model — What Is Already Available

**No new database migrations are required.** Every annotation can be derived from
existing tables using already-synced data. The `(issueKey, field)` index on
`jira_changelogs` added by the Sprint Detail migration already covers the queries
needed here.

| Source entity | Fields used | Already present? |
|---|---|---|
| `JiraIssue` | `key`, `summary`, `status`, `issueType`, `priority`, `points`, `epicKey`, `labels`, `createdAt`, `boardId` | ✅ |
| `JiraChangelog` | `issueKey`, `field`, `fromValue`, `toValue`, `changedAt` | ✅ |
| `BoardConfig` | `boardType`, `doneStatusNames`, `incidentIssueTypes`, `incidentLabels`, `failureIssueTypes`, `failureLabels` | ✅ |
| `RoadmapConfig` | `jpdKey` (all configured rows; all `jpdKey` values are collected to build `coveredEpicKeys`) | ✅ |
| `JpdIdea` | `deliveryIssueKeys`, `jpdKey` | ✅ |

**Note on `JiraIssue.priority`:** The `priority` column is `nullable` on the entity
(`priority!: string | null`). The Quarter Detail View exposes it as-is. No default
value is needed; `null` is a valid response value.

**Note on `JiraIssue.points`:** The `points` column is `float | null` on the entity.
`totalPoints` and `completedPoints` in the summary treat `null` as 0 for summation.

**Note on `boardType`:** The quarter detail endpoint is valid for **both** Scrum and
Kanban boards. Unlike the Sprint Detail View (which rejects Kanban boards with 400),
the Quarter View is the correct drill-down for both board types. The `boardType` from
`BoardConfig` determines which board-entry date algorithm is used (see §4b).

---

### 3. Backend API

#### 3a. Module Location: New `QuarterModule`

The feature belongs in a new, narrow `quarter` module — not in `roadmap` (roadmap
concerns JPD alignment, not calendar-period issue breakdown), not in `planning`
(planning concerns sprint commitment vs. delivery), not in `sprint` (sprint concerns
sprint-bounded membership reconstruction, which is inapplicable here).

```
backend/src/quarter/
  quarter.module.ts
  quarter.controller.ts
  quarter-detail.service.ts
  dto/
    quarter-detail-query.dto.ts
```

This maintains the existing dependency rule: calculation logic in services, controllers
thin, no circular module imports.

#### 3b. Endpoint

```
GET /api/quarters/:boardId/:quarter/detail
```

Protected by `ApiKeyAuthGuard` (same as all other controllers).

**Request parameters:**

| Parameter | In | Type | Required | Description |
|---|---|---|---|---|
| `boardId` | path | `string` | ✅ | Board identifier (e.g. `PLAT`, `ACC`) |
| `quarter` | path | `string` | ✅ | Quarter string in `YYYY-QN` format (e.g. `2025-Q2`) |

**Error responses:**

| Status | Condition |
|---|---|
| `400 Bad Request` | `quarter` path parameter does not match `YYYY-QN` format |

**Empty response (not 404):** If `boardId` has no issues assigned to the given quarter,
return a valid `QuarterDetailResponse` with an empty `issues[]` array and zeroed summary
counts. This matches the brief requirement and is consistent with the roadmap accuracy
endpoint which returns `[]` for boards with no data (rather than 404).

#### 3c. Response DTO

```typescript
// backend/src/quarter/quarter-detail.service.ts — exported interfaces

export interface QuarterDetailIssue {
  /** Jira issue key, e.g. "PLAT-45" */
  key: string;

  /** Issue summary / title */
  summary: string;

  /** Jira issue type, e.g. "Story", "Bug", "Task" */
  issueType: string;

  /** Issue priority as stored in Jira, or null if not set */
  priority: string | null;

  /** Current status at time of last sync */
  status: string;

  /** Story points, or null if not estimated */
  points: number | null;

  /** Epic key this issue belongs to, or null */
  epicKey: string | null;

  /**
   * The quarter string this issue is assigned to.
   * Always equals the `quarter` path parameter for issues in the response.
   */
  assignedQuarter: string;

  /**
   * True if this issue transitioned to any of the board's doneStatusNames
   * within the quarter's calendar date range [quarterStart, quarterEnd].
   * If no BoardConfig exists, defaults are ['Done', 'Closed', 'Released'].
   */
  completedInQuarter: boolean;

  /**
   * True if the issue's boardEntryDate is strictly after the quarter start date.
   * i.e. the issue was not present at the beginning of the quarter.
   * boardEntryDate is derived using board-type-specific logic (see §4b).
   */
  addedMidQuarter: boolean;

  /**
   * True if issue.epicKey appears in any JpdIdea.deliveryIssueKeys across all
   * configured RoadmapConfig rows (mirrors SprintDetailService pattern).
   * False when no RoadmapConfig rows exist, or when epicKey is null.
   */
  linkedToRoadmap: boolean;

  /**
   * True if issueType is in BoardConfig.incidentIssueTypes OR any label is in
   * BoardConfig.incidentLabels. Defaults to BoardConfig defaults when no config row
   * exists for this boardId.
   */
  isIncident: boolean;

  /**
   * True if issueType is in BoardConfig.failureIssueTypes OR any label is in
   * BoardConfig.failureLabels. Defaults to BoardConfig defaults when no config row
   * exists for this boardId.
   */
  isFailure: boolean;

  /** Issue labels */
  labels: string[];

  /**
   * ISO 8601 date string representing when this issue entered the board.
   * For Scrum boards: earliest Sprint-field changelog changedAt for this issue.
   * For Kanban boards: earliest 'To Do → *' status changelog changedAt, or
   *   issue.createdAt as fallback.
   */
  boardEntryDate: string;

  /**
   * Deep link to the issue in Jira Cloud.
   * Constructed as: `${JIRA_BASE_URL}/browse/${key}`
   * Empty string if JIRA_BASE_URL is not configured.
   */
  jiraUrl: string;
}

export interface QuarterDetailSummary {
  /** Total number of issues assigned to this quarter */
  totalIssues: number;

  /** Count of issues where completedInQuarter = true */
  completedIssues: number;

  /** Count of issues where addedMidQuarter = true */
  addedMidQuarter: number;

  /** Count of issues where linkedToRoadmap = true */
  linkedToRoadmap: number;

  /** Sum of points for all issues in the quarter (null points treated as 0) */
  totalPoints: number;

  /** Sum of points for issues where completedInQuarter = true (null points treated as 0) */
  completedPoints: number;
}

export interface QuarterDetailResponse {
  /** The boardId path parameter echoed back */
  boardId: string;

  /** The quarter string, e.g. "2025-Q2" */
  quarter: string;

  /** ISO 8601 — start of quarter (inclusive), midnight UTC */
  quarterStart: string;

  /** ISO 8601 — end of quarter (inclusive), end-of-day UTC */
  quarterEnd: string;

  /** The doneStatusNames used to compute completedInQuarter */
  doneStatusNames: string[];

  /** Aggregate summary bar counts */
  summary: QuarterDetailSummary;

  /**
   * All issues assigned to this quarter for this board.
   * Epics and Sub-tasks are excluded.
   * Sorted: incomplete issues first (alphabetical by key), then completed.
   */
  issues: QuarterDetailIssue[];
}
```

#### 3d. Controller (thin)

```typescript
// backend/src/quarter/quarter.controller.ts

@ApiTags('quarters')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('api/quarters')
export class QuarterController {
  constructor(private readonly quarterDetailService: QuarterDetailService) {}

  @ApiOperation({ summary: 'Get annotated ticket-level breakdown for a quarter' })
  @Get(':boardId/:quarter/detail')
  async getDetail(
    @Param('boardId') boardId: string,
    @Param('quarter') quarter: string,
  ): Promise<QuarterDetailResponse> {
    return this.quarterDetailService.getDetail(boardId, quarter);
  }
}
```

---

### 4. Backend Service: `QuarterDetailService`

#### 4a. Query Strategy — Single Coordinated Pass

The service avoids N+1 queries using the same bulk-load pattern as `SprintDetailService`
and `RoadmapService`:

1. **Parse and validate** `quarter` string → derive `quarterStart` / `quarterEnd` dates.
   Throw `BadRequestException` if format is invalid. (No DB query.)
2. **Load `BoardConfig`** (1 query) — extract `boardType` and `doneStatusNames`.
3. **Load all board issues** (1 query, `boardId` scoped) — filter out Epics and Sub-tasks.
4. **Load board-entry date changelogs** (1 query, bulk) — the field and filter differ by
   board type (see §4b).
5. **Determine `boardEntryDate` per issue** (in-memory) → filter issues to those assigned
   to this quarter (entry date falls within `[quarterStart, quarterEnd]`).
6. **Load status-field changelogs** for quarter-member issues (1 query, bulk) — used for
   `completedInQuarter`.
7. **Load `RoadmapConfig` rows and `JpdIdea` rows** for `linkedToRoadmap` set (1–2
   queries, conditionally executed) — see §4d.

Total: 5–7 database round-trips regardless of quarter size. No unbounded queries. No
`find()` without a `where` clause.

#### 4b. Board-Entry Date Logic (must match `roadmap.service.ts` exactly)

The `boardEntryDate` per issue determines which quarter the issue belongs to. The
algorithm matches `RoadmapService.getKanbanAccuracy()` exactly:

**For Kanban boards** (`boardConfig.boardType === 'kanban'`):

```
boardEntryChangelogs = changelogRepo.createQueryBuilder('cl')
  .where('cl.issueKey IN (:...keys)', { keys: allIssueKeys })
  .andWhere('cl.field = :field', { field: 'status' })
  .andWhere('cl.fromValue = :from', { from: 'To Do' })
  .orderBy('cl.changedAt', 'ASC')
  .getMany()

// Build map: issueKey → earliest changedAt where fromValue = 'To Do'
boardEntryMap: Map<string, Date> = {}
for cl in boardEntryChangelogs:
  if issueKey not in boardEntryMap:
    boardEntryMap[issueKey] = cl.changedAt

// For issues with no such changelog, fall back to issue.createdAt
boardEntryDate(issue) = boardEntryMap.get(issue.key) ?? issue.createdAt
```

This exactly mirrors `RoadmapService.getKanbanAccuracy()` lines 166–179.

**For Scrum boards** (`boardConfig.boardType !== 'kanban'`):

```
sprintChangelogs = changelogRepo.createQueryBuilder('cl')
  .where('cl.issueKey IN (:...keys)', { keys: allIssueKeys })
  .andWhere('cl.field = :field', { field: 'Sprint' })
  .orderBy('cl.changedAt', 'ASC')
  .getMany()

// Build map: issueKey → earliest changedAt of any Sprint-field changelog
sprintEntryMap: Map<string, Date> = {}
for cl in sprintChangelogs:
  if issueKey not in sprintEntryMap:
    sprintEntryMap[issueKey] = cl.changedAt

// For issues with no Sprint changelog (created directly into a sprint),
// fall back to issue.createdAt
boardEntryDate(issue) = sprintEntryMap.get(issue.key) ?? issue.createdAt
```

**Critical note on Scrum board-entry date vs. `RoadmapService`:** The roadmap service
uses `issue.sprintId` to look up sprint `startDate` for board-entry timing on Scrum
boards (in `calculateSprintAccuracy()`). The quarter detail view uses a different but
consistent approach: the earliest Sprint-field changelog `changedAt` is the moment the
issue first appeared in any sprint, which is the conceptual "board entry" for a Scrum
board. This is the same data used by `SprintDetailService` for membership reconstruction
but applied to determine quarter assignment rather than sprint membership. When no Sprint
changelog exists and `issue.sprintId` is set, `issue.createdAt` is a reasonable fallback
(the issue was created directly into a sprint).

**Quarter assignment filter:**

```typescript
function issueToQuarterKey(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${q}`;
}

// Filter: only include issues whose boardEntryDate falls in the requested quarter
const quarterIssues = allIssues.filter(
  (issue) => issueToQuarterKey(boardEntryDate(issue)) === quarter
);
```

This `issueToQuarterKey` function is identical to `RoadmapService.issueToQuarterKey()`
(lines 259–262 of `roadmap.service.ts`). It must produce the same bucketing.

#### 4c. Quarter Date Range Derivation

The `YYYY-QN` string is parsed server-side into a precise UTC date range. This
replicates the `RoadmapService.quarterToDates()` method (lines 362–374):

```typescript
function parseQuarter(quarter: string): { quarterStart: Date; quarterEnd: Date } {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) {
    throw new BadRequestException(
      'Invalid quarter format. Expected YYYY-QN e.g. 2025-Q2',
    );
  }
  const year = parseInt(match[1], 10);
  const q = parseInt(match[2], 10);
  const startMonth = (q - 1) * 3;
  return {
    quarterStart: new Date(year, startMonth, 1, 0, 0, 0, 0),
    quarterEnd:   new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
  };
}
```

Quarter boundaries:
| Quarter | Start | End |
|---|---|---|
| Q1 | Jan 1 00:00:00.000 | Mar 31 23:59:59.999 |
| Q2 | Apr 1 00:00:00.000 | Jun 30 23:59:59.999 |
| Q3 | Jul 1 00:00:00.000 | Sep 30 23:59:59.999 |
| Q4 | Oct 1 00:00:00.000 | Dec 31 23:59:59.999 |

All dates use the server's local time. If the server runs in UTC (as expected in Docker),
these are UTC boundaries.

**Note on `new Date(year, month, 0)`:** JavaScript's `new Date(y, m, 0)` returns the
last day of month `m-1`. This is the same expression used in `RoadmapService` and
correctly produces Mar 31, Jun 30, Sep 30, Dec 31 for Q1–Q4 respectively.

#### 4d. Annotation Derivation Rules

For each issue in `quarterIssues` (Epics and Sub-tasks already excluded in §4a step 3):

**`completedInQuarter`**

Uses the status-field changelogs bulk-loaded in step 6 of §4a:

```
issueLogs = statusChangelogsByIssue.get(issue.key) ?? []

completedByChangelog = issueLogs.some(cl =>
  doneStatusNames.includes(cl.toValue ?? '')
  && cl.changedAt >= quarterStart
  && cl.changedAt <= quarterEnd
)

// Fallback: no changelog at all AND current status is done
// (mirrors SprintDetailService.completedInSprint fallback logic)
completedInQuarter =
  completedByChangelog
  || (issueLogs.length === 0 && doneStatusNames.includes(issue.status))
```

Default `doneStatusNames` when no `BoardConfig` exists: `['Done', 'Closed', 'Released']`.

**`addedMidQuarter`**

```
addedMidQuarter = boardEntryDate(issue) > quarterStart
```

Strictly greater than `quarterStart` (midnight on the first day of the quarter). An
issue whose `boardEntryDate` is exactly `quarterStart` is treated as present from the
start of the quarter. This mirrors the `addedMidSprint` logic semantics in
`SprintDetailService` (where `> sprint.startDate + grace period`), adapted for calendar
semantics (no grace period needed — board-entry dates are historical and not subject to
Jira bulk-add delay confusion).

**`linkedToRoadmap`**

Mirrors `SprintDetailService` exactly — uses all configured `RoadmapConfig` rows,
not an explicit `jpdKey` query param:

```
// Load all configured RoadmapConfig rows (already loaded in step 7 of §4a)
roadmapConfigs = roadmapConfigRepo.find()

// Collect all jpdKey values from configured rows
configuredJpdKeys = roadmapConfigs.map(rc => rc.jpdKey)

if configuredJpdKeys.length === 0:
  // No RoadmapConfig rows → linkedToRoadmap = false for all issues
  coveredEpicKeys = new Set()
else:
  // Load all JpdIdea rows for any configured jpdKey
  ideas = jpdIdeaRepo.find({ where: { jpdKey: In(configuredJpdKeys) } })
  coveredEpicKeys = new Set(
    ideas.flatMap(idea => idea.deliveryIssueKeys ?? []).filter(Boolean)
  )

linkedToRoadmap = issue.epicKey !== null && coveredEpicKeys.has(issue.epicKey)
```

This is the same algorithm as `SprintDetailService`. `linkedToRoadmap` will be `true`
for any issue whose `epicKey` appears in any JPD idea's `deliveryIssueKeys` across all
configured roadmap projects. If no `RoadmapConfig` rows exist, `linkedToRoadmap = false`
for all issues.

**`isIncident`**

Uses the `BoardConfig` for this `boardId` (already loaded in step 2 of §4a):

```
incidentIssueTypes = boardConfig?.incidentIssueTypes ?? DEFAULT_INCIDENT_ISSUE_TYPES
incidentLabels     = boardConfig?.incidentLabels     ?? DEFAULT_INCIDENT_LABELS

isIncident =
  incidentIssueTypes.includes(issue.issueType)
  || issue.labels.some(l => incidentLabels.includes(l))
```

Defaults to the `BoardConfig` entity defaults when no config row exists for the given
`boardId`. This is the same logic as used in `DoraService` / `BoardConfig`-driven MTTR
and CFR calculations.

**`isFailure`**

```
failureIssueTypes = boardConfig?.failureIssueTypes ?? DEFAULT_FAILURE_ISSUE_TYPES
failureLabels     = boardConfig?.failureLabels     ?? DEFAULT_FAILURE_LABELS

isFailure =
  failureIssueTypes.includes(issue.issueType)
  || issue.labels.some(l => failureLabels.includes(l))
```

Same pattern as `isIncident`, using the `failureIssueTypes` and `failureLabels` fields
from `BoardConfig`.

**`boardEntryDate`** (field on `QuarterDetailIssue`)

```
boardEntryDate = (boardEntryDate(issue) as derived in §4b).toISOString()
```

Returned as ISO 8601 string.

**`assignedQuarter`**

```
assignedQuarter = quarter  // always equals the request path parameter
```

Included in the per-issue payload for client convenience (avoids client having to
re-derive which quarter the issue belongs to).

**`jiraUrl`**

```
jiraUrl = JIRA_BASE_URL
  ? `${JIRA_BASE_URL}/browse/${issue.key}`
  : ''
```

Read from `ConfigService.get<string>('JIRA_BASE_URL', '')`. If absent, log a one-time
warning in the constructor; return `''` for all issues.

#### 4e. Summary Computation

After building `issues[]`, compute `summary` in a single pass:

```typescript
const summary: QuarterDetailSummary = {
  totalIssues:      issues.length,
  completedIssues:  issues.filter(i => i.completedInQuarter).length,
  addedMidQuarter:  issues.filter(i => i.addedMidQuarter).length,
  linkedToRoadmap:  issues.filter(i => i.linkedToRoadmap).length,
  totalPoints:      issues.reduce((acc, i) => acc + (i.points ?? 0), 0),
  completedPoints:  issues
    .filter(i => i.completedInQuarter)
    .reduce((acc, i) => acc + (i.points ?? 0), 0),
};
```

#### 4f. Issue Sorting

```typescript
issues.sort((a, b) => {
  if (a.completedInQuarter !== b.completedInQuarter) {
    return a.completedInQuarter ? 1 : -1;  // incomplete first
  }
  return a.key.localeCompare(b.key);  // alphabetical by key within each group
});
```

This matches the sort order in `SprintDetailService`.

#### 4g. Module Definition

```typescript
// backend/src/quarter/quarter.module.ts

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraIssue,
      JiraChangelog,
      BoardConfig,
      JpdIdea,
      RoadmapConfig,  // required: all rows loaded to build coveredEpicKeys for linkedToRoadmap
    ]),
  ],
  controllers: [QuarterController],
  providers: [QuarterDetailService],
})
export class QuarterModule {}
```

`QuarterModule` is added to the `imports` array of `AppModule`. No other existing
modules are modified.

`JiraSprint` is **not** imported — the quarter detail view does not load sprint records.
Board-entry date for Scrum boards is derived from Sprint-field changelogs directly.

`RoadmapConfig` is imported and required: all configured `RoadmapConfig` rows are
loaded to build `coveredEpicKeys` for the `linkedToRoadmap` annotation. This mirrors
the `SprintDetailService` pattern exactly.

`ConfigService` is injected for `JIRA_BASE_URL` (same pattern as `SprintDetailService`).
`ConfigModule` is global in `AppModule`; no module-level import needed.

---

### 5. Frontend Component Structure

#### 5a. Page File

```
frontend/src/app/quarter/[boardId]/[quarter]/page.tsx
```

A Next.js dynamic route. `'use client'` component (consistent with all other pages in
the project). The `[quarter]` segment uses the `YYYY-QN` string directly (e.g.
`2025-Q2`), which is URL-safe.

#### 5b. API Client Additions (`frontend/src/lib/api.ts`)

```typescript
// New types added to api.ts (no semicolons — frontend style)

export interface QuarterDetailIssue {
  key: string
  summary: string
  issueType: string
  priority: string | null
  status: string
  points: number | null
  epicKey: string | null
  assignedQuarter: string
  completedInQuarter: boolean
  addedMidQuarter: boolean
  linkedToRoadmap: boolean
  isIncident: boolean
  isFailure: boolean
  labels: string[]
  boardEntryDate: string
  jiraUrl: string
}

export interface QuarterDetailSummary {
  totalIssues: number
  completedIssues: number
  addedMidQuarter: number
  linkedToRoadmap: number
  totalPoints: number
  completedPoints: number
}

export interface QuarterDetailResponse {
  boardId: string
  quarter: string
  quarterStart: string
  quarterEnd: string
  doneStatusNames: string[]
  summary: QuarterDetailSummary
  issues: QuarterDetailIssue[]
}

// New typed API function
export function getQuarterDetail(
  boardId: string,
  quarter: string,
): Promise<QuarterDetailResponse> {
  return apiFetch(
    `/api/quarters/${encodeURIComponent(boardId)}/${encodeURIComponent(quarter)}/detail`,
  )
}
```

#### 5c. Page Layout

```
┌────────────────────────────────────────────────────────────────┐
│ ← Roadmap   Q2 2025   PLAT   Apr 1 – Jun 30 2025              │  ← Header
├────────────────────────────────────────────────────────────────┤
│ Total: 34  │ Completed: 21  │ Added mid-quarter: 5            │  ← Summary bar
│ Roadmap-linked: 18  │ Total pts: 89  │ Completed pts: 54      │
├────────────────────────────────────────────────────────────────┤
│ [Issue table — see §5d]                                        │  ← Issues table
└────────────────────────────────────────────────────────────────┘
```

The header follows the same structure as `SprintDetailPage`: back-link, title, board
identifier badge, and date range. Quarter label is formatted from the `quarter` string
(e.g. `"2025-Q2"` → `"Q2 2025"`). Date range is formatted from `quarterStart` and
`quarterEnd` ISO strings.

The summary bar uses `StatChip` components (same pattern as `SprintDetailPage`).
Six chips: Total, Completed, Added mid-quarter, Roadmap-linked, Total points, Completed
points. Highlight states:
- `Completed`: `'good'` if `completedIssues > 0`
- `Added mid-quarter`: `'warn'` if `addedMidQuarter > 0`
- `Roadmap-linked`: `'good'` if `linkedToRoadmap > 0`
- Others: `'none'`

#### 5d. Issues Table Columns

Reuses `DataTable<QuarterDetailIssue>` from `frontend/src/components/ui/data-table.tsx`.

| Column key | Label | Sortable | Render |
|---|---|---|---|
| `key` | Issue | ✅ | `<a href={row.jiraUrl} target="_blank">` if `jiraUrl` non-empty; plain text otherwise |
| `summary` | Summary | ✅ | Truncated to 60 chars, full text in `title` tooltip |
| `issueType` | Type | ✅ | Plain text |
| `priority` | Priority | ✅ | Plain text or `—` if null |
| `status` | Status | ✅ | Pill badge (same style as `SprintDetailPage`) |
| `points` | Points | ✅ | Number or `—` if null |
| `addedMidQuarter` | Scope creep | ✅ | `⚠ Mid-quarter` badge (amber) if true; `—` if false |
| `completedInQuarter` | Done in quarter | ✅ | `✓` (green) if true; `—` if false |
| `linkedToRoadmap` | Roadmap | ✅ | `✓` (green) if true; `—` if false |
| `isIncident` | Incident | ✅ | `🔴 Incident` badge if true; `—` if false |
| `isFailure` | Failure | ✅ | `⚠ Failure` badge (red) if true; `—` if false |
| `boardEntryDate` | Board entry | ✅ | Formatted date (e.g. `3 Jan 2025`) |

`rowClassName` callback:
- `bg-amber-50` if `addedMidQuarter && !completedInQuarter`
- `bg-green-50/30` if `completedInQuarter && !addedMidQuarter`
- `''` otherwise

#### 5e. Loading and Error States

Identical pattern to `SprintDetailPage`:
- **Loading:** Centred `<Loader2 className="h-8 w-8 animate-spin text-muted" />`
- **Error:** Red error banner
- **Empty quarter:** `<EmptyState>` with message "No issues were found in this quarter
  for this board."
- **400 (invalid format):** This should not occur via normal navigation (the roadmap
  page generates valid quarter keys); if it does, show an error banner.

#### 5f. No New Dependencies

All UI elements use:
- `DataTable` component (`frontend/src/components/ui/data-table.tsx`) — reused as-is
- `EmptyState` component (`frontend/src/components/ui/empty-state.tsx`) — reused as-is
- `lucide-react` (already installed): `Loader2`, `AlertCircle`, `ChevronLeft`,
  `ExternalLink`
- Next.js `Link` from `next/link`
- Tailwind CSS classes already in use across the project

No new npm packages are added.

---

### 6. Affected Files

| File | Change | New / Modified |
|---|---|---|
| `backend/src/quarter/quarter.module.ts` | New module | **New** |
| `backend/src/quarter/quarter.controller.ts` | Thin controller, `GET :boardId/:quarter/detail` | **New** |
| `backend/src/quarter/quarter-detail.service.ts` | All annotation and query logic | **New** |
| `backend/src/quarter/dto/quarter-detail-query.dto.ts` | Placeholder (path params validated inline) | **New** |
| `backend/src/app.module.ts` | Add `QuarterModule` to `imports[]` | Modified |
| `frontend/src/app/quarter/[boardId]/[quarter]/page.tsx` | Quarter detail page | **New** |
| `frontend/src/lib/api.ts` | Add `QuarterDetailIssue`, `QuarterDetailSummary`, `QuarterDetailResponse`, `getQuarterDetail()` | Modified |
| `frontend/src/app/roadmap/page.tsx` | Add `<Link>` render to `quarterColumns.quarter` cell | Modified |

Data sources (read-only, existing entities — no schema changes):

| Entity | Role |
|---|---|
| `JiraIssue` | Issue list, status, type, labels, priority, points, epicKey |
| `JiraChangelog` | Board-entry date derivation; `completedInQuarter` status changelog lookup |
| `BoardConfig` | `boardType`, `doneStatusNames`, `incidentIssueTypes`, `incidentLabels`, `failureIssueTypes`, `failureLabels` |
| `RoadmapConfig` | All configured `jpdKey` values — used to build `coveredEpicKeys` for `linkedToRoadmap` |
| `JpdIdea` | `deliveryIssueKeys` per idea — used to populate `coveredEpicKeys` |

No entity files, migration files, or sidebar navigation files are changed.

---

### 7. Open Questions

#### 7.1 — `jpdKey` scoping: explicit param vs. all-configured-RoadmapConfig keys

**Status: CLOSED — Decision made by product owner (2026-04-10)**

**Decision:** Do NOT use an explicit `jpdKey` query param. Mirror the `SprintDetailService`
pattern exactly: load all configured `RoadmapConfig` rows, collect all `jpdKey` values,
and use them to build `coveredEpicKeys`. The `jpdKey` query param is removed from the
endpoint spec. `linkedToRoadmap` will be `true` for any issue whose `epicKey` appears
in any JPD idea's `deliveryIssueKeys` across all configured roadmap projects. If no
`RoadmapConfig` rows exist, `linkedToRoadmap = false` for all issues.

This aligns the quarter detail view with `SprintDetailService` behaviour and removes
the divergence noted in the original draft of this proposal.

#### 7.2 — Should the quarter detail view surface DORA annotations (`isIncident`, `isFailure`)?

**Status: CLOSED — Decision made by product owner (2026-04-10)**

**Decision:** Include `isIncident` and `isFailure` in `QuarterDetailIssue`. Use the same
logic as the board's `BoardConfig`:
- `isIncident = true` if `issueType` in `incidentIssueTypes` OR any label in `incidentLabels`
- `isFailure = true` if `issueType` in `failureIssueTypes` OR any label in `failureLabels`

Both default to `BoardConfig` defaults when no config row exists. See §4d for the full
algorithm and §5d for the frontend column definitions.

#### 7.3 — Scrum board board-entry date: earliest Sprint changelog vs. sprint `startDate`

For Scrum boards, the `boardEntryDate` is derived as the earliest Sprint-field changelog
`changedAt`. An alternative is to use the sprint `startDate` for the sprint the issue
was first added to (as `RoadmapService.calculateSprintAccuracy()` implicitly does by
using `sprint.startDate` as the bucket boundary).

Using changelog `changedAt` is more precise (it reflects when the issue actually entered
a sprint, not when the sprint started), but it requires a Sprint-field changelog to
exist. For issues with no Sprint changelog (created directly into a sprint), `createdAt`
is used as a fallback.

**Recommendation:** Use earliest Sprint-field changelog `changedAt` as specified in §4b.
This is consistent with how `SprintDetailService` determines board-entry for
`addedMidSprint` classification.

#### 7.4 — What happens when `boardEntryDate` falls outside all quarters?

If `issue.createdAt` is very old (e.g. an issue from 2020 on a board with no Sprint
changelog), it will be bucketed into a 2020 quarter. Requests for recent quarters will
simply not include it. This is the correct behaviour and requires no special handling.

#### 7.5 — `issueToQuarterKey` and `quarterToDates` duplication

These two helpers exist in `RoadmapService` as private methods. They will be duplicated
in `QuarterDetailService`. This follows the established "duplicate with TODO" pattern
from `SprintDetailService` (§7.5 of Proposal 0002) and is not a prerequisite for this
feature.

**Recommendation:** Add `// TODO: extract to shared utility (backend/src/utils/quarter.ts)`
comment. Create a follow-on refactoring task that also extracts `median()` /
`percentile()` from `SprintDetailService`.

---

### 8. Risks and Constraints

#### 8.1 — Query Performance

The `(issueKey, field)` index on `jira_changelogs` added by the Sprint Detail migration
covers the bulk changelog queries required here (board-entry date changelogs and
status changelogs). No additional indexes are needed.

The board-issue bulk load (`boardId` scoped) is the same pattern used by
`SprintDetailService` and `RoadmapService.getKanbanAccuracy()` and is bounded by board
size.

#### 8.2 — `boardType` Defaulting

If no `BoardConfig` row exists for a given `boardId`, `boardType` defaults to `'scrum'`
(consistent with `BoardConfig.entity.ts` `@Column({ default: 'scrum' })`). The service
must not throw a `NotFoundException` for missing `BoardConfig` — it should proceed with
scrum defaults for both `boardType` and `doneStatusNames`.

#### 8.3 — Large Quarter Issue Sets

A quarter may contain many more issues than a sprint (all issues across multiple sprints
for a Scrum board, or all Kanban issues in a three-month window). On a board with 500
issues per quarter, the response is still a single unbounded array. Pagination is not
implemented; it is deferred as per the established pattern from Proposal 0002 §7.4.

#### 8.4 — `quarter` Path Parameter URL Encoding

The `YYYY-QN` format (e.g. `2025-Q2`) is URL-safe — it contains only digits, hyphens,
and a capital Q. No special encoding is required. `encodeURIComponent('2025-Q2') ===
'2025-Q2'`. The frontend should use `encodeURIComponent` regardless for correctness.

#### 8.5 — ESM Import Convention

All new backend files must use `.js` import suffixes (e.g.
`import { JiraIssue } from '../database/entities/index.js'`). Strict TypeScript, no
`any`. No semicolons in frontend files. Semicolons required in backend files.

---

## Alternatives Considered

### Alternative A — Extend `RoadmapModule` to add the quarter drill-down endpoint

Add `GET /api/roadmap/:boardId/:quarter/detail` to the existing `RoadmapController`.

**Rejected because:** `RoadmapModule` is responsible for JPD alignment metrics
(coverage rates, delivery rates). The quarter detail view is a generic issue breakdown
for a calendar period — it is not exclusively a roadmap feature. Placing it in
`RoadmapModule` would (a) mix concerns, (b) require `RoadmapService` to handle per-issue
breakdown logic orthogonal to its core purpose, and (c) make it confusing that the
quarter view for a non-JPD board (`jpdKey` absent, `linkedToRoadmap = false`) is served
from a `roadmap` endpoint. A separate `QuarterModule` has a clean, unambiguous scope.

### Alternative B — Extend `SprintModule` to handle both sprint and quarter drill-downs

Add a `/quarter` sub-path to `SprintController` and a quarter variant to
`SprintDetailService`.

**Rejected because:** The sprint detail and quarter detail algorithms are fundamentally
different. Sprint detail uses changelog-replay sprint membership reconstruction; quarter
detail uses board-entry date bucketing. The response shapes are different (sprint detail
returns sprint metadata and sprint-specific annotations; quarter detail returns calendar
period metadata and different annotations). Merging these into one module produces a
service with branching logic that serves two distinct use cases, violating
single-responsibility. Separate modules with separate services keep each narrow and
independently testable.

### Alternative C — Derive quarter data client-side from `getRoadmapAccuracy()` data

The roadmap page already has quarter-level data (issue counts, coverage). Clicking a
quarter row could expand it inline or navigate to a page that re-requests the same
roadmap accuracy data and filters it down.

**Rejected because:** `getRoadmapAccuracy()` returns aggregate sprint metrics, not
per-issue data. Getting per-issue data client-side would require the frontend to call
multiple endpoints (issues, changelogs, JPD ideas) and replicate board-entry date
bucketing logic in the browser, violating the calculation-logic-in-services principle.
A single typed backend endpoint is the correct pattern (as established in ADR-0014).

### Alternative D — Re-use the `/api/sprints` endpoint with a synthetic sprint ID

Use the existing `SprintDetailService` and pass the quarter string as a "sprint ID" with
special handling.

**Rejected because:** This abuses the sprint membership reconstruction algorithm
(designed for Jira sprint IDs, not calendar periods), would require special-casing
throughout `SprintDetailService`, and produces an incorrect API contract (Kanban boards
would need to be un-rejected). It is an abstraction inversion.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes. No new migrations. Existing `(issueKey, field)` index covers all required queries. |
| API contract | Additive | New endpoint `GET /api/quarters/:boardId/:quarter/detail`. No existing endpoints changed. |
| Frontend | New page + one navigation link in the roadmap quarter table | New `frontend/src/app/quarter/[boardId]/[quarter]/page.tsx`. `quarter` column in `frontend/src/app/roadmap/page.tsx` quarter-mode table gains a `<Link>` render. `frontend/src/lib/api.ts` gains new types and `getQuarterDetail()`. |
| Tests | New unit tests for `QuarterDetailService` | Require mocked repositories. Cover: Kanban board-entry date (To Do→* changelog), Scrum board-entry date (Sprint changelog), `completedInQuarter` with and without changelogs, `addedMidQuarter`, `linkedToRoadmap` with all-configured RoadmapConfig rows and with no RoadmapConfig rows, `isIncident` and `isFailure` with and without matching BoardConfig, empty quarter, invalid quarter format, missing BoardConfig defaults, `jiraUrl` with and without `JIRA_BASE_URL`. |
| Jira API | No new calls | All data read from Postgres. No rate-limit impact. |
| `AppModule` | Additive | `QuarterModule` added to `imports` in `backend/src/app.module.ts`. |

---

## Acceptance Criteria

- [ ] `GET /api/quarters/ACC/invalid-format/detail` returns `400 Bad Request` with
      message `'Invalid quarter format. Expected YYYY-QN e.g. 2025-Q2'`.
- [ ] `GET /api/quarters/ACC/2025-Q5/detail` returns `400 Bad Request` (Q5 is out of
      range `[1-4]` per the regex).
- [ ] `GET /api/quarters/ACC/2025-Q2/detail` for a board with no issues in Q2 2025
      returns a `QuarterDetailResponse` with `issues: []`, zeroed summary counts, and
      status `200 OK` (not 404).
- [ ] The endpoint is valid for **both** Scrum boards (e.g. `ACC`) and Kanban boards
      (e.g. `PLAT`) — no `400` is returned for Kanban.
- [ ] The `issues[]` array excludes `issueType === 'Epic'` and `issueType === 'Sub-task'`.
- [ ] For a **Kanban board**, issues are bucketed by the earliest `'To Do → *'` status
      changelog `changedAt`; issues with no such changelog are bucketed by `createdAt`.
- [ ] For a **Scrum board**, issues are bucketed by the earliest Sprint-field changelog
      `changedAt`; issues with no Sprint changelog are bucketed by `createdAt`.
- [ ] Quarter date boundaries are correctly derived: Q2 2025 spans Apr 1 – Jun 30 2025
      (inclusive, start-of-day to end-of-day).
- [ ] `completedInQuarter = true` for an issue that transitioned to a `doneStatusName`
      with `changedAt` within `[quarterStart, quarterEnd]`.
- [ ] `completedInQuarter = false` for an issue that transitioned to a `doneStatusName`
      outside the quarter date range (before `quarterStart` or after `quarterEnd`).
- [ ] `completedInQuarter = true` (fallback) for an issue with no status changelog and
      whose current `status` is in `doneStatusNames`.
- [ ] `completedInQuarter = false` for an issue with status changelogs but none
      transitioning to a `doneStatusName` within the quarter window.
- [ ] Default `doneStatusNames` `['Done', 'Closed', 'Released']` are used when no
      `BoardConfig` row exists for the given `boardId`.
- [ ] `addedMidQuarter = true` for an issue whose `boardEntryDate` is strictly after
      `quarterStart`.
- [ ] `addedMidQuarter = false` for an issue whose `boardEntryDate` equals or precedes
      `quarterStart`.
- [ ] `linkedToRoadmap = true` when `issue.epicKey` appears in `JpdIdea.deliveryIssueKeys`
      for an idea belonging to any configured `RoadmapConfig` row.
- [ ] `linkedToRoadmap = false` when `issue.epicKey` is null.
- [ ] `linkedToRoadmap = false` for all issues when no `RoadmapConfig` rows exist.
- [ ] `linkedToRoadmap = false` when configured `RoadmapConfig` rows exist but no matching
      ideas contain the issue's `epicKey` in their `deliveryIssueKeys`.
- [ ] `isIncident = true` for an issue whose `issueType` is in `BoardConfig.incidentIssueTypes`.
- [ ] `isIncident = true` for an issue with at least one label in `BoardConfig.incidentLabels`.
- [ ] `isIncident = false` for an issue whose `issueType` and labels do not match any
      configured incident criteria.
- [ ] `isFailure = true` for an issue whose `issueType` is in `BoardConfig.failureIssueTypes`.
- [ ] `isFailure = true` for an issue with at least one label in `BoardConfig.failureLabels`.
- [ ] `isFailure = false` for an issue whose `issueType` and labels do not match any
      configured failure criteria.
- [ ] `isIncident` and `isFailure` default to `BoardConfig` entity defaults when no
      `BoardConfig` row exists for the given `boardId`.
- [ ] `summary.totalIssues` equals `issues.length`.
- [ ] `summary.completedIssues` equals `issues.filter(i => i.completedInQuarter).length`.
- [ ] `summary.addedMidQuarter` equals `issues.filter(i => i.addedMidQuarter).length`.
- [ ] `summary.totalPoints` equals the sum of `points` for all issues (null = 0).
- [ ] `summary.completedPoints` equals the sum of `points` for completed issues only
      (null = 0).
- [ ] Issues are sorted: incomplete issues first (alphabetical by key), then completed
      issues (alphabetical by key).
- [ ] `jiraUrl` equals `${JIRA_BASE_URL}/browse/${issue.key}` when `JIRA_BASE_URL` is
      configured.
- [ ] `jiraUrl` is `''` (empty string) when `JIRA_BASE_URL` is not configured.
- [ ] `boardEntryDate` is an ISO 8601 string (e.g. `'2025-04-03T09:15:00.000Z'`).
- [ ] `assignedQuarter` on each issue equals the `quarter` path parameter.
- [ ] The frontend page `/quarter/PLAT/2025-Q2` renders the summary bar and issues
      table.
- [ ] Clicking a quarter row in the Roadmap page quarter-mode table navigates to
      `/quarter/[boardId]/[quarter]`.
- [ ] The back-link on the Quarter Detail page navigates to `/roadmap`.
- [ ] The issues table is sortable by all columns with `sortable: true`.
- [ ] External Jira links open in a new tab (`target="_blank"`).
- [ ] No TypeScript `any` types are introduced in new files.
- [ ] All new backend files use `.js` ESM import suffixes.
- [ ] Frontend files use no semicolons and no `any` types.
- [ ] No new npm packages are added to `frontend/package.json`.
- [ ] `QuarterModule` is added to `AppModule.imports[]`.
- [ ] `QuarterDetailService` injects `ConfigService` for `JIRA_BASE_URL`.
- [ ] The service makes no more than 7 database round-trips per request (no N+1 queries).
