# 0002 — Sprint Detail View

**Date:** 2026-04-10
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** [ADR-0014](../decisions/0014-sprint-detail-view.md)

> **Note:** Code snippets in this proposal that include `@ApiSecurity('api-key')`,
> `@UseGuards(ApiKeyAuthGuard)`, or `import { ApiKeyAuthGuard }` reflect the
> implementation at time of writing. These decorators were subsequently removed by
> [Proposal 0009](0009-remove-api-key-auth.md) / [ADR-0020](../decisions/0020-no-application-level-authentication.md).

---

> **Amendment notes (Architect review 2026-04-10):**
> The following corrections were made after verifying the proposal against the codebase:
>
> 1. **`RoadmapConfig` scoping** (§2, §4a, §4e): `SprintDetailService` must load
>    `coveredEpicKeys` via `RoadmapConfig`-scoped query — identical to
>    `RoadmapService.loadCoveredEpicKeys()` — not by loading all `JpdIdea` rows.
>    `RoadmapConfig` added to entity imports in `SprintModule` (§4e).
>
> 2. **`wasInSprintAtDate()` — no-changelog issues** (§4b, §6c): The `PlanningService`
>    handles no-changelog issues by also including issues where `issue.sprintId ===
>    sprint.id` (current assignment) as a fallback. The `SprintDetailService` must
>    replicate this pattern. Section §4b amended to document this explicitly.
>
> 3. **`completedInSprint` — `>= startDate` constraint** (§4c): The proposal's logic
>    adds a `>= sprint.startDate` guard on status changelogs to avoid crediting
>    completions from a previous sprint. `PlanningService` does not apply this guard,
>    so this is a deliberate refinement (more correct for the detail view context).
>    Documented as an intentional deviation.
>
> 4. **`SprintDetailBoardConfig` named interface** (§3c, §8.3): The inline `boardConfig`
>    object in `SprintDetailResponse` is promoted to a named `SprintDetailBoardConfig`
>    interface in §3c, consistent with the constraint in §8.3.
>
> 5. **`ConfigService` injection** (§4e): `ConfigModule` is global in `AppModule` so no
>    module-level import is needed, but the `SprintDetailService` constructor must
>    inject `ConfigService`. Documented in §4e.
>
> 6. **No index on `jira_changelogs`**: Confirmed — the initial migration
>    (`1775795358704-InitialSchema.ts`) creates no indexes on `jira_changelogs`.
>    The `(issueKey, field)` index is missing. §8.1 already flags this correctly;
>    the acceptance criteria now explicitly require the migration.
>
> 7. **`apps/api` vs `backend/`** (§3a, §5a): The project uses `backend/` and
>    `frontend/` directories (ADR-0007), not `apps/api`/`apps/web`. All paths
>    confirmed correct in the proposal — no changes needed.
>
> 8. **`SprintAccuracy.sprintId` availability** (§1a, §1b): Confirmed present on both
>    `SprintAccuracy` (planning) and `RoadmapSprintAccuracy` (roadmap) interfaces.
>    `row.sprintId` is safe to use in `render` callbacks.

---

## Problem Statement

The existing Planning, DORA, and Roadmap dashboards expose _aggregate_ sprint-level
metrics: totals, rates, and trend lines. A team that spots an anomaly (e.g. high scope
change, low roadmap coverage, elevated CFR) has no path from that aggregate number to
the individual tickets responsible. Every annotation signal that the system already
computes — scope creep, roadmap linkage, incident classification, failure classification,
lead time, completion — lives in separate endpoints with no per-issue breakdown.

The result is that post-sprint retrospectives require the team to leave the dashboard and
manually cross-reference Jira, defeating the purpose of the tool. This proposal adds a
**Sprint Detail View**: a single read-only screen reachable by clicking a sprint row from
any existing table, showing every ticket in that sprint with all metric annotations
computed and displayed inline.

---

## Proposed Solution

### Overview

```
[Planning table row click]  ─────────────────────────────────┐
[Roadmap table row click]   ─────────────────────────────────┤
[DORA sprint selector]      ─────────────────────────────────┘
                                         │
                         /sprint/[boardId]/[sprintId]  (Next.js page)
                                         │
                         GET /api/sprints/:boardId/:sprintId/detail
                                         │
                                 SprintDetailService
                                         │
                 ┌────────────────────────┴──────────────────────────┐
                 │                                                    │
         jira_sprints (1 row)                             BoardConfig (1 row)
         jira_issues  (N rows, sprintId match + changelog replay)
         jira_changelogs (sprint-field + status-field, bulk)
         roadmap_configs (all, to scope jpd keys)
         jpd_ideas   (scoped by roadmap_configs.jpdKey, for coveredEpicKeys set)
```

A new `SprintModule` owns a `SprintDetailService` and a `SprintController`. It depends
on the same entities as the existing planning and roadmap modules but performs a single
coordinated query sequence per request, returning a fully annotated per-issue response.
The frontend page is a new Next.js dynamic route at
`frontend/src/app/sprint/[boardId]/[sprintId]/page.tsx`.

No new npm packages are required. No new database migrations are required beyond the
`jira_changelogs(issueKey, field)` index addition (see §8.1).

---

### 1. Navigation — Entry Points

There are three natural entry points, one per existing table view. All three navigate
to the same URL shape: `/sprint/[boardId]/[sprintId]`.

#### 1a. Planning page (`/planning`)

The `sprintName` column in the sprint-mode `DataTable` gains a `render` override that
wraps the name in a `<Link>` (Next.js `Link` from `next/link`):

```tsx
// In planning/page.tsx — modify the sprintColumns definition
{
  key: 'sprintName',
  label: 'Sprint',
  sortable: true,
  render: (value, row) => (
    <Link
      href={`/sprint/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(row.sprintId)}`}
      className="font-medium text-blue-600 hover:underline"
    >
      {String(value)}
    </Link>
  ),
},
```

The `selectedBoard` local state is already available in scope. `row.sprintId` is
available because `SprintAccuracy` already carries it (confirmed: `sprintId: string`
is field 1 of the `SprintAccuracy` interface in `backend/src/planning/planning.service.ts`
and mirrored in `frontend/src/lib/api.ts`).

#### 1b. Roadmap page (`/roadmap`)

The same pattern in the sprint-mode `DataTable` in `roadmap/page.tsx`:

```tsx
{
  key: 'sprintName',
  label: 'Sprint',
  sortable: true,
  render: (value, row) => (
    <Link
      href={`/sprint/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(row.sprintId)}`}
      className="font-medium text-blue-600 hover:underline"
    >
      {String(value)}
    </Link>
  ),
},
```

`RoadmapSprintAccuracy` also carries `sprintId: string` (confirmed in
`frontend/src/lib/api.ts`). The Kanban board path through `roadmap/page.tsx` returns
quarter-keyed rows (where `sprintId` is a string like `"2026-Q1"`) — the link
should only be rendered when `periodType === 'sprint'`, so the Kanban case is
naturally excluded because Kanban boards switch to `quarter` mode automatically.

#### 1c. DORA page (`/dora`)

The DORA page does not currently surface a per-sprint table, but it loads sprint names
via `getSprints()`. A future enhancement could add a "View sprint →" link next to the
period selector. For this proposal, DORA is treated as an **out-of-scope entry point**;
it is noted here so the URL scheme is compatible with it.

#### 1d. URL Structure

```
/sprint/[boardId]/[sprintId]
```

Examples:
- `/sprint/ACC/12345`
- `/sprint/BPT/67890`

`boardId` and `sprintId` are both path parameters. `boardId` is needed to load the
`BoardConfig` and to scope issue queries — `sprintId` alone is not sufficient because
sprint IDs from the Jira Agile API are globally unique integers but the board context
determines which `BoardConfig` rules apply.

The page does **not** appear in the sidebar navigation (it is a drill-through, not a
top-level view). The `NAV_ITEMS` array in
`frontend/src/components/layout/sidebar.tsx` is left unchanged.

#### 1e. Back Navigation

The page renders a breadcrumb or back-link. Because the entry point varies, the page
derives context from query parameters:

```
/sprint/ACC/12345?from=planning
/sprint/ACC/12345?from=roadmap
```

`from` is optional. If present, the back-link label reads "← Planning" or "← Roadmap"
respectively and uses `router.back()` (Next.js `useRouter`). If absent, the link reads
"← Dashboard" and navigates to `/planning` as a sensible default.

---

### 2. Data Model — What Is Already Available

**No new database migrations are required** beyond the index addition in §8.1.
Every annotation can be derived from existing tables using already-synced data.

The full data model required by the service is:

| Source entity | Fields used | Already present? |
|---|---|---|
| `JiraSprint` | `id`, `name`, `state`, `startDate`, `endDate`, `boardId` | ✅ |
| `JiraIssue` | `key`, `summary`, `status`, `issueType`, `epicKey`, `labels`, `createdAt`, `sprintId`, `boardId` | ✅ |
| `JiraChangelog` | `issueKey`, `field`, `fromValue`, `toValue`, `changedAt` | ✅ |
| `RoadmapConfig` | `jpdKey` (to scope which JPD projects are configured) | ✅ |
| `JpdIdea` | `deliveryIssueKeys` (array), `jpdKey` (to filter by configured projects) | ✅ |
| `BoardConfig` | `doneStatusNames`, `failureIssueTypes`, `failureLabels`, `failureLinkTypes`, `incidentIssueTypes`, `incidentLabels` | ✅ |

**Critical observation on `JiraIssue.sprintId`:** The `sprintId` column stores the
_last-synced_ sprint for an issue. Because Jira upserts overwrite this on every sync,
an issue that moved between sprints will only show the most-recent value. The sprint
detail view must therefore reconstruct sprint membership from `JiraChangelog`
(field = `'Sprint'`) — exactly the same approach used by `PlanningService`. This is
a known limitation that `PlanningService` already handles correctly.

**Critical observation on `coveredEpicKeys` scoping:** `RoadmapService.loadCoveredEpicKeys()`
loads `JpdIdea` rows scoped to configured `RoadmapConfig.jpdKey` values, not all ideas.
`SprintDetailService` must use the same scoped approach — loading all `JpdIdea` rows
without `RoadmapConfig` scoping would include epic keys from JPD projects the team has
not configured for this dashboard, producing incorrect `roadmapLinked` annotations.
The `SprintModule` therefore imports both `RoadmapConfig` and `JpdIdea` repositories
(see §4e).

**Critical observation on link-based CFR (`failureLinkTypes`):** The `JiraIssue` entity
does not store `issuelinks`. Link-based failure detection (an issue linked *to* another
via a `failureLinkType`) cannot be evaluated from the database alone. Two options exist:

1. **Skip link-based CFR annotation** at the per-issue level — only type and label rules
   are evaluated. The aggregate CFR metric (which also skips link detection in the
   current `CfrService`) is unaffected.
2. **Fetch issue links live from Jira** — violates the rule that metric services never
   call Jira directly, and would impose per-sprint latency.

**Decision (see Open Questions §7.3):** Link-based CFR is excluded from the per-issue
annotation. The `isFailure` column reflects `failureIssueTypes` OR `failureLabels` only,
consistent with the existing `CfrService` implementation which also does not evaluate
`failureLinkTypes` at query time.

---

### 3. Backend API

#### 3a. Module Location: New `SprintModule`

The feature does **not** belong in the `roadmap` module (roadmap concerns JPD
alignment, not generic sprint breakdown), nor in `planning` (planning concerns
commitment vs delivery totals, not per-issue breakdown), nor in `metrics` (metrics
concern DORA aggregates across time periods). The correct home is a new, narrow
`sprint` module owning a single service and controller.

This maintains the existing dependency rule: calculation logic lives in services,
controllers remain thin.

```
backend/src/sprint/
  sprint.module.ts
  sprint.controller.ts
  sprint-detail.service.ts
  dto/
    sprint-detail-query.dto.ts
```

#### 3b. Endpoint

```
GET /api/sprints/:boardId/:sprintId/detail
```

Protected by `ApiKeyAuthGuard` (same guard used across all other controllers; imported
from `../auth/api-key-auth.guard.js`).

**Request parameters:**

| Parameter | In | Type | Required | Description |
|---|---|---|---|---|
| `boardId` | path | `string` | ✅ | Board identifier (e.g. `ACC`) |
| `sprintId` | path | `string` | ✅ | Sprint numeric ID as string |

No query parameters. The response is fully self-contained — all annotation logic is
server-side.

**Error responses:**

| Status | Condition |
|---|---|
| `400 Bad Request` | `boardId` refers to a Kanban board (`boardConfig.boardType === 'kanban'`) |
| `404 Not Found` | No `JiraSprint` row matches `{ id: sprintId, boardId }` |

#### 3c. Response DTO

```typescript
// backend/src/sprint/dto/sprint-detail-query.dto.ts
// (path params are validated inline via @Param() in the controller)

// backend/src/sprint/sprint-detail.service.ts — exported interfaces

/** Board configuration rules applied to derive per-issue annotations */
export interface SprintDetailBoardConfig {
  doneStatusNames: string[];
  failureIssueTypes: string[];
  failureLabels: string[];
  incidentIssueTypes: string[];
  incidentLabels: string[];
}

export interface SprintDetailIssue {
  /** Jira issue key, e.g. "ACC-123" */
  key: string;

  /** Issue summary / title */
  summary: string;

  /** Current status at time of last sync */
  currentStatus: string;

  /** Jira issue type, e.g. "Story", "Bug", "Task" */
  issueType: string;

  /**
   * True if the issue was added to the sprint AFTER sprint start
   * (using the 5-minute grace period defined in PlanningService).
   * False if the issue was present at sprint start or created in the sprint
   * within the grace window.
   */
  addedMidSprint: boolean;

  /**
   * True if the issue's epicKey is a member of the coveredEpicKeys set
   * (i.e. issue.epicKey ∈ any JpdIdea.deliveryIssueKeys, scoped to
   * configured RoadmapConfig.jpdKey values).
   * False if epicKey is null or not covered.
   */
  roadmapLinked: boolean;

  /**
   * True if the issue matches incidentIssueTypes OR incidentLabels
   * from BoardConfig. This is the MTTR signal.
   */
  isIncident: boolean;

  /**
   * True if the issue matches failureIssueTypes OR failureLabels
   * from BoardConfig. This is the CFR signal.
   * Note: link-based failure detection (failureLinkTypes) is excluded
   * at the per-issue level — see proposal §2 and §7.3.
   */
  isFailure: boolean;

  /**
   * True if the issue transitioned to a doneStatusName between
   * sprint.startDate and sprint.endDate (inclusive).
   * For active sprints, sprint.endDate is treated as the current time.
   * Also true if the issue's current status is already in doneStatusNames,
   * as a fallback for issues with missing or truncated changelogs.
   */
  completedInSprint: boolean;

  /**
   * Lead time in days, or null if it cannot be computed.
   * = (firstDoneTransitionDate - firstInProgressTransitionDate) in days.
   * Falls back to (firstDoneTransitionDate - issue.createdAt) if no
   * "In Progress" transition exists.
   * Null if no done transition is found in the changelog at all.
   * Negative values (data anomalies) are clamped to null.
   * Rounded to 2 decimal places.
   */
  leadTimeDays: number | null;

  /**
   * ISO 8601 timestamp of the issue's first done-status transition,
   * or null if no such transition is found.
   */
  resolvedAt: string | null;

  /**
   * Deep link to the issue in Jira Cloud.
   * Constructed as: `${JIRA_BASE_URL}/browse/${key}`
   * Empty string if JIRA_BASE_URL is not configured (see §7.2).
   */
  jiraUrl: string;
}

export interface SprintDetailSummary {
  /** Count of issues present at sprint start (committed scope) */
  committedCount: number;

  /** Count of issues added after sprint start */
  addedMidSprintCount: number;

  /** Count of issues removed during the sprint */
  removedCount: number;

  /** Count of issues completed within the sprint window */
  completedInSprintCount: number;

  /** Count of issues linked to a JPD roadmap item */
  roadmapLinkedCount: number;

  /** Count of issues classified as incidents (MTTR signal) */
  incidentCount: number;

  /** Count of issues classified as failures (CFR signal) */
  failureCount: number;

  /** Median lead time in days across completed issues, or null if no completed issues */
  medianLeadTimeDays: number | null;
}

export interface SprintDetailResponse {
  sprintId: string;
  sprintName: string;
  state: string;             // 'active' | 'closed' | 'future'
  startDate: string | null;  // ISO 8601
  endDate: string | null;    // ISO 8601

  /** The BoardConfig rules applied to derive annotations */
  boardConfig: SprintDetailBoardConfig;

  /** Aggregate summary bar counts */
  summary: SprintDetailSummary;

  /**
   * All issues that were part of this sprint (committed + added - removed).
   * Epics and Sub-tasks are excluded.
   * Sorted: incomplete issues first (alphabetical by key), then completed.
   */
  issues: SprintDetailIssue[];
}
```

#### 3d. Controller (thin)

```typescript
// backend/src/sprint/sprint.controller.ts

@ApiTags('sprints')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('api/sprints')
export class SprintController {
  constructor(private readonly sprintDetailService: SprintDetailService) {}

  @ApiOperation({ summary: 'Get annotated ticket-level breakdown for a sprint' })
  @Get(':boardId/:sprintId/detail')
  async getDetail(
    @Param('boardId') boardId: string,
    @Param('sprintId') sprintId: string,
  ): Promise<SprintDetailResponse> {
    return this.sprintDetailService.getDetail(boardId, sprintId);
  }
}
```

---

### 4. Backend Service: `SprintDetailService`

#### 4a. Query Strategy — Single Coordinated Pass

The service must avoid N+1 queries. The pattern used by `PlanningService` and
`RoadmapService` is followed:

1. Load sprint (1 query)
2. Load `BoardConfig` (1 query) — and check for Kanban before proceeding
3. Load all board issues (1 query, `boardId` scoped — required for changelog replay)
4. Bulk-load Sprint-field changelogs for all board issue keys (1 query)
5. Identify the final sprint membership set (in-memory replay — see §4b)
6. Bulk-load status-field changelogs for sprint member issue keys (1 query)
7. Load `RoadmapConfig` rows (1 query) → extract configured `jpdKey` set
8. Load `JpdIdea` rows scoped to those `jpdKey` values (1 query) → build `coveredEpicKeys` set (in-memory)

Total: 7 database round-trips regardless of sprint size. No unbounded queries.

**Note on step 7–8 vs. all-ideas approach:** Loading all `JpdIdea` rows without
`RoadmapConfig` scoping is incorrect — it would include ideas from JPD projects the
team has not configured for this dashboard. The `RoadmapService.loadCoveredEpicKeys()`
pattern (scoped by `RoadmapConfig.jpdKey`) must be replicated here. If no
`RoadmapConfig` rows exist, `coveredEpicKeys` is an empty set and all issues will have
`roadmapLinked = false`.

#### 4b. Sprint Membership Reconstruction

This is the most complex part of the service. It reuses the **exact same algorithm**
as `PlanningService.calculateSprintAccuracy()`, including:

- The 5-minute grace period (`SPRINT_GRACE_PERIOD_MS = 5 * 60 * 1000`)
- The `sprintValueContains()` comma-split exact-match helper
- The `wasInSprintAtDate()` changelog replay logic

The service additionally tracks **per-issue** `addedMidSprint` and `removed` flags so
they can be included in the response (planning service only exposes aggregate counts).

**Handling no-changelog issues (critical):** `PlanningService` handles issues with no
Sprint-field changelog in two steps:
1. The `wasInSprintAtDate()` function returns `true` when `sprintChangelogs.length === 0`,
   treating creation-time assignment as "was in sprint at start".
2. Additionally, `PlanningService` explicitly includes issues where `issue.sprintId ===
   sprint.id` with an empty changelog entry, because some issues may be currently
   assigned to the sprint but have no changelog (e.g. created directly in the sprint
   via the Jira UI before changelog recording began).

`SprintDetailService` must replicate step 2: after building the `logsByIssue` map from
Sprint-field changelogs, include any board issue where `issue.sprintId === sprint.id`
AND the issue is not already in `logsByIssue` (assign it an empty changelog array).

**Membership reconstruction algorithm** (produces the `finalIssueSet` and per-issue flags):

```
// Step 1: Filter board issues — exclude Epics and Sub-tasks
boardIssues = boardIssues.filter(i => i.issueType !== 'Epic' && i.issueType !== 'Sub-task')

// Step 2: Build logsByIssue map from Sprint-field changelogs
for each cl in sprintChangelogs where field = 'Sprint':
  if sprintValueContains(cl.fromValue, sprint.name) || sprintValueContains(cl.toValue, sprint.name):
    logsByIssue[cl.issueKey].push(cl)

// Step 3: Include current-sprint issues with no changelog (PlanningService pattern)
for each issue in boardIssues where issue.sprintId === sprint.id:
  if issue.key not in logsByIssue:
    logsByIssue[issue.key] = []

// Step 4: Classify each issue
effectiveSprintStart = sprint.startDate + GRACE_PERIOD
sprintEnd = sprint.endDate ?? new Date()

for each [issueKey, logs] in logsByIssue:
  createdAt = issue.createdAt
  createdMidSprint = (logs.length === 0) && (createdAt > effectiveSprintStart)

  wasAtStart = !createdMidSprint && wasInSprintAtDate(logs, sprint.name, sprint.startDate)

  inSprintAtEnd = wasAtStart || createdMidSprint
  wasAddedDuringSprint = createdMidSprint
  removedFromSprint = false

  for cl in logs where cl.changedAt > sprint.startDate && cl.changedAt <= sprintEnd:
    if sprintValueContains(cl.toValue, sprint.name):
      if !inSprintAtEnd && !wasAtStart:
        wasAddedDuringSprint = true
      inSprintAtEnd = true
    if sprintValueContains(cl.fromValue, sprint.name) && !sprintValueContains(cl.toValue, sprint.name):
      inSprintAtEnd = false

  if wasAtStart && !inSprintAtEnd:
    removedFromSprint = true
  if wasAddedDuringSprint && !inSprintAtEnd:
    removedFromSprint = true

  if wasAtStart:
    committedKeys.add(issueKey)
  else if wasAddedDuringSprint:
    addedKeys.add(issueKey)

  if removedFromSprint:
    removedKeys.add(issueKey)

// Step 5: Build finalIssueSet = (committedKeys ∪ addedKeys) \ removedKeys
```

#### 4c. Annotation Derivation Rules

For each issue in `finalIssueSet` (epics and sub-tasks already excluded in §4b step 1):

**`addedMidSprint`**
```
addedMidSprint = issueKey ∈ addedKeys (as determined in §4b classification)
```
This covers both the changelog-based case (first Sprint-field changelog pointing to this
sprint has `changedAt > sprint.startDate + 5 minutes`) and the direct-creation case
(`issue.createdAt > sprint.startDate + 5 minutes` with no changelog).

**`roadmapLinked`**
```
roadmapLinked = issue.epicKey !== null
             && coveredEpicKeys.has(issue.epicKey)

where coveredEpicKeys = new Set(
  jpdIdeas                              // scoped to configured RoadmapConfig.jpdKey values
    .flatMap(idea => idea.deliveryIssueKeys ?? [])
    .filter(Boolean)
)
```
This is identical to the rule used by `RoadmapService.calculateSprintAccuracy()`.

**`isIncident`**
```
isIncident = boardConfig.incidentIssueTypes.includes(issue.issueType)
          || (boardConfig.incidentLabels.length > 0
              && issue.labels.some(l => boardConfig.incidentLabels.includes(l)))
```
Mirrors `MttrService.calculate()` — the `incidentLabels.length > 0` guard is
important and must not be omitted.

**`isFailure`**
```
isFailure = boardConfig.failureIssueTypes.includes(issue.issueType)
         || issue.labels.some(l => boardConfig.failureLabels.includes(l))
```
Mirrors `CfrService.calculate()` line for line.
Link-based detection (`failureLinkTypes`) is **not evaluated** — see §2 and §7.3.

**`completedInSprint`**

Uses the status-field changelogs bulk-loaded in step 6 of §4a. Note: this is a
deliberate refinement over `PlanningService` — the `>= sprint.startDate` guard on
changelog lookup prevents a previous-sprint completion from being credited.

```
sprintWindow = [sprint.startDate, sprint.endDate ?? new Date()]

completedInSprint =
  // Case 1: current status is already done (fallback for missing/truncated changelogs)
  boardConfig.doneStatusNames.includes(issue.status)
  ||
  // Case 2: a status changelog transitioned TO a done status within the sprint window
  statusChangelogs
    .filter(cl => cl.issueKey === issue.key)
    .some(cl => boardConfig.doneStatusNames.includes(cl.toValue ?? '')
             && cl.changedAt >= sprint.startDate     // ← guard: not from a prior sprint
             && cl.changedAt <= (sprint.endDate ?? new Date()))
```

**`leadTimeDays` and `resolvedAt`**

Uses the same status-field changelogs already loaded for `completedInSprint`.

```
issueLogs = statusChangelogs for this issue, ordered by changedAt ASC

inProgressTransition = first log where toValue === 'In Progress'
startTime = inProgressTransition?.changedAt ?? issue.createdAt

doneTransition = first log where doneStatusNames.includes(toValue)
resolvedAt     = doneTransition?.changedAt ?? null

leadTimeDays =
  doneTransition !== null
  ? (doneTransition.changedAt.getTime() - startTime.getTime()) / 86_400_000
  : null
```

For `leadTimeDays`, values are rounded to 2 decimal places. Negative values (data
anomalies where createdAt > resolvedAt) are clamped to `null`.

This is consistent with `LeadTimeService.calculate()` for Scrum boards (falls back
to `issue.createdAt` when no In Progress transition exists). The `resolvedAt` is the
date of the first done-transition, not the sprint-window-restricted done transition —
it is purely informational.

**`jiraUrl`**

```
jiraUrl = `${configService.get('JIRA_BASE_URL', '')}/browse/${issue.key}`
```

`JIRA_BASE_URL` is read via NestJS `ConfigService` (injected in constructor). If absent,
`jiraUrl` is empty string `''` and the frontend renders the key as plain text.

#### 4d. Summary Computation

After building `issues[]`, compute `summary` in a single pass:

```typescript
const summary: SprintDetailSummary = {
  committedCount:         issues.filter(i => !i.addedMidSprint).length,
  addedMidSprintCount:    issues.filter(i => i.addedMidSprint).length,
  removedCount:           removedKeys.size,   // tracked separately during membership replay
  completedInSprintCount: issues.filter(i => i.completedInSprint).length,
  roadmapLinkedCount:     issues.filter(i => i.roadmapLinked).length,
  incidentCount:          issues.filter(i => i.isIncident).length,
  failureCount:           issues.filter(i => i.isFailure).length,
  medianLeadTimeDays:     median(issues.filter(i => i.leadTimeDays !== null).map(i => i.leadTimeDays!)) ?? null,
};
```

`median()` is a local utility (same `percentile()` function already duplicated in
`MttrService` and `LeadTimeService` — see §7.5 for deduplication note).

#### 4e. Module Definition

```typescript
// backend/src/sprint/sprint.module.ts

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraSprint,
      JiraIssue,
      JiraChangelog,
      BoardConfig,
      JpdIdea,
      RoadmapConfig,   // required for scoped coveredEpicKeys loading
    ]),
  ],
  controllers: [SprintController],
  providers: [SprintDetailService],
})
export class SprintModule {}
```

`SprintModule` is added to the `imports` array of `AppModule`
(`backend/src/app.module.ts`). No other existing modules are modified.

**`ConfigService` injection:** `ConfigModule` is already global in `AppModule`
(`ConfigModule.forRoot({ isGlobal: true })`), so no module-level `ConfigModule`
import is needed in `SprintModule`. `SprintDetailService` injects `ConfigService`
directly in its constructor:

```typescript
constructor(
  @InjectRepository(JiraSprint) private readonly sprintRepo: ...,
  // ... other repos ...
  private readonly configService: ConfigService,
) {}
```

---

### 5. Frontend Component Structure

#### 5a. Page File

```
frontend/src/app/sprint/[boardId]/[sprintId]/page.tsx
```

This is a Next.js dynamic route. It is a `'use client'` component (no RSC data
fetching needed — consistent with all other pages in this project which are all
`'use client'`).

#### 5b. API Client Additions (`frontend/src/lib/api.ts`)

```typescript
// New types added to api.ts

/** Board configuration rules applied to derive per-issue annotations */
export interface SprintDetailBoardConfig {
  doneStatusNames: string[];
  failureIssueTypes: string[];
  failureLabels: string[];
  incidentIssueTypes: string[];
  incidentLabels: string[];
}

export interface SprintDetailIssue {
  key: string;
  summary: string;
  currentStatus: string;
  issueType: string;
  addedMidSprint: boolean;
  roadmapLinked: boolean;
  isIncident: boolean;
  isFailure: boolean;
  completedInSprint: boolean;
  leadTimeDays: number | null;
  resolvedAt: string | null;
  jiraUrl: string;
}

export interface SprintDetailSummary {
  committedCount: number;
  addedMidSprintCount: number;
  removedCount: number;
  completedInSprintCount: number;
  roadmapLinkedCount: number;
  incidentCount: number;
  failureCount: number;
  medianLeadTimeDays: number | null;
}

export interface SprintDetailResponse {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  boardConfig: SprintDetailBoardConfig;
  summary: SprintDetailSummary;
  issues: SprintDetailIssue[];
}

// New typed API function
export function getSprintDetail(
  boardId: string,
  sprintId: string,
): Promise<SprintDetailResponse> {
  return apiFetch(
    `/api/sprints/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}/detail`,
  );
}
```

#### 5c. Page Layout

The page is divided into three vertical sections:

```
┌─────────────────────────────────────────────────────────────┐
│ ← Planning   [Sprint Name]    ACC · active   Jan 5 – Jan 19 │  ← Header / breadcrumb
├─────────────────────────────────────────────────────────────┤
│ Committed: 12  │ Added: 3  │ Removed: 1  │ Completed: 10   │  ← Summary bar
│ Roadmap-linked: 8  │ Incidents: 1  │ Failures: 2           │
│ Median Lead Time: 4.3 days                                  │
├─────────────────────────────────────────────────────────────┤
│ [Ticket table — see §5d]                                    │  ← Issues table
└─────────────────────────────────────────────────────────────┘
```

The header uses the same `text-2xl font-bold` style as existing pages. The summary bar
uses a flex-wrap row of small `<div>` stat chips consistent with the metric cards in
`dora/page.tsx`. The issues table reuses `DataTable<SprintDetailIssue>` from
`frontend/src/components/ui/data-table.tsx` (the `Column<T>` generic interface with
`render?: (value: unknown, row: T) => ReactNode` supports all required badge renders).

#### 5d. Issues Table Columns

The `DataTable` component accepts a `columns: Column<T>[]` prop with optional
`render` functions. All annotation columns are rendered as icon badges to keep the
table scannable at a glance.

| Column key | Label | Sortable | Render |
|---|---|---|---|
| `key` | Issue | ✅ | `<a href={row.jiraUrl} target="_blank">ACC-123 ↗</a>` (plain text if `jiraUrl` is empty) |
| `summary` | Summary | ✅ | Plain text, truncated to 60 chars with `title` tooltip |
| `issueType` | Type | ✅ | Plain text |
| `currentStatus` | Status | ✅ | Pill badge (same style as existing state badges) |
| `addedMidSprint` | Scope creep | ✅ | `⚠ Mid-sprint` badge (amber) if true, `—` if false |
| `roadmapLinked` | Roadmap | ✅ | `✓` (green) if true, `—` if false |
| `isIncident` | Incident | ✅ | `🔴 Incident` badge (red-50 bg) if true, `—` if false |
| `isFailure` | Failure | ✅ | `🟠 Failure` badge (orange-50 bg) if true, `—` if false |
| `completedInSprint` | Done in sprint | ✅ | `✓` (green) if true, `—` if false |
| `leadTimeDays` | Lead time | ✅ | `4.3d` or `—` if null |

The `rowClassName` callback applies:
- `bg-red-50` if `isIncident || isFailure`
- `bg-amber-50` if `addedMidSprint && !isIncident && !isFailure`
- `bg-green-50/30` if `completedInSprint && !isIncident && !isFailure && !addedMidSprint`
- `''` otherwise

Priority order: incident/failure > scope creep > completed.

#### 5e. Loading and Error States

- **Loading:** Full-width centered `<Loader2 className="h-8 w-8 animate-spin" />` (same
  as all other pages).
- **Error:** Red error banner (same pattern as other pages).
- **404 / Kanban:** Show `<EmptyState>` with message derived from error type.
  `EmptyState` is already available at `frontend/src/components/ui/empty-state.tsx`.

#### 5f. No New Dependencies

All UI elements are achievable with:
- Existing `DataTable` component (`frontend/src/components/ui/data-table.tsx`) — reused
  as-is; the existing `Column<T>` interface with `render?: (value, row) => ReactNode`
  supports all required badge renders
- Existing `EmptyState` component (`frontend/src/components/ui/empty-state.tsx`)
- `lucide-react` (already installed) for `Loader2`, `AlertCircle`, `ChevronLeft`,
  `ExternalLink` icons
- Next.js `Link` from `next/link` (already used across all pages)
- Tailwind CSS classes already in use across the project

No new npm packages are added.

---

### 6. Mid-Sprint Scope Creep Detection (Detailed)

This section provides the precise derivation from raw `JiraChangelog` data.

#### 6a. Changelog Structure for Sprint Membership

When Jira moves an issue into or out of a sprint, it records a changelog entry:

```
field:     'Sprint'           (capital S — confirmed in PlanningService line 138)
fromValue: 'ACC Sprint 22'          (or null if issue had no sprint before)
toValue:   'ACC Sprint 22, ACC Sprint 23'  (comma-separated when multi-sprint)
changedAt: <timestamp>
```

The `toValue` is a comma-separated list of sprint names currently assigned to the
issue. The `JiraChangelog.toValue` and `fromValue` columns store this raw string.

#### 6b. `sprintValueContains()` — Critical Helper

Sprint names must be matched exactly within the comma-separated string to prevent
"Sprint 1" matching "Sprint 10":

```typescript
function sprintValueContains(value: string | null, sprintName: string): boolean {
  if (!value) return false;
  return value.split(',').some(s => s.trim() === sprintName);
}
```

This function is already implemented in `PlanningService` (private method) and must be
duplicated in `SprintDetailService` (or extracted — see §7.5).

#### 6c. `wasInSprintAtDate()` — Grace Period Logic

```typescript
const SPRINT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

function wasInSprintAtDate(
  sprintChangelogs: JiraChangelog[],  // Sprint-field logs for this issue, ASC order
  sprintName: string,
  date: Date,
): boolean {
  const effectiveDate = new Date(date.getTime() + SPRINT_GRACE_PERIOD_MS);
  let inSprint = false;

  for (const cl of sprintChangelogs) {
    if (cl.changedAt > effectiveDate) break;
    if (sprintValueContains(cl.toValue, sprintName)) inSprint = true;
    if (sprintValueContains(cl.fromValue, sprintName) &&
        !sprintValueContains(cl.toValue, sprintName)) inSprint = false;
  }

  // No Sprint changelog at all = issue was created directly in the sprint
  // (or no changelog exists — see §4b for the additional currentSprintId check)
  if (sprintChangelogs.length === 0) return true;
  return inSprint;
}
```

The 5-minute grace period absorbs Jira's bulk-add delay: when a sprint is started,
Jira records `startDate` at the moment of creation, but initial backlog issues are
added ~20–60 seconds later. Without the grace period, every committed issue would be
incorrectly classified as "added mid-sprint."

#### 6d. Determining `addedMidSprint`

An issue is `addedMidSprint = true` if AND ONLY IF:

**Case 1: Has Sprint-field changelog entries referencing this sprint**
- `wasInSprintAtDate(sprintLogs, sprintName, sprint.startDate)` returns `false`
- AND at least one changelog entry with `toValue` containing `sprintName`
  exists with `changedAt > sprint.startDate + GRACE_PERIOD`

**Case 2: No Sprint-field changelog entries (created directly into sprint)**
- `issue.createdAt > sprint.startDate + GRACE_PERIOD`

An issue where `issue.createdAt ≤ sprint.startDate + GRACE_PERIOD` AND `sprintLogs.length === 0`
is treated as committed at start (it was created before or at sprint creation time,
likely because the sprint was created from the backlog with the issue already assigned).

---

### 7. Open Questions

#### 7.1 — Should removed issues appear in the issues table?

Currently proposed: issues removed from the sprint are counted in `summary.removedCount`
but excluded from the `issues[]` array. This keeps the table focused on "what the team
actually worked on." An alternative would be to include them with a `removedFromSprint`
flag and a `bg-gray-50 text-muted` row style. This could be resolved during
implementation and surfaced as a filter toggle ("Show removed issues").

**Recommendation:** Exclude from the issues array by default; add a show/hide toggle in a
follow-on iteration.

#### 7.2 — Jira deep-link URL

The `jiraUrl` field is constructed from `JIRA_BASE_URL`. If `JIRA_BASE_URL` is not
configured, the service returns `''` for all `jiraUrl` fields. The frontend renders the
issue key as plain text (not a link) when `jiraUrl` is empty.

**Recommendation:** Validate `JIRA_BASE_URL` presence in `SprintDetailService`
constructor; log a warning if absent; return `''` for all `jiraUrl` fields.

#### 7.3 — Link-based CFR annotation (`failureLinkTypes`)

`CfrService.calculate()` references `failureLinkTypes` in its config loading but does
**not actually evaluate it** — reading the code, the current failure count is based
solely on `failureIssueTypes` and `failureLabels`. This is consistent with the proposed
per-issue annotation which also omits link evaluation.

Should `failureLinkTypes` ever be evaluated requires storing `issuelinks` in a new
table — a non-trivial schema change. This proposal explicitly excludes it and documents
the gap. A future proposal could add a `jira_issue_links` table.

#### 7.4 — Pagination for large sprints

The `issues[]` array is returned in a single response. Sprints in this project (ACC,
BPT, SPS, OCS, DATA) typically contain 10–40 issues. The response is not paginated.

If a sprint exceeds 200 issues, the `DataTable` component renders all rows in the DOM,
which may cause jank on lower-powered machines. A limit of 500 issues per sprint is
implicit (if the board has 500+ issues matching a sprint, the query still completes,
but the frontend should add a warning banner). Pagination is explicitly deferred.

#### 7.5 — `percentile()` / `median()` utility duplication

The `percentile()` function is currently duplicated in `MttrService` and
`LeadTimeService` (both at the module level, not exported). It will be needed again in
`SprintDetailService`. This is a candidate for extraction into a shared utility module
at `backend/src/utils/statistics.ts`. Extraction is recommended but is a separate
refactoring concern and is not a prerequisite for this feature.

**Recommendation:** Duplicate for now with a `// TODO: extract to shared utility`
comment; create a follow-on task.

#### 7.6 — Should the view support re-syncing?

The view is read-only. A sync button (calling `POST /api/sync`) could be placed in the
header, but this is equivalent to the global sync in the layout and is not specific to
the sprint view. The existing sync mechanism in
`frontend/src/store/sync-store.ts` handles this globally.

**Recommendation:** No per-sprint sync button. The global sync in the header is
sufficient.

---

### 8. Risks and Constraints

#### 8.1 — Query Performance and Missing Index

The most expensive query is the bulk load of Sprint-field changelogs across all board
issues. For a board with 2,000 synced issues and 50,000 changelog rows, this query
selects by `issueKey IN (...)` with up to 2,000 keys.

**Confirmed gap:** The initial migration (`1775795358704-InitialSchema.ts`) creates
**no indexes** on `jira_changelogs`. The table has only a primary key. An index on
`(issueKey, field)` is missing and must be added as part of this feature's
implementation.

The new migration must be:
```sql
-- Up
CREATE INDEX "IDX_jira_changelogs_issueKey_field"
  ON "jira_changelogs" ("issueKey", "field");

-- Down
DROP INDEX "IDX_jira_changelogs_issueKey_field";
```

This index benefits all existing services (`PlanningService`, `MttrService`,
`LeadTimeService`, `RoadmapService`) as well as the new `SprintDetailService`. The
migration file should follow the existing naming convention:
`backend/src/migrations/1775795358706-AddChangelogIndex.ts` (next available timestamp
prefix should be generated at implementation time).

#### 8.2 — `sprintId` Column Staleness

`JiraIssue.sprintId` stores only the most-recently synced sprint. Issues that were in
the requested sprint but have since moved to a later sprint will have a different
`sprintId` at query time. The service cannot rely on `WHERE sprintId = :id` alone — it
must load all board issues and replay changelogs, as `PlanningService` does. This is
correctly handled in §4a and §4b.

A consequence: for boards with many historical issues, loading all board issues is
mandatory. On a board with 2,000 issues this is a single efficient query (~100KB of
data), but it must be monitored.

#### 8.3 — No `any` Types

TypeScript `any` is prohibited throughout. All DTO interfaces must be fully typed.
The `boardConfig` sub-object in `SprintDetailResponse` uses the named
`SprintDetailBoardConfig` interface (defined in §3c) to prevent implicit `any` in
frontend consumers.

#### 8.4 — ESM Import Convention

All backend imports use the `.js` extension suffix (e.g. `import { JiraSprint } from
'../database/entities/index.js'`). All new files in `backend/src/sprint/` must follow
this convention exactly. Verify against existing controllers and services for the exact
pattern.

#### 8.5 — `DataTable` Row Key

The existing `DataTable` component (`frontend/src/components/ui/data-table.tsx`)
uses array index as the row key (`key={idx}` at line 113). For the sprint detail view,
`issue.key` (the Jira issue key) is stable and unique — however, changing `DataTable`
to accept an optional `rowKey` prop would affect all consumers. The array-index
fallback is acceptable here and the `DataTable` component is left unchanged.

---

## Alternatives Considered

### Alternative A — Add Detail Columns to the Existing Planning Table

Extend `SprintAccuracy` with per-issue breakdown data and render it as an expandable
row within the existing planning table.

**Rejected because:** per-sprint issue lists can contain 10–40 rows. Embedding a nested
table inside a table row creates significant accessibility and layout complexity, and
requires a fundamentally different component model than the existing `DataTable`.
A separate page is cleaner, naturally deep-linkable, and avoids bloating the planning
API response with per-issue data for every sprint in the page load.

### Alternative B — Extend an Existing Module (Planning or Roadmap)

Add the `GET /api/sprints/:boardId/:sprintId/detail` endpoint to the `PlanningModule`
or `RoadmapModule`.

**Rejected because:** the sprint detail view synthesises data from both planning
(membership reconstruction) and roadmap (JPD coverage) domains. Placing it in either
module creates an awkward dependency (planning importing JPD repositories, or roadmap
importing planning logic). A separate `SprintModule` has a clean dependency edge:
it imports entities from the database layer but has no module-level dependency on
`PlanningModule` or `RoadmapModule`.

### Alternative C — Client-Side Annotation Computation

Fetch raw sprint issues from an existing endpoint and compute annotations in the browser
using data already available from other API calls (roadmap accuracy, planning accuracy).

**Rejected because:** client-side computation would require the frontend to independently
implement sprint membership reconstruction from changelogs, CFR/MTTR rule evaluation,
and lead time calculation — all of which already exist as server-side logic. This
violates the principle that calculation logic lives in services. It would also require
multiple round-trip API calls (issues, changelogs, sprint data, board config, JPD ideas)
rather than a single typed endpoint.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Index migration required | No schema changes. Add `(issueKey, field)` index on `jira_changelogs` — benefits all existing services. Migration file: `backend/src/migrations/<timestamp>-AddChangelogIndex.ts`. |
| API contract | Additive | New endpoint `GET /api/sprints/:boardId/:sprintId/detail`. No existing endpoints changed. |
| Frontend | New page + navigation links in two tables | New `frontend/src/app/sprint/[boardId]/[sprintId]/page.tsx`. `sprintName` column in `frontend/src/app/planning/page.tsx` and `frontend/src/app/roadmap/page.tsx` gains a `<Link>` wrapper. `frontend/src/lib/api.ts` gains new types and `getSprintDetail()`. |
| Tests | New unit tests for `SprintDetailService` | Require mocked repositories. Cover: membership replay (committed, added, removed), all annotation rules, empty sprint, Kanban rejection, missing boardConfig defaults, no RoadmapConfig rows. |
| Jira API | No new calls | All data is read from Postgres. No new Jira API endpoints. No rate-limit impact. |
| `AppModule` | Additive | `SprintModule` added to `imports` in `backend/src/app.module.ts`. |

---

## Acceptance Criteria

- [ ] A new migration adds a `CREATE INDEX "IDX_jira_changelogs_issueKey_field" ON
      "jira_changelogs" ("issueKey", "field")` with a matching `DROP INDEX` in the
      `down()` method.
- [ ] `GET /api/sprints/PLAT/:sprintId/detail` returns `400 Bad Request` with a clear
      message for Kanban boards.
- [ ] `GET /api/sprints/ACC/nonexistent/detail` returns `404 Not Found`.
- [ ] `GET /api/sprints/ACC/:sprintId/detail` for a known sprint returns a
      `SprintDetailResponse` with correct `sprintId`, `sprintName`, `state`,
      `startDate`, `endDate`.
- [ ] The `issues[]` array excludes `issueType === 'Epic'` and `issueType === 'Sub-task'`.
- [ ] An issue present at sprint start has `addedMidSprint = false`.
- [ ] An issue whose first Sprint-field changelog pointing to this sprint has
      `changedAt > sprint.startDate + 5 minutes` has `addedMidSprint = true`.
- [ ] An issue created within 5 minutes of `sprint.startDate` has `addedMidSprint = false`.
- [ ] An issue with `issue.sprintId === sprint.id` and no Sprint-field changelog is
      included in the `issues[]` array (current-sprint assignment fallback).
- [ ] `roadmapLinked = true` iff `issue.epicKey ∈ coveredEpicKeys`, where
      `coveredEpicKeys` is built from `JpdIdea.deliveryIssueKeys` **scoped to
      configured `RoadmapConfig.jpdKey` values** only.
- [ ] `roadmapLinked = false` when `issue.epicKey` is null.
- [ ] `roadmapLinked = false` for all issues when no `RoadmapConfig` rows exist.
- [ ] `isIncident = true` iff `issue.issueType ∈ boardConfig.incidentIssueTypes`
      OR (`boardConfig.incidentLabels.length > 0` AND `issue.labels` intersects
      `boardConfig.incidentLabels`).
- [ ] `isFailure = true` iff `issue.issueType ∈ boardConfig.failureIssueTypes`
      OR `issue.labels` intersects `boardConfig.failureLabels`.
- [ ] `completedInSprint = true` for an issue that transitioned to a `doneStatusName`
      within `[sprint.startDate, sprint.endDate]`.
- [ ] `completedInSprint = true` for an issue whose current status is in
      `doneStatusNames` (fallback for missing/truncated changelogs).
- [ ] `completedInSprint = false` for an issue that reached a done status only after
      `sprint.endDate`.
- [ ] `completedInSprint = false` for an issue that reached a done status before
      `sprint.startDate` (prior-sprint completion not credited).
- [ ] `leadTimeDays` is `null` for an issue with no done-status transition in the
      changelog.
- [ ] `leadTimeDays` is computed from `firstInProgressTransition → firstDoneTransition`
      when an In Progress transition exists.
- [ ] `leadTimeDays` falls back to `createdAt → firstDoneTransition` when no In Progress
      transition exists (Scrum fallback, not null).
- [ ] Negative `leadTimeDays` values (data anomalies) are clamped to `null`.
- [ ] `summary.committedCount + summary.addedMidSprintCount` equals `issues.length`
      (every issue in the array is either committed or added).
- [ ] `summary.removedCount` correctly counts issues removed during the sprint window
      (these are NOT in `issues[]`).
- [ ] `summary.medianLeadTimeDays` is null when no issues have a computed `leadTimeDays`.
- [ ] `jiraUrl` for each issue equals `${JIRA_BASE_URL}/browse/${issue.key}`.
- [ ] `jiraUrl` is `''` (empty string) when `JIRA_BASE_URL` is not configured.
- [ ] `GET /api/sprints/ACC/:sprintId/detail` completes in under 500ms for a sprint with
      40 issues on a board with 500 total issues (performance regression guard).
- [ ] The frontend page `/sprint/ACC/:sprintId` renders the summary bar and issues table.
- [ ] Clicking a sprint name in the Planning page sprint table navigates to
      `/sprint/[boardId]/[sprintId]`.
- [ ] Clicking a sprint name in the Roadmap page sprint-mode table navigates to
      `/sprint/[boardId]/[sprintId]`.
- [ ] No sprint navigation links are rendered in roadmap quarter-mode (Kanban path).
- [ ] The back-link navigates correctly based on the `?from=` query parameter.
- [ ] The issues table is sortable by all columns with sortable=true.
- [ ] The `jiraUrl` opens in a new tab (`target="_blank"`).
- [ ] No TypeScript `any` types are introduced in new files.
- [ ] All new backend files use `.js` ESM import suffixes.
- [ ] No new npm packages are added to `frontend/package.json`.
- [ ] `SprintModule` imports `RoadmapConfig` in `TypeOrmModule.forFeature([...])`.
- [ ] `SprintDetailService` injects `ConfigService` for `JIRA_BASE_URL`.
