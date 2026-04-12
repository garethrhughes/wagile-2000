# 0014 — Gaps Report Filtering: Active Sprint and Kanban Board Rules

**Date:** 2026-04-12
**Status:** Accepted
**Implemented:** 2026-04-12
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

The Gaps report (`GET /api/gaps`, implemented in proposal 0013) currently surfaces all
open work items across every board — including issues that are sitting in the backlog
with no sprint assignment, and unestimated items from Kanban boards where story points
are structurally irrelevant. This produces two categories of false-positive noise:

1. **Backlog clutter in both tables.** An issue with no sprint assignment (or assigned
   to a closed/future sprint) cannot be acted on in the current planning cycle.
   Including it alongside in-flight work dilutes the signal and inflates the counts.

2. **Kanban boards in the "no estimate" table.** Kanban boards (PLAT) do not use story
   points by workflow convention. Flagging every Kanban issue as unestimated is
   technically correct but operationally misleading — teams on Kanban cannot be expected
   to remediate these, making the table unreliable as a planning hygiene signal.

Without targeted filtering, both tables will consistently contain items that cannot
reasonably be actioned, reducing trust in the report.

---

## Proposed Solution

Two new filtering rules are applied inside `GapsService.getGaps()`, with different
scope for each table.

### Rule 1 — Active sprint gate (applied to both tables)

An issue is only included in either `noEpic` or `noEstimate` if it is currently
assigned to an **active** sprint. Formally:

- `issue.sprintId` must be non-null, AND
- the `JiraSprint` row with `id = issue.sprintId` must have `state = 'active'`.

Issues where `sprintId` is null (backlog) or points to a sprint with
`state = 'closed'` or `state = 'future'` are excluded from both tables.

### Rule 2 — Kanban board exclusion (applied to `noEstimate` only)

An issue is excluded from the `noEstimate` table if its `boardId` maps to a
`BoardConfig` row where `boardType = 'kanban'`.

This rule does **not** apply to `noEpic` — Kanban issues in an active sprint without
an epic link are still a genuine hygiene gap and should be visible.

### Updated `getGaps()` — step-by-step

```
1.  Load all BoardConfig rows → doneByBoard, cancelledByBoard, kanbanBoardIds

2.  Load all JiraSprint rows where state = 'active'
    → activeSprintIds: Set<string>   (used for the active-sprint gate)

3.  Load all JiraIssue rows; filter to isWorkItem only

4.  For each issue:

    a. EXCLUDE if status ∈ doneByBoard[boardId] ∪ cancelledByBoard[boardId]
       (existing logic — unchanged)

    b. EXCLUDE if sprintId IS NULL
       (new: backlog issues are not actionable)

    c. EXCLUDE if activeSprintIds does not contain sprintId
       (new: closed/future sprint issues are not actionable)

    d. Issue passes the shared gate → eligible for both tables

    e. Append to noEpic   if epicKey IS NULL or epicKey = ''

    f. Append to noEstimate if points IS NULL
                           AND boardId NOT IN kanbanBoardIds
       (new: Kanban board exclusion for estimate table only)

5.  Resolve sprintName for each surviving issue from sprintMap
    (sprint rows already loaded in step 2 — reuse the same array)

6.  Sort both arrays: boardId ASC, createdAt ASC
```

### Data access pattern

The current `getGaps()` loads sprints lazily — only the sprint IDs referenced by
open issues are queried. Under the new rules the sprint query must be **eager**: we
need all active sprints up front (step 2) so we can build `activeSprintIds` before
filtering issues.

**Change:** Replace the conditional lazy query:

```typescript
// BEFORE (lazy — only sprints referenced by open issues)
const sprints = await this.sprintRepo
  .createQueryBuilder('s')
  .where('s.id IN (:...ids)', { ids: sprintIds })
  .getMany();
```

With an eager query filtered to active state:

```typescript
// AFTER (eager — load all active sprints upfront)
const activeSprints = await this.sprintRepo.find({
  where: { state: 'active' },
});
const activeSprintIds = new Set(activeSprints.map((s) => s.id));
const sprintNameMap = new Map(activeSprints.map((s) => [s.id, s.name]));
```

This is correct because: (a) only issues assigned to active sprints survive the gate,
so `sprintNameMap` only needs entries for active sprints; (b) the previous two-phase
approach (collect IDs from issues, then query sprints) is rendered redundant.

**`kanbanBoardIds` derivation** (from the already-loaded configs array):

```typescript
const kanbanBoardIds = new Set(
  configs
    .filter((c) => c.boardType === 'kanban')
    .map((c) => c.boardId),
);
```

No new repository injection is required — `boardConfigRepo` is already present.

### Complete pseudocode for `getGaps()`

```typescript
async getGaps(): Promise<GapsResponse> {
  // Step 1: board configs
  const configs = await this.boardConfigRepo.find();
  const doneByBoard = new Map<string, string[]>();
  const cancelledByBoard = new Map<string, string[]>();
  const kanbanBoardIds = new Set<string>();

  for (const cfg of configs) {
    doneByBoard.set(cfg.boardId, cfg.doneStatusNames ?? ['Done', 'Closed', 'Released']);
    cancelledByBoard.set(cfg.boardId, cfg.cancelledStatusNames ?? ['Cancelled']);
    if (cfg.boardType === 'kanban') kanbanBoardIds.add(cfg.boardId);
  }

  // Step 2: active sprints (eager — needed for gate AND name resolution)
  const activeSprints = await this.sprintRepo.find({ where: { state: 'active' } });
  const activeSprintIds = new Set<string>(activeSprints.map((s) => s.id));
  const sprintNameMap = new Map<string, string>(activeSprints.map((s) => [s.id, s.name]));

  // Step 3: all work-item issues
  const allIssues = (await this.issueRepo.find()).filter((i) => isWorkItem(i.issueType));

  const jiraBase = process.env['JIRA_BASE_URL'] ?? '';

  const noEpic: GapIssue[] = [];
  const noEstimate: GapIssue[] = [];

  for (const issue of allIssues) {
    // Step 4a: exclude done / cancelled
    const done = doneByBoard.get(issue.boardId) ?? ['Done', 'Closed', 'Released'];
    const cancelled = cancelledByBoard.get(issue.boardId) ?? ['Cancelled'];
    if (done.includes(issue.status) || cancelled.includes(issue.status)) continue;

    // Step 4b–c: active sprint gate
    if (issue.sprintId === null || !activeSprintIds.has(issue.sprintId)) continue;

    const gap: GapIssue = {
      key: issue.key,
      summary: issue.summary,
      issueType: issue.issueType,
      status: issue.status,
      boardId: issue.boardId,
      sprintId: issue.sprintId,
      sprintName: sprintNameMap.get(issue.sprintId) ?? null,
      points: issue.points,
      epicKey: issue.epicKey,
      jiraUrl: jiraBase ? `${jiraBase}/browse/${issue.key}` : '',
    };

    // Step 4e: no-epic check
    if (issue.epicKey === null || issue.epicKey === '') noEpic.push(gap);

    // Step 4f: no-estimate check (Kanban boards excluded)
    if (issue.points === null && !kanbanBoardIds.has(issue.boardId)) noEstimate.push(gap);
  }

  // Step 6: sort
  const byBoardThenCreated = (a: GapIssue, b: GapIssue): number =>
    a.boardId.localeCompare(b.boardId) || a.key.localeCompare(b.key);

  noEpic.sort(byBoardThenCreated);
  noEstimate.sort(byBoardThenCreated);

  return { noEpic, noEstimate };
}
```

> **Sort note:** `createdAt` is not present on `GapIssue` (it was dropped in the
> implemented version relative to the 0013 proposal). The sort falls back to
> `boardId ASC, key ASC`, which is deterministic and adequate. If `createdAt` is
> added back to `GapIssue` (see Open Questions §1), the sort should prefer it.

### Interface changes

**None.** The `GapIssue` and `GapsResponse` interfaces are unchanged:

```typescript
// No changes to these interfaces
export interface GapIssue { ... }   // unchanged
export interface GapsResponse {
  noEpic: GapIssue[];
  noEstimate: GapIssue[];
}
```

The response shape is identical. Only the set of issues returned changes — rows are
removed (more restrictive), never added or renamed.

### Frontend impact

**None.** The board-chip / board-select filter on `/gaps` already works client-side
against the payload returned by the API. Because rows are only removed from the
response (never added), the frontend requires no changes:

- The board filter still operates over `boardId` values in the response.
- The `sprintName` field will now always be non-null (since backlog issues are
  excluded), but the frontend already handles both cases gracefully.
- The "Backlog" fallback for a null `sprintName` remains correct as a defensive
  render — it will simply never be shown under the new rules.

---

## Data Flow Diagram

```
GET /api/gaps
  │
  └─► GapsService.getGaps()
        │
        ├─ boardConfigRepo.find()
        │    → doneByBoard, cancelledByBoard
        │    → kanbanBoardIds  [NEW]
        │
        ├─ sprintRepo.find({ where: { state: 'active' } })  [CHANGED: eager, state-filtered]
        │    → activeSprintIds Set<string>  [NEW]
        │    → sprintNameMap Map<id, name>
        │
        ├─ issueRepo.find() → filter isWorkItem
        │
        └─ single-pass filter loop
              │
              ├─ skip if status ∈ done ∪ cancelled          (existing)
              ├─ skip if sprintId IS NULL                    [NEW]
              ├─ skip if sprintId ∉ activeSprintIds          [NEW]
              │
              ├─ if epicKey IS NULL → noEpic[]
              │
              └─ if points IS NULL
                   AND boardId ∉ kanbanBoardIds              [NEW]
                   → noEstimate[]

  Response shape: unchanged
  { noEpic: GapIssue[], noEstimate: GapIssue[] }
```

---

## Alternatives Considered

### Alternative A — Filter active sprint issues at the SQL layer (WHERE clause)

Apply the `state = 'active'` filter via a JOIN between `jira_issues` and
`jira_sprints` in a single SQL query, rather than loading all sprints eagerly and
filtering in TypeScript.

**Why considered:** Would reduce the number of rows loaded from `jira_issues` —
only issues in active sprints are fetched at all.

**Why ruled out:** The current `getGaps()` already loads all issues in-memory for
the done/cancelled exclusion pass. A JOIN query would require a more complex
`QueryBuilder` expression with multi-board conditions. The volume of issues in this
single-user tool is small (≤ ~5,000 rows across all boards), making the in-memory
filter path fast and simpler to maintain. Consistency with the existing pattern in
`GapsService` is preferred over premature SQL optimisation.

### Alternative B — Exclude Kanban boards from the `noEpic` table as well

Apply the Kanban exclusion symmetrically to both tables.

**Why considered:** Simplifies the filtering logic — a single Kanban exclusion pass
before the epic/estimate checks.

**Why ruled out:** Epic linkage is a valid hygiene concern on Kanban boards. Kanban
issues assigned to an active sprint (PLAT uses sprint-like milestones or `fixVersion`
groupings) without an epic represent untracked initiative scope regardless of board
type. The asymmetric rule — Kanban excluded from estimate table only — is intentional
and matches the business rationale (story points are irrelevant on Kanban; epic
linkage is relevant everywhere).

### Alternative C — Introduce a `noActiveSprint: GapIssue[]` third bucket

Rather than silently excluding backlog issues, surface them in a third result array
so the frontend can optionally show them.

**Why considered:** Would provide richer data; the frontend could toggle between
"active sprint only" and "all open issues" views.

**Why ruled out:** The current `/gaps` page has no UI for a third table, and the
brief explicitly asks for backlog exclusion. Adding a third bucket changes the API
contract and frontend layout, which is out of scope for this change. A follow-up
proposal can introduce it if demand arises.

### Alternative D — Client-side sprint filtering (pass sprint data to frontend)

Return sprint state information inside `GapIssue` (e.g., add `sprintState: string`)
and let the frontend apply the active-sprint filter.

**Why considered:** The sprint `state` field is already accessible on `JiraSprint`;
adding it to the DTO would be trivial.

**Why ruled out:** Filtering belongs in the service layer, not the view layer
(consistent with the design principle that calculation logic lives in services).
Client-side filtering also means the response payload always carries backlog issues,
increasing payload size and requiring the frontend to implement and test the rule.

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Board with no active sprint | All issues on that board fail the active-sprint gate and are excluded from both tables. The board may not appear in the response at all. This is correct — there is nothing actionable in that board's current cycle. |
| Issue with `sprintId` pointing to a closed sprint | `activeSprintIds.has(sprintId)` is false → excluded. This handles the common case of a leftover issue whose sprint was closed without being completed. |
| Issue with `sprintId` pointing to a future sprint | Same exclusion as closed sprint. Future sprints represent planned work, not current active work. |
| Issue with `sprintId = null` (pure backlog) | Explicitly excluded at step 4b. No sprint name resolution is attempted. |
| Kanban board (PLAT) with an active sprint equivalent | If PLAT has a sprint-like construct synced into `jira_sprints` with `state = 'active'`, its issues will pass the sprint gate and appear in `noEpic` if unlinked. They will not appear in `noEstimate` due to the Kanban exclusion. |
| Issue on a board with no `BoardConfig` row | `kanbanBoardIds` will not contain the boardId → the issue is treated as Scrum (included in `noEstimate` if unestimated). `doneByBoard` and `cancelledByBoard` fall back to their defaults. This matches the existing fallback behaviour. |
| Active sprint with zero issues passing all gates | Both arrays may be empty. The frontend `<EmptyState>` component handles this correctly. |
| Issue appears in both `noEpic` and `noEstimate` | Still possible and intentional (Scrum board, active sprint, no epic, no points). The Kanban exclusion only removes the `noEstimate` path, not the `noEpic` path. |

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes. No new migrations. The `state` column on `jira_sprints` and `boardType` on `board_configs` already exist. |
| API contract | None (additive filtering only) | Response shape is identical. Fewer rows are returned (stricter filter). No field is added, removed, or renamed. Clients that relied on backlog issues appearing will see them removed — this is the intended breaking behaviour for consumers, but the shape contract is unchanged. |
| Frontend | None | Board-chip filter and collapsible tables require no changes. `sprintName` will now always be non-null in practice, but the null-guard render path remains correct. |
| Tests | Updated unit tests | Existing `GapsService` tests must be updated: (1) add `sprintId` pointing to an active sprint to all "should include" fixtures; (2) add cases for backlog exclusion, closed-sprint exclusion, and Kanban exclusion from `noEstimate`; (3) verify Kanban issue still appears in `noEpic`. |
| Jira API | No new calls | All data sourced from local Postgres. |
| Performance | Neutral / slight improvement | The sprint query changes from a two-phase lazy load (collect IDs, then query) to a single eager `WHERE state = 'active'` query. The active sprint set is small (one per Scrum board at most), so the in-memory Set lookup is O(1) per issue. |

---

## Open Questions

1. **`createdAt` in `GapIssue`:** The implemented `GapIssue` (as seen in
   `gaps.service.ts`) does not include a `createdAt` field, whereas the 0013 proposal
   specified it. The sort in this proposal falls back to `boardId ASC, key ASC`. If
   `createdAt` is re-added to `GapIssue`, the sort should be updated to
   `boardId ASC, createdAt ASC`. Confirm whether this omission is intentional.

2. **`epicKey = ''` handling:** The current implementation checks
   `i.epicKey === null || i.epicKey === ''`. Confirm whether an empty-string `epicKey`
   can be returned by the Jira sync, or whether `null` is the canonical "no epic" value
   and the empty-string guard is defensive only.

3. **Multi-sprint issues (Jira next-gen projects):** In Jira next-gen projects an issue
   can be a member of multiple sprints simultaneously, but the sync stores only the
   most recent `sprintId`. If a board uses next-gen projects, an issue could be in both
   a closed sprint and an active sprint, but `sprintId` only reflects the last-synced
   one. Confirm whether any of the target boards (ACC, BPT, SPS, OCS, DATA, PLAT) use
   next-gen projects — if so, the `sprintId` field semantics need revisiting.

---

## Acceptance Criteria

- [ ] `GET /api/gaps` returns only issues whose `sprintId` maps to a `JiraSprint` row
      with `state = 'active'`. Issues with `sprintId = null` or with a sprint in
      `'closed'` or `'future'` state do not appear in either `noEpic` or `noEstimate`.

- [ ] `noEstimate` does not contain any issue whose `boardId` maps to a `BoardConfig`
      row where `boardType = 'kanban'`.

- [ ] `noEpic` still includes issues from Kanban boards, provided they are in an
      active sprint and their status is not done or cancelled.

- [ ] A board with no active sprint contributes zero issues to either result array.

- [ ] An issue assigned to a closed sprint (e.g., the sprint ended last week and was
      marked closed) does not appear in either table.

- [ ] An issue assigned to a future sprint does not appear in either table.

- [ ] An issue on a Scrum board with `points = null` and in an active sprint still
      appears in `noEstimate`.

- [ ] An issue that has both `epicKey = null` and `points = null`, is on a Scrum board,
      and is in an active sprint, appears in both `noEpic` and `noEstimate`.

- [ ] The `GapIssue` and `GapsResponse` interface shapes are unchanged (no new fields,
      no removed fields, no renamed fields).

- [ ] The frontend `/gaps` page requires no code changes and renders correctly with the
      updated response.

- [ ] Unit tests for `GapsService.getGaps()` are updated to cover:
      - backlog issue (sprintId = null) → excluded from both tables
      - issue in closed sprint → excluded from both tables
      - issue in future sprint → excluded from both tables
      - issue on Kanban board with `points = null` and active sprint → excluded from
        `noEstimate`, but included in `noEpic` if `epicKey = null`
      - issue on Scrum board with active sprint, `epicKey = null` → appears in `noEpic`
      - issue on Scrum board with active sprint, `points = null` → appears in `noEstimate`

- [ ] No new npm dependencies are introduced.

- [ ] No database migrations are required.
