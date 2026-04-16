# 0034 — Changelog Lower-Bound Date Filter Bug Fix (Lead Time & MTTR)

**Date:** 2026-04-16
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** —
**Related Proposals:** [0033](0033-dora-trend-endpoint-performance.md)

---

## Problem Statement

PR perf/0033 added `changedAt >= startDate` lower-bound filters to the changelog
queries inside `getLeadTimeObservations()` and `getMttrObservations()`, mirroring
an existing optimisation already present in `DeploymentFrequencyService` and
`CfrService`. The optimisation is correct for DF and CFR but is semantically wrong
for Lead Time and MTTR, and causes both metrics to silently under-count and
mis-measure issues that were already in-flight when the measurement window opens.

### Why DF/CFR lower-bound filters are safe

`DeploymentFrequencyService` and `CfrService` use changelogs exclusively to find
events *within* the period (done-status transitions, failure-link transitions). Any
changelog row that pre-dates `startDate` is irrelevant to those computations.
Excluding pre-period rows is safe and beneficial.

### Why Lead Time lower-bound filter is wrong

`getLeadTimeObservations()` in `lead-time.service.ts` (lines 81–87) adds:

```typescript
.andWhere('cl.changedAt >= :from', { from: startDate })
```

Lead time is measured from the *first transition into an in-progress status* (any
value in `DEFAULT_IN_PROGRESS_NAMES` / `config.inProgressStatusNames`) to the done
or release endpoint. For issues that were already in progress when the measurement
window opens — a common case for sprint-based or quarter-based views — the
in-progress transition is recorded before `startDate`. With the lower-bound filter
in place, `changelogsByIssue.get(issue.key)` returns an empty list or only
post-`startDate` rows for those issues. The `inProgressTransition` search at line
126 finds nothing, the code reaches the `anomalyCount++; continue;` branch at line
168, and the issue is **excluded from the lead time sample entirely** rather than
measured.

This means:
- Issues that span the period boundary are silently dropped.
- The lead time sample is biased toward same-period short-cycle issues.
- `anomalyCount` is inflated, masking the true rate of genuinely anomalous records.

### Why MTTR lower-bound filter is wrong

`getMttrObservations()` in `mttr.service.ts` (lines 106–112) adds the same filter:

```typescript
.andWhere('cl.changedAt >= :from', { from: startDate })
```

MTTR is measured from `startTime`, which the code at lines 152–157 resolves as:
- the first in-progress transition (`inProgressTransition.changedAt`), or
- `issue.createdAt` as a fallback when no such transition is found.

With the lower-bound filter, incidents that moved to In Progress before `startDate`
have their pre-period changelogs stripped. `inProgressTransition` is `undefined`
and the code falls back to `issue.createdAt`, which precedes the actual In Progress
time. This **inflates every such incident's MTTR** by the gap between `createdAt`
and the true In Progress transition.

The comment in `mttr.service.ts` (lines 103–105) explicitly acknowledges the
fallback to `createdAt` for incidents without an in-progress transition, but the
concern cited ("In Progress transitions before startDate are rare for incidents") is
an empirical assumption, not a structural guarantee, and is incorrect for longer
incidents or incidents logged retroactively.

### Effect on the in-memory `*FromData` paths

`getLeadTimeObservationsFromData()` and `getMttrObservationsFromData()` receive
their changelogs from `TrendDataLoader.load()`, which uses `rangeStart` (the full
trend span start) as the lower bound on `cl.changedAt >= :from` (line 106 of
`trend-data-loader.service.ts`). For a trend query spanning 8 quarters,
`rangeStart` is approximately two years before the current quarter's `startDate`,
which mitigates the bug for the *first period in the trend* in practice. However:

1. The DB paths (`getLeadTimeObservations`, `getMttrObservations`) are still
   broken for single-period requests (i.e. `GET /api/metrics/dora?boardId=...`,
   `GET /api/metrics/lead-time`, `GET /api/metrics/mttr`).
2. The mitigation in the trend path is accidental, not designed. Issues in-flight
   since before `rangeStart` (e.g. long-lived epics tracked as bugs, chronic
   incidents) still have their in-progress transitions dropped even on the
   `*FromData` path.
3. The `TrendDataLoader` comment does not document why `rangeStart` rather than
   `periodStart` is used, making the safety property invisible to future maintainers.

### Bonus issue — null sprint dates in `getDoraTrend()` (sprint mode)

`getDoraTrend()` in `metrics.service.ts` (lines 327–328) computes:

```typescript
const rangeStart = sprints[sprints.length - 1].startDate ?? new Date();
const rangeEnd   = sprints[0].endDate ?? new Date();
```

`sprints` is the raw query result from `sprintRepo.find()`. If any sprint in the
result set has a `null` `startDate` or `endDate`, the nullish-coalescing fallback
`new Date()` (now) silently corrupts `rangeStart` or `rangeEnd` before it is passed
to `TrendDataLoader.load()`, resulting in a changelog window that is wrong for every
board in that trend call. The `startDate ?? new Date()` pattern is also applied at
lines 336–337 per-sprint within the `points.map()`, meaning null-dated sprints
produce trend points with `start` / `end` both set to the request timestamp.

---

## Proposed Solution

### Fix 1 — Remove lower-bound filter from `getLeadTimeObservations()`

In `backend/src/metrics/lead-time.service.ts`, remove the `.andWhere('cl.changedAt >= :from', { from: startDate })` clause from the `createQueryBuilder` chain at lines 81–87. The corrected query fetches all status changelogs for the board's issue keys with no date lower bound:

```typescript
const changelogs = await this.changelogRepo
  .createQueryBuilder('cl')
  .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
  .andWhere('cl.field = :field', { field: 'status' })
  .orderBy('cl.changedAt', 'ASC')
  .getMany();
```

The period-scoping that determines which issues *belong* in the sample is already
applied correctly at lines 132–139 (the `doneTransition` filter uses
`cl.changedAt >= startDate && cl.changedAt <= endDate`). Pre-period changelogs are
needed only as lookups for the in-progress start time and are not included in the
output sample.

### Fix 2 — Remove lower-bound filter from `getMttrObservations()`

In `backend/src/metrics/mttr.service.ts`, remove the `.andWhere('cl.changedAt >= :from', { from: startDate })` clause from the `createQueryBuilder` chain at lines 106–112. The corrected query:

```typescript
const allIncidentChangelogs = await this.changelogRepo
  .createQueryBuilder('cl')
  .where('cl.issueKey IN (:...keys)', { keys: incidentKeys })
  .andWhere('cl.field = :field', { field: 'status' })
  .orderBy('cl.changedAt', 'ASC')
  .getMany();
```

Period-scoping for the *recovery* event is already applied at lines 123–128 (the
`recoveryChangelogs` filter uses `cl.changedAt >= startDate && cl.changedAt <= endDate`).
Removing the lower bound restores the ability to find in-progress transitions that
pre-date `startDate`.

Remove the now-incorrect comment block at lines 102–105 that rationalises the filter.

### Fix 3 — Add explanatory comment to `TrendDataLoader`

In `backend/src/metrics/trend-data-loader.service.ts`, add a comment before the
`cl.changedAt >= :from` clause at line 106 to document why the lower bound is
`rangeStart` rather than the period start, and to note that this is intentional
(and necessary) for the in-memory Lead Time and MTTR paths:

```typescript
// Lower bound is rangeStart (the full trend span start), NOT the per-period
// startDate.  Lead Time and MTTR need pre-period changelogs to find in-progress
// transitions for issues that were already in-flight when a period opens.
// Using rangeStart here means the *FromData methods see those transitions.
// DF and CFR do not need pre-period changelogs; they tolerate the lower bound.
.andWhere('cl.changedAt >= :from', { from: rangeStart })
```

### Fix 4 — Null-guard sprint dates before range computation in `getDoraTrend()`

In `backend/src/metrics/metrics.service.ts`, inside the `mode === 'sprints'` branch
of `getDoraTrend()` (lines 318–360), filter out sprints with null `startDate` or
`endDate` immediately after the `sprintRepo.find()` call, before computing
`rangeStart`/`rangeEnd` and before the `points.map()`:

```typescript
const sprints = (await this.sprintRepo.find({
  where: { boardId, state: 'closed' },
  order: { endDate: 'DESC' },
  take: limit,
})).filter((s) => s.startDate !== null && s.endDate !== null);

if (sprints.length === 0) return [];

const rangeStart = sprints[sprints.length - 1].startDate as Date;
const rangeEnd   = sprints[0].endDate as Date;
```

This eliminates the `?? new Date()` fallbacks entirely, turning runtime corruption
into a clean omission of the malformed sprint from the trend.

---

## Alternatives Considered

### A — Keep the lower-bound filter; widen it by a fixed lookback window

Add a configurable lookback margin (e.g. `startDate - 90 days`) rather than
removing the filter entirely. This reduces the I/O cost while covering most
in-flight issues.

**Rejected.** A fixed margin is arbitrary and will still mis-classify issues with
longer cycle times (e.g. a PLAT issue open for 6 months). The correct solution is
to load all changelogs for the board's issue keys. The I/O cost is bounded by the
number of work items on the board, not the date range, and is the same as the
pre-0033 baseline.

### B — Pre-compute and cache in-progress start times per issue

Store the first in-progress transition date on the `JiraIssue` entity (a new
column) and populate it during sync. Lead Time and MTTR queries then only need
period-scoped changelogs.

**Not rejected, but out of scope.** This is a valid long-term optimisation and may
be worth a separate proposal. It requires a schema migration and sync-path changes.
Doing it here conflates a correctness fix with a schema change.

### C — Use the `*FromData` path for all requests (not just trend)

Route single-period requests through `TrendDataLoader` as well, accepting the
slightly larger query scope in exchange for uniform code paths.

**Not rejected, but deferred.** The DB paths are used by `calculate()` on each
service and are called from `getDoraAggregate()`. Consolidating to a single path
is architecturally cleaner but is a larger refactor. Fix 1 and Fix 2 are minimal
and targeted.

---

## Impact Assessment

| Area | Impact |
|---|---|
| `lead-time.service.ts` | Correctness fix: in-flight issues now included in sample; `anomalyCount` reflects genuine anomalies only |
| `mttr.service.ts` | Correctness fix: incidents in-flight at period start now use actual In Progress time, not `createdAt` |
| `trend-data-loader.service.ts` | Documentation only; no behaviour change |
| `metrics.service.ts` | Defensive fix; prevents corrupt trend output when a sprint has null dates |
| DB query volume | Fixes 1 & 2 remove a `WHERE cl.changedAt >= $start` predicate from two queries. PostgreSQL will still use the `issueKey` index; the date lower bound was not a primary selectivity driver. Marginal I/O increase is acceptable. |
| Tests | Unit tests for `LeadTimeService` and `MttrService` that mock changelogs with pre-period in-progress transitions must be added or updated to validate the fix. |

### Risk

Low. The change removes a filter clause that was incorrectly added; it restores
the query shape to the pre-0033 baseline for these two services. No schema changes.
No interface changes. No new dependencies.

---

## Open Questions

1. Should `TrendDataLoader` load changelogs without any lower-bound filter to
   correctly handle issues with in-progress transitions before even `rangeStart`
   (e.g. issues open for longer than the full trend span)? This is a separate
   correctness edge case not introduced by 0033.

2. Is the `anomalyCount` surface in `LeadTimeResult` and `MttrResult` exposed in
   the API response used by the frontend? If so, the corrected (lower) anomaly
   counts may affect displayed warnings — confirm UI behaviour is acceptable.

---

## Acceptance Criteria

- [ ] `getLeadTimeObservations()` in `lead-time.service.ts` does not include
  `cl.changedAt >= :from` in its `createQueryBuilder` chain.
- [ ] `getMttrObservations()` in `mttr.service.ts` does not include
  `cl.changedAt >= :from` in its `createQueryBuilder` chain.
- [ ] A unit test for `LeadTimeService.getLeadTimeObservations()` passes where an
  issue has its in-progress transition before `startDate` and its done transition
  within `[startDate, endDate]`: the issue is included in `observations`, not
  `anomalyCount`.
- [ ] A unit test for `MttrService.getMttrObservations()` passes where an incident
  has its in-progress transition before `startDate` and its recovery transition
  within `[startDate, endDate]`: the measured MTTR uses the in-progress changedAt
  as `startTime`, not `issue.createdAt`.
- [ ] `TrendDataLoader.load()` has an inline comment explaining why `rangeStart`
  is used as the changelog lower bound rather than a per-period date.
- [ ] `getDoraTrend()` sprint branch filters out sprints with null `startDate` or
  `endDate` before computing `rangeStart`/`rangeEnd` and before the `points.map()`.
- [ ] All existing metric service tests continue to pass.
