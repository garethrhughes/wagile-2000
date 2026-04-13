# 0022 — Sprint Report

**Date:** 2026-04-13
**Status:** Proposed
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

The application calculates seven distinct metric dimensions for Scrum boards
(DORA×4 + delivery rate, scope stability, roadmap coverage), but there is no
view that combines them into a single, sprint-scoped verdict.  When a sprint
closes, an engineering lead must open four separate pages, correlate data
across different time windows, and form their own qualitative assessment.
There is no persistent record of how a sprint performed, and no mechanism to
surface actionable recommendations automatically.

The Sprint Detail page (`/sprint/[boardId]/[sprintId]`) already provides the
raw per-issue breakdown but stops short of aggregation and diagnosis.  This
proposal defines a **Sprint Report** feature that:

1. Aggregates all metric dimensions into a composite 0–100 score per closed sprint.
2. Persists the computed report in Postgres so it can be loaded instantly without
   re-running seven independent calculation pipelines.
3. Produces deterministic, rule-based textual recommendations per dimension.
4. Shows trend context against the previous N sprints on the same board.
5. Can be triggered on demand or automatically when a sprint transitions to `closed`.

This proposal does **not** change existing entity schemas, migration files,
service method signatures, the `BoardConfig` entity, or introduce AI/LLM calls.

---

## Proposed Solution

### 1. Architecture Overview

```
SprintReportController  (backend/src/sprint-report/sprint-report.controller.ts)
        │
        └── SprintReportService  (sprint-report.service.ts)
                │
                ├── SprintDetailService        (existing — sprint/sprint-detail.service.ts)
                ├── PlanningService            (existing — planning/planning.service.ts)
                ├── RoadmapService             (existing — roadmap/roadmap.service.ts)
                ├── MetricsService             (existing — metrics/metrics.service.ts)
                ├── ScoringService             (new — sprint-report/scoring.service.ts)
                └── RecommendationService      (new — sprint-report/recommendation.service.ts)

Persisted to:
        SprintReport entity  (database/entities/sprint-report.entity.ts)
        Table: sprint_reports
```

**Design rules:**
- `SprintReportService` is the single orchestration point.  It calls existing
  services and does not duplicate their calculation logic.
- `ScoringService` is a pure stateless service: given raw metric values it
  returns dimension scores and a composite.  No DB access.
- `RecommendationService` is a pure stateless service: given dimension scores
  and raw metric values it returns recommendation objects.  No DB access.
- No existing service signatures are modified.
- All Jira data continues to come from Postgres via existing services.

---

### 2. Scoring Model

#### 2.1 Band-to-Score Mapping

DORA dimensions reuse the four-band classification already in `dora-bands.ts`.
The band maps to a fixed score:

| Band | Score |
|---|---|
| `elite` | 100 |
| `high` | 75 |
| `medium` | 50 |
| `low` | 25 |

This gives a score that is **monotonically consistent** with the DORA thresholds
already displayed elsewhere in the app.  Using linear interpolation within bands
was considered (see §Alternatives) but rejected: it creates a perception that a
value barely inside the "low" band scores nearly the same as "medium", which
contradicts the intent of the band boundary.

#### 2.2 Non-DORA Dimension Scoring

For the three planning dimensions that have no pre-existing band, piecewise
linear interpolation is used with explicit breakpoints chosen to align
intuitively with "acceptable" and "good" thresholds.

**Delivery Rate** (`deliveryRate = completedInSprintCount / inScopeCount`)
where `inScopeCount = committedCount + addedMidSprintCount - removedCount`.

| Raw value | Score |
|---|---|
| `inScopeCount == 0` | 50 (neutral — no data) |
| `deliveryRate >= 1.0` | 100 |
| `deliveryRate >= 0.8` | 75 + (rate − 0.8) / 0.2 × 25 → linear 75–100 |
| `deliveryRate >= 0.5` | 25 + (rate − 0.5) / 0.3 × 50 → linear 25–75 |
| `deliveryRate < 0.5` | rate / 0.5 × 25 → linear 0–25 |

Simplified breakpoints for implementation:

```typescript
function scoreDeliveryRate(rate: number, inScopeCount: number): number {
  if (inScopeCount === 0) return 50;
  const r = Math.max(0, Math.min(1, rate));
  if (r >= 1.0) return 100;
  if (r >= 0.8) return 75 + ((r - 0.8) / 0.2) * 25;
  if (r >= 0.5) return 25 + ((r - 0.5) / 0.3) * 50;
  return (r / 0.5) * 25;
}
```

**Scope Stability** (`scopeChangeRatio = (addedMidSprintCount + removedCount) / committedCount`)

| Condition | Score |
|---|---|
| `committedCount == 0` | 50 (neutral) |
| `scopeChangeRatio <= 0.10` | 100 |
| `scopeChangeRatio <= 0.25` | 75 − (ratio − 0.10) / 0.15 × 25 → linear 75–50 |
| `scopeChangeRatio <= 0.50` | 50 − (ratio − 0.25) / 0.25 × 25 → linear 50–25 |
| `scopeChangeRatio > 0.50` | max(0, 25 − (ratio − 0.50) / 0.50 × 25) → linear 25–0 |

```typescript
function scoreScopeStability(added: number, removed: number, committed: number): number {
  if (committed === 0) return 50;
  const ratio = (added + removed) / committed;
  if (ratio <= 0.10) return 100;
  if (ratio <= 0.25) return 75 - ((ratio - 0.10) / 0.15) * 25;
  if (ratio <= 0.50) return 50 - ((ratio - 0.25) / 0.25) * 25;
  return Math.max(0, 25 - ((ratio - 0.50) / 0.50) * 25);
}
```

**Roadmap Coverage** (`roadmapCoverage` = % of in-sprint issues linked to a roadmap idea)

| Raw value | Score |
|---|---|
| `totalIssues == 0` | 50 (neutral) |
| `coverage >= 80%` | 100 |
| `coverage >= 50%` | 50 + (coverage − 50) / 30 × 50 → linear 50–100 |
| `coverage < 50%` | coverage / 50 × 50 → linear 0–50 |

```typescript
function scoreRoadmapCoverage(coverage: number, totalIssues: number): number {
  if (totalIssues === 0) return 50;
  const c = Math.max(0, Math.min(100, coverage));
  if (c >= 80) return 100;
  if (c >= 50) return 50 + ((c - 50) / 30) * 50;
  return (c / 50) * 50;
}
```

#### 2.3 Composite Score and Weights

Seven dimensions, weights summing to 100:

| # | Dimension | Input signal | Score fn | Weight |
|---|---|---|---|---|
| 1 | Delivery Rate | `completedInSprint / inScope` | `scoreDeliveryRate` | **25** |
| 2 | Scope Stability | `(added + removed) / committed` | `scoreScopeStability` | **15** |
| 3 | Roadmap Coverage | `roadmapCoverage %` (from `RoadmapService`) | `scoreRoadmapCoverage` | **10** |
| 4 | Lead Time | `medianLeadTimeDays` → `classifyLeadTime` → band score | band-to-score | **20** |
| 5 | Deployment Frequency | `deploymentsPerDay` → `classifyDeploymentFrequency` | band-to-score | **10** |
| 6 | Change Failure Rate | `changeFailureRate %` → `classifyChangeFailureRate` | band-to-score | **10** |
| 7 | MTTR | `medianHours` → `classifyMTTR` | band-to-score | **10** |

**Total weight: 100**

**Rationale for weighting:**
- Delivery Rate (25) is the primary sprint health signal — did the team deliver
  what it committed to?
- Lead Time (20) is the strongest DORA predictor of overall engineering
  effectiveness and is evaluated at the sprint level.
- Scope Stability (15) is a leading indicator of planning quality.
- Roadmap Coverage (10), Deployment Frequency (10), CFR (10), and MTTR (10)
  are equally weighted contextual signals.  DORA metrics at sprint granularity
  have higher noise than at quarter granularity, so they are kept at parity
  rather than dominating.

**Composite formula:**

```typescript
compositeScore = round(
  deliveryScore    * 0.25 +
  stabilityScore   * 0.15 +
  roadmapScore     * 0.10 +
  leadTimeScore    * 0.20 +
  dfScore          * 0.10 +
  cfrScore         * 0.10 +
  mttrScore        * 0.10,
  1  // round to 1 dp
);
```

**Composite bands** (for display colour):

| Range | Label |
|---|---|
| ≥ 80 | `'strong'` |
| ≥ 60 | `'good'` |
| ≥ 40 | `'fair'` |
| < 40 | `'needs-attention'` |

These four labels are introduced for the Sprint Report only and are distinct from
`DoraBand` to avoid coupling.  They live in `sprint-report/sprint-report-bands.ts`.

---

### 3. Recommendations Engine

`RecommendationService` evaluates a set of rules against the computed dimension
scores and the underlying raw metric values.  Each rule is a plain object:

```typescript
interface RecommendationRule {
  id: string;           // stable identifier for deduplication
  dimension: SprintReportDimension;
  severity: 'info' | 'warning' | 'critical';
  condition: (ctx: RecommendationContext) => boolean;
  message: (ctx: RecommendationContext) => string;
}

interface RecommendationContext {
  // Raw metric values
  deliveryRate: number;
  inScopeCount: number;
  committedCount: number;
  addedMidSprintCount: number;
  removedCount: number;
  roadmapCoverage: number;     // 0–100
  medianLeadTimeDays: number | null;
  deploymentsPerDay: number;
  changeFailureRate: number;
  medianMttrHours: number;
  // Computed scores
  scores: SprintDimensionScores;
  // Previous sprint context (null if no previous sprint)
  previousScores: SprintDimensionScores | null;
}
```

Rules are evaluated in order; all matching rules are returned (not just the first).
The output list is sorted: `critical` first, then `warning`, then `info`.

#### 3.1 Rule Definitions

**Dimension 1 — Delivery Rate**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `DR-001` | `critical` | `deliveryRate < 0.5 && inScopeCount > 0` | "Only {pct}% of in-scope work was completed. Review whether the sprint was over-committed or blocked by unplanned work." |
| `DR-002` | `warning` | `deliveryRate >= 0.5 && deliveryRate < 0.7 && inScopeCount > 0` | "{pct}% completion rate is below the 70% target. Consider reducing sprint commitment or investigating late-sprint blockers." |
| `DR-003` | `info` | `deliveryRate >= 0.7 && deliveryRate < 0.9 && inScopeCount > 0` | "{pct}% completion is approaching target. A small number of issues carried over — confirm whether they are tracked in the next sprint." |
| `DR-004` | `info` | `deliveryRate >= 1.0 && inScopeCount > 0` | "100% of in-scope work was completed. Verify that the sprint was not under-committed (check scope stability)." |
| `DR-005` | `info` | `inScopeCount === 0` | "No in-scope work was recorded for this sprint. Ensure the sprint was properly closed in Jira." |

**Dimension 2 — Scope Stability**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `SS-001` | `critical` | `(added + removed) / committed > 0.50 && committed > 0` | "Scope changed by more than 50% of commitment ({pct}%). This level of churn indicates a planning breakdown or uncontrolled demand." |
| `SS-002` | `warning` | `(added + removed) / committed > 0.25 && <= 0.50 && committed > 0` | "Scope changed by {pct}% of commitment. Aim to keep mid-sprint changes below 25% to maintain predictability." |
| `SS-003` | `warning` | `addedMidSprintCount > removedCount * 2 && addedMidSprintCount > 2` | "{added} issues were added mid-sprint vs {removed} removed. Asymmetric additions suggest reactive scope inflation rather than genuine re-prioritisation." |
| `SS-004` | `info` | `(added + removed) / committed > 0.10 && <= 0.25 && committed > 0` | "Minor scope change ({pct}%). This is within acceptable range but worth reviewing in retrospective." |
| `SS-005` | `info` | `committed === 0` | "No committed issues were recorded — sprint membership data may be incomplete." |

**Dimension 3 — Roadmap Coverage**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `RC-001` | `critical` | `roadmapCoverage < 25 && inScopeCount >= 3` | "Only {pct}% of sprint work is linked to a roadmap item. The team may be delivering work that is not aligned to strategic goals." |
| `RC-002` | `warning` | `roadmapCoverage >= 25 && roadmapCoverage < 50 && inScopeCount >= 3` | "{pct}% roadmap coverage. Review whether unlinked issues represent genuine overhead or missing epic relationships in Jira." |
| `RC-003` | `info` | `roadmapCoverage >= 50 && roadmapCoverage < 80` | "{pct}% roadmap coverage. Good alignment — consider linking remaining issues to epics for fuller visibility." |
| `RC-004` | `info` | `roadmapCoverage >= 80` | "{pct}% roadmap coverage. Excellent strategic alignment for this sprint." |
| `RC-005` | `info` | `inScopeCount > 0 && inScopeCount < 3` | "Too few issues to make a meaningful roadmap coverage assessment." |

**Dimension 4 — Lead Time**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `LT-001` | `critical` | `medianLeadTimeDays > 30` | "Median lead time is {n} days — greater than one month. This suggests significant queue time or long-running issues that should be split." |
| `LT-002` | `warning` | `medianLeadTimeDays > 7 && <= 30` | "Median lead time is {n} days. Work is taking longer than one sprint to complete on average — consider breaking issues down further." |
| `LT-003` | `info` | `medianLeadTimeDays > 1 && <= 7` | "Median lead time of {n} days is within the 'high' DORA band. Small improvements in flow could push this to 'elite' (< 1 day)." |
| `LT-004` | `info` | `medianLeadTimeDays !== null && medianLeadTimeDays <= 1` | "Median lead time is under 1 day — elite DORA performance. Verify that in-progress transitions are being recorded accurately." |
| `LT-005` | `info` | `medianLeadTimeDays === null` | "Lead time could not be computed — no issues in this sprint had a resolved-at timestamp. Check that done-status names are configured correctly for this board." |

**Dimension 5 — Deployment Frequency**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `DF-001` | `critical` | `deploymentsPerDay < 1/30` | "Deployment frequency is below monthly. This sprint's work may not be releasing to production regularly — check version release cadence or done-status configuration." |
| `DF-002` | `warning` | `deploymentsPerDay >= 1/30 && < 1/7` | "Deployment frequency is roughly monthly. Aim for weekly or better to reduce batch size and deployment risk." |
| `DF-003` | `info` | `deploymentsPerDay >= 1/7 && < 1` | "Deployment frequency is weekly ('high' band). Increasing to on-demand (daily) would further reduce release risk." |
| `DF-004` | `info` | `deploymentsPerDay >= 1` | "Daily or better deployment frequency — elite DORA performance for this sprint window." |

**Dimension 6 — Change Failure Rate**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `CFR-001` | `critical` | `changeFailureRate > 15` | "Change failure rate is {pct}% — greater than 15% (low band). More than 1 in 6 changes is causing an incident or regression." |
| `CFR-002` | `warning` | `changeFailureRate > 10 && <= 15` | "Change failure rate of {pct}% is in the 'medium' band. Review whether failure issues are correctly linked to causative changes." |
| `CFR-003` | `warning` | `changeFailureRate > 5 && <= 10` | "Change failure rate of {pct}% is in the 'high' band. Some regressions are occurring — consider expanding automated test coverage." |
| `CFR-004` | `info` | `changeFailureRate <= 5` | "Change failure rate of {pct}% is elite. Maintain current quality practices." |

**Dimension 7 — MTTR**

| ID | Severity | Condition | Message template |
|---|---|---|---|
| `MT-001` | `critical` | `medianMttrHours >= 168` | "Median MTTR is {n} hours — over one week. Incidents are not being resolved promptly. Review on-call processes and escalation paths." |
| `MT-002` | `warning` | `medianMttrHours >= 24 && < 168` | "Median MTTR is {n} hours. Recovery is taking longer than a working day — aim to reduce to under 24 hours." |
| `MT-003` | `info` | `medianMttrHours >= 1 && < 24` | "Median MTTR of {n} hours is in the 'high' band. Targeting under 1 hour would achieve elite recovery performance." |
| `MT-004` | `info` | `medianMttrHours < 1` | "Median MTTR under 1 hour — elite recovery performance." |
| `MT-005` | `info` | `incidentCount === 0` | "No qualifying incidents were recorded in this sprint window. MTTR score defaults to elite (neutral)." |

All message templates are evaluated at runtime by interpolating `{pct}`, `{n}`,
`{added}`, `{removed}` from the `RecommendationContext`.  This is pure string
interpolation — no AI or external service call.

---

### 4. API Design

#### 4.1 Endpoint: Generate / Retrieve Report

```
GET  /api/sprint-report/:boardId/:sprintId
```

- If a persisted `SprintReport` row already exists for this sprint, it is
  returned immediately from Postgres without recalculating.
- If no row exists, the report is computed on-the-fly, persisted, then returned.
- Query parameter `?refresh=true` forces recomputation and overwrites any
  cached row.

**Response: `SprintReportResponse`**

```typescript
interface SprintDimensionScore {
  score: number;          // 0–100, rounded to 1 dp
  band?: DoraBand;        // present for DORA dimensions only
  rawValue: number | null; // the raw metric value fed into scoring
  rawUnit: string;        // human-readable unit, e.g. "days", "%", "per day"
}

interface SprintDimensionScores {
  deliveryRate:        SprintDimensionScore;
  scopeStability:      SprintDimensionScore;
  roadmapCoverage:     SprintDimensionScore;
  leadTime:            SprintDimensionScore;
  deploymentFrequency: SprintDimensionScore;
  changeFailureRate:   SprintDimensionScore;
  mttr:                SprintDimensionScore;
}

interface SprintRecommendation {
  id: string;               // e.g. "DR-001"
  dimension: string;        // e.g. "deliveryRate"
  severity: 'info' | 'warning' | 'critical';
  message: string;          // fully interpolated, human-readable
}

interface SprintReportTrendPoint {
  sprintId: string;
  sprintName: string;
  compositeScore: number;
  scores: SprintDimensionScores;
}

interface SprintReportResponse {
  // Sprint identity
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;    // ISO 8601
  endDate: string | null;      // ISO 8601

  // Composite
  compositeScore: number;      // 0–100, 1 dp
  compositeBand: 'strong' | 'good' | 'fair' | 'needs-attention';

  // Per-dimension breakdown
  scores: SprintDimensionScores;

  // Recommendations (sorted: critical → warning → info)
  recommendations: SprintRecommendation[];

  // Trend: this sprint + N most recent prior closed sprints on the same board
  // Ordered oldest → newest; the last element IS this sprint.
  trend: SprintReportTrendPoint[];

  // Metadata
  generatedAt: string;         // ISO 8601 timestamp
  dataAsOf: string;            // ISO 8601 — timestamp of most recent Jira sync
}
```

#### 4.2 Endpoint: List Reports for a Board

```
GET  /api/sprint-report/:boardId
```

Returns a lightweight list (no `recommendations`, no `trend`) of all persisted
reports for a board, sorted most recent first.  Useful for populating a
history dropdown.

**Response: `SprintReportSummary[]`**

```typescript
interface SprintReportSummary {
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  compositeScore: number;
  compositeBand: 'strong' | 'good' | 'fair' | 'needs-attention';
  generatedAt: string;
}
```

#### 4.3 Endpoint: Delete Cached Report

```
DELETE  /api/sprint-report/:boardId/:sprintId
```

Deletes the persisted row; the next `GET` will recompute.  Returns `204 No Content`.

---

### 5. Persisted Entity

A new entity `SprintReport` is introduced.  **No existing entities are modified.**

```typescript
// backend/src/database/entities/sprint-report.entity.ts

@Entity('sprint_reports')
export class SprintReport {
  @PrimaryColumn()
  boardId!: string;

  @PrimaryColumn()
  sprintId!: string;

  @Column()
  sprintName!: string;

  @Column({ type: 'timestamptz', nullable: true })
  startDate!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endDate!: Date | null;

  @Column({ type: 'float' })
  compositeScore!: number;

  @Column()
  compositeBand!: string;   // 'strong' | 'good' | 'fair' | 'needs-attention'

  /**
   * Full computed SprintReportResponse serialised as JSON.
   * Stored as a single column to avoid a complex relational schema for what is
   * effectively a snapshot.  The full response object (scores, recommendations,
   * trend) is embedded here.
   *
   * Trade-off: this is not queryable per-dimension at the SQL level.
   * Accepted because this is an internal tool with a single consumer (the
   * frontend), and the list endpoint derives its data from the scalar columns
   * above rather than parsing the payload column.
   */
  @Column({ type: 'jsonb' })
  payload!: object;

  @Column({ type: 'timestamptz' })
  generatedAt!: Date;
}
```

**Composite primary key:** `(boardId, sprintId)` — one report per sprint per board.
Recomputing with `?refresh=true` performs an upsert.

**Migration:** A single reversible migration is required.

```sql
-- up
CREATE TABLE sprint_reports (
  "boardId"       varchar NOT NULL,
  "sprintId"      varchar NOT NULL,
  "sprintName"    varchar NOT NULL,
  "startDate"     timestamptz,
  "endDate"       timestamptz,
  "compositeScore" float   NOT NULL,
  "compositeBand" varchar NOT NULL,
  "payload"       jsonb   NOT NULL,
  "generatedAt"   timestamptz NOT NULL,
  PRIMARY KEY ("boardId", "sprintId")
);

-- down
DROP TABLE sprint_reports;
```

---

### 6. Data Sources and Orchestration

`SprintReportService.generateReport(boardId, sprintId)` calls existing services
in this order, using the sprint's `[startDate, endDate]` window as the period:

```
1.  SprintDetailService.getDetail(boardId, sprintId)
      → SprintDetailResponse
        committedCount, addedMidSprintCount, removedCount,
        completedInSprintCount, medianLeadTimeDays, summary.roadmapLinkedCount

2.  PlanningService.getAccuracy(boardId, sprintId)
      → SprintAccuracy[]  (single element)
        completionRate, planningAccuracy, committedPoints, completedPoints

3.  RoadmapService.getAccuracy(boardId, sprintId=sprintId)
      → RoadmapSprintAccuracy[]  (single element)
        roadmapCoverage, roadmapOnTimeRate, totalIssues, coveredIssues

4.  MetricsService.getDora({ boardId, sprintId })
      → DoraMetricsResult[]  (single element for this boardId)
        deploymentFrequency.deploymentsPerDay, deploymentFrequency.band
        leadTime.medianDays, leadTime.band
        changeFailureRate.changeFailureRate, changeFailureRate.band
        mttr.medianHours, mttr.band

5.  SprintReport repo lookup for N most recent prior closed reports on same board
      → SprintReportTrendPoint[] (for trend context, up to 5 prior sprints)
```

All five calls can be made concurrently with `Promise.all` except step 5, which
depends on nothing and can also run in parallel with steps 1–4.

After data collection, `ScoringService.score(inputs)` and
`RecommendationService.recommend(context)` are called (both synchronous).
The assembled `SprintReportResponse` is then persisted and returned.

**Trend context (step 5):** The service queries `sprint_reports` for the 5 most
recent rows with `boardId = ? AND sprintId != currentSprintId` ordered by
`startDate DESC`, then reverses them to oldest-first for the chart.  If fewer
than 5 prior reports exist, only those available are returned.  This means that
on the first report for a board, `trend` will contain only the current sprint.
The frontend must handle `trend.length === 1` gracefully.

**Guard:** If `sprint.state !== 'closed'`, the service throws
`BadRequestException('Sprint reports can only be generated for closed sprints')`.
This prevents generating misleading composite scores for in-progress sprints.

---

### 7. Auto-Trigger Strategy

The `SyncService` already runs a cron job every 30 minutes
(`@Cron('0 */30 * * * *')`).  After each board sync completes, the sync service
already knows which sprints were updated.

The proposed approach: `SprintReportService` exposes a
`generateIfClosed(boardId: string, sprintId: string): Promise<void>` method.
`SyncService` calls this **non-blocking** (fire-and-forget, errors logged not
re-thrown) for each sprint record that:

a. Has `state === 'closed'`, AND
b. Has no existing row in `sprint_reports` for `(boardId, sprintId)`.

This fires at most once per sprint.  A sprint that transitions from `active` to
`closed` during a sync window will have its report generated on the next
scheduled sync after closure, introducing at most ~30 minutes of delay.

**Why not a webhook or event?** Jira Cloud webhooks require an HTTPS callback
URL.  The current architecture is a polling model; introducing a real-time
trigger would add operational complexity disproportionate to the benefit.
The 30-minute delay is acceptable for a closed-sprint report.

**Why not on the sync scheduler itself?** Adding report generation to the
`SyncService` cron is the simplest path, but it creates a dependency from
`SyncModule` to `SprintReportModule`.  To keep dependency direction clean:

```
SyncModule  →  SprintReportService
```

`SprintReportModule` exports `SprintReportService`.
`SyncModule` imports `SprintReportModule` and injects `SprintReportService`.

This is an additive one-directional dependency.  `SyncModule` already imports
other modules (none currently, it only imports entities).  The alternative of
having `SprintReportModule` poll independently was rejected because it would
duplicate the sync cadence logic.

---

### 8. Backend Module Structure

New directory: `backend/src/sprint-report/`

| File | Purpose |
|---|---|
| `sprint-report.module.ts` | NestJS module wiring |
| `sprint-report.controller.ts` | REST endpoints (GET, DELETE) |
| `sprint-report.service.ts` | Orchestration, persistence, guard logic |
| `scoring.service.ts` | Stateless scoring computation |
| `recommendation.service.ts` | Stateless rule evaluation |
| `sprint-report-bands.ts` | `SprintReportBand` type + `classifyComposite()` |
| `dto/sprint-report-query.dto.ts` | `@IsOptional() @IsBoolean() refresh?: boolean` |

The entity file lives in the existing entities directory:
`backend/src/database/entities/sprint-report.entity.ts`

The migration lives in `backend/src/migrations/`.

**Module wiring:**

```typescript
// sprint-report.module.ts
@Module({
  imports: [
    TypeOrmModule.forFeature([SprintReport, JiraSprint]),
    SprintModule,         // exports SprintDetailService
    PlanningModule,       // exports PlanningService
    RoadmapModule,        // exports RoadmapService
    MetricsModule,        // exports MetricsService
  ],
  controllers: [SprintReportController],
  providers: [SprintReportService, ScoringService, RecommendationService],
  exports: [SprintReportService],
})
export class SprintReportModule {}
```

**app.module.ts change:** Add `SprintReportModule` to the `imports` array.
`SyncModule` must also import `SprintReportModule` for the auto-trigger.

**Existing module exports that need adding:**

| Module | Currently exports | Change needed |
|---|---|---|
| `SprintModule` | nothing | Add `SprintDetailService` to `exports` |
| `PlanningModule` | `PlanningService` | Already exported ✓ |
| `RoadmapModule` | `RoadmapService` | Already exported ✓ |
| `MetricsModule` | `MetricsService` | Already exported ✓ |

Only `SprintModule` requires a one-line `exports` addition.

---

### 9. Frontend Page

#### 9.1 Route

```
/sprint-report/[boardId]/[sprintId]
```

Directory: `frontend/src/app/sprint-report/[boardId]/[sprintId]/page.tsx`

This parallels the existing sprint detail route
(`/sprint/[boardId]/[sprintId]`) and uses the same URL parameter names.

#### 9.2 Navigation Entry Point

A "View Report" button is added to the Sprint Detail page
(`/sprint/[boardId]/[sprintId]/page.tsx`) when `sprint.state === 'closed'`.
This is a `<Link>` to `/sprint-report/[boardId]/[sprintId]`.
No new nav item is added to the sidebar — the report is accessed contextually
from the sprint detail view.

#### 9.3 Component Structure

```
SprintReportPage  (page.tsx — 'use client')
  ├── SprintReportHeader          (sprintName, startDate–endDate, generatedAt)
  ├── CompositeScoreGauge         (large circular score display + compositeBand label)
  ├── DimensionScoreGrid          (7-card grid, one card per dimension)
  │     └── DimensionScoreCard   (score 0–100, band badge for DORA dims, raw value label)
  ├── RecommendationsList         (sorted critical→warning→info, colour-coded by severity)
  │     └── RecommendationItem   (icon + severity chip + message text)
  ├── SprintTrendChart            (line chart: composite score across sprints)
  └── DimensionTrendTable         (tabular view of per-dimension scores across the trend window)
```

All components are co-located in
`frontend/src/app/sprint-report/[boardId]/[sprintId]/` or in
`frontend/src/components/sprint-report/` for any reusable sub-components.

#### 9.4 Charts and Visualisation

**CompositeScoreGauge:** A simple SVG arc (no third-party charting library
required for this single element) showing 0–100 with colour:
- ≥ 80: green
- 60–79: blue
- 40–59: amber
- < 40: red

**SprintTrendChart:** A `recharts` `LineChart` (already used on the DORA page)
with:
- X-axis: sprint names (abbreviated)
- Y-axis: 0–100 composite score
- Single line: `compositeScore`
- Optional secondary lines for the two highest-weight dimensions
  (deliveryRate, leadTime) as lighter dashed lines

**DimensionScoreGrid:** Seven `DimensionScoreCard` components laid out in a
responsive CSS grid (4 columns on ≥ lg, 2 columns on ≥ md, 1 column on mobile).
Each card displays:
- Dimension name
- Score (large, coloured)
- Band badge (for DORA dimensions)
- Raw value in plain English (e.g. "Median 8.3 days", "CFR 4.2%")

**DimensionTrendTable:** A plain HTML table (using the existing `DataTable`
component) showing one row per sprint in the trend window and one column per
dimension.

#### 9.5 API Client Addition (frontend/src/lib/api.ts)

```typescript
export interface SprintDimensionScore {
  score: number;
  band?: DoraBand;
  rawValue: number | null;
  rawUnit: string;
}

export interface SprintDimensionScores {
  deliveryRate:        SprintDimensionScore;
  scopeStability:      SprintDimensionScore;
  roadmapCoverage:     SprintDimensionScore;
  leadTime:            SprintDimensionScore;
  deploymentFrequency: SprintDimensionScore;
  changeFailureRate:   SprintDimensionScore;
  mttr:                SprintDimensionScore;
}

export type SprintReportBand = 'strong' | 'good' | 'fair' | 'needs-attention';

export interface SprintRecommendation {
  id: string;
  dimension: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

export interface SprintReportTrendPoint {
  sprintId: string;
  sprintName: string;
  compositeScore: number;
  scores: SprintDimensionScores;
}

export interface SprintReportResponse {
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  compositeScore: number;
  compositeBand: SprintReportBand;
  scores: SprintDimensionScores;
  recommendations: SprintRecommendation[];
  trend: SprintReportTrendPoint[];
  generatedAt: string;
  dataAsOf: string;
}

export interface SprintReportSummary {
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  compositeScore: number;
  compositeBand: SprintReportBand;
  generatedAt: string;
}

export function getSprintReport(
  boardId: string,
  sprintId: string,
  refresh = false,
): Promise<SprintReportResponse> {
  return apiFetch(
    `/api/sprint-report/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}${refresh ? '?refresh=true' : ''}`,
  );
}

export function getSprintReportList(
  boardId: string,
): Promise<SprintReportSummary[]> {
  return apiFetch(`/api/sprint-report/${encodeURIComponent(boardId)}`);
}

export function deleteSprintReport(boardId: string, sprintId: string): Promise<void> {
  return apiFetch(
    `/api/sprint-report/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}`,
    { method: 'DELETE' },
  );
}
```

---

### 10. Data Freshness

| Scenario | Behaviour |
|---|---|
| Report not yet generated for a closed sprint | Computed on-demand by first `GET`, persisted, returned |
| Report exists | Returned from `sprint_reports` table instantly |
| `?refresh=true` | Recomputed against current Jira-sync data, old row overwritten |
| Sprint still active | `400 BadRequest` — report cannot be generated for non-closed sprints |
| Sync completes and new sprint closed | Auto-trigger generates the report asynchronously within the same sync run |

**`dataAsOf` field:** Populated from the most recent `sync_logs` row for the
board (queried from `SyncLog` entity in `SprintReportService`).  This tells the
reader whether the underlying Jira data was synced recently.

---

### 11. Edge Cases

| Scenario | Handling |
|---|---|
| **Kanban board** | `SprintDetailService` already throws `400` for Kanban boards; `SprintReportService` inherits this guard and adds its own early-exit check against `boardConfig.boardType` |
| **Sprint with zero issues** | All dimension scores default to 50 (neutral); `inScopeCount === 0` triggers `DR-005`; composite score will be 50 |
| **No roadmap config rows** | `RoadmapService.getAccuracy` returns `roadmapCoverage = 0`; `totalIssues` from `SprintDetail` determines whether `RC-001` or `RC-005` fires |
| **No MTTR incidents** | `medianHours = 0` → `classifyMTTR(0) = 'elite'` → score 100; `MT-005` fires (info) |
| **No deployments** | `deploymentsPerDay = 0` → `classifyDeploymentFrequency(0) = 'low'` → score 25 |
| **Sprint with no start/end date** | `SprintDetailService` handles this; `SprintReportService` catches the case and returns `400` with "Sprint has no date range" |
| **First sprint on a board (no trend data)** | `trend` array contains only the current sprint's point; frontend renders chart with single point gracefully |
| **Trend data for prior sprints has been deleted** | Re-queried from `sprint_reports`; if rows are missing, trend is shorter but not an error |
| **Concurrent report generation** | Upsert strategy: `save()` with composite PK means concurrent requests produce identical rows with no data corruption |

---

## Alternatives Considered

### Alternative A — On-the-fly only (no persistence)

Compute the full report on every `GET` without storing it.

**Ruled out** because: (1) generating a report requires 4–5 sequential DB
round-trips through existing services; for boards with many issues this takes
1–3 seconds.  Persisting allows sub-50ms retrieval for the common case.
(2) Trend data would require re-computing N prior sprints on every request,
multiplying the DB cost by N.

### Alternative B — Event-driven auto-trigger via Jira webhook

Register a Jira webhook for sprint-completion events that calls a backend
endpoint to trigger report generation.

**Ruled out** because: the application runs in a private network environment
(see proposal 0019 for AWS hosting).  Jira Cloud webhooks require a publicly
accessible HTTPS endpoint.  The current architecture polls Jira; adding a
webhook listener would introduce a new ingress path, TLS certificate management,
and operational overhead inconsistent with the "minimum cost / minimum
complexity" principle established in proposal 0019.

### Alternative C — Store scores in relational columns, not JSONB payload

Normalise `scores`, `recommendations`, and `trend` into separate tables.

**Ruled out** because: Sprint reports are snapshots — they capture the state
at the moment of generation and are not updated incrementally.  A relational
decomposition would add three tables and complex joins for no query benefit
(this is a single-user internal tool that never queries individual dimensions
in isolation).  The `payload` JSONB column stores the complete snapshot; the
scalar `compositeScore` and `compositeBand` columns cover the only use cases
that benefit from SQL-level access (the list endpoint and sorting).

### Alternative D — Linear interpolation within DORA bands

Instead of mapping bands to fixed scores (elite→100, high→75, medium→50,
low→25), interpolate within the band using the raw metric value.

**Ruled out** because: the band boundaries already encode the DORA research
thresholds.  Interpolating within bands would require defining sub-band
thresholds that have no research backing, and would make the composite score
harder to explain ("why did adding one deployment push the score from 76 to
78?").  Fixed band scores are transparent and consistent with the rest of the
application's band-based UX.

### Alternative E — Separate `SprintReportModule` from `SprintModule`

Re-implement sprint membership logic in `SprintReportService` rather than
calling `SprintDetailService`.

**Ruled out** because: sprint membership reconstruction (5-minute grace period,
changelog replay, committed/added/removed classification) is complex, tested
logic in `SprintDetailService`.  Duplicating it violates DRY and would diverge
over time.  The correct approach is to export `SprintDetailService` from
`SprintModule` and inject it.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | New entity + migration | `sprint_reports` table; one reversible migration; no existing schema changes |
| API contract | Additive only | Three new endpoints under `/api/sprint-report/`; no existing endpoints modified |
| Frontend | New page + minor Sprint Detail change | `/sprint-report/[boardId]/[sprintId]`; "View Report" link added to Sprint Detail page only when sprint is closed |
| Tests | New unit tests required | `ScoringService` and `RecommendationService` are pure functions — 100% unit testable; `SprintReportService` integration test with mocked dependencies |
| Jira API | No new calls | All data comes from existing Postgres tables via existing services |
| `SprintModule` | Minor export addition | `SprintDetailService` added to `exports` array — no behaviour change |
| `SyncModule` | Minor import addition | `SprintReportModule` imported; `SprintReportService` injected for auto-trigger |
| `app.module.ts` | Additive | `SprintReportModule` added to imports list |

---

## Open Questions

1. **Trend window size:** The proposal specifies N=5 prior sprints.  Should this
   be configurable per board (e.g. stored in `BoardConfig`)?  The constraint is
   that `BoardConfig` must not be changed (per the task requirements).  A
   hard-coded `TREND_LOOKBACK_SPRINTS = 5` constant in `SprintReportService` is
   acceptable for v1, with configurability deferred.

2. **Recommendation message localisation:** All messages are English strings
   baked into the rule definitions.  If multi-language support is ever needed,
   the `id` field provides a stable key for externalisation.  Not an immediate
   concern for an internal tool.

3. **Score thresholds for non-DORA dimensions:** The delivery rate and scope
   stability breakpoints (0.5, 0.7, 0.8, 0.25, 0.50) were chosen based on
   engineering judgment, not industry research.  The team should validate these
   during retrospective review of the first 2–3 generated reports and adjust
   via a follow-up proposal if they prove poorly calibrated.

4. **Points-based delivery rate:** The current `deliveryRate` dimension uses
   issue counts.  `PlanningService` already computes `planningAccuracy` in story
   points when available.  A v2 enhancement could replace the count-based
   delivery rate with a points-based one when point data is available.  Out of
   scope for this proposal.

5. **Report for active sprints:** The guard rejecting non-closed sprints is
   deliberate.  An "in-progress preview" report (real-time, not persisted)
   could be valuable for mid-sprint health checks.  This is out of scope but
   the architecture supports it by dropping the guard and skipping persistence.

---

## Acceptance Criteria

- [ ] `GET /api/sprint-report/:boardId/:sprintId` returns a `SprintReportResponse`
      for any closed Scrum sprint within ≤ 200ms on the second call (cache hit).
- [ ] `GET /api/sprint-report/:boardId/:sprintId?refresh=true` forces recomputation
      and overwrites the `sprint_reports` row; the response `generatedAt` timestamp
      is updated.
- [ ] `GET /api/sprint-report/:boardId/:sprintId` for a Kanban board returns `400`.
- [ ] `GET /api/sprint-report/:boardId/:sprintId` for an active sprint returns `400`.
- [ ] `GET /api/sprint-report/:boardId` returns an array of `SprintReportSummary`
      objects (no `recommendations`, no `trend`) for all persisted reports on the board.
- [ ] `DELETE /api/sprint-report/:boardId/:sprintId` removes the persisted row and
      returns `204`; a subsequent `GET` recomputes the report.
- [ ] Composite score is the weighted sum of dimension scores per §2.3, rounded to 1 dp.
- [ ] Dimension scores for DORA metrics (LT, DF, CFR, MTTR) use the band-to-score
      mapping in §2.1 exclusively — no raw-value interpolation.
- [ ] `ScoringService` and `RecommendationService` have unit tests covering:
      - all band-to-score mappings
      - all three scoring breakpoints for delivery rate, scope stability, and roadmap coverage
      - at least 2 rules per dimension (one trigger condition true, one false)
- [ ] Sync completes for a board with a newly closed sprint → a `sprint_reports`
      row is generated automatically within the same sync run.
- [ ] Frontend `/sprint-report/[boardId]/[sprintId]` renders without error when
      `trend.length === 1` (first report for the board).
- [ ] The Sprint Detail page (`/sprint/[boardId]/[sprintId]`) shows a "View Report"
      link only when `sprint.state === 'closed'`.
- [ ] The `sprint_reports` migration is reversible: `down()` drops the table cleanly.
- [ ] `SprintModule` exports `SprintDetailService` without breaking existing tests.
