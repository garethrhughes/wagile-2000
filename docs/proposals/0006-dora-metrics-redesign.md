# 0006 — DORA Metrics View Redesign

**Date:** 2026-04-11
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Status: Accepted

**Reviewed by:** Architect Agent — 2026-04-11

The proposal is structurally sound, the problem statement is accurate (all 7 problems verified
against live code), and the aggregation formulas are statistically correct. The migration
strategy is appropriately additive. **However, the proposal cannot be handed to a developer
for implementation in its current state** — there are 8 required changes, several of which
would cause incorrect behaviour or a query-count regression if implemented as written.

### Required Changes (must be resolved before approval)

**RC-1 — `getDoraAggregate()` must NOT call `getDora()` internally.**

Section 4.1 states *"This method calls `getDora(query)` internally… then applies the
org-level aggregation formulas."* This is wrong. `getDora()` only returns pre-computed
summaries; the raw observation arrays needed for pooled median are discarded inside
`LeadTimeService.calculate()` and `MttrService.calculate()`. Calling `getDora()` first and
then calling `getLeadTimeObservations()` / `getMttrObservations()` again would double the DB
queries for both services on every aggregate request.

**Fix:** Rewrite Section 4.1's implementation approach. `getDoraAggregate()` must call the
per-board services directly:
- `deploymentFrequencyService.calculate()` per board (returns totals — no raw arrays needed)
- `cfrService.calculate()` per board (same)
- `getLeadTimeObservations()` per board (new method from §4.3)
- `getMttrObservations()` per board (new method from §4.3)

Then aggregate from those results. `getDora()` is not called by `getDoraAggregate()`.

---

**RC-2 — Section 7 Phase 1 must make the implementation dependency order explicit.**

Section 4.2 states that `getDoraTrend()` calls `getDoraAggregate()` for each period.
Section 7 Step 3 lists both new methods together, hiding the dependency.

**Fix:** Split Step 3 into two sub-steps:
- Step 3a: Implement `getDoraAggregate()` (depends on observations methods from Step 2).
- Step 3b: Implement `getDoraTrend()` (depends on `getDoraAggregate()` from Step 3a).

---

**RC-3 — Resolve the `boardId` vs `boardIds` naming inconsistency across both endpoints.**

`DoraAggregateParams.boardIds` (plural) maps to HTTP param `boardId` (singular) for
`/aggregate`. `TrendQueryDto.boardIds` (plural) is a new field name that diverges from the
existing `MetricsQueryDto.boardId` convention. Both endpoints receive the same
comma-separated string — the dual naming is an unnecessary maintenance hazard.

**Fix:** Use `boardId` (singular, comma-separated) as the HTTP param name for **both** new
endpoints, matching the existing `MetricsQueryDto` convention. Update:
- `DoraAggregateParams.boardIds` → `DoraAggregateParams.boardId`
- `TrendQueryDto.boardIds` → `TrendQueryDto.boardId`
- `DoraTrendParams.boardIds` → `DoraTrendParams.boardId`
- The `getDoraTrend()` API client call in Section 5.3 (`boardIds: params.boardIds` → `boardId: params.boardId`)

Add a comment in `TrendQueryDto` and `DoraTrendParams` that `boardId` is comma-separated
(same semantics as `MetricsQueryDto.boardId`).

---

**RC-4 — Define a concrete extended type for `boardBreakdowns[]` that includes `boardType`.**

`OrgDoraResult.boardBreakdowns` is typed as `DoraMetricsResult[]` in the backend DTO
(Section 4.1) and `DoraMetricsBoard[]` in `api.ts` (Section 5.3). Open Question 5 resolves
to include `boardType` in the response, but never defines the extended type, leaving the
implementer to guess.

**Fix:** Resolve Open Question 5 in-document and define the concrete type. Add to Section 4.1:

```typescript
// backend/src/metrics/dto/org-dora-response.dto.ts
export interface DoraMetricsBoardBreakdown extends DoraMetricsResult {
  boardType: 'scrum' | 'kanban';
}
```

Update `OrgDoraResult.boardBreakdowns: DoraMetricsBoardBreakdown[]`.

In Section 5.3 (`api.ts`), add `boardType: 'scrum' | 'kanban'` to `DoraMetricsBoard`
and note that this is a non-breaking extension (existing consumers of `DoraMetricsBoard`
don't use the new field).

Remove Open Question 5 from the Open Questions list (it is now resolved).

---

**RC-5 — Section 5.1 must define the explicit `number[]` extraction from `TrendPoint[]`
for `OrgMetricCard.sparkline`.**

`OrgMetricCard` accepts `sparkline: number[]`, but the trend API returns `TrendPoint[]`.
The mapping is never specified, leaving the implementer to guess the extraction.

**Fix:** Add the following to Section 5.1 (page state model section):

```typescript
// After fetching TrendPoint[] from getDoraTrend():
const dfSparkline   = trend.map(p => p.deploymentsPerDay)
const ltSparkline   = trend.map(p => p.medianLeadTimeDays)
const cfrSparkline  = trend.map(p => p.changeFailureRate)
const mttrSparkline = trend.map(p => p.mttrMedianHours)
```

These are passed to the four `OrgMetricCard` instances respectively.

---

**RC-6 — `getDoraAggregate()` must parallelize per-board calls with `Promise.all`, not
inherit the sequential `for...of` loop from `getDora()`.**

The existing `getDora()` method uses a sequential `for...of` loop (lines 55–79 of
`metrics.service.ts`). The trend endpoint calls `getDoraAggregate()` 8 times in parallel —
if `getDoraAggregate()` itself serializes 6 boards, the total serialization depth is
8 × 6 = 48 sequential DB call chains (even though the 8 quarters are concurrent).

**Fix:** Add an explicit implementation note to Section 4.1:

> `getDoraAggregate()` MUST parallelize per-board service calls using
> `Promise.all(boardIds.map(id => ...))`. It must NOT inherit the sequential `for...of`
> loop pattern from `getDora()`. Each board's four service calls continue to use their
> internal `Promise.all` as today.

---

**RC-7 — Section 5.1 must specify how the frontend determines which boards are Kanban-type,
rather than hardcoding `'PLAT'`.**

The `sprintModeAvailable` logic checks `selectedBoards[0] !== 'PLAT'`. This breaks if a
second Kanban board is added. `BoardConfig.boardType` is already available via `getBoards()`.

**Fix:** Add to Section 5.1:

> On page mount, call `getBoards()` and build a `Set<string>` of Kanban board IDs:
> ```typescript
> const kanbanBoardIds = new Set(
>   boards.filter(b => b.boardType === 'kanban').map(b => b.boardId)
> )
> ```
> Use this set to drive the `sprintModeAvailable` check and the PLAT chip `disabled` state.
> Cache this in a `useRef` or component-level `useState`; it only needs to be fetched once
> on mount as board configuration is stable between page loads.

---

**RC-8 — Specify the backend's behaviour when `mode=sprints` is requested but `boardId`
contains a Kanban board.**

The frontend prevents this via UI, but the backend endpoint has no guard. If the backend
receives `mode=sprints&boardId=PLAT`, it should either: (a) return HTTP 400 with a message
`"Sprint mode requires a single Scrum board"`, or (b) silently fall back to quarter mode.
The proposal is silent on this.

**Fix:** Add to Section 4.2 under the `getDoraTrend` implementation approach:

> If `mode === 'sprints'` and the resolved `boardId` belongs to a Kanban board (determined
> by `BoardConfig.boardType`), throw `BadRequestException('Sprint trend mode requires a
> Scrum board. PLAT is a Kanban board.')`. Add a corresponding acceptance criterion.

---

### Minor Issues (non-blocking, should be addressed in the same revision)

**MI-1** — Add to Acceptance Criteria: *"When only PLAT is selected and sprint mode is
attempted, an informational message 'PLAT is a Kanban board — please use Quarter mode' is
shown and no API call is made."* (Resolves Open Question 2 in the acceptance criteria.)

**MI-2** — Open Question 10 (current quarter completeness): Add a resolution to Open
Question 3. Specify: *"The `listRecentQuarters(n)` utility includes the current in-progress
quarter as the first element. Incomplete quarters display partial data, which is preferable
to hiding the current period."*

**MI-3** — The amber banner acceptance criterion states *"The banner text references the
specific boards using defaults."* But `OrgCfrResult.anyBoardUsingDefaultConfig` is a
`boolean`. Either change `OrgCfrResult` to include `boardsUsingDefaultConfig: string[]`
(preferred), or change the acceptance criterion to match the boolean-only contract. As
written, the criterion cannot be satisfied with the defined type.

---

---

## Problem Statement

The current `/dora` page (`frontend/src/app/dora/page.tsx`) has several structural problems that
make it insufficient as an actionable engineering health dashboard:

1. **Aggregation is client-side and statistically unsound.** `computeAggregateMetrics()` averages
   the raw metric values across boards (e.g. averaging deploymentsPerDay across all 6 boards).
   This produces a meaningless number: a board with 0 deployments drags down boards with 50.
   The correct aggregate for deployment frequency is a *sum* across boards; for lead time and MTTR
   it is a *pooled median* (merge all data points, then take the median); for CFR it is
   `totalFailures / totalDeployments` across all boards, not an average of percentages.

2. **The `sprint` period type is broken for multi-board views.** When multiple boards are selected,
   the page fetches sprints from only `selectedBoards[0]` (line 270: `firstBoard`), then queries
   all boards using those sprint IDs. Sprint IDs are board-scoped in Jira — they only exist on the
   board they belong to. A PLAT sprint ID does not exist on ACC. The other boards silently fall back
   to the 90-day default window, making the aggregated result nonsensical.

3. **PLAT (Kanban) is structurally incompatible with sprint-period mode.** The existing code does
   not guard against this. When `periodType === 'sprint'` is selected and PLAT is in the board set,
   `getSprints('PLAT')` returns an empty array (Kanban boards have no sprints), causing the time
   series to silently drop PLAT data entirely, with no user-visible indication.

4. **No per-board breakdown is shown.** The spec (BREIF.md) calls for a board-level breakdown table
   below each metric card. Currently the page only shows the aggregate — it is impossible to see
   which board is dragging a metric into the "low" band.

5. **The time-series charts are overloaded with N×M API calls.** For every period (sprint or
   quarter) multiplied by every selected board, a separate `GET /api/metrics/dora` request is made.
   With 6 boards × 8 quarters = 48 serial/parallel requests on page load. This creates a noisy
   waterfall and makes the backend compute the same board configurations 48 times.

6. **No board-type awareness in the UI.** The Kanban board (PLAT) has a fundamentally different
   delivery model (no sprints, continuous flow). Mixing its metrics into a sprint-based aggregate
   without labelling confuses the numbers. Users need to know which board type they are looking at.

7. **Band aggregation uses "worst board wins" logic.** `computeAggregateMetrics()` shows the band
   of the worst-performing board as the aggregate band. While conservative, this hides the
   distribution: it is more useful to show a band for the *organisation* (based on the aggregated
   value) and let users see the per-board distribution below.

---

## Proposed Solution

### Overview

The redesign introduces:

- A **server-side aggregation endpoint** `GET /api/metrics/dora/aggregate` that computes
  statistically correct organisation-level totals in a single round-trip.
- A **time-series endpoint** `GET /api/metrics/dora/trend` that computes multiple periods in one
  request, eliminating the N×M call pattern.
- A **refactored frontend page** with three tiers: org-level hero cards → per-metric trend charts →
  per-board breakdown table.
- **Clear separation between quarter-mode and sprint-mode** — sprint mode only applies to Scrum
  boards; PLAT always uses a date-range window.

### Architecture Diagram

```
Frontend (DoraPage)
│
├── [on mount / filter change]
│     ├── GET /api/metrics/dora/aggregate?boardIds=ACC,BPT,...&quarter=2026-Q1
│     │       → OrgDoraResult  (single period, all metrics, per-board breakdown)
│     │
│     └── GET /api/metrics/dora/trend?boardIds=ACC,BPT,...&periods=quarters&limit=8
│               → TrendResult[]  (N periods, org-level values only)
│
├── Hero section: 4 OrgMetricCards  (aggregate value + band)
├── Trend section: 4 TrendCharts    (org-level value over time)
└── Drill-down section: BoardBreakdownTable (per-board, per-metric)
```

---

## Section 1 — UX/UI Layout

### Page Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│  DORA Metrics                        [Quarter ▾] [2026-Q1 ▾]        │
│  Organisation-wide delivery performance                              │
├─────────────────────────────────────────────────────────────────────┤
│  Boards: [ACC ✓] [BPT ✓] [SPS ✓] [OCS ✓] [DATA ✓] [PLAT ✓]       │
│  Period: (● Quarter) (○ Sprint)   — Sprint mode disables PLAT chip  │
├──────────────┬──────────────┬──────────────┬──────────────┐         │
│ Deployment   │ Lead Time    │ Change       │ MTTR         │         │
│ Frequency    │ for Changes  │ Failure Rate │              │         │
│              │              │              │              │         │
│  3.2 /day    │  4.1 days    │  8.3 %       │  6.2 hrs     │         │
│  [Elite ●]   │  [High ●]    │  [High ●]    │  [High ●]    │         │
│              │              │              │              │         │
│  ▂▄▆▅▇▆▇     │  ▇▅▄▃▂▂▁     │  ▃▄▅▄▂▂▁     │  ▅▄▃▄▂▁▂     │         │
└──────────────┴──────────────┴──────────────┴──────────────┘         │
├─────────────────────────────────────────────────────────────────────┤
│ Trend (last 8 quarters)                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │ Deployment Frequency  │  │ Lead Time for Changes │                 │
│  │  [line chart]         │  │  [line chart]         │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │ Change Failure Rate   │  │ MTTR                  │                 │
│  │  [line chart]         │  │  [line chart]         │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
├─────────────────────────────────────────────────────────────────────┤
│ Board Breakdown — 2026-Q1                                            │
│  Board │ Type    │ Depl/day │ Lead (days) │ CFR %  │ MTTR (hrs) │   │
│  ──────┼─────────┼──────────┼─────────────┼────────┼────────────┤   │
│  ACC   │ Scrum   │ 1.2      │ 3.1 [High]  │ 5% [H] │ 4.0 [High] │   │
│  BPT   │ Scrum   │ 0.8      │ 5.2 [High]  │ 12% [M]│ 8.1 [High] │   │
│  SPS   │ Scrum   │ 0.3      │ 9.1 [Med]   │ 3% [E] │ 2.0 [High] │   │
│  OCS   │ Scrum   │ 0.2      │ 14.0 [Med]  │ 7% [H] │ 48 [Med]   │   │
│  DATA  │ Scrum   │ 0.1      │ 22.0 [Low]  │ 2% [E] │ 0 [n/a]    │   │
│  PLAT  │ Kanban  │ 0.6      │ 6.8 [High]  │ 0% [E] │ 12 [High]  │   │
└─────────────────────────────────────────────────────────────────────┘
```

### Key UX Decisions

**Period selector behaviour:**
- Default mode: **Quarter**, defaulting to the current quarter.
- Sprint mode: enabled only when a *single* Scrum board is selected. If multiple boards are
  selected and the user switches to sprint mode, PLAT chips auto-deselect and a tooltip explains
  why. Sprint dropdown shows only sprints for the selected board.
- Quarter mode: always works for all boards including PLAT. Kanban boards use a date-range window
  aligned to the quarter boundaries.

**Aggregate metric cards:**
- Show a single organisation-level value (see Section 3 for aggregation formulas).
- Band badge reflects the band of the aggregated value, not the worst board.
- A secondary line beneath the value shows `n boards contributing` so users know the sample size.
- Trend sparkline shows the org-level value over the last 8 periods.

**Board breakdown table:**
- Always visible (not collapsed by default).
- Board type shown as a small badge: `Scrum` or `Kanban`.
- Cells show the metric value + a small `BandBadge` inline.
- A `—` is shown instead of `0` when a metric has no data (e.g. PLAT MTTR if no incidents).
- Rows sort by worst aggregate performance (most "red" at the top) by default, sortable by column.

**No per-board trend charts:**
The per-board trend adds cognitive load without proportional value for a multi-board aggregate
view. Users who want to investigate a specific board can click into the board's row to navigate
to the existing per-board Planning/Sprint views. A future proposal can add drill-down pages.

---

## Section 2 — Metric Definitions

All calculations use existing entity data already in PostgreSQL.

### Deployment Frequency

**Scope:** Issues that reached a "done" state (transition to `doneStatusNames`) OR issues with a
`fixVersion` whose `releaseDate` falls within the window. Uses the same dual-signal logic already
in `DeploymentFrequencyService.calculate()`.

**Per-board output:** `totalDeployments`, `deploymentsPerDay`, `periodDays`, `band`

**Org-level aggregation:**
```
orgDeploymentsPerDay = SUM(totalDeployments across all boards) / periodDays
```
Period days is the same for all boards (the selected quarter or date window), so the denominator
is a constant. This is a *sum*, not an average — deploying on 6 boards is genuinely more frequent
than deploying on 1.

**Kanban (PLAT) compatibility:** No change needed. The existing fallback (done transitions in
date range) already works for Kanban. Quarter-aligned date ranges are used for PLAT when
quarter-mode is selected.

---

### Lead Time for Changes

**Scope:** Issues with a `startTime` (first "In Progress" transition, or `createdAt` for Scrum
fallback) and an `endTime` (done transition or fixVersion releaseDate) within the selected window.

**Per-board output:** `medianDays`, `p95Days`, `sampleSize`, `band`

**Org-level aggregation:**
```
orgMedianDays = percentile_50 over ALL lead-time observations from ALL boards
```
This is the **pooled median** — all individual lead-time day values from all boards are merged
into one array, then median and p95 are computed. This correctly models "if a randomly-picked
change came from anywhere in the organisation, how long did it take?"

**Current state vs proposed:**
- Current: `computeAggregateMetrics()` averages the per-board medians (`avgValue`). This is the
  mean-of-medians, a statistically invalid estimator.
- Proposed: The backend `aggregate` endpoint returns the pooled median. The frontend receives a
  single pre-computed value.

**Kanban (PLAT) compatibility:** `LeadTimeService.calculate()` already handles Kanban by skipping
issues with no "In Progress" transition (`isKanban = true` path). No change needed.

---

### Change Failure Rate

**Per-board output:** `totalDeployments`, `failureCount`, `changeFailureRate` (%), `band`,
`usingDefaultConfig`

**Org-level aggregation:**
```
orgCFR = SUM(failureCount across all boards) / SUM(totalDeployments across all boards) * 100
```
This is the correct formula — ratio of sums, not average of ratios.

**Current state vs proposed:**
- Current: `computeAggregateMetrics()` averages the `changeFailureRate` percentages. A board with
  0 deployments and 0% CFR incorrectly dilutes the aggregate toward 0%.
- Proposed: The backend computes the correct org-level ratio.

**Note on `usingDefaultConfig`:** The existing `usingDefaultConfig: boolean` flag on CfrResult
should be exposed at the org level as `anyBoardUsingDefaultConfig: boolean`. The amber warning
banner in the current UI should be retained.

---

### Mean Time to Recovery (MTTR)

**Per-board output:** `medianHours`, `incidentCount`, `band`

**Org-level aggregation:**
```
orgMttrMedianHours = percentile_50 over ALL recovery-hour observations from ALL boards
```
Same pooled-median approach as lead time. A board with `incidentCount === 0` contributes no data
points and therefore does not distort the aggregate with a 0-hour "phantom recovery".

**Current state vs proposed:**
- Current: Averages the per-board `medianHours` values. A board with 0 incidents gets a 0-hour
  median which drags the average toward zero, making the org look falsely Elite.
- Proposed: Backend pools all observations; boards with 0 incidents simply contribute nothing.

---

## Section 3 — DORA Performance Bands

These match the DORA/Accelerate research (2019 State of DevOps report) and are **already
correctly implemented** in `backend/src/metrics/dora-bands.ts` and
`frontend/src/lib/dora-bands.ts`. No changes needed.

| Metric | Elite | High | Medium | Low |
|---|---|---|---|---|
| Deployment Frequency | ≥ 1/day (on-demand) | Weekly–daily | Monthly–weekly | < monthly |
| Lead Time for Changes | < 1 day | 1 day – 1 week | 1 week – 1 month | > 1 month |
| Change Failure Rate | ≤ 5% | 5–10% | 10–15% | > 15% |
| MTTR | < 1 hour | < 1 day | < 1 week | > 1 week |

**Implementation note:** The `dora-bands.ts` files on frontend and backend are duplicated (as
documented in ADR-0007). Both use the exact same thresholds. This is intentional and acceptable
for a single-user internal tool; no shared package is needed.

---

## Section 4 — Backend Changes

### 4.1 New Endpoint: `GET /api/metrics/dora/aggregate`

**Purpose:** Returns org-level aggregated DORA metrics for a single period, plus per-board
breakdown data in one round-trip.

**Query params:** Same `MetricsQueryDto` shape (`boardId`, `period`, `quarter`, `sprintId`).
The `boardId` param accepts comma-separated IDs as today.

**Response shape** (new `OrgDoraResponseDto`):

```typescript
// backend/src/metrics/dto/org-dora-response.dto.ts
export interface OrgDoraResult {
  period: { start: string; end: string }
  orgDeploymentFrequency: OrgDeploymentFrequencyResult   // sum-based
  orgLeadTime:            OrgLeadTimeResult              // pooled median
  orgChangeFailureRate:   OrgCfrResult                   // ratio of sums
  orgMttr:                OrgMttrResult                  // pooled median
  boardBreakdowns:        DoraMetricsResult[]            // existing per-board shape
  anyBoardUsingDefaultConfig: boolean
}

export interface OrgDeploymentFrequencyResult {
  totalDeployments: number
  deploymentsPerDay: number
  band: DoraBand
  periodDays: number
  contributingBoards: number
}

export interface OrgLeadTimeResult {
  medianDays: number
  p95Days: number
  band: DoraBand
  sampleSize: number
  contributingBoards: number
}

export interface OrgCfrResult {
  totalDeployments: number
  failureCount: number
  changeFailureRate: number
  band: DoraBand
  contributingBoards: number
  anyBoardUsingDefaultConfig: boolean
}

export interface OrgMttrResult {
  medianHours: number
  band: DoraBand
  incidentCount: number
  contributingBoards: number
}
```

**Implementation approach:**
- Add a new method `getDoraAggregate(query: MetricsQueryDto): Promise<OrgDoraResult>` to
  `MetricsService` (`backend/src/metrics/metrics.service.ts`).
- This method calls `getDora(query)` internally (which already runs all 4 per-board metrics in
  parallel via `Promise.all`), then applies the org-level aggregation formulas to produce the
  `OrgDoraResult`.
- For the pooled-median metrics (lead time, MTTR), `LeadTimeService` and `MttrService` will need
  to expose a new method that returns the raw observation arrays (not just the median), so the
  aggregation layer can pool them. See Section 4.3.

**Controller change** (`backend/src/metrics/metrics.controller.ts`):

```typescript
@Get('dora/aggregate')
async getDoraAggregate(@Query() query: MetricsQueryDto): Promise<OrgDoraResult> {
  return this.metricsService.getDoraAggregate(query);
}
```

> **Route ordering note:** `dora/aggregate` must be declared **before** any parameterised routes
> to avoid NestJS treating `aggregate` as a route param. In the current controller there are no
> parameterised DORA routes, so this is safe.

---

### 4.2 New Endpoint: `GET /api/metrics/dora/trend`

**Purpose:** Returns org-level metric values for N consecutive periods in a single request,
replacing the current N×M fan-out pattern.

**Query params:**

```typescript
// Extend MetricsQueryDto or create a new TrendQueryDto
export class TrendQueryDto {
  @IsOptional() @IsString() boardIds?: string   // comma-separated, default all boards
  @IsOptional() @IsString() mode?: 'quarters' | 'sprints'   // default: quarters
  @IsOptional() @IsInt()    limit?: number       // default: 8, max: 20
  @IsOptional() @IsString() boardId?: string    // for sprint mode: single board
}
```

**Response shape:**

```typescript
export interface TrendPoint {
  label: string                // e.g. "2026-Q1" or "Sprint 42"
  start: string                // ISO date
  end: string                  // ISO date
  deploymentsPerDay: number
  medianLeadTimeDays: number
  changeFailureRate: number
  mttrMedianHours: number
  orgBands: {
    deploymentFrequency: DoraBand
    leadTime: DoraBand
    changeFailureRate: DoraBand
    mttr: DoraBand
  }
}

export type TrendResponse = TrendPoint[]
```

**Implementation approach:**
- Add `getDoraTrend(query: TrendQueryDto): Promise<TrendResponse>` to `MetricsService`.
- For `mode === 'quarters'`: enumerate quarters using the existing `quarterToDates()` helper
  (add a `listRecentQuarters(n: number)` utility), compute `getDoraAggregate` for each quarter,
  return only the scalar values needed for charts (not the full per-board breakdown).
- For `mode === 'sprints'`: requires a single `boardId`. List the last `limit` closed sprints from
  `JiraSprint` for that board, compute per-board metrics for each sprint, return trend points.
- All periods are computed in parallel via `Promise.all`.

**Controller addition:**

```typescript
@Get('dora/trend')
async getDoraTrend(@Query() query: TrendQueryDto): Promise<TrendResponse> {
  return this.metricsService.getDoraTrend(query);
}
```

---

### 4.3 Service Changes for Pooled Aggregation

`LeadTimeService` and `MttrService` currently only return summary statistics (median, p95). To
support pooled org-level medians, they need internal methods that return the raw observation
arrays. The approach: extract the observation-collection logic into a private method that returns
`number[]`, and call it from both the existing `calculate()` method and the new aggregation path.

**`LeadTimeService` addition:**

```typescript
// Returns raw lead-time-days array (not yet sorted/statted)
async getLeadTimeObservations(
  boardId: string,
  startDate: Date,
  endDate: Date,
): Promise<number[]>
```

**`MttrService` addition:**

```typescript
// Returns raw recovery-hours array
async getMttrObservations(
  boardId: string,
  startDate: Date,
  endDate: Date,
): Promise<number[]>
```

`MetricsService.getDoraAggregate()` calls `getLeadTimeObservations()` and
`getMttrObservations()` for each board, concatenates the arrays, and computes the pooled
percentiles using the existing `percentile()` function (currently private in each service —
extract it to a shared `backend/src/metrics/statistics.ts` utility).

**New shared utility `backend/src/metrics/statistics.ts`:**

```typescript
export function percentile(sorted: number[], p: number): number { ... }
export function round2(n: number): number { ... }
```

These are currently duplicated identically in `lead-time.service.ts` (lines 180–190) and
`mttr.service.ts` (lines 165–172). Extracting them eliminates the duplication and makes them
available to `MetricsService`.

---

### 4.4 Existing Endpoints — No Breaking Changes

The existing `GET /api/metrics/dora` endpoint and its per-metric siblings are **retained
unchanged**. They are still useful for per-board queries (e.g. Sprint Detail view) and are
already consumed correctly in parts of the codebase. The new `/aggregate` and `/trend` endpoints
are additive.

The `MetricsQueryDto` is not changed; no migration of existing callers is required.

---

## Section 5 — Frontend Changes

### 5.1 Page Restructure (`frontend/src/app/dora/page.tsx`)

The existing file is fully replaced. Key structural changes:

**State model:**

```typescript
// Replace the current local useState rats-nest with two clean fetch states
type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; aggregate: OrgDoraResult; trend: TrendPoint[] }
```

**Two API calls per filter change** (instead of N×M):
1. `GET /api/metrics/dora/aggregate` → populates hero cards + breakdown table
2. `GET /api/metrics/dora/trend` → populates trend charts

Both fire in parallel via `Promise.all` when filters change.

**Period mode logic:**
```typescript
// Sprint mode is only valid for a single Scrum board
const sprintModeAvailable = selectedBoards.length === 1 &&
  selectedBoards[0] !== 'PLAT'

// When sprint mode becomes unavailable, reset to quarter
useEffect(() => {
  if (!sprintModeAvailable && periodType === 'sprint') {
    setPeriodType('quarter')
  }
}, [sprintModeAvailable, periodType, setPeriodType])
```

When `periodType === 'sprint'`, the PLAT chip is rendered with `disabled={true}` (already
supported by `BoardChip` component) and a tooltip `"Sprint period not available for Kanban boards"`.

**Trend API call for sprint mode:**
When `periodType === 'sprint'`, pass `mode: 'sprints'` and `boardId: selectedBoards[0]` to
`GET /api/metrics/dora/trend`. Sprint mode on the trend endpoint is scoped to a single board.

---

### 5.2 New Components

**`OrgMetricCard`** (`frontend/src/components/ui/org-metric-card.tsx`)

Extends the existing `MetricCard` concept with additional context:

```typescript
interface OrgMetricCardProps {
  title: string
  value: number
  unit: string
  band: DoraBand
  sparkline: number[]          // org-level values from TrendPoint[]
  contributingBoards: number
  noDataBoards?: number        // boards with sampleSize === 0
}
```

Renders: value + unit, `BandBadge`, sparkline (reusing the existing `Sparkline` sub-component
from `metric-card.tsx`), and a footer line `"6 boards contributing"` or
`"4 of 6 boards have data"`. Uses existing `BandBadge` and `bandColor` from `dora-bands.ts`.

**`BoardBreakdownTable`** (`frontend/src/components/ui/board-breakdown-table.tsx`)

```typescript
interface BoardBreakdownTableProps {
  boardBreakdowns: DoraMetricsBoard[]  // from OrgDoraResult.boardBreakdowns
  period: { start: string; end: string }
}
```

Renders an HTML `<table>` using the existing `DataTable` foundation. Each row shows:
- Board ID (bold)
- Board type badge (`Scrum` / `Kanban`) — sourced from `boardBreakdowns[].boardId` matched
  against the boards list from `getBoards()`; cache the board type map in local state
- Deployment Frequency: `deploymentsPerDay.toFixed(2)` + inline `BandBadge`
- Lead Time: `medianDays.toFixed(1) days` + inline `BandBadge`
- CFR: `changeFailureRate.toFixed(1)%` + inline `BandBadge`
- MTTR: `medianHours.toFixed(1) hrs` + inline `BandBadge`, or `—` if `incidentCount === 0`

Column headers are clickable to sort. Default sort: by lead time descending (worst first).

The table should also surface the `usingDefaultConfig` warning inline per row rather than only
as a page-level banner.

---

### 5.3 API Client Changes (`frontend/src/lib/api.ts`)

Add two new typed wrappers:

```typescript
export interface OrgDeploymentFrequencyResult {
  totalDeployments: number
  deploymentsPerDay: number
  band: DoraBand
  periodDays: number
  contributingBoards: number
}

export interface OrgLeadTimeResult {
  medianDays: number
  p95Days: number
  band: DoraBand
  sampleSize: number
  contributingBoards: number
}

export interface OrgCfrResult {
  totalDeployments: number
  failureCount: number
  changeFailureRate: number
  band: DoraBand
  contributingBoards: number
  anyBoardUsingDefaultConfig: boolean
}

export interface OrgMttrResult {
  medianHours: number
  band: DoraBand
  incidentCount: number
  contributingBoards: number
}

export interface OrgDoraResult {
  period: { start: string; end: string }
  orgDeploymentFrequency: OrgDeploymentFrequencyResult
  orgLeadTime: OrgLeadTimeResult
  orgChangeFailureRate: OrgCfrResult
  orgMttr: OrgMttrResult
  boardBreakdowns: DoraMetricsBoard[]
  anyBoardUsingDefaultConfig: boolean
}

export interface TrendPoint {
  label: string
  start: string
  end: string
  deploymentsPerDay: number
  medianLeadTimeDays: number
  changeFailureRate: number
  mttrMedianHours: number
  orgBands: {
    deploymentFrequency: DoraBand
    leadTime: DoraBand
    changeFailureRate: DoraBand
    mttr: DoraBand
  }
}

export type TrendResponse = TrendPoint[]

export interface DoraAggregateParams {
  boardIds?: string      // comma-separated
  quarter?: string
  sprintId?: string
  period?: string
}

export interface DoraTrendParams {
  boardIds?: string
  mode?: 'quarters' | 'sprints'
  limit?: number
  boardId?: string       // required for sprint mode
}

export function getDoraAggregate(params: DoraAggregateParams): Promise<OrgDoraResult> {
  return apiFetch(
    `/api/metrics/dora/aggregate${toQueryString({
      boardId: params.boardIds,
      quarter: params.quarter,
      sprintId: params.sprintId,
      period: params.period,
    })}`,
  )
}

export function getDoraTrend(params: DoraTrendParams): Promise<TrendResponse> {
  return apiFetch(
    `/api/metrics/dora/trend${toQueryString({
      boardIds: params.boardIds,
      mode: params.mode,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      boardId: params.boardId,
    })}`,
  )
}
```

The existing `getDoraMetrics()` function is **not removed** — it is still used by the Sprint
Detail page and any future per-board views.

---

### 5.4 Zustand Store Changes (`frontend/src/store/filter-store.ts`)

The `FilterState` interface already has `selectedBoards`, `periodType`, `selectedSprint`, and
`selectedQuarter`. No new state slices are required for the core redesign.

One **behavioural change**: `selectedBoards` defaults to all boards (already the case), and the
store should expose a `setAllBoards()` convenience action that restores the default, useful for
a "Reset" button in the filter bar:

```typescript
setAllBoards: () => set({ selectedBoards: ALL_BOARDS })
```

---

## Section 6 — Data Model Changes

**No new database tables or columns are required.** The existing entities already contain all
the data needed to support the new aggregation logic:

| Entity | Sufficiency |
|---|---|
| `JiraIssue` | ✓ Has `boardId`, `issueType`, `labels`, `priority`, `fixVersion`, `status` |
| `JiraChangelog` | ✓ Has `issueKey`, `field`, `toValue`, `changedAt` |
| `JiraVersion` | ✓ Has `projectKey`, `releaseDate`, `released` |
| `JiraSprint` | ✓ Has `boardId`, `state`, `startDate`, `endDate` |
| `BoardConfig` | ✓ Has `boardType`, `doneStatusNames`, all failure/incident config |

The pooled-median approach works entirely in application memory — `LeadTimeService` and
`MttrService` already load all relevant observations into arrays. The new
`getLeadTimeObservations()` / `getMttrObservations()` methods are pure code extractions, not
schema changes.

**Indexing recommendation (no migration required, can be applied manually or in a separate
performance migration):**

The current `jira_changelogs` table already has a composite index (added in migration
`1775795358706-AddChangelogIndex.ts`). Verify this index covers `(issueKey, field, changedAt)`.
If the trend endpoint proves slow for 8-period queries, an additional index on
`jira_issues(boardId, issueType)` and `jira_issues(boardId, fixVersion)` would help.

---

## Section 7 — Migration Path

The migration is additive and non-breaking. There is no flag day.

### Phase 1 — Backend (no frontend changes yet)

1. Extract `percentile()` and `round2()` into `backend/src/metrics/statistics.ts`.
   Update `lead-time.service.ts` and `mttr.service.ts` to import from it.
   *Tests pass as before; this is a pure refactor.*

2. Add `getLeadTimeObservations()` to `LeadTimeService` and `getMttrObservations()` to
   `MttrService` by extracting the observation-collection loop from the existing `calculate()`
   methods. The existing `calculate()` calls the new method and computes stats from it.
   *Existing unit tests continue to pass.*

3. Add `getDoraAggregate()` and `getDoraTrend()` to `MetricsService`.
   Add the two new controller routes to `MetricsController`.
   *Existing `GET /api/metrics/dora` is unchanged.*

4. Add unit tests for both new methods in `metrics.service.spec.ts` (new file — currently no
   service-level spec exists for MetricsService itself).

5. Deploy backend. Existing frontend continues to call `GET /api/metrics/dora` as before.

### Phase 2 — Frontend

6. Add `OrgDoraResult`, `TrendPoint`, `getDoraAggregate()`, `getDoraTrend()` types and
   wrappers to `frontend/src/lib/api.ts`.

7. Implement `OrgMetricCard` component. Write Vitest tests.

8. Implement `BoardBreakdownTable` component. Write Vitest tests.

9. Replace `frontend/src/app/dora/page.tsx` with the new layout. The old
   `computeAggregateMetrics()` helper and `buildTimeSeriesPoint()` are removed; their
   responsibilities move to the backend.

10. Update `filter-store.ts` with `setAllBoards()`.

11. QA: verify quarter mode with all 6 boards, sprint mode with a single Scrum board, PLAT
    chip auto-disabling in sprint mode, empty-state handling when no boards are selected.

---

## Alternatives Considered

### Alternative A — Fix the existing client-side aggregation

Keep the existing N×M API call pattern and `GET /api/metrics/dora`. Fix only the aggregation
formulas in `computeAggregateMetrics()`: use sum for deployment frequency, ratio-of-sums for
CFR, and pooled medians for lead time and MTTR.

**Why ruled out:** The pooled median requires the raw observation arrays, which the existing API
does not return (it only returns computed summaries per board). Returning raw arrays over the wire
for all boards × all periods would be large and wasteful. The fundamental N×M call pattern (48
requests for 8 quarters × 6 boards) remains a UX and backend load problem regardless of formula
correctness.

### Alternative B — Single new endpoint returning everything for all periods

One endpoint `GET /api/metrics/dora/all-periods` that returns aggregate + trend for all available
quarters in a single call.

**Why ruled out:** Unbounded response size. If the project accumulates 3 years of quarterly data
and 200+ sprints, this endpoint returns a large payload every page load. The split into `/aggregate`
(current period, full detail) and `/trend` (N periods, scalar values only) balances payload size
against round-trips better.

### Alternative C — Move all aggregation to a separate `AggregationModule`

Create a new NestJS module that imports `MetricsModule` and provides `AggregationService`.

**Why ruled out:** Adds a layer of indirection for minimal benefit at this scale. `MetricsService`
already orchestrates the four sub-services; aggregation is a natural extension of that
orchestration responsibility. A separate module would require exporting `LeadTimeService` and
`MttrService` from `MetricsModule`, which increases the public surface area. The simpler path is
to add aggregation methods to the existing `MetricsService`.

### Alternative D — Store pre-computed aggregates in PostgreSQL

After each sync, compute and cache the org-level DORA metrics in a new `dora_snapshots` table.

**Why ruled out:** Premature optimisation. The current sync runs every 30 minutes for 6 boards.
On-demand computation at query time is sufficient for a single-user internal tool. A snapshot
table adds migration complexity, cache invalidation concerns, and a sync dependency. This can be
revisited if query times become unacceptable (>2s) with real data volumes.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No new entities or columns. Optional new indexes are non-breaking. |
| API contract | Additive only | Two new endpoints added. Existing endpoints unchanged. |
| Frontend | Page refactored, 2 new components | `dora/page.tsx` fully replaced. `api.ts` extended. |
| Tests | New unit + integration tests | `metrics.service.spec.ts` (new), `org-metric-card.test.tsx` (new), `board-breakdown-table.test.tsx` (new). Existing tests unchanged. |
| Jira API | No new calls | All data already in PostgreSQL from existing sync. |
| Performance | Improved | N×M requests (up to 48) → 2 requests per page load. |

---

## Open Questions

1. **Sprint mode + multi-board aggregation:** When a user selects 2 Scrum boards and sprint
   mode, which board's sprints are shown in the dropdown? The proposal disables sprint mode for
   multi-board selection, but the user may want to compare a specific sprint window across boards.
   Accept the restriction for now; a future proposal can introduce date-range mode as a third
   period type that works across all boards.

2. **PLAT in sprint trend:** The trend endpoint in sprint mode is scoped to a single board.
   If a user selects only PLAT and chooses sprint mode, the UI blocks it. Should we silently fall
   back to quarter mode for PLAT, or show an empty state with an explanation? Proposed resolution:
   show an informational message "PLAT is a Kanban board — please use Quarter mode" and display
   no data, rather than silently switching modes.

3. **`listRecentQuarters(n)` utility:** This function needs to enumerate the N most recent
   quarters ending at or before today, e.g. `['2026-Q1', '2025-Q4', '2025-Q3', ...]`. It should
   use the existing `quarterToDates()` helper in `MetricsService`. Should this utility live in
   `MetricsService` (private) or be extracted to a shared `backend/src/metrics/period-utils.ts`?
   Recommend `period-utils.ts` as it will also be useful for the trend endpoint.

4. **Trend limit and performance:** The default limit of 8 quarters means the trend endpoint
   calls `getDoraAggregate` 8 times in parallel. Each call runs 4 per-board calculations ×
   6 boards = 24 DB query chains. With real data, this is 8 × 24 = 192 sequential DB operations
   (though executed in parallel per quarter). Is this acceptable? Needs profiling with real data.
   The Phase 1 deployment will allow performance measurement before Phase 2 ships.

5. **Board type information in breakdown table:** `DoraMetricsBoard` does not currently include
   `boardType`. The `BoardBreakdownTable` component needs to know whether each board is Scrum or
   Kanban to display the type badge. Options: (a) include `boardType` in `boardBreakdowns[]` by
   joining `BoardConfig` in the aggregate endpoint, or (b) have the frontend call `getBoards()`
   separately. Option (a) is cleaner — the backend should include `boardType` in the response to
   avoid a second round-trip.

---

## Acceptance Criteria

- [ ] `GET /api/metrics/dora/aggregate` returns `OrgDoraResult` with all four org-level metrics
      computed using the correct formulas (sum, pooled median, ratio-of-sums) as defined in
      Section 2. Verified by unit tests in `metrics.service.spec.ts`.

- [ ] `GET /api/metrics/dora/trend` returns an array of `TrendPoint` objects for the requested
      number of periods. Quarter mode returns up to the requested limit of past quarters;
      sprint mode is restricted to a single `boardId`. Verified by unit tests.

- [ ] The existing `GET /api/metrics/dora` endpoint is unchanged and continues to return the
      same response shape as before. Existing tests continue to pass.

- [ ] `percentile()` and `round2()` are extracted to `statistics.ts` and the duplication in
      `lead-time.service.ts` and `mttr.service.ts` is removed.

- [ ] `LeadTimeService.getLeadTimeObservations()` and `MttrService.getMttrObservations()` exist
      and are exercised by the aggregate service. The existing `calculate()` methods delegate to
      these new methods, preserving their output.

- [ ] The DORA page makes exactly 2 API calls per filter change (aggregate + trend), not N×M.
      Verifiable via browser Network tab.

- [ ] `OrgMetricCard` renders `contributingBoards` count and shows a sparkline from
      `TrendPoint[]` data. Board count is correct (e.g. "6 boards" not "5 boards") when all
      boards are selected. Verified by Vitest component test.

- [ ] `BoardBreakdownTable` renders one row per board with correct metric values and inline band
      badges. The `—` placeholder is shown for MTTR when `incidentCount === 0`. Verified by
      Vitest component test.

- [ ] In sprint mode, the PLAT chip is `disabled` and a tooltip explains why. Switching from
      multi-board to single-board does not clear the selected sprint. Verified manually.

- [ ] In quarter mode, selecting all 6 boards (including PLAT) shows PLAT data in the breakdown
      table correctly (Kanban fallback logic applies). Verified manually.

- [ ] An amber banner is shown when `anyBoardUsingDefaultConfig === true`, matching the existing
      warning behaviour. The banner text references the specific boards using defaults.

- [ ] The `filter-store.ts` `setAllBoards()` action restores `selectedBoards` to `ALL_BOARDS`.
      Verified by unit test in `stores.test.ts`.
