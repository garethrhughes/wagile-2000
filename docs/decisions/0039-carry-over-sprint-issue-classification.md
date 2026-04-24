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
