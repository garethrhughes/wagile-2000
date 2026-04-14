# 0026 — Metric Calculation Fixes: Post-Implementation Validation Report

**Date:** 2026-04-14
**Status:** Informational
**Author:** Architect Agent
**Related:** [0017-metric-calculation-audit.md](0017-metric-calculation-audit.md), [0018-metric-calculation-fixes.md](0018-metric-calculation-fixes.md)

---

## Purpose

This document is the **post-implementation validation** of the P1 and P2 fixes
specified in proposal 0018.  It records which findings were implemented correctly,
which were only partially addressed, and which introduced new bugs.  It also
records new issues found during the validation pass that were not present in the
original 0017 audit.

The validation was performed by reading every source file named in 0017 and 0018
against the current codebase state (2026-04-14).

---

## Summary

| Finding | Original Status | Validation Outcome |
|---|---|---|
| P1-1 — DF double-counting (`Math.max`) | Must Fix | ✅ FIXED |
| P1-2 — Lead Time ignores `inProgressStatusNames` | Must Fix | ✅ FIXED |
| P1-3 — Kanban roadmap `issueActivityEnd` inverted | Must Fix | ✅ FIXED |
| P1-4 — `resolveBoardIds` reads `JIRA_BOARD_IDS` | Must Fix | ✅ FIXED |
| P2-1 — MTTR hardcoded `'In Progress'` | Must Fix before rollout | ✅ FIXED |
| P2-2 — Frontend CFR/Lead Time band thresholds | Must Fix before rollout | ⚠️ PARTIALLY FIXED — new residual mismatch (see NEW-1) |
| P2-3 — `boardId === projectKey` assumption | Known Limitation | ✅ DOCUMENTED (no code change, as decided) |
| P2-4 — `dateToWeekKey` non-standard ISO 8601 | Must Fix before rollout | ✅ FIXED |
| P2-5 — Kanban `deliveryRate` uses current status | Must Fix before rollout | ✅ FIXED |
| P2-5b — Scrum roadmap stale JPD ideas | Must Fix before rollout | ✅ FIXED |
| P2-6 — Quarter `roadmapOnTimeRate` is mean-of-% | Must Fix before rollout | ❌ INCORRECTLY FIXED — new bug (see NEW-2) |
| P2-7 — Timezone `TIMEZONE` env var missing | Must Fix before rollout | ✅ FIXED |

**New issues discovered during validation:**

| ID | Description | Severity | Runtime Impact |
|---|---|---|---|
| NEW-1 | Lead Time elite boundary: backend `< 1`, frontend `<= 1` | Low | None (functions unused in UI) |
| NEW-2 | `roadmapOnTimeRate === roadmapCoverage` in quarter grouping | Medium | Active — redundant and semantically wrong column |
| NEW-3 | `avgCoverage` / `avgOnTimeRate` summary stats still use simple mean | Medium | Active — same averaging-percentages bug in stat cards |
| NEW-4 | `avgPlanningAccuracy` still uses simple mean (P3-3 still open) | Low | Active — deferred per 0018; confirmed still present |

---

## P1 Findings — Detailed Status

### P1-1 — Deployment Frequency double-counting ✅ FIXED

**Files:** `backend/src/metrics/deployment-frequency.service.ts`,
`backend/src/metrics/cfr.service.ts`

The `Math.max(versionDeployments, transitionDeployments)` pattern is gone.
Both services now implement the priority-based, mutually-exclusive model
from 0018 §P1-1:

- Issues **with** a `fixVersion` → counted via the version-release-date path.
- Issues **without** a `fixVersion` → counted via the Done-transition fallback
  path only.
- The two sets are `Set`-unioned to deduplicate multiple transitions for the
  same issue.

`DeploymentFrequencyService` and `CfrService` use the same partition logic,
so their `totalDeployments` denominators are consistent.

---

### P1-2 — Lead Time ignores `inProgressStatusNames` ✅ FIXED

**File:** `backend/src/metrics/lead-time.service.ts`

`getLeadTimeObservations()` now reads `config?.inProgressStatusNames` with the
full 20-entry default list (matching `CycleTimeService` word-for-word).  The
hardcoded `cl.toValue === 'In Progress'` check is gone.  The Scrum `createdAt`
fallback has been removed.  Issues with no in-progress transition are counted
in `anomalyCount` and excluded from the percentile distribution.

`LeadTimeResult` now includes `anomalyCount`.  All callers of
`getLeadTimeObservations()` in `MetricsService` destructure the new return
shape correctly.

---

### P1-3 — Kanban roadmap `issueActivityEnd` inverted ✅ FIXED

**File:** `backend/src/roadmap/roadmap.service.ts`

Both `getKanbanAccuracy()` and `getKanbanWeeklyAccuracy()` now assign:

```typescript
const issueActivityEnd = completionDates.get(i.key) ?? null;
```

The former inverted logic (`doneStatusNames.includes(i.status) ? null : ...`)
is gone.  Done issues now use their actual completion date from the changelog
map; genuinely in-flight issues (no done-transition) remain `null` and always
qualify.

---

### P1-4 — `resolveBoardIds` reads `JIRA_BOARD_IDS` ✅ FIXED

**File:** `backend/src/metrics/metrics.service.ts`

`resolveBoardIds` is now `async` and queries `boardConfigRepo.find()` when no
`boardId` query param is supplied.  All callers `await` it.  The hardcoded
`'ACC,BPT,SPS,OCS,DATA,PLAT'` fallback string is gone.

---

## P2 Findings — Detailed Status

### P2-1 — MTTR hardcoded `'In Progress'` ✅ FIXED

**File:** `backend/src/metrics/mttr.service.ts`

`getMttrObservations()` now reads `config?.inProgressStatusNames` with the
full default list.  The `createdAt` fallback is retained for MTTR (incident
detection time), as specified in 0018.

---

### P2-2 — Frontend band threshold mismatch ⚠️ PARTIALLY FIXED

**File:** `frontend/src/lib/dora-bands.ts`

The CFR thresholds (`<= 5 / 10 / 15 %`) are now consistent between backend and
frontend.

**Residual mismatch — Lead Time elite boundary (NEW-1):**

| Function | Backend (`dora-bands.ts` line 13) | Frontend (`dora-bands.ts` line 31) |
|---|---|---|
| `classifyLeadTime` elite threshold | `< 1` (strict) | `<= 1` (inclusive) |

At `medianDays === 1.0`: backend returns `'high'`; frontend returns `'elite'`.
This is the **opposite** direction from the original P2-2 finding (frontend now
uses `<=` where backend uses `<`).

**Runtime impact:** `classifyLeadTime` and `classifyChangeFailureRate` are not
imported by any page component in the frontend.  They are only consumed by
`dora-bands.test.ts`.  There is currently no runtime UI impact.  The comment
in the frontend source (`Elite: < 1 day`) disagrees with the implementation
(`<= 1`), and the test description at line 34 ("returns elite for < 1 day")
would not catch `medianDays === 1.0`.

**Recommended fix:** Change frontend `classifyLeadTime` line 31 from
`if (medianDays <= 1)` to `if (medianDays < 1)` to match the backend.  Update
the corresponding test to cover `medianDays === 1.0` → `'high'`.

---

### P2-3 — `boardId === projectKey` assumption ✅ DOCUMENTED

**Files:** `backend/src/metrics/lead-time.service.ts` line 118,
`backend/src/metrics/cycle-time.service.ts` line 171

`projectKey: boardId` is still present in both services, as decided by the
project owner in 0018.  This is a known limitation, documented in 0018
§"Known Limitation".  No action required.

---

### P2-4 — `dateToWeekKey` ISO 8601 algorithm ✅ FIXED

**Files:** `backend/src/planning/planning.service.ts`,
`backend/src/roadmap/roadmap.service.ts`

Both `dateToWeekKey` implementations now use the correct ISO 8601 algorithm:
Thursday-finding to determine the ISO year, then Monday-of-week-1 via the
"Jan 4 is always in W01" rule, then `Math.floor` to count full weeks.  Both
services read `TIMEZONE` from `ConfigService` and use `dateParts(date, tz)`
for timezone-aware input.

---

### P2-5 — Kanban `deliveryRate` uses current status ✅ FIXED

**File:** `backend/src/planning/planning.service.ts`

Both `getKanbanQuarters()` and `getKanbanWeeks()` now build a
`completionDateByIssue` map from done-transition changelogs and check
`completedAt >= startDate && completedAt <= endDate`.  The
`doneStatuses.includes(issue.status)` current-snapshot check is gone.

---

### P2-5b — Scrum roadmap stale JPD ideas ✅ FIXED

**File:** `backend/src/roadmap/roadmap.service.ts`

`calculateSprintAccuracy()` now calls `this.filterIdeasForWindow(allIdeas, sprintStart, sprintEnd)` instead of `buildEpicIdeaMap`.  `buildEpicIdeaMap` no
longer exists in the codebase.  Both the Kanban and Scrum paths now use
the same window-filtered idea lookup.

---

### P2-6 — Quarter `roadmapOnTimeRate` is mean-of-percentages ❌ INCORRECTLY FIXED

**File:** `frontend/src/app/roadmap/page.tsx` lines 96–101

The simple-averaging bug has been replaced with a different bug.
The implemented formula is:

```typescript
// P2-6 fix comment in source:
const roadmapOnTimeRate =
  totalIssues > 0
    ? Math.round((coveredIssues / totalIssues) * 10000) / 100
    : 0;
```

This is **identical to `roadmapCoverage`** (lines 92–95 compute the same
`coveredIssues / totalIssues` expression with the same denominator).  The
on-time rate column is therefore always equal to the coverage column in the
quarter view, making it redundant and semantically wrong.

**Root cause:** The 0018 spec called for `coveredIssues / (coveredIssues + uncoveredIssues)`, i.e. green ÷ (green + amber).  The implementation uses
`totalIssues` as the denominator instead.  However, `uncoveredIssues` in the
`RoadmapSprintAccuracy` DTO aggregates both linked-not-covered (amber) **and**
unlinked (no roadmap entry) issues.  This means `coveredIssues + uncoveredIssues === totalIssues`, so the correct denominator from 0018's note is
also `totalIssues` — which makes `roadmapOnTimeRate === roadmapCoverage`
mathematically unavoidable given the current DTO shape.

**Underlying design gap:** The API does not return `linkedNotCoveredCount` as a
separate field.  Without it, "on-time rate among roadmap-linked issues only"
(green ÷ (green + amber)) cannot be computed in the frontend.  The correct fix
requires either:

1. **Backend change (preferred):** Add `linkedIssues` (or `linkedNotCoveredIssues`) as a separate field in `RoadmapSprintAccuracy`.  Then the
   frontend computes `coveredIssues / linkedIssues`.
2. **Accept the current semantics:** Rename the column to "Covered" and remove
   the separate on-time rate column, since they are identical.

This is logged as NEW-2 below and requires a follow-on fix.

---

### P2-7 — Timezone `TIMEZONE` env var ✅ FIXED

**Files:** `backend/src/metrics/tz-utils.ts`, `backend/src/metrics/period-utils.ts`,
`backend/src/planning/planning.service.ts`, `backend/src/roadmap/roadmap.service.ts`,
`backend/src/config/config.controller.ts`, `frontend/src/app/planning/page.tsx`,
`frontend/src/app/roadmap/page.tsx`

The fix is comprehensive:

- `tz-utils.ts` provides `dateParts()` and `midnightInTz()`.
- `period-utils.ts` accepts an optional `tz` parameter.
- Both backend services read `TIMEZONE` from `ConfigService` and pass it to
  all date helpers.
- `/api/config` endpoint exists in `config.controller.ts`.
- Frontend pages call `getAppConfig()` and use `Intl.DateTimeFormat` with the
  configured timezone in `getQuarterKey()` and `getCurrentQuarterKey()`.

---

## New Issues Found During Validation

### NEW-1 — Lead Time elite boundary: residual backend/frontend mismatch

**Severity:** Low  
**Runtime impact:** None (function unused in UI components)

`frontend/src/lib/dora-bands.ts` line 31:
```typescript
if (medianDays <= 1) return 'elite';   // ← inclusive
```

`backend/src/metrics/dora-bands.ts` line 13:
```typescript
if (medianDays < 1) return 'elite';    // ← strict
```

The JSDoc comment in the frontend (`Elite: < 1 day`) correctly documents the
intended behaviour; the implementation is wrong.  The test at
`frontend/src/lib/dora-bands.test.ts` line 34 describes "returns elite for
< 1 day" — a test for `medianDays === 1.0` would fail with the current
implementation (`'elite'`) but should return `'high'`.

**Fix:** Change frontend line 31 to `if (medianDays < 1)`.  Add test case for
`classifyLeadTime(1)` → `'high'`.

---

### NEW-2 — `roadmapOnTimeRate === roadmapCoverage` in quarter grouping

**Severity:** Medium  
**Runtime impact:** Active — the on-time rate column in the quarter roadmap
table always shows the same value as the coverage column, making it redundant
and misleading.

**File:** `frontend/src/app/roadmap/page.tsx` lines 88–101

`groupByQuarter()` builds `roadmapCoverage` and `roadmapOnTimeRate` from the
same expression:

```typescript
const roadmapCoverage    = Math.round((coveredIssues / totalIssues) * 10000) / 100;
const roadmapOnTimeRate  = Math.round((coveredIssues / totalIssues) * 10000) / 100;
// These are identical.
```

**Root cause:** The API DTO (`RoadmapSprintAccuracy`) does not carry a separate
`linkedNotCoveredCount` field.  Without it, the "on-time rate among linked issues" metric cannot be computed in the frontend.

**Options:**

1. **Add `linkedIssues` to `RoadmapSprintAccuracy` (backend + migration):**
   Rename or add a field so the frontend can compute `coveredIssues / linkedIssues`.
   This is the semantically correct fix but requires a backend DTO change.

2. **Remove the on-time rate column from the quarter view** until the DTO is
   updated.  The per-sprint rows (non-grouped) still show `roadmapOnTimeRate`
   from the backend directly, where the value is meaningful.

3. **Accept the current semantics** and retitle the column "Covered (%)" in
   both the quarter and per-sprint views to remove the misleading "on-time"
   framing.

Option 2 is the recommended minimal fix.  Option 1 is the correct long-term
fix and should be proposed separately.

---

### NEW-3 — Summary stat cards use simple mean of per-period percentages

**Severity:** Medium  
**Runtime impact:** Active — the `avgCoverage` and `avgOnTimeRate` hero stat
cards above the roadmap table show incorrect values whenever periods have
unequal issue counts.

**File:** `frontend/src/app/roadmap/page.tsx` lines 351–366

```typescript
const totalCoverage = rows.reduce((s, r) => s + r.roadmapCoverage, 0);
const totalOnTime   = rows.reduce((s, r) => s + r.roadmapOnTimeRate, 0);
return {
  avgCoverage:    totalCoverage / rows.length,   // simple mean of %
  avgOnTimeRate:  totalOnTime   / rows.length,   // simple mean of %
};
```

This is the same "averaging percentages" anti-pattern as the original P2-6
finding, applied to the summary stat cards.  A sprint with 1 issue at 100%
and a sprint with 50 issues at 20% produces an average of 60%, not the correct
weighted 20.4%.

The P2-6 fix addressed this for the quarter-grouped **table rows** but missed
the summary stat cards which aggregate across all displayed rows.

**Fix:** Use the same sum-of-counts pattern as the corrected `groupByQuarter()`:

```typescript
const allCovered = rows.reduce((s, r) => s + r.coveredIssues, 0);
const allTotal   = rows.reduce((s, r) => s + r.totalIssues, 0);
return {
  avgCoverage:   allTotal > 0 ? Math.round((allCovered / allTotal) * 10000) / 100 : 0,
  avgOnTimeRate: allTotal > 0 ? Math.round((allCovered / allTotal) * 10000) / 100 : 0,
};
```

Note: until NEW-2 is resolved, `avgCoverage === avgOnTimeRate` regardless.
Both fixes should be applied together.

---

### NEW-4 — `avgPlanningAccuracy` is simple mean of per-sprint percentages (P3-3 still open)

**Severity:** Low  
**Runtime impact:** Active — same class of bug as P2-6/NEW-3; deferred in 0018.

**File:** `frontend/src/app/planning/page.tsx` lines 404–410

`avgPlanningAccuracy` is still computed as a simple mean of per-sprint
`planningAccuracy` values, as documented in 0018 §P3-3.  No code change was
made.  This is confirmed still present and still a deferred item.

---

## Action Items

The following items require follow-on work before the metric calculation
improvements are considered complete:

| Priority | Item | File | Proposal needed? |
|---|---|---|---|
| P2 | NEW-2: Remove or fix `roadmapOnTimeRate` in quarter grouping | `roadmap/page.tsx` | No — small targeted fix |
| P2 | NEW-3: Fix `avgCoverage` / `avgOnTimeRate` summary cards to use sum-of-counts | `roadmap/page.tsx` | No — same file, same fix pattern |
| P3 | NEW-1: Align Lead Time elite boundary (`< 1`) in frontend | `frontend/src/lib/dora-bands.ts` | No — one-line fix + test |
| P3 | NEW-4: Fix `avgPlanningAccuracy` to use sum-of-counts | `planning/page.tsx` | No — was already deferred as P3-3 in 0018 |

NEW-2 and NEW-3 should be fixed together in a single PR as they are in the
same file and both stem from the same root cause.

---

## Acceptance Criteria for Outstanding Items

- [ ] `classifyLeadTime(1)` returns `'high'` in the frontend (NEW-1).
- [ ] `frontend/src/lib/dora-bands.test.ts` has a test case for `classifyLeadTime(1)` → `'high'` (NEW-1).
- [ ] In the quarter roadmap view, `roadmapOnTimeRate` is either removed or computed from a denominator that differs from `totalIssues` (NEW-2).
- [ ] `avgCoverage` and `avgOnTimeRate` in the summary stat cards use sum-of-counts, not simple mean of per-period percentages (NEW-3).
- [ ] No regression to any currently-passing test.
