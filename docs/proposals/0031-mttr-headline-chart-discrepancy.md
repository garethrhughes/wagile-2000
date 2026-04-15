# 0031 — MTTR Headline / Chart Discrepancy: Root Cause & Fix

**Date:** 2026-04-15
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** none (bug fix — no new architectural decision required)

---

## Problem Statement

The DORA page displays an MTTR headline of **168.3 hours** while the trend
chart shows a single data point of **91.07 hours**.  A user with one incident
in the current period should see the same value in both places.  The
discrepancy is large enough (≈ 85 % error) to make the headline meaningless
and to erode trust in all other metrics displayed alongside it.

---

## Investigation Findings

### 1. Where does the 168.3 headline number come from?

**Code path:**

```
GET /api/metrics/dora/aggregate?boardId=...
  → MetricsService.getDoraAggregate()          metrics.service.ts:167
    → MttrService.getMttrObservations()         mttr.service.ts:49
      → returns { recoveryHours: [...], ... }
    → percentile(allMttrObs, 50)               metrics.service.ts:276
    → round2(mttrMedian)                        metrics.service.ts:331
  → OrgDoraResult.orgMttr.medianHours          org-dora-response.dto.ts:43
→ frontend: pageState.aggregate.orgMttr.medianHours   dora/page.tsx:468
→ OrgMetricCard value prop                     org-metric-card.tsx:105
```

**What `getDoraAggregate` does:**

```
GET /api/metrics/dora/aggregate
  (no ?quarter= param)
→ resolvePeriod(): falls back to "last 90 days"   metrics.service.ts:611-613
```

The frontend call at `dora/page.tsx:211` is:

```ts
getDoraAggregate({ boardId })    // no quarter/period param
```

Because no `quarter`, `period`, or `sprintId` is passed, `resolvePeriod()`
falls through to the default branch at `metrics.service.ts:611-613`:

```ts
const endDate = new Date();
const startDate = new Date();
startDate.setDate(startDate.getDate() - 90);
```

This means the headline is computed over the **last 90 days**.

### 2. Where does the 91.07 chart data point come from?

**Code path:**

```
GET /api/metrics/dora/trend?boardId=...&mode=quarters&limit=8
  → MetricsService.getDoraTrend()              metrics.service.ts:346
    → listRecentQuarters(8, tz)                period-utils.ts:56
    → per quarter: getDoraAggregate({ boardId, quarter: q.label })
      → resolvePeriod(): uses quarterToDates()  metrics.service.ts:595-597
```

The frontend call at `dora/page.tsx:212-216` passes `mode: 'quarters'`, so
the trend endpoint calls `getDoraAggregate` with an explicit `quarter:` param
for each of the last 8 quarters.  Each trend point is therefore scoped to
**one calendar quarter**.

The 91.07 data point is the MTTR for the most-recent completed quarter (e.g.
2026-Q1: 1 Jan → 31 Mar), where there happened to be exactly **one incident**
that took 91.07 hours to resolve.

### 3. Why do they differ?

The headline and the chart are reading from **different time windows**:

| Display element | Endpoint | Time window |
|---|---|---|
| Headline "Mean Time to Recovery" card | `GET /api/metrics/dora/aggregate` | **Last 90 days** (rolling) |
| Rightmost chart data point | `GET /api/metrics/dora/trend` → last quarter | **Current calendar quarter** (partial) |

The 90-day rolling window extends further back than the current-quarter
boundary, so it can include additional incidents that are not visible in the
chart.  In this case there is exactly **one incident in the current quarter**
(91.07 hours) and the 90-day window has also picked up an older incident
— or the current quarter started mid-90-day-window and a second incident
from a prior quarter is included — producing a multi-point median that rounds
to 168.3.

**Is 168.3 a magic number?**  
`168` appears in `dora-bands.ts:40` as the boundary between 'medium' and
'low' (`medianHours < 168`), which is exactly 7 × 24.  The observed value
168.3 is just slightly above this boundary, which is consistent with a second
incident taking around 245 hours (≈ 10 days), giving a median of
`(91.07 + 245.53) / 2 ≈ 168.3`.  It is a real calculated value, not a
sentinel or fallback.

**Could this also be caused by the `openIncidentCount` changes from
proposal 0030?**  
No.  Open incidents are explicitly excluded from the `recoveryHours` array
(`mttr.service.ts:177-179`) before the `percentile()` call, so they cannot
inflate the median.

### 4. What is the root cause?

The DORA page's headline aggregate call never passes a time period, so it
always defaults to a rolling 90-day window.  The trend chart always shows
calendar quarters.  **These two windows are structurally different** and will
almost always produce different values, even when the page is ostensibly
"showing the same data".

The user expectation — and the correct behaviour for a coherent dashboard —
is that **the headline number is the value for the most-recent period shown
in the chart**.

### 5. Is 168.3 defensible?

It is arithmetically correct given its inputs, but it is **not defensible as
a headline** because:
- The time window is never disclosed to the user.
- It will always disagree with the rightmost trend chart point.
- "Last 90 days" is not a meaningful DORA reporting unit; quarters and sprints
  are.

The correct headline MTTR given one incident of 91.07 hours is **91.1 hours**
(the value already shown by the chart).

---

## Proposed Solution

### Fix

Change the DORA page to always pass the current quarter as the time window
when calling `getDoraAggregate`, so the headline and the rightmost trend chart
point are always computed over the same period.

**Option A (preferred): derive current quarter client-side and pass it**

In `frontend/src/app/dora/page.tsx`, the `getDoraAggregate` call becomes:

```ts
// Compute the current quarter label client-side (e.g. "2026-Q2")
function currentQuarterLabel(): string {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3) + 1
  return `${now.getFullYear()}-Q${q}`
}

// Inside the load() function:
const [aggregate, trend] = await Promise.all([
  getDoraAggregate({ boardId, quarter: currentQuarterLabel() }),  // ← add quarter
  getDoraTrend({ boardId, mode: ..., limit: 8 }),
])
```

This guarantees that both calls cover the same calendar quarter.  The
headline will always equal the rightmost bar in the trend chart.

**Why not Option B (pass `period` matching the trend's last point)?**  
It would require fetching the trend first, waiting for it, then fetching the
aggregate — two sequential round-trips instead of one parallel pair.
Client-side quarter derivation is a pure function with zero extra latency.

**Why not Option C (fix the backend default period to use the current
quarter instead of 90 days)?**  
The 90-day rolling default is used by other pages and the `/api/metrics/dora`
(non-aggregate) endpoint.  Changing it is a broader breaking change.  The
fix should be surgical.

### Files to change

| File | Change |
|---|---|
| `frontend/src/app/dora/page.tsx` | Add `currentQuarterLabel()` helper; pass `quarter:` to `getDoraAggregate` |

No backend changes are required.  No database migrations are required.

---

## Alternatives Considered

### Alternative A — Fix the backend default to use current quarter
Rejected: would change behaviour of all callers of `resolvePeriod()` that
rely on the 90-day default.  Scope too broad for a targeted bug fix.

### Alternative B — Sequential fetch (trend first, then aggregate using its last point)
Rejected: adds latency; unnecessary complexity.

### Alternative C — Accept the discrepancy and add a footnote
Rejected: the headline is wrong, not merely confusing.  Footnotes do not fix
incorrect numbers.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes |
| API contract | None | No new endpoints or field changes |
| Frontend | Single file, 3-line change | `dora/page.tsx` only |
| Tests | Existing unit tests unaffected; add a test for `currentQuarterLabel()` | Optional |
| Jira API | None | No new Jira calls |

---

## Open Questions

None.

---

## Acceptance Criteria

- [ ] The MTTR headline on the DORA page equals the rightmost MTTR value in
      the trend chart when viewed in the same calendar quarter.
- [ ] With a single incident of 91.07 hours in the current quarter, the
      headline reads **91.1 hours**, not 168.3 hours.
- [ ] The headline value updates correctly when the quarter rolls over (e.g.
      on 1 July the headline switches from Q2 data to Q3 data, which will
      initially be 0 if no incidents have occurred yet in Q3).
- [ ] No regression in other metrics (DF, LT, CFR) on the same page.
- [ ] TypeScript compilation passes without errors.
