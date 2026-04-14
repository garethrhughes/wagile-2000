# 0024 — Unplanned Done Tickets Report

**Date:** 2026-04-14
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** None yet — to be created upon acceptance

---

## Problem Statement

The existing Gaps report (`GET /api/gaps`, proposals 0013 + 0014) surfaces hygiene
problems in **active sprints**: open issues missing epic links or story point estimates.
It does not answer the complementary question: *"which tickets were marked Done during
a sprint or quarter but were never part of any sprint's formal commitment?"*

These "unplanned completions" — tickets resolved from the backlog, ad-hoc hotfixes
filed and closed without sprint assignment, or issues added to a sprint retroactively
*after* they were already completed — are invisible to the current tooling. They
represent scope that was delivered but never planned, which distorts sprint velocity,
obscures true delivery capacity, and masks ad-hoc work patterns that may indicate
process friction. Surfacing them as a named Gaps sub-report gives engineering managers
an actionable signal: either the issues should have been planned, or the planning
process needs strengthening.

---

## Feature Summary

The **Unplanned Done Tickets** report shows every work item that transitioned to a done
status within a selected date window (a sprint or a calendar quarter) **but had no
recorded sprint membership at the point of completion**. The report is placed in the
existing Gaps section of the frontend (`/gaps`) as a new collapsible panel and a new
backend endpoint `GET /api/gaps/unplanned-done`.

A ticket is classified as "unplanned done" when **all** of the following hold at the
moment it transitioned to a done status:

1. The transition timestamp falls within the requested date window.
2. The issue was not a member of any sprint at or before the completion timestamp
   (determined by replaying the `Sprint`-field changelog, the same algorithm used by
   `PlanningService` and `SprintDetailService`).
3. The issue is a work item (`isWorkItem` — excludes Epics and Sub-tasks).
4. The issue belongs to a Scrum board (Kanban boards are excluded — they have no
   sprint concept and all completed Kanban issues would otherwise flood the report).

---

## Data Model Analysis

### Fields available in the current schema

| Field | Source | Notes |
|---|---|---|
| `jira_issues.key` | `JiraIssue.key` | Issue key e.g. `ACC-123` |
| `jira_issues.summary` | `JiraIssue.summary` | Issue title |
| `jira_issues.status` | `JiraIssue.status` | Current status (snapshot at last sync) |
| `jira_issues.issueType` | `JiraIssue.issueType` | `Story`, `Bug`, `Task`, etc. |
| `jira_issues.boardId` | `JiraIssue.boardId` | Project key / board identifier |
| `jira_issues.sprintId` | `JiraIssue.sprintId` | **Last-synced sprint only** — NOT reliable for history |
| `jira_issues.epicKey` | `JiraIssue.epicKey` | Parent epic link (nullable) |
| `jira_issues.points` | `JiraIssue.points` | Story points / estimate (nullable) |
| `jira_issues.priority` | `JiraIssue.priority` | Priority label (nullable) |
| `jira_issues.labels` | `JiraIssue.labels` | JSON array of label strings |
| `jira_issues.createdAt` | `JiraIssue.createdAt` | Issue creation timestamp |
| `jira_changelogs.field = 'status'` | `JiraChangelog` | Status transition history — used to find `resolvedAt` |
| `jira_changelogs.field = 'Sprint'` | `JiraChangelog` | Sprint membership history — used to determine sprint assignment at completion time |
| `jira_sprints.*` | `JiraSprint` | Sprint start/end dates and state — used for date-window queries |
| `board_configs.boardType` | `BoardConfig.boardType` | `'scrum'` \| `'kanban'` — Kanban exclusion |
| `board_configs.doneStatusNames` | `BoardConfig.doneStatusNames` | Per-board done status list |

### Missing fields — `assignee` is not persisted

The Jira REST API returns an `assignee` object on each issue, but the current
`JiraIssue` entity **does not store it**. The `mapJiraIssue` method in `SyncService`
does not map `raw.fields.assignee`. Including assignee in the report would require:

1. A new `assignee` column in `jira_issues` (varchar, nullable).
2. A corresponding database migration.
3. Updating `mapJiraIssue` to extract `raw.fields.assignee?.displayName ?? null`.
4. Updating the Jira API field list in `getSprintIssues` and `searchIssues` to include
   the `assignee` field.

This is a standalone database migration (additive, reversible). **See Open Questions §1.**

### `resolvedAt` is derived, not stored

There is no `resolvedAt` column in `jira_issues`. The resolution timestamp must be
reconstructed from `jira_changelogs` by finding the first `field = 'status'`
changelog whose `toValue` is in the board's `doneStatusNames` list. This is the same
approach used in `SprintDetailService.getDetail()` (see `doneTransition` logic at
lines 485–490 of `sprint-detail.service.ts`).

---

## Identification Logic — "Completed Outside a Sprint"

### Core algorithm

For each work item on a Scrum board, the service must answer: *"was this issue in a
sprint when it transitioned to Done?"*

The `jira_issues.sprintId` column stores only the **last-synced** sprint assignment
and is unreliable for historical queries. The canonical approach (already established
in `PlanningService` and `SprintDetailService`) is changelog replay over the
`jira_changelogs` table, using `field = 'Sprint'` entries.

```
For issue I:
  1. Find the first status-changelog entry where toValue ∈ doneStatusNames
     → resolvedAt (timestamp), resolvedStatus (status name)
     If none found AND current status is done → treat createdAt as resolvedAt (fallback)

  2. If resolvedAt is outside the requested date window → skip

  3. Replay Sprint-field changelogs for I up to and including resolvedAt:
     - At each changelog: if toValue contains a sprint name → inSprint = true
     - At each changelog: if fromValue contains a sprint name and toValue does not → inSprint = false
     - After replay: if inSprint is false → issue was NOT in any sprint at completion

  4. If inSprint is false at resolvedAt → this is an unplanned completion
```

### Sprint-name matching

Use the same `sprintValueContains` helper already present in `PlanningService` and
`SprintDetailService`: split the comma-separated Sprint field value and match by exact
sprint name (prevents `Sprint 1` from matching `Sprint 10`).

### Date window modes

The endpoint accepts either a **sprint ID** (`?boardId=ACC&sprintId=123`) or a
**quarter** (`?boardId=ACC&quarter=2026-Q1`), mirroring the existing pattern used by
`GET /api/planning/accuracy` and `GET /api/sprints/:boardId/:sprintId/detail`.

For sprint mode: the date window is `[sprint.startDate, sprint.endDate]`.
For quarter mode: derive the window from `quarterToDates()` (already in `period-utils.ts`).
For "all time" (no window): return results for the last 90 days as a fallback
(consistent with `quarterToDates` fallback behaviour for invalid input).

### The retroactive-addition edge case

A ticket may appear in a sprint *after* it was marked Done. For example, a developer
completes a ticket, then a sprint master retroactively adds it to the just-closed
sprint to capture the credit. In this case:

- The Sprint-field changelog shows the issue added to the sprint **after** its done
  transition.
- The replay algorithm (step 3 above) only considers changelog entries **up to and
  including `resolvedAt`**, so the retroactive addition is not visible at completion
  time.
- Result: the issue is **correctly classified as unplanned** even though it is
  nominally in a sprint by the time of the next sync.

This is the desired behaviour: the question is "was it planned when it was done?",
not "is it in a sprint now?".

---

## Backend Changes

### New endpoint

```
GET /api/gaps/unplanned-done?boardId=ACC&sprintId=123
GET /api/gaps/unplanned-done?boardId=ACC&quarter=2026-Q1
GET /api/gaps/unplanned-done?boardId=ACC
```

The endpoint lives on the **existing `GapsController`** (`api/gaps`), adding a new
route method. Keeping it in the Gaps module maintains the existing module boundary
and avoids creating a new module for a single endpoint.

### New service method: `GapsService.getUnplannedDone()`

A new method is added to the existing `GapsService`. It requires the `JiraChangelog`
repository, which is **not currently injected into `GapsService`**. The module must
be updated to add this dependency.

#### Method signature (proposed)

```typescript
export interface UnplannedDoneIssue {
  key: string;
  summary: string;
  issueType: string;
  boardId: string;
  resolvedAt: string;          // ISO 8601 — the done-transition timestamp
  resolvedStatus: string;      // the done status name reached
  points: number | null;
  epicKey: string | null;
  priority: string | null;
  assignee: string | null;     // requires schema migration — see Open Questions §1
  labels: string[];
  jiraUrl: string;
}

export interface UnplannedDoneResponse {
  boardId: string;
  window: { start: string; end: string };
  issues: UnplannedDoneIssue[];
  summary: {
    total: number;
    totalPoints: number;         // sum of points (null treated as 0)
    byIssueType: Record<string, number>;  // e.g. { Bug: 3, Story: 2 }
  };
}
```

#### Query DTO

```typescript
// backend/src/gaps/dto/unplanned-done-query.dto.ts
export class UnplannedDoneQueryDto {
  @IsString()
  boardId!: string;

  @IsOptional()
  @IsString()
  sprintId?: string;

  @IsOptional()
  @IsString()
  quarter?: string;
}
```

#### Algorithm outline

```
getUnplannedDone(boardId, sprintId?, quarter?):

1. Load BoardConfig for boardId
   - If boardType = 'kanban' → throw BadRequestException
   - Extract doneStatusNames

2. Determine date window:
   - If sprintId: load JiraSprint, set [sprint.startDate, sprint.endDate ?? now]
   - If quarter: use quarterToDates(quarter) from period-utils
   - If neither: last 90 days

3. Load all work-item JiraIssues for this boardId
   (issueRepo.find({ where: { boardId } }) filtered through isWorkItem)

4. Bulk-load ALL status-field changelogs for these issue keys
   (single query: field = 'status', ordered by changedAt ASC)

5. Bulk-load ALL Sprint-field changelogs for these issue keys
   (single query: field = 'Sprint', ordered by changedAt ASC)

6. For each issue:
   a. Find the first status changelog where toValue ∈ doneStatusNames
      AND changedAt is within [windowStart, windowEnd]
      → resolvedAt, resolvedStatus
      If no such changelog found:
        - If current status is done AND createdAt is within the window → use createdAt
        - Else → skip this issue

   b. Replay Sprint-field changelogs for this issue up to resolvedAt:
      - Start with inSprint = false
      - Walk changelog entries (sorted ASC by changedAt):
        - If changedAt > resolvedAt → break
        - If toValue contains any sprint name → inSprint = true
        - If fromValue contains a sprint name AND toValue does not → inSprint = false

   c. If inSprint is true at resolvedAt → skip (planned completion)
   d. If inSprint is false → classify as unplanned done

7. Build UnplannedDoneIssue objects for all unplanned issues

8. Sort by resolvedAt DESC (most recent first), then by key ASC for ties

9. Build summary stats

10. Return UnplannedDoneResponse
```

#### Performance characteristics

- Issues per board: ≤ ~1,000 rows (bounded by sync cap).
- Changelogs per issue: typically 5–20 rows; Sprint-field changelogs are a small
  fraction of total changelogs.
- Total changelog rows per board: ≤ ~20,000.
- All data is in Postgres; no live Jira API calls at query time.
- The two bulk-load queries (steps 4 and 5) use `IN (:...keys)` — consistent with
  the existing pattern in `SprintDetailService` and `PlanningService`.
- No new indexes are required. The existing pattern has been proven adequate for the
  target data volumes (single-user tool, see proposal 0013 §Performance).

#### Module changes

`GapsModule` must add `JiraChangelog` to its `TypeOrmModule.forFeature` list and
inject the `JiraChangelog` repository into `GapsService`.

```typescript
// gaps.module.ts — updated imports
TypeOrmModule.forFeature([JiraIssue, JiraSprint, BoardConfig, JiraChangelog])
```

No changes to `AppModule` are required.

---

## Frontend Changes

### Route

No new route is needed. The report is added as a new collapsible section on the
existing `/gaps` page (`frontend/src/app/gaps/page.tsx`), below the existing
"Issues without an Epic" and "Issues without a story point estimate" sections.

The gaps page already uses the `CollapsibleSection` component pattern with count
badges. The new section follows the same pattern.

### Filters

The report needs two controls:

1. **Board selector** — already present on the page (board chip filter). The board
   selection drives the API call (the endpoint requires `boardId`).

2. **Period selector** — a new control allowing the user to pick either:
   - A specific sprint (populated from `GET /api/planning/sprints?boardId=ACC`), or
   - A calendar quarter (populated from `GET /api/planning/quarters`), or
   - "Last 90 days" (no filter, the default).

   This follows the same pattern used by `/planning/page.tsx` (the sprint/quarter
   selector tabs). The existing `SprintSelect` and `QuarterSelect` components can be
   reused directly.

### Data fetching

The unplanned done report is **not** fetched with the existing `getGaps()` call. It is
fetched separately on demand when the user selects a board + period, because:

- It requires a `boardId` parameter (unlike the current gaps which are board-agnostic
  in their API call).
- The changelog-replay algorithm is more expensive; it should not run on page load for
  all boards simultaneously.
- Lazy loading per board is consistent with the UX of the Planning page and Sprint
  Detail page.

The section shows an empty/prompt state ("Select a board and period to see unplanned
completions") until the user makes a selection.

### New `api.ts` types and wrapper

```typescript
// frontend/src/lib/api.ts additions

export interface UnplannedDoneIssue {
  key: string
  summary: string
  issueType: string
  boardId: string
  resolvedAt: string
  resolvedStatus: string
  points: number | null
  epicKey: string | null
  priority: string | null
  assignee: string | null      // null until assignee migration lands
  labels: string[]
  jiraUrl: string
}

export interface UnplannedDoneSummary {
  total: number
  totalPoints: number
  byIssueType: Record<string, number>
}

export interface UnplannedDoneResponse {
  boardId: string
  window: { start: string; end: string }
  issues: UnplannedDoneIssue[]
  summary: UnplannedDoneSummary
}

export interface UnplannedDoneParams {
  boardId: string
  sprintId?: string
  quarter?: string
}

export function getUnplannedDone(
  params: UnplannedDoneParams,
): Promise<UnplannedDoneResponse> {
  return apiFetch(
    `/api/gaps/unplanned-done${toQueryString({
      boardId: params.boardId,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  )
}
```

### Table columns

The issues table renders the following columns (using the existing `DataTable<T>`
component):

| Column | Key | Notes |
|---|---|---|
| Issue | `key` | Linked to `jiraUrl`, opens in new tab |
| Summary | `summary` | Truncated to 60 chars with `title` tooltip |
| Type | `issueType` | Plain text |
| Status | `resolvedStatus` | The done status reached |
| Resolved | `resolvedAt` | Formatted as `dd Mon yyyy` using `toLocaleDateString` |
| Points | `points` | `—` when null |
| Epic | `epicKey` | Monospace, `—` when null |
| Priority | `priority` | `—` when null |
| Board | `boardId` | Present when showing cross-board results (future) |

### Summary bar

Above the table, a small stats bar shows:
- Total unplanned tickets (count)
- Total unplanned points (sum, with `—` when all null)
- Breakdown by issue type (e.g. `Bug × 3`, `Story × 2`)

This follows the `StatChip` pattern used in `sprint/[boardId]/[sprintId]/page.tsx`.

### Navigation / Sidebar

The sidebar requires **no changes**. The report lives under the existing `/gaps` route
which is already in the `MAIN_NAV_ITEMS` array.

---

## Proposed File Structure

### Backend (new and modified files)

```
backend/src/gaps/
  gaps.module.ts               MODIFIED — add JiraChangelog to forFeature()
  gaps.controller.ts           MODIFIED — add GET unplanned-done route
  gaps.service.ts              MODIFIED — add getUnplannedDone() method
  gaps.service.spec.ts         MODIFIED — add tests for getUnplannedDone()
  dto/
    unplanned-done-query.dto.ts  NEW
```

### Frontend (new and modified files)

```
frontend/src/
  lib/
    api.ts                     MODIFIED — add types + getUnplannedDone()
  app/
    gaps/
      page.tsx                 MODIFIED — add UnplannedDoneSection component
      unplanned-done-section.tsx  NEW (optional extract for cleanliness)
```

### Optional: database migration (if assignee is included)

```
backend/src/
  migrations/
    NNNNNNNNNNNN-AddAssigneeToJiraIssues.ts   NEW (reversible)
  database/entities/
    jira-issue.entity.ts       MODIFIED — add assignee column
  sync/
    sync.service.ts            MODIFIED — map assignee in mapJiraIssue()
  jira/
    jira-client.service.ts     MODIFIED — add 'assignee' to fields param
```

---

## Edge Cases

### 1. Subtasks and Epics

Both are excluded by the `isWorkItem()` filter, which rejects `issueType` values of
`'Epic'` and `'Sub-task'`. This is consistent with every other metric in the system.
Subtasks typically do not have independent sprint membership and would produce noise.

### 2. Tickets in multiple sprints (Jira next-gen / team-managed projects)

Jira next-gen projects support concurrent sprint membership. The sync stores only the
most recent `sprintId` in `jira_issues.sprintId`, but the `Sprint`-field changelog
captures all sprint transitions. The changelog-replay algorithm handles multi-sprint
scenarios correctly: if the Sprint changelog shows the issue was ever added to a sprint
before `resolvedAt`, `inSprint` will be `true` and the issue is classified as planned.

### 3. Tickets added to a sprint *after* completion (retroactive sprint assignment)

As described in the identification logic section above: the algorithm caps the
changelog replay at `resolvedAt`. Any Sprint changelog entry after `resolvedAt` is
ignored. The ticket is correctly classified as unplanned at the time of completion.
This is intentional behaviour.

### 4. Issues completed in a previous sync cycle that are no longer in `jira_issues`

The sync does not delete issues from `jira_issues` when they leave a sprint; issues
are upserted on every sync cycle. An issue completed six months ago that is still
in the database will appear in the results if its `resolvedAt` falls within the
requested window. This is correct — historical completions are within scope.

Issues that were *deleted from Jira* (rare) would disappear from `jira_issues` on
the next sync and would not appear in the results. This is an acceptable data gap.

### 5. No status changelog (changelog truncation)

Some issues have no `status` changelog entries (data truncation, issues created
directly in a done status, or very old issues). The fallback rule: if the current
`issue.status` is in `doneStatusNames` AND `issue.createdAt` falls within the window
— treat `createdAt` as the resolution timestamp. This is a conservative fallback;
the sprint membership replay will proceed normally and may classify the issue as
unplanned if no Sprint changelog exists.

### 6. Issues resolved and then re-opened

The algorithm finds the **first** status-changelog entry where `toValue ∈ doneStatusNames`
within the window. If an issue was resolved, re-opened, and resolved again, only the
first within-window completion is counted. The issue appears once in the results.
A future proposal could change this to "most recent completion within window" if
needed.

### 7. Kanban boards

All Kanban boards are excluded from this report via `BadRequestException` when
`boardType = 'kanban'`. The frontend should gracefully disable or hide the period
selector and show an informational message when a Kanban board is selected.

### 8. Scrum boards with no sprint data

If a Scrum board has no sprints in `jira_sprints` (e.g. a new board that has never
had a sprint), the service returns an empty `issues` array. The Sprint-field changelog
replay will always yield `inSprint = false`, so all resolved issues would be flagged
as unplanned. **This is a genuine edge case worth noting**: a brand-new board with
its first sprint in progress but not yet synced would produce a misleading flood of
"unplanned" issues. The frontend should include a note about sync recency.

### 9. Issues with `points = 0` vs `points = null`

`points = 0` is treated as estimated at zero points (distinct from `null`). It
contributes `0` to the `totalPoints` aggregate and is not flagged differently.
This is consistent with the existing convention in `GapsService`.

---

## Alternatives Considered

### Alternative A — Extend the existing `GET /api/gaps` endpoint

Add `unplannedDone` as a third array in the existing `GapsResponse`, alongside
`noEpic` and `noEstimate`.

**Why considered:** Keeps a single HTTP call for the Gaps page; no board/period
selector needed.

**Why ruled out:**
- The current Gaps endpoint is a parameterless, cross-board report of *open* issues.
  Unplanned done requires a `boardId` and a date window (sprint or quarter) — it has
  fundamentally different filter semantics.
- The changelog-replay algorithm is more expensive than the existing pass. Running it
  across all boards on every page load would make the Gaps page noticeably slower.
- The `UnplannedDoneResponse` shape includes a `summary` object and a `window` field
  that have no parallel in `GapsResponse`. Shoehorning it into the existing response
  would make the shape inconsistent.

### Alternative B — New standalone module (`UnplannedModule`)

Create `backend/src/unplanned/` with its own module, controller, and service.

**Why considered:** Maintains strict module boundary separation; keeps Gaps module
focused on its original hygiene-report responsibility.

**Why ruled out:** The unplanned done report is semantically part of the "Gaps" family
(it surfaces a planning gap). Creating a new module for a single endpoint adds
boilerplate without benefit. The Gaps module already imports `JiraIssue`, `JiraSprint`,
and `BoardConfig` — it only needs `JiraChangelog` added. The existing `GapsController`
can host the new route method cleanly.

### Alternative C — Use the `jira_issues.sprintId` column directly

Check `issue.sprintId IS NULL` at query time and classify any issue with no sprint
assignment as "unplanned done".

**Why considered:** Extremely simple — one column check, no changelog replay needed.

**Why ruled out:**
- `sprintId` stores only the **last-synced** sprint. An issue that was completed in
  Sprint 5 but has since been assigned (retroactively or accidentally) to Sprint 6
  would be classified as planned even though it was unplanned at completion time.
- Conversely, an issue completed *during* a sprint but whose `sprintId` was later
  cleared (sprint closed and issue moved) would be incorrectly classified as unplanned.
- The changelog-replay approach is already the established pattern in this codebase
  (proposals 0002, 0006, 0014) and is the correct answer to any historical sprint
  membership question.

### Alternative D — New page at `/gaps/unplanned-done`

Route the report to its own page rather than embedding it in `/gaps`.

**Why considered:** Gives the report more vertical space; allows deeper pagination and
filtering without competing with the existing gap tables.

**Why ruled out:** The Gaps section already has a collapsible UI pattern that scales
well. A separate page increases routing complexity and requires a back-button
integration. The collapsible panel approach is consistent with existing sections.
A follow-up proposal could promote it to a dedicated page if usage patterns demand it.

### Alternative E — Include Kanban boards (treat completion date as "planned" only if within a quarter window)

Define "planned" on Kanban boards as any issue that was already "on the board" (had
a board-entry date) before the quarter started.

**Why considered:** Extends the feature to Kanban boards, which have value as a
completeness signal.

**Why ruled out:** The semantic of "unplanned" is tied to sprint membership, which is
a Scrum concept. Kanban planning is continuous-flow by design; applying sprint-based
unplanned logic would produce misleading results. A separate "Kanban ad-hoc completions"
report with different semantics would be a better framing — out of scope for this
proposal.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Optional migration | Additive `assignee` column on `jira_issues` — nullable varchar, reversible. Not required for the core feature; report functions without it (column shows `—`). |
| API contract | Additive | New `GET /api/gaps/unplanned-done` endpoint. Existing `GET /api/gaps` endpoint unchanged. `GapsResponse` interface unchanged. |
| Frontend | Additive (existing page modified) | New collapsible section on `/gaps` page. New `UnplannedDoneIssue`, `UnplannedDoneResponse` types in `api.ts`. New `getUnplannedDone()` wrapper. No sidebar changes. |
| Tests | New unit tests required | `GapsService.getUnplannedDone()` needs cases for: issue completed in window with no sprint → unplanned; issue completed in window with sprint at completion time → planned; retroactive sprint assignment after completion → unplanned; Kanban board → throws; no changelog fallback; outside window → excluded. |
| Jira API | No new calls | All data sourced from local Postgres changelogs, synced at regular intervals. |
| Performance | Moderate | Two bulk `IN (:...keys)` changelog queries per request. Bounded by single-board scope (~1,000 issues, ~20,000 changelog rows). Consistent with existing patterns in `PlanningService` and `SprintDetailService`. |
| Sync | Optional: `assignee` field | If assignee is added: update `mapJiraIssue` and add `'assignee'` to the `fields` param in `getSprintIssues` and `searchIssues`. Backward-compatible — existing synced issues will have `assignee = null` until re-synced. |

---

## Open Questions

1. **Assignee field.** Should `assignee` be included in the report? It is the most
   useful filter for managers ("who is closing tickets outside of sprint planning?").
   Requires a migration (`AddAssigneeToJiraIssues`), a sync change, and a `jira-issue.entity.ts`
   update. The core report works without it. Decision: include or defer to a follow-up?

2. **Cross-board mode.** Should the endpoint support `boardId=ALL` (or omit `boardId`)
   to return unplanned done tickets across all Scrum boards? This is useful for an
   org-level view but requires running the changelog-replay algorithm across all boards.
   Performance risk is manageable (≤ 5 Scrum boards × ~1,000 issues each) but the
   frontend UI would need to handle mixed-board results differently. Defer to a
   follow-up?

3. **"First done transition" vs "last done transition" within window.** If an issue
   transitions to Done, is re-opened, and transitions to Done again within the same
   window — should it count once (first) or once (last)? Current proposal: first.
   Is this the right behaviour?

4. **Threshold / summary callout.** Should the summary bar include a band signal
   (e.g. green/amber/red thresholds for what % of completed work was unplanned)?
   There are no published DORA-equivalent thresholds for this metric. Recommend
   deferring to post-launch when baseline data is available.

5. **Pagination.** For a full-quarter query on a busy board, the issue list could
   exceed 50–100 rows. Should the table paginate, or is scrolling acceptable for an
   internal tool? The existing `DataTable` component does not paginate. Recommend
   accepting scrolling for now and adding pagination in a follow-up if needed.

6. **"No active sprints" boards in the period selector.** When a Kanban board is
   selected, the sprint dropdown would be empty and a quarter dropdown would still
   work. The frontend must gracefully degrade the period control when no sprints are
   available.

---

## Acceptance Criteria

- [ ] `GET /api/gaps/unplanned-done?boardId=ACC&sprintId=123` returns an
      `UnplannedDoneResponse` containing only work items whose first done-status
      transition falls within the sprint's `[startDate, endDate]` window AND whose
      Sprint-field changelog replay (up to `resolvedAt`) shows `inSprint = false`.

- [ ] `GET /api/gaps/unplanned-done?boardId=ACC&quarter=2026-Q1` returns the same
      shape scoped to the calendar quarter window.

- [ ] `GET /api/gaps/unplanned-done?boardId=PLAT` returns HTTP 400 for a Kanban board.

- [ ] An issue that was committed to a sprint before completion does **not** appear in
      the response (correctly classified as planned).

- [ ] An issue that was added to a sprint **after** its done transition appears in the
      response (correctly classified as unplanned at completion time).

- [ ] Epics and Sub-tasks are excluded from the response (`isWorkItem` filter applied).

- [ ] The `resolvedAt` field in each `UnplannedDoneIssue` is the ISO 8601 timestamp of
      the first done-status transition within the requested window.

- [ ] The `summary` object reflects the correct `total`, `totalPoints`, and
      `byIssueType` counts for the returned issues.

- [ ] Issues are sorted `resolvedAt DESC` (most recent first), with `key ASC` as the
      tiebreaker.

- [ ] The `/gaps` frontend page renders a new "Unplanned Done Tickets" collapsible
      section below the existing two sections.

- [ ] The section shows a prompt state ("Select a board and period to view results")
      when no board or period has been chosen.

- [ ] The period selector supports sprint mode (via `SprintSelect`) and quarter mode
      (via `QuarterSelect`), mirroring the Planning page pattern.

- [ ] The section is hidden / shows a "not available for Kanban boards" message when
      a Kanban board is selected.

- [ ] The issues table renders: Issue key (linked), Summary, Type, Resolved Status,
      Resolved date, Points, Epic, Priority.

- [ ] The summary bar above the table shows: total count, total points, per-type
      breakdown.

- [ ] The existing `/gaps` page (`noEpic` / `noEstimate` sections) is unchanged in
      behaviour and appearance.

- [ ] `GET /api/gaps` (existing endpoint) is unchanged.

- [ ] No new npm dependencies are introduced in either the frontend or backend.

- [ ] Unit tests for `GapsService.getUnplannedDone()` cover: unplanned completion
      within window, planned completion (sprint at resolution time), retroactive sprint
      assignment, Kanban rejection, outside-window exclusion, no-changelog fallback,
      epic/subtask exclusion.

- [ ] The `JiraChangelog` repository is injected into `GapsService` without circular
      dependencies.

- [ ] If the `assignee` migration is included: the migration is reversible (has both
      `up` and `down` methods) and the `assignee` field appears in `UnplannedDoneIssue`
      with a non-null value for issues synced after the migration.
