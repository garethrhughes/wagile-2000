# 0038 — Carry-Over Sprint Issue Classification Fix

**Date:** 2026-04-24
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** [0039](../decisions/0039-carry-over-sprint-issue-classification.md)

## Problem Statement

When a sprint's start time is configured to a point in the past (or the previous sprint
is completed after the new sprint has already been started), Jira records the bulk
carry-over of incomplete issues at the time the "Complete Sprint" button is clicked —
not at the sprint's configured `startDate`. Because the current classification algorithm
uses a 5-minute grace period (`SPRINT_GRACE_PERIOD_MS`), any carry-over that occurs
more than 5 minutes after `startDate` is misclassified as a mid-sprint addition, inflating
the `added` count and `scopeChangePercent` figures in both `PlanningService` and
`SprintDetailService`.

This affects two views: the Planning Accuracy report and the Sprint Detail view.

## Proposed Solution

Detect carry-over issues by inspecting the Sprint-field changelog entry that adds the
issue to the current sprint. When Jira's "Complete Sprint" bulk-carry-over runs, it
creates a changelog entry with:

```
field:     'Sprint'
fromValue: '<previous sprint name>'   ← non-null; contains the sprint just closed
toValue:   '<current sprint name>'
changedAt: <timestamp of Complete Sprint operation>
```

For a genuine backlog addition mid-sprint, `fromValue` is null (or an empty string).

**Rule:** If the changelog entry that adds an issue to the current sprint has a `fromValue`
that contains at least one sprint name that is NOT the current sprint name, the issue is
a carry-over from a previous sprint. It should be classified as **committed** (not added),
because the team already committed to it in a prior sprint.

### Changes required

**`PlanningService.calculateSprintAccuracy()`** (`backend/src/planning/planning.service.ts`):

1. Add a `wasCarryOver` variable (alongside `wasAddedDuringSprint`) in the per-issue
   classification loop.
2. When a post-start changelog entry adds the issue to the sprint, check
   `isCarryOverFromSprint(cl.fromValue, sprintName)`. If true, set `wasCarryOver = true`
   rather than `wasAddedDuringSprint = true`.
3. In the final classification block, treat `wasAtStart || wasCarryOver` as committed.
4. Add a private helper `isCarryOverFromSprint(fromValue, currentSprintName): boolean`.

**`SprintDetailService`** (`backend/src/sprint/sprint-detail.service.ts`):

Apply the same changes to the matching classification loop (lines 330–376 in the current
implementation). Add a module-level `isCarryOverFromSprint` helper alongside the existing
`sprintValueContains` and `wasInSprintAtDate` helpers.

### Helper function

```typescript
/**
 * Returns true when a Sprint-field changelog `fromValue` indicates that the
 * issue was carried over from a different sprint (moved from another sprint
 * into the current one, rather than added from the backlog).
 *
 * When Jira's "Complete Sprint" carry-over runs, the entry has:
 *   fromValue: "<previous sprint name>"
 *   toValue:   "<current sprint name>"
 *
 * A backlog addition has fromValue = null or "".
 */
function isCarryOverFromSprint(
  fromValue: string | null,
  currentSprintName: string,
): boolean {
  if (!fromValue) return false;
  return fromValue.split(',').some((s) => {
    const name = s.trim();
    return name !== '' && name !== currentSprintName;
  });
}
```

## Alternatives Considered

### Alternative A — Increase the grace period

Extend `SPRINT_GRACE_PERIOD_MS` from 5 minutes to a larger value (e.g. 4 hours or
even 24 hours) to absorb late carry-overs.

**Ruled out:** A fixed larger window is an imprecise heuristic. It would falsely classify
genuine mid-sprint additions made in the first hours of a sprint as committed. There is
no safe value that works across all teams and sprint-management workflows. The `fromValue`
signal is unambiguous and does not have this weakness.

### Alternative B — Compare sprint ordering to identify the "immediately prior" sprint

Query the sprint immediately preceding the current sprint (by `startDate` on the same
board) and only treat additions from that specific sprint as carry-overs.

**Ruled out:** Over-engineered. The `fromValue` pattern is sufficient. Moving an issue
from any prior sprint into the current sprint is typically an act of recommitment, not
a new scope addition — regardless of how many sprints ago the issue was first committed.
Sprint ordering queries also add latency to an already computation-heavy path.

### Alternative C — No code change; document it as a process issue

Accept the misclassification and advise teams to avoid back-dating sprint start times
or to complete the previous sprint before starting the new one.

**Ruled out:** The issue is detectable from the changelog data and the fix is minimal.
Asking teams to change their workflow to accommodate a metric tool limitation is the
wrong trade-off.

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema or migration changes required |
| API contract | None | Response shape is unchanged; only the classification of individual issues changes |
| Frontend | None | Frontend consumes `committed`, `added`, `removed` counts — semantics improve, format unchanged |
| Tests | New unit tests | Carry-over scenarios in `planning.service.spec.ts` and `sprint-detail.service.spec.ts` |
| Jira API | No new calls | Uses existing Sprint-field changelog data already cached in Postgres |

## Open Questions

None.

## Acceptance Criteria

- [ ] An issue whose first add-to-sprint changelog after `sprintStart` has a non-null
      `fromValue` containing a different sprint name is counted as `committed`, not `added`,
      in `PlanningService.calculateSprintAccuracy()`.
- [ ] The same issue is NOT counted in `SprintDetailSummary.addedMidSprintCount` and
      `SprintDetailIssue.addedMidSprint` is `false`.
- [ ] An issue whose first add-to-sprint changelog after `sprintStart` has `fromValue = null`
      (backlog addition) continues to be counted as `added`.
- [ ] An issue whose first add-to-sprint changelog falls within the existing 5-minute grace
      period continues to be counted as `committed` (no regression).
- [ ] Unit tests cover: carry-over classification, backlog-addition classification, and
      the grace-period path.
