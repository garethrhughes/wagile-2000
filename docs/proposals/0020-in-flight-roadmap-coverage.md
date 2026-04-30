# 0020 — In-Flight Roadmap Coverage: Count Active-Sprint Issues as Covered

**Date:** 2026-04-13
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance
**Supersedes:** N/A
**Related:** [0012-roadmap-coverage-semantics.md](0012-roadmap-coverage-semantics.md)

---

## Problem Statement

Proposal 0012 (accepted) established the coverage semantic: an issue is `in-scope`
(green) only if its `resolvedAt` timestamp is on or before `idea.targetDate` (end-of-day
UTC). Issues that are not yet resolved fall into `linked` (amber) regardless of
whether the roadmap commitment window is still open.

This creates a false-negative for issues that are **actively being worked on inside
the sprint window with the target date still in the future**. A story in "In Progress"
or "In Review" during the current active sprint, against an idea whose `targetDate` is
still weeks away, is being correctly actioned — yet it shows as amber alongside stories
that are genuinely overdue or forgotten. Engineering leads cannot distinguish "work
in progress on time" from "work that already missed its deadline".

The fix is to add a second path to `in-scope`: an issue also counts as covered if it
is in the current active sprint AND its current status is not done/cancelled (i.e. it
is "in-flight") AND the roadmap idea's `targetDate` has not yet lapsed. This is a
pure in-memory logic addition to two existing functions; it requires no new Jira API
calls, no new database queries beyond what is already loaded, and — on the current
evidence — no new `BoardConfig` fields.

---

## Codebase Findings

### Where coverage is calculated

Coverage classification happens in **two places** that must be kept in sync:

1. **`backend/src/roadmap/roadmap.service.ts` → `calculateSprintAccuracy()`** (lines 821–918)
   Produces the `RoadmapSprintAccuracy` aggregate row (counts only). Called once per
   sprint when `GET /api/roadmap/accuracy` is requested.

2. **`backend/src/sprint/sprint-detail.service.ts` → `getDetail()`** (lines 490–507)
   Produces the per-issue `roadmapStatus: 'in-scope' | 'linked' | 'none'` field on
   each `SprintDetailIssue`. Called when `GET /api/sprints/:boardId/:sprintId/detail`
   is requested.

Both services have identical per-issue logic:

```typescript
// Current logic (both services):
const resolvedDate = doneTransition?.changedAt ?? null;
const deliveredOnTime = resolvedDate !== null && resolvedDate <= targetEndOfDay;
roadmapStatus = deliveredOnTime ? 'in-scope' : 'linked';
```

### `BoardConfig` entity fields (relevant subset)

From `board-config.entity.ts`:

| Field | Type | Default |
|---|---|---|
| `doneStatusNames` | `string[]` | `['Done', 'Closed', 'Released']` |
| `cancelledStatusNames` | `string[]` | `["Cancelled", "Won't Do"]` |
| `inProgressStatusNames` | `string[]` | `['In Progress']` |

There is **no `toDoStatusNames` field**. "Not started" statuses are currently not
named anywhere in `BoardConfig`; they are implicitly anything that is not in
`doneStatusNames`, `cancelledStatusNames`, or `inProgressStatusNames`.

### `JiraSprint` entity

```typescript
@Entity('jira_sprints')
export class JiraSprint {
  id: string;
  name: string;
  state: string;  // 'active' | 'closed' | 'future'
  startDate: Date | null;
  endDate: Date | null;
  boardId: string;
}
```

Sprint `state` is synced from Jira and stored as-is. An active sprint has
`state === 'active'`. Only one sprint per board can be `active` at a time (Jira
enforces this).

### `JiraIssue` entity

```typescript
@Entity('jira_issues')
export class JiraIssue {
  key: string;
  status: string;    // current status name at last sync
  sprintId: string | null;  // current sprint assignment (last sync only)
  epicKey: string | null;
  // ...
}
```

`issue.status` reflects the issue's current status at the time of the last sync.
This is the correct field to check for "is this issue in-flight right now?"

### How sprint membership is known in each service

**`roadmap.service.ts` / `calculateSprintAccuracy`**: Receives `sprintIssues:
JiraIssue[]` — the set of issues determined to belong to this sprint via the
changelog replay algorithm in the outer `getAccuracy()` function. The sprint
object itself (`JiraSprint`) is also passed in and carries `sprint.state`.

**`sprint-detail.service.ts` / `getDetail`**: The sprint is loaded directly and
is the subject of the entire call. `sprint.state` is available at lines 304/305.
Sprint membership is determined by the same changelog replay algorithm.

### Data already available — no new queries needed

Both services already load:
- The sprint entity (with `state`)
- All sprint member issues (with their current `issue.status`)
- `doneStatusNames` and `cancelledStatusNames` from `BoardConfig`
- `inProgressStatusNames` from `BoardConfig`

Nothing extra needs to be fetched from Jira or the database to implement this
change.

---

## Proposed Solution

### Coverage classification: updated rule

An issue is `in-scope` (green) if **either** of the following conditions holds:

**Condition A — already delivered on time (existing rule):**
```
resolvedAt !== null AND resolvedAt <= endOfDay(idea.targetDate)
```

**Condition B — in-flight and on track (new rule):**
```
sprint.state === 'active'
AND idea.targetDate >= startOfDay(today)
AND issue.status is NOT in doneStatusNames
AND issue.status is NOT in cancelledStatusNames
```

An issue is `linked` (amber) otherwise — i.e. it has a roadmap link but is:
- not yet done AND the sprint is closed (work stopped, never completed), or
- not yet done AND the sprint is active BUT `targetDate` has already lapsed, or
- completed after `targetDate`.

An issue is `none` (dash) if it has no epic link, the epic has no idea, or the
issue is in a cancelled status.

### Why "not done and not cancelled" is sufficient — no `toDoStatusNames` needed

The brief proposes "To Do / not started OR in-progress" as the positive condition
for Condition B. By inspection:

- An issue that is "To Do" or "Backlog" inside an active sprint is legitimate
  planned work. Counting it as in-flight coverage is correct.
- An issue that is "In Progress", "In Review", or "PEER REVIEW" is actively worked.
- The only statuses we want to **exclude** from in-flight coverage are `done`
  (already handled by Condition A) and `cancelled` (excluded from all coverage
  by design).

Therefore the correct predicate is simply:
```
!doneStatusNames.includes(issue.status) && !cancelledStatusNames.includes(issue.status)
```

This is a **derivation by exclusion** — any status that is not done or cancelled is
considered "available for in-flight coverage". This is more robust than a positive
allowlist because it does not require teams to configure a third status list, and it
handles custom status names (e.g. "CODE REVIEW", "QA", "BLOCKED") automatically.

A new `toDoStatusNames` field on `BoardConfig` is therefore **not required**.

### Change 1 — `roadmap.service.ts`: update `calculateSprintAccuracy`

The sprint object already flows into `calculateSprintAccuracy` as the first
parameter. The `doneStatusNames` and `cancelledStatusNames` arrays are also
already in scope.

Today is needed to evaluate whether `targetDate` has lapsed. Since `today` is
evaluated at request time (not stored), we use `new Date()` and compare at the
date boundary.

```typescript
private async calculateSprintAccuracy(
  sprint: JiraSprint,
  sprintIssues: JiraIssue[],
  doneStatusNames: string[],
  cancelledStatusNames: string[],
  allIdeas: JpdIdea[],
  inProgressStatusNames: string[],   // NEW parameter
): Promise<RoadmapSprintAccuracy> {
  // ... existing filter / changelog query unchanged ...

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0); // start of today UTC

  for (const issue of filteredIssues) {
    if (issue.epicKey === null) continue;
    const idea = epicIdeaMap.get(issue.epicKey);
    if (!idea) continue;

    const targetEndOfDay = this.endOfDayUTC(idea.targetDate);
    const resolvedAt = completionDates.get(issue.key) ?? null;

    // Condition A: delivered on time
    const deliveredOnTime = resolvedAt !== null && resolvedAt <= targetEndOfDay;

    // Condition B: in-flight and on track
    const isInFlight =
      sprint.state === 'active' &&
      idea.targetDate >= today &&
      !doneStatusNames.includes(issue.status) &&
      !cancelledStatusNames.includes(issue.status);

    if (deliveredOnTime || isInFlight) {
      coveredIssues.push(issue);
    } else {
      linkedNotCoveredIssues.push(issue);
    }
  }

  // ... rest of metric computation unchanged ...
}
```

`inProgressStatusNames` is passed in but not directly used in the core predicate
(see the derivation-by-exclusion rationale above). It is accepted as a parameter
to make the intent explicit in the call signature and to keep the door open for
a future opt-in `toDoStatusNames` refinement without changing the function
signature again. The caller in `getAccuracy()` must be updated to pass
`boardConfig?.inProgressStatusNames ?? ['In Progress']`.

### Change 2 — `sprint-detail.service.ts`: update per-issue `roadmapStatus` block

The sprint entity is already in scope as `sprint` (loaded in Query 1). The board
config fields (`doneStatusNames`, `cancelledStatusNames`) are already extracted.

```typescript
// roadmapStatus: per-issue delivery against roadmap targetDate
//
//   in-scope (green)  = linked to idea AND:
//                         (a) completed on or before targetDate, OR
//                         (b) in-flight in an active sprint with targetDate not yet lapsed
//   linked   (amber)  = linked to idea AND neither (a) nor (b)
//   none              = no roadmap link, OR issue is cancelled

let roadmapStatus: 'in-scope' | 'linked' | 'none' = 'none';
if (!cancelledStatusNames.includes(issue.status) && issue.epicKey !== null) {
  const idea = epicIdeaMap.get(issue.epicKey);
  if (idea) {
    const targetEndOfDay = new Date(idea.targetDate.getTime());
    targetEndOfDay.setUTCHours(23, 59, 59, 999);

    const resolvedDate = doneTransition?.changedAt ?? null;

    // Condition A: delivered on time
    const deliveredOnTime = resolvedDate !== null && resolvedDate <= targetEndOfDay;

    // Condition B: in-flight and on track
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const isInFlight =
      sprint.state === 'active' &&
      idea.targetDate >= todayStart &&
      !doneStatusNames.includes(issue.status) &&
      !cancelledStatusNames.includes(issue.status);

    roadmapStatus = deliveredOnTime || isInFlight ? 'in-scope' : 'linked';
  }
}
```

No new queries. No new parameters. The only new variable is `todayStart` (a
`new Date()` call), which is acceptable inside a per-sprint request handler.

### Change 3 — `jsdoc` comment updates

The `roadmapStatus` JSDoc comment in `sprint-detail.service.ts` (lines 56–62)
currently describes only the delivered-on-time semantic. It must be updated to
reflect the two-path definition.

Similarly, the equivalent inline comment in `calculateSprintAccuracy` (lines
868–871) must be updated.

### No changes required

| Area | No change needed | Reason |
|---|---|---|
| `BoardConfig` entity | ✓ | Derivation by exclusion — no new field |
| Database migrations | ✓ | No schema change |
| `RoadmapSprintAccuracy` interface | ✓ | Field names and types unchanged |
| `frontend/src/lib/api.ts` | ✓ | Types unchanged |
| `frontend/src/app/roadmap/page.tsx` | ✓ | No rendering change needed |
| `frontend/src/app/planning/page.tsx` | ✓ | No rendering change needed |
| Jira API / `JiraClient` | ✓ | No new Jira calls |
| Kanban paths (`getKanbanAccuracy`, `getKanbanWeeklyAccuracy`) | ✓ | See edge-case analysis below |

---

## Edge Cases

### E1 — Issue is in an active sprint but the sprint hasn't started yet (`state: 'future'`)

`JiraSprint.state` is one of `'active' | 'closed' | 'future'`. Condition B
explicitly checks `sprint.state === 'active'`. Future sprints have `state ===
'future'`, so Condition B will never fire for them. Issues in future sprints
remain `linked` (amber) until the sprint starts and the state transitions to
`active` on the next sync. This is the correct behaviour — we should not count
planned-but-not-yet-started work as actively covered.

### E2 — Issue is in multiple sprints (closed + active)

The changelog-replay algorithm that populates `sprintIssues` for
`calculateSprintAccuracy` correctly handles multi-sprint issues: an issue that
appeared in a closed sprint AND was carried over to the active sprint will appear
in the issue set for **both** sprints. For the closed sprint, `sprint.state ===
'closed'`, so Condition B does not fire. For the active sprint, Condition B may
fire if the issue is still in-flight and the target date has not lapsed. This is
exactly the right behaviour — the issue gets credit for being actively worked in
the current sprint while correctly showing as amber (not covered) in the closed
sprint where it was not completed.

### E3 — Kanban boards (no sprints)

Kanban boards use `getKanbanAccuracy` and `getKanbanWeeklyAccuracy`, not
`calculateSprintAccuracy`. These paths are explicitly excluded from this change.

The Kanban equivalents of "active" are the current quarter or current ISO week.
The `state` field on Kanban accuracy rows is derived as `qKey === currentQuarterKey
? 'active' : 'closed'` (line 430 of `roadmap.service.ts`). There is no
`JiraSprint.state === 'active'` concept; the "sprint" is a synthetic bucket, not
a real Jira entity.

Applying Condition B to Kanban would require the same `state === 'active'` guard
but against the synthetic bucket — which is not unreasonable. However, the Kanban
coverage semantics are governed by a pending follow-up proposal (referenced in
proposal 0012, Open Question 4). This proposal intentionally leaves Kanban
coverage unchanged.

### E4 — Quarter rollup view (sprint-mode → quarter-mode aggregation)

The frontend's `groupByQuarter()` function in `roadmap/page.tsx` aggregates sprint
`coveredIssues` counts from `RoadmapSprintAccuracy` rows by simply summing
`coveredIssues` across all sprints in a quarter (lines 89–101). Since this proposal
only changes which issues fall into the `coveredIssues` bucket (adding in-flight
issues), the quarterly rollup will automatically include them. No frontend change is
needed.

The implication: a quarter row for the current quarter will now include in-flight
issues from the active sprint. This is correct — the quarter is not over, and these
issues may still be delivered on time.

### E5 — `targetDate` exactly equals today

The Condition B guard is:
```typescript
idea.targetDate >= todayStart   // todayStart = 00:00:00.000 UTC
```

`idea.targetDate` is stored as midnight UTC (date-only values from Polaris). If
`targetDate` is today, `idea.targetDate.getTime() === todayStart.getTime()`, so
the comparison evaluates to `true` — an issue whose deadline is today is still
considered "on track" and counts as in-flight coverage for the active sprint. This
is intentional: the full calendar day is still available.

### E6 — `targetDate` is in the past, issue is still in-flight in the active sprint

`idea.targetDate < todayStart` → Condition B is `false`. The issue falls into
`linked` (amber). This matches the stated requirement: "Issues that are in-progress
but the roadmap item HAS lapsed should still show as linked but not covered."

### E7 — Issue transitions to Done between syncs

The sync runs once daily at midnight. Between syncs, an issue may complete. On the next
sync, `issue.status` will update to a done status name, `completionDates` will be
populated from the new changelog, and Condition A will take over from Condition B.
There is no double-counting — either A or B fires, not both, since Condition B
requires `!doneStatusNames.includes(issue.status)`.

### E8 — Sprint crosses midnight into a new calendar day during a request

`todayStart` is computed once per call to `calculateSprintAccuracy` via `new
Date()`. For the rare edge case where a request spans a day boundary, the worst
outcome is that a sprint that expired at midnight shows as covered for the
fraction of a request before midnight. This is negligible for a daily sync
cadence and a ~200ms request.

### E9 — Sprint is active but `sprint.startDate` is null

`sprint.startDate` is nullable but is not referenced in Condition B. Condition B
only checks `sprint.state`. If a sprint has no start date, `state` is still set
by Jira (the sprint can still be `active`). Condition B fires correctly.

### E10 — Issue is in a done status but `completionDates` has no entry (truncated changelog)

`sprint-detail.service.ts` already handles this: if `doneTransition` is null but
`issue.status` is in `doneStatusNames`, the issue falls into `completedInSprint`
via the fallback path (line 470–472). For roadmap purposes, Condition B also
guards against this: `!doneStatusNames.includes(issue.status)` will be `false`
for a done issue, so Condition B will not incorrectly elevate it to in-scope.
Condition A requires a non-null `resolvedAt`, so the issue will fall to `linked`
— the same false-negative as today. This is an existing limitation, not
introduced by this proposal.

---

## Alternatives Considered

### Alternative A — Add `toDoStatusNames` to `BoardConfig`

Introduce a new `BoardConfig` column listing statuses that represent "not started"
(e.g. "To Do", "Backlog", "Open"), then require Condition B to check that the
issue's current status is in `toDoStatusNames` OR `inProgressStatusNames`.

**Ruled out.** The derivation-by-exclusion approach is strictly simpler:

- No new `BoardConfig` field → no migration → no settings UI change.
- Works automatically for custom status names ("CODE REVIEW", "BLOCKED",
  "WAITING FOR REVIEW") that teams add without updating the config.
- The set of statuses that should count as "in-flight" is exactly the complement
  of done + cancelled. There is no meaningful distinction between "To Do" and
  "In Progress" for the purpose of this coverage check — both represent work
  that is intended to land in this sprint against this roadmap commitment.

If a future requirement emerges to exclude "To Do" issues (i.e. only count issues
that have actual work begun), a `boolean` flag such as
`requireActiveWorkForInFlightCoverage` could be added to `BoardConfig` to opt into
that stricter check. That is deferred unless a concrete need is identified.

### Alternative B — A fourth `roadmapStatus` value: `'in-flight'`

Introduce `'in-flight'` as a distinct fourth state, separate from `'in-scope'`,
so the UI can differentiate "already delivered green" from "in-progress green".

**Ruled out for now.** The `roadmapStatus` union is already typed as
`'in-scope' | 'linked' | 'none'` in both the backend interface and the frontend
`api.ts` type. Adding a fourth value would be an API contract change requiring
updates to every consumer that does `roadmapStatus === 'in-scope'` comparisons —
at minimum `sprint-detail.service.spec.ts`, `roadmap.service.spec.ts`, and the
sprint detail frontend rendering code.

The user-visible impact is also low: both "delivered on time" and "in-flight and
on track" are genuinely positive coverage signals; collapsing them to a single
`in-scope` (green) is the right default. The sprint detail view already shows the
issue's `currentStatus` in the table, so a user can see at a glance which green
issues are done vs. still in progress.

This alternative is worth revisiting if a future request asks for a visual
distinction (e.g. a lighter green or a clock icon for in-flight issues).

### Alternative C — Only apply in-flight coverage to the active sprint in `getAccuracy`, not in `getDetail`

Apply Condition B in `roadmap.service.ts / calculateSprintAccuracy` but leave
`sprint-detail.service.ts / getDetail` using the existing Condition A only.

**Ruled out.** The two services must produce consistent results. If the roadmap
accuracy table shows a sprint at 80% coverage (with in-flight issues counted),
but the sprint detail view shows those same issues as amber (linked), the engineer
sees contradictory data. Both services must apply the same classification logic.

### Alternative D — Re-query sprint `state` live from Jira instead of trusting the cached value

`JiraSprint.state` is synced from Jira on each daily sync cycle. Between
syncs, a sprint could be manually completed or started via the Jira UI, causing
a brief inconsistency.

**Ruled out.** The entire codebase relies on cached sprint state for planning
accuracy, coverage, and detail views. A live re-query would break the
single-JiraClient-gateway principle and add latency to every coverage request.
The daily staleness window is accepted throughout the codebase.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | Pure logic change. No new entity fields, no migrations. |
| API contract | None / additive behaviour | `RoadmapSprintAccuracy` shape is unchanged. Field values will change (some `coveredIssues` counts increase for active sprints with in-flight issues). The `roadmapStatus` type union is unchanged. |
| Frontend | None | No type changes, no template changes, no rendering changes. The `roadmapStatus: 'in-scope'` value is already rendered as a green tick in the sprint detail view. |
| `roadmap.service.ts` | Two-line logic change + one parameter | `calculateSprintAccuracy` adds Condition B to the per-issue classification loop. A new `inProgressStatusNames` parameter is threaded from `getAccuracy()`. |
| `sprint-detail.service.ts` | Two-line logic change | The `roadmapStatus` assignment block gains Condition B. No new queries, no new constructor parameters. |
| Tests | New unit tests required | See Acceptance Criteria. Existing green/amber tests for closed sprints continue to pass. Tests for active sprints with in-flight issues must be added. |
| Jira API | No new calls | All data is already cached in Postgres. |
| Kanban paths | Not changed | `getKanbanAccuracy` and `getKanbanWeeklyAccuracy` are unaffected. |
| `BoardConfig` entity | None | No new column, no migration, no settings UI change. |

---

## Open Questions

1. **Should `roadmapStatus = 'in-scope'` on an in-flight issue be visually
   distinguished from a completed one in the sprint detail view?**

   **Resolved:** No distinction needed. Both in-flight and completed covered issues
   render identically as a green tick. The `currentStatus` column in the sprint
   detail view already provides sufficient context for a user to distinguish the
   two cases. No frontend change is required.

2. **Should the roadmap accuracy summary table column header "Covered" be
   retitled "Covered / In-Flight" to communicate that in-progress issues are
   now counted?**

   **Resolved:** The existing "Covered" label is sufficient. No frontend label
   change is needed.

3. **Kanban in-flight coverage**: The equivalent change for Kanban boards
   (current quarter/week where the "sprint-equivalent" state is `'active'`) is
   out of scope for this proposal.

   **Resolved:** Confirmed out of scope. To be addressed in the follow-up proposal
   referenced in 0012 Open Question 4 (Kanban `linkedToRoadmap` boolean upgrade
   to three-state).

---

## Acceptance Criteria

### Core behaviour

- [ ] An issue whose epic is linked to a JPD idea, whose current status is
      neither done nor cancelled, in an active sprint where `idea.targetDate >=
      today` shows `roadmapStatus = 'in-scope'` (green tick) in the sprint
      detail view.

- [ ] An issue whose epic is linked to a JPD idea, whose current status is
      neither done nor cancelled, in an active sprint where `idea.targetDate <
      today` (lapsed deadline) shows `roadmapStatus = 'linked'` (amber tick).

- [ ] An issue whose epic is linked to a JPD idea, whose current status is
      neither done nor cancelled, in a **closed** sprint shows `roadmapStatus =
      'linked'` (amber tick) — Condition B does not fire for closed sprints.

- [ ] An issue in a **future** sprint (state = `'future'`) that is linked to a
      JPD idea and not yet done shows `roadmapStatus = 'linked'` — Condition B
      does not fire for future sprints.

- [ ] An issue whose epic is linked to a JPD idea AND whose `resolvedAt` is on
      or before `idea.targetDate` shows `roadmapStatus = 'in-scope'` regardless
      of sprint state — Condition A is unchanged.

- [ ] An issue in a cancelled status (`cancelledStatusNames`) always shows
      `roadmapStatus = 'none'` and is excluded from all coverage metrics —
      unchanged from current behaviour.

### `roadmap.service.ts` — `calculateSprintAccuracy`

- [ ] `coveredIssues` in the `RoadmapSprintAccuracy` response for the active
      sprint includes issues that satisfy Condition B (in-flight, target date
      not lapsed).

- [ ] `coveredIssues` for a closed sprint does **not** include issues that
      were in-flight at time of close (Condition B requires `sprint.state ===
      'active'`).

- [ ] `roadmapCoverage` and `roadmapOnTimeRate` are computed from the updated
      `coveredIssues` and `linkedNotCoveredIssues` counts — no formula change
      needed, only the input sets change.

- [ ] `getAccuracy()` passes `boardConfig?.inProgressStatusNames ?? ['In Progress']`
      to `calculateSprintAccuracy` as the new parameter. (The parameter is
      currently unused in the core predicate but accepted for API clarity.)

### `sprint-detail.service.ts` — `getDetail`

- [ ] The per-issue `roadmapStatus` annotation in the sprint detail response
      applies Condition B using `sprint.state` and `new Date()` evaluated at
      request time.

- [ ] `summary.roadmapLinkedCount` is unchanged — it counts issues where
      `roadmapStatus !== 'none'` (green + amber), which includes in-flight issues
      promoted to green.

### Consistency

- [ ] The set of issues returned as `in-scope` by `calculateSprintAccuracy` for
      the active sprint is consistent with the set of `roadmapStatus = 'in-scope'`
      issues returned by `getDetail` for the same sprint. (Both services apply
      the same Condition A + Condition B logic.)

### Tests

- [ ] New unit test in `roadmap.service.spec.ts`: active sprint + in-flight
      issue + target date in future → `coveredIssues = 1`.

- [ ] New unit test in `roadmap.service.spec.ts`: active sprint + in-flight
      issue + target date in past → `coveredIssues = 0`.

- [ ] New unit test in `roadmap.service.spec.ts`: closed sprint + in-flight
      issue + target date in future → `coveredIssues = 0` (Condition B does
      not apply to closed sprints).

- [ ] New unit test in `sprint-detail.service.spec.ts`: active sprint + issue
      with status "In Progress" + idea with future target date →
      `roadmapStatus = 'in-scope'`.

- [ ] New unit test in `sprint-detail.service.spec.ts`: active sprint + issue
      with status "To Do" + idea with future target date →
      `roadmapStatus = 'in-scope'`.

- [ ] New unit test in `sprint-detail.service.spec.ts`: active sprint + issue
      with status "In Progress" + idea with **past** target date →
      `roadmapStatus = 'linked'`.

- [ ] New unit test in `sprint-detail.service.spec.ts`: active sprint + issue
      with status "Cancelled" + idea with future target date →
      `roadmapStatus = 'none'` (cancelled issues excluded).

- [ ] Existing tests for `roadmapStatus = 'linked'` on not-yet-completed issues
      in **closed** sprints continue to pass unchanged.

- [ ] Existing tests for `roadmapStatus = 'in-scope'` on issues completed
      before `targetDate` continue to pass unchanged (Condition A unchanged).

- [ ] Existing tests for `roadmapStatus = 'linked'` on issues completed
      after `targetDate` continue to pass unchanged.

### No regressions

- [ ] No changes to `BoardConfig` entity, no new migrations.
- [ ] No changes to `RoadmapSprintAccuracy` interface shape.
- [ ] No changes to `SprintDetailIssue` interface shape.
- [ ] No changes to `frontend/src/lib/api.ts` types.
- [ ] Kanban paths (`getKanbanAccuracy`, `getKanbanWeeklyAccuracy`) produce
      identical output before and after this change.
