# ADR-0016 — Calendar-Period Drill-Down as a First-Class View Pattern

**Date:** 2026-04-10
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0004 — Quarter Detail View](../proposals/0004-quarter-detail-view.md)

---

## Context

ADR-0014 established the **Sprint Detail View** pattern: a drill-down page reachable
from an aggregate sprint table, showing every issue in that sprint with per-issue
annotations computed server-side by a dedicated service module.

The Sprint Detail View is bounded by sprint membership, which is reconstructed by
replaying Jira Sprint-field changelogs. This algorithm is specific to sprint-aware
(Scrum) boards: it answers "was this issue in this sprint?" by examining how Jira
assigned and re-assigned issues to sprints over time.

The **Quarter Detail View** (Proposal 0004) introduces a second drill-down pattern
using a fundamentally different membership algorithm: **calendar-period bucketing via
board-entry date**. Rather than replaying sprint membership from changelogs, issues are
assigned to a quarter based on when they first appeared on the board. This algorithm
applies uniformly to both Scrum and Kanban boards (using different board-entry date
sources per board type) and is already the logic that `RoadmapService.getKanbanAccuracy()`
uses to bucket Kanban issues.

These are two distinct membership models:

| Model | Source of membership | Applicable to | Existing precedent |
|---|---|---|---|
| Sprint membership | Sprint-field changelog replay | Scrum boards only | `PlanningService`, `SprintDetailService` |
| Calendar-period bucketing | Board-entry date (changelog or createdAt) | Both Scrum and Kanban | `RoadmapService.getKanbanAccuracy()`, `QuarterDetailService` |

Establishing calendar-period drill-down as an explicit pattern (separate module, separate
algorithm, separate route shape) prevents the two models from being conflated in future
work.

---

## Decision

> **Calendar-period drill-down is a first-class view pattern distinct from sprint
> drill-down.** It lives in a dedicated `QuarterModule` at `backend/src/quarter/`,
> uses board-entry date bucketing (not sprint-membership reconstruction), and is valid
> for both Scrum and Kanban boards. The frontend route is `/quarter/[boardId]/[quarter]`,
> separate from `/sprint/[boardId]/[sprintId]`.

The two patterns are kept separate at every layer:

- **Module:** `QuarterModule` is a new, independent NestJS module. It does not depend on
  `SprintModule` and `SprintModule` does not depend on it.
- **Service:** `QuarterDetailService` uses `boardEntryDate` bucketing, not
  `wasInSprintAtDate()` changelog replay. It contains no sprint membership logic.
- **Endpoint:** `GET /api/quarters/:boardId/:quarter/detail` is a separate route prefix
  from `GET /api/sprints/:boardId/:sprintId/detail`.
- **Frontend:** `/quarter/[boardId]/[quarter]` is a separate Next.js dynamic route from
  `/sprint/[boardId]/[sprintId]`.

---

## Options Considered

### Option A — New `QuarterModule` with calendar-period bucketing

- **Summary:** Dedicated module/service/controller, board-entry date algorithm,
  valid for Scrum and Kanban boards.
- **Pros:** Clean separation of concerns; each pattern is independently testable and
  understandable; no algorithm leakage between sprint and quarter logic; Kanban boards
  are first-class citizens in the quarter view.
- **Cons:** Some helper function duplication (`issueToQuarterKey`, `quarterToDates`)
  shared with `RoadmapService`.

### Option B — Extend `SprintModule` to handle calendar-period drill-down

- **Summary:** Add a quarter path to `SprintController` and add quarter-bucketing logic
  to `SprintDetailService` behind a conditional branch.
- **Pros:** One fewer module.
- **Cons:** Merges two fundamentally different algorithms in one service, with branching
  on board type and period type. Makes both algorithms harder to understand, test, and
  modify independently. Kanban boards would need special-casing in a module originally
  designed to reject Kanban. Violates single-responsibility.

### Option C — Extend `RoadmapModule` with the quarter drill-down

- **Summary:** Add `GET /api/roadmap/:boardId/:quarter/detail` to the existing
  `RoadmapController` / `RoadmapService`.
- **Pros:** `RoadmapService` already has `issueToQuarterKey` and `quarterToDates`.
- **Cons:** Couples issue-breakdown logic to roadmap coverage logic; a quarter detail
  page for a board with no JPD roadmap configuration should not live in a roadmap module.
  The `roadmap` URL prefix would be misleading (`/api/roadmap/ACC/2025-Q2/detail` for a
  board that has no roadmap configuration). Confuses future developers about whether
  roadmap configuration is required to use the quarter detail view.

---

## Rationale

Option A is selected for the same reason Option A was selected in ADR-0014: clean
module boundaries, no cross-concern coupling, and each algorithm independently testable.
The helper duplication (`issueToQuarterKey`, `quarterToDates`) is minor and is tracked
as a TODO for extraction to `backend/src/utils/quarter.ts` in a follow-on refactoring
task.

The key architectural insight is that **calendar-period membership and sprint membership
are orthogonal**. A single issue can be in Sprint 23 AND in Q1 2025, but the questions
"which issues were in Sprint 23?" and "which issues were in Q1 2025?" are answered by
different algorithms from different changelog fields. Keeping these algorithms in
separate services prevents any temptation to unify them into a single, more complex
service.

---

## Consequences

### Positive

- Quarter drill-down works for both Scrum and Kanban boards without the Kanban-rejection
  guard that `SprintDetailService` requires. Teams using PLAT (Kanban) gain a fully
  functional drill-down for the first time.
- The calendar-period bucketing algorithm is isolated in one place
  (`QuarterDetailService`) and can evolve (e.g. support ISO weeks, fiscal quarters)
  without touching sprint logic.
- The URL scheme (`/quarter/` vs. `/sprint/`) is self-documenting: the type of period
  is clear from the URL.

### Negative / Trade-offs

- `issueToQuarterKey()` and `quarterToDates()` are now duplicated across `RoadmapService`
  and `QuarterDetailService`. Tracked as technical debt: extract to
  `backend/src/utils/quarter.ts`.
- The `linkedToRoadmap` annotation in the quarter view uses the same all-configured-
  `RoadmapConfig`-keys approach as `SprintDetailService` — there is no `jpdKey` query
  parameter. `linkedToRoadmap` is `true` for any issue whose `epicKey` appears in any
  JPD idea's `deliveryIssueKeys` across all configured roadmap projects. If no
  `RoadmapConfig` rows exist, `linkedToRoadmap = false` for all issues.

### Constraints Carried Forward

- **Pagination** is not implemented. Returns all issues in a single response.
  Deferred as per the pattern established in ADR-0014.

---

## Key Implementation Details

### Board-entry date algorithm by board type

```
Kanban:  earliest status changelog where fromValue = 'To Do'  →  changedAt
         fallback: issue.createdAt

Scrum:   earliest Sprint-field changelog changedAt
         fallback: issue.createdAt
```

This is identical to `RoadmapService.getKanbanAccuracy()` for Kanban boards and
consistent with `SprintDetailService`'s sprint-membership data for Scrum boards.

### Quarter-assignment bucketing

```typescript
function issueToQuarterKey(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${q}`;
}
```

This function must produce output identical to `RoadmapService.issueToQuarterKey()` —
they are the same algorithm and must agree on which quarter a given date belongs to.

### `QuarterModule` entity imports

```typescript
TypeOrmModule.forFeature([
  JiraIssue,
  JiraChangelog,
  BoardConfig,
  JpdIdea,
  RoadmapConfig,
])
```

`JiraSprint` is **not** imported — the quarter view uses changelog-derived board-entry
dates, not sprint record lookups.

### Response shape

The `QuarterDetailResponse` does not include sprint metadata (`sprintId`, `sprintName`,
`state`). It includes calendar metadata (`boardId`, `quarter`, `quarterStart`,
`quarterEnd`) and per-issue fields specific to the quarter context (`assignedQuarter`,
`completedInQuarter`, `addedMidQuarter`, `linkedToRoadmap`, `boardEntryDate`, `points`).

Notably, `QuarterDetailIssue` includes `points`, `priority`, `isIncident`, and
`isFailure` (compared to `SprintDetailIssue`) and omits `leadTimeDays`, `resolvedAt`
(sprint-specific DORA signals that are not applicable to calendar-period context).
`isIncident` and `isFailure` use the same `BoardConfig`-driven logic as in the sprint
detail view: `issueType` matched against `incidentIssueTypes`/`failureIssueTypes`, or
any label matched against `incidentLabels`/`failureLabels`.

---

## Related Decisions

- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Quarter detail data is read from
  Postgres; no live Jira API calls per request.
- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — `BoardConfig`
  `doneStatusNames` drives `completedInQuarter` annotation.
- [ADR-0005](0005-kanban-boards-excluded-from-planning-accuracy.md) — Kanban boards are
  excluded from the Sprint Detail View; they are explicitly included in the Quarter
  Detail View (calendar-period bucketing is board-type-agnostic).
- [ADR-0010](0010-kanban-roadmap-accuracy-via-changelog-board-entry-date.md) — The
  Kanban board-entry date algorithm (earliest `To Do → *` status changelog) established
  here is reused verbatim in `QuarterDetailService`.
- [ADR-0014](0014-sprint-detail-view.md) — Establishes the drill-down pattern that
  Quarter Detail View extends to calendar periods.
