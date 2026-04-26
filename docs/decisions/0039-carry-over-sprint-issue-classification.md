# 0039 — Carry-over Sprint Issues Classified as Committed, Not Added

**Date:** 2026-04-24
**Status:** Accepted
**Proposal:** [0038 — Carry-Over Sprint Issue Classification Fix](../proposals/0038-carry-over-sprint-issue-classification.md)

## Context

When a sprint's `startDate` is configured to a point in the past (common when a sprint
is started retroactively or when the previous sprint is completed after the new sprint
has already begun), Jira records the bulk carry-over of incomplete issues at the time the
"Complete Sprint" button is clicked — not at the sprint's configured `startDate`.

This creates a systematic misclassification in `PlanningService` and `SprintDetailService`:
carry-over issues whose Sprint-field changelog entry falls outside the 5-minute grace
period are counted as `added` (mid-sprint scope change) rather than `committed`
(original sprint commitment). The result is an inflated `added` count and
`scopeChangePercent` for sprints that follow a team's normal "complete sprint → carry over"
workflow.

The Jira changelog for a carry-over issue has a distinctive shape:

```
field:     'Sprint'
fromValue: '<previous sprint name>'   ← non-null, contains the just-closed sprint
toValue:   '<current sprint name>'
changedAt: <timestamp of Complete Sprint operation>
```

A genuine mid-sprint addition from the backlog has `fromValue = null` or `""`.

## Decision

> When the Sprint-field changelog entry that adds an issue to the current sprint has a
> `fromValue` containing at least one sprint name that is NOT the current sprint name,
> the issue is treated as a **carry-over** from a previous sprint and classified as
> **committed** rather than **added**.

This logic is applied in both `PlanningService.calculateSprintAccuracy()` and
`SprintDetailService.getDetail()` via a shared pattern using an
`isCarryOverFromSprint(fromValue, currentSprintName)` helper.

## Rationale

The `fromValue` signal is unambiguous and does not require knowledge of sprint ordering,
timestamps, or any additional Jira API calls. The data is already available in the
cached `JiraChangelog` table.

The alternative of expanding the grace period is an imprecise heuristic: any fixed
window would either miss genuine carry-overs that happen hours into a sprint, or falsely
suppress real mid-sprint additions made early in the sprint. The `fromValue` check has
no such false-negative/false-positive trade-off.

Treating issues moved from any prior sprint (not just the immediately preceding one) as
carry-overs is the most useful interpretation: the team had already committed to those
issues in a previous sprint context, and their appearance in the new sprint is a
continuation of prior commitment rather than new scope.

## Consequences

- The `commitment` count in Planning Accuracy and Sprint Detail now includes issues
  carried over from a completed sprint, regardless of when in the sprint window the
  carry-over changelog was recorded.
- The `added` count is reserved for issues added to an active sprint from the backlog
  (i.e. where `fromValue` is null or empty).
- The `scopeChangePercent` figure will be lower for sprints that use carry-over,
  giving a more accurate representation of genuine in-sprint scope change.
- No schema changes, no API contract changes, no additional Jira API calls.

## Amendment (2026-04-25) — Future-sprint carry-over fix

### Problem with the original decision

The original `isCarryOverFromSprint` check (`fromValue !== currentSprintName`) was
**incomplete**: it treated any non-null `fromValue` as evidence of a carry-over,
regardless of the *state* of the sprint referenced in `fromValue`.

An issue moved from a **future** or **groomed** sprint (e.g. "Sprint 7" or a
"Backlog — Groomed" sprint) into the current sprint is **not** a carry-over — it
is a deliberate mid-sprint scope addition by the team. The previous logic
incorrectly classified such issues as committed, understating `added` and
overstating `commitment`.

### Corrected rule

> An issue is a carry-over **only** if the sprint named in `fromValue` has
> `state = 'closed'` in the database. Issues moved from any sprint that is
> not closed (future, active, or groomed) are classified as **added**.

### Implementation

Both `PlanningService` and `SprintDetailService` now load closed sprint names
once per `getAccuracy` / `getDetail` call:

```typescript
const closedSprints = await this.sprintRepo.find({ where: { boardId, state: 'closed' } });
const closedSprintNames = new Set(closedSprints.map((s) => s.name));
```

The `closedSprintNames` set is passed into `isCarryOverFromSprint`, which now
requires the from-sprint name to be present in that set:

```typescript
function isCarryOverFromSprint(
  fromValue: string | null,
  currentSprintName: string,
  closedSprintNames: Set<string>,
): boolean {
  if (!fromValue) return false;
  return fromValue.split(',').some((s) => {
    const name = s.trim();
    return name !== '' && name !== currentSprintName && closedSprintNames.has(name);
  });
}
```

In `PlanningService.getAccuracy`, the closed-sprints query is hoisted to run
before the sprint-list branching so that it can serve double duty: building
`closedSprintNames` **and** providing the sprint list for the no-filter path
(eliminating a duplicate query).

### Consequences of the amendment

- Issues pulled from future/groomed sprints are now correctly counted as `added`,
  not `commitment`, giving accurate scope-change reporting.
- One additional `sprintRepo.find` query is issued per `getAccuracy` / `getDetail`
  call when there are sprints to process. In `getAccuracy`, the no-filter path
  reuses the closed-sprints query for both the sprint list and carry-over names
  (no extra query); the `sprintId` and `quarter` paths add one closed-sprint
  query, but only when they return at least one sprint. In `getDetail`, the
  closed-sprints query is deferred to inside the `if (sprintStart)` block and
  only executed when there are issues and changelogs to classify.
- No schema changes, no API contract changes.
