# 0018 — Exclude Epics and Sub-tasks from All Metric Calculations

**Date:** 2026-04-12
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0008 — Exclude Epics and Sub-tasks from All Metric Calculations](../proposals/0008-exclude-epics-from-metrics.md)

## Context

Jira issues of type `Epic` and `Sub-task` are structural container/fragment types, not
independently deliverable units of work. Including them in flow metrics produces
systematically incorrect numbers:

- **Cycle time** — Epics remain open for months (they close only when all children close),
  pulling p85/p95 far to the right.
- **Deployment frequency / lead time** — Epics are counted alongside Stories, inflating
  issue counts and skewing delivery rate calculations.
- **CFR / MTTR** — Including Epics as potential failure signals adds noise to incident
  classification.
- **Planning accuracy** — Sprint commitment and completion counts include Epics, making
  boards appear to carry more work than they actually do.
- **Quarter and week detail views** — Issue tables show Epics alongside Stories, creating
  a confusing per-issue breakdown.

Six call sites in the codebase already filtered both types correctly using inline
`i.issueType !== 'Epic' && i.issueType !== 'Sub-task'` conditions. Eight further call
sites were missing the filter entirely, causing the above distortions.

---

## Decision 1 — Hardcode as a Shared Constant Rather Than Per-Board Configuration

### Options Considered

#### Option A — Hardcode in a shared module constant (selected)
- **Summary:** A single file `backend/src/metrics/issue-type-filters.ts` exports
  `EXCLUDED_ISSUE_TYPES = ['Epic', 'Sub-task'] as const` and a utility function
  `isWorkItem(issueType)`. Every call site imports and applies `isWorkItem`.
- **Pros:**
  - `'Epic'` and `'Sub-task'` are Jira-standard type names, not team-specific. No board
    legitimately wants Epics or Sub-tasks counted as deliverable work.
  - Zero runtime config lookup — no database read per request.
  - Consistent with the six existing call sites that already hardcode the same two-condition
    filter.
  - Single source of truth: if a third structural type were ever added, one constant changes.
- **Cons:**
  - Cannot be overridden per board at runtime. If a future Jira project genuinely used
    `Sub-task` as a first-class deliverable, a code change would be required. This is
    considered an acceptable constraint given the tool's scope.

#### Option B — Per-board `excludedIssueTypes` column on `BoardConfig`
- **Summary:** Add a `simple-json` array to `board_configs`; boards declare which issue
  types to exclude via `PUT /api/boards/:boardId/config`.
- **Pros:** Configurable per board without a code deployment.
- **Cons:** Requires a DB migration, DTO change, settings UI update, and a
  `ConfigService` lookup in every affected service — substantial complexity for zero
  practical benefit given that the correct answer is always "exclude Epics and Sub-tasks".
  Ruled out.

#### Option C — DB-layer filter via TypeORM `Not(In([...]))`
- **Summary:** Pass `issueType: Not(In(['Epic', 'Sub-task']))` inside every `issueRepo.find()`
  call so the exclusion happens in SQL.
- **Pros:** Eliminates a post-query in-process filter; slightly lower memory allocation
  for large issue sets.
- **Cons:** The exclusion is invisible at the service call site — a reader sees `find()`
  with no indication that structural types are excluded. The application-layer filter
  is explicit and auditable. At the data volumes of this tool (hundreds to low thousands of
  issues per board), the memory difference is negligible.
  Ruled out.

### Decision

> Epics and Sub-tasks are excluded via a shared constant and utility function in
> `backend/src/metrics/issue-type-filters.ts`. The filter is applied at the application
> layer immediately after each `issueRepo.find()` call. No per-board configuration is
> provided; the exclusion is universal and unconditional.

### Rationale

The hardcoded approach matches the pattern already established by the six existing correct
call sites, eliminates the need for a migration, and makes the exclusion clearly visible
at every call site through the named `isWorkItem()` predicate. Option B adds disproportionate
complexity; Option C hides the filter in the ORM call.

---

## Decision 2 — Use a Utility Function (`isWorkItem`) Rather Than an Inline Condition

### Options Considered

#### Option A — Named utility function `isWorkItem(issueType: string): boolean` (selected)
- **Summary:** Each call site reads `.filter((i) => isWorkItem(i.issueType))`.
- **Pros:**
  - Intent is clear: the predicate name describes the business rule ("is this a work item?")
    rather than the implementation ("is this not an Epic or Sub-task?").
  - Adding a third excluded type requires changing one function body; all call sites
    automatically pick up the change.
  - Easy to test in isolation.
- **Cons:** Requires an import at every call site.

#### Option B — Inline condition at every call site
- **Summary:** Each call site repeats `i.issueType !== 'Epic' && i.issueType !== 'Sub-task'`.
- **Pros:** No import required; immediately visible.
- **Cons:** Duplication across 14 call sites; any extension (adding a third type) requires
  14 edits. The existing six "correct" sites already showed the fragility of this approach —
  the eight "gap" sites were gaps precisely because the inline pattern wasn't enforced.
  Ruled out.

### Decision

> Every call site applies `.filter((i) => isWorkItem(i.issueType))`.
> The six pre-existing inline conditions were also refactored to use `isWorkItem` for
> consistency (no behaviour change, pure DRY cleanup).

---

## Decision 3 — Apply at the Application Layer After `issueRepo.find()`

As described under Decision 1, Option C was considered and rejected. The filter is applied
in service code immediately after loading issues from the repository, not in the ORM query
itself.

---

## Consequences

### Positive

- Deployment frequency counts, lead time percentiles, cycle time distributions, and planning
  accuracy figures all drop Epic/Sub-task noise. Metrics better reflect actual deliverable
  work.
- The `isWorkItem` predicate is a single, named, testable function. Future exclusions
  (e.g. a hypothetical `'Spike'` type) require a one-line change.
- The cycle-time issue type filter dropdown no longer surfaces `'Epic'` as a selectable
  type, since the service never returns Epic observations.

### Negative / Trade-offs

- **Metric values will change** for boards that previously included Epics. Deployment
  frequency may decrease; lead time p95 may shorten; planning accuracy figures may shift.
  This is the correct outcome — the previous numbers were inflated or distorted.
- The exclusion is unconditional. A board that genuinely wanted Epic-level cycle time
  tracking (e.g. for Epic throughput analysis) cannot enable it without a code change.
  This trade-off is accepted given the tool's scope and the absence of any such requirement.

### Risks

- **CFR secondary query** — `cfr.service.ts` has two `issueRepo.find()` calls: one for all
  issues and one for linked failure issues. Both must be filtered. Missing the second would
  allow Epic-type issues to re-enter via the failure-link path.
- **`cycle-time issueTypeFilter` stacking** — the user-driven `issueTypeFilter` parameter
  in `CycleTimeService` stacks on top of `isWorkItem`. Callers requesting `issueTypeFilter: 'Epic'`
  receive an empty result (the `isWorkItem` guard short-circuits before the ORM call). No
  existing caller passes `'Epic'` as a filter, so this is a no-op in practice.

---

## Implementation

### New file

```
backend/src/metrics/issue-type-filters.ts
```

```typescript
/** Issue types that are never counted as deliverable work items. */
export const EXCLUDED_ISSUE_TYPES = ['Epic', 'Sub-task'] as const;

/** Returns true if the issue should be included in flow metrics. */
export function isWorkItem(issueType: string): boolean {
  return !EXCLUDED_ISSUE_TYPES.includes(issueType as typeof EXCLUDED_ISSUE_TYPES[number]);
}
```

### Call sites patched (gaps closed)

| File | Method |
|---|---|
| `backend/src/planning/planning.service.ts` | `getSprintAccuracy()` |
| `backend/src/metrics/lead-time.service.ts` | `getLeadTimeObservations()` |
| `backend/src/metrics/mttr.service.ts` | `getMttrObservations()` |
| `backend/src/metrics/cfr.service.ts` | `calculate()` (two `find()` calls) |
| `backend/src/metrics/deployment-frequency.service.ts` | `calculate()` (two `find()` calls) |
| `backend/src/metrics/cycle-time.service.ts` | `getCycleTimeObservations()` |
| `backend/src/quarter/quarter-detail.service.ts` | `getDetail()` |
| `backend/src/week/week-detail.service.ts` | `getDetail()` |

### Existing correct sites updated to use `isWorkItem` (DRY cleanup, no behaviour change)

| File | Location |
|---|---|
| `backend/src/planning/planning.service.ts` | `getKanbanQuarters()`, `getKanbanWeeks()` |
| `backend/src/roadmap/roadmap.service.ts` | `getKanbanAccuracy()`, `getKanbanWeeklyAccuracy()`, `getSprintAccuracy()` private helper |
| `backend/src/sprint/sprint-detail.service.ts` | `getDetail()` |

### No database migration required

This is a pure application-layer filter change.

---

## Related Decisions

- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — The decision _not_
  to use per-board config for issue type exclusion is the inverse of the pattern established
  here; CFR/MTTR rules are board-specific whereas Epic/Sub-task exclusion is universal
- [ADR-0015](0015-board-config-as-metric-filter-composition-point.md) — `BoardConfig` is
  the composition point for board-specific rules; issue type exclusion deliberately lives
  outside `BoardConfig` because it is not board-specific
