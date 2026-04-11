# 0007 — Cycle Time Report

## Status: Accepted

**Reviewed by:** Architect Agent  
**Review date:** 2026-04-11

Seven blocking issues must be corrected before implementation begins. Three additional non-blocking improvements are also noted. The proposal is otherwise technically sound, well-scoped, and consistent with codebase conventions.

---

### Required changes (blocking — must fix before implementation)

**1. `CycleTimeResult` is missing the `anomalyCount` field everywhere it is defined.**

The acceptance criteria (final bullet) explicitly require `anomalyCount: number` in `CycleTimeResult` and mandate a visible amber indicator in the UI when `anomalyCount > 0`. However, `anomalyCount` is absent from:
- The `CycleTimeResult` interface in **Section 4.2** (service-layer type)
- The `CycleTimeResult` interface in **Section 4.4** (`cycle-time-response.dto.ts`)
- The `CycleTimeResult` interface in **Section 5.4** (`api.ts` frontend types)

The implementer will produce type-safe code that fails the acceptance criteria. Add `anomalyCount: number` to all three interface definitions before implementation.

---

**2. Section 1.4 (re-opened issues) contradicts the algorithm in Section 4.2.**

Section 1.4 states: *"use the **first** in-progress transition as the start time, and the **last** done transition that falls within the query window as the end time."*

The algorithm pseudocode in Section 4.2, step (b), says: *"cycleEnd = **first** changelog where toValue ∈ doneStatusNames AND changedAt ∈ [startDate, endDate]"*

These are mutually contradictory. `LeadTimeService` also uses `find()` (first match). The proposal must pick one rule and state it consistently. The Architect's recommendation is to honour **Section 1.4's "last done in period"** rule — it better handles re-opens and is the more correct behaviour for the stated rationale — and update the algorithm pseudocode in Section 4.2 step (b) accordingly. The implementation note should also describe how to find the last match (e.g. reverse the sorted changelogs before calling `.find()`, or use `.filter().at(-1)`).

---

**3. The migration class name template is syntactically invalid TypeScript.**

Section 4.1 shows:

```typescript
export class AddInProgressStatusNamesToBoardConfigs<timestamp>
  implements MigrationInterface {
```

`<timestamp>` is not a valid TypeScript generic placeholder in this position — it would be parsed as a generic type parameter, which is not what is meant. The actual migration naming convention in this codebase is: **timestamp as a numeric suffix on the class name**, not a generic. All eight existing migrations follow this pattern (e.g. `AddBacklogStatusIds1775820879077`). Additionally, the two most recent `board_configs` migrations omit the `name` field; the three older ones include it. The developer should follow the **most recent pattern** (no `name` field).

The correct template is:

```typescript
export class AddInProgressStatusNamesToBoardConfigs<TIMESTAMP> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> { ... }
  public async down(queryRunner: QueryRunner): Promise<void> { ... }
}
```

where `<TIMESTAMP>` is replaced with the actual 13-digit Unix millisecond timestamp in the filename and class name (e.g. `AddInProgressStatusNamesToBoardConfigs1775820881077`). Update Section 4.1 to show the correct class-name convention and remove the `<timestamp>` generic notation.

---

**4. `CycleTimeTrendQueryDto` is missing required `class-validator` imports and decorators.**

Section 4.4 shows the DTO using `@IsInt()` and `@Max()` but provides no import statement. More critically, comparing against the existing `DoraTrendQueryDto` (the direct analogue), the proposal's DTO is **missing**:
- `@Min(1)` on `limit` (present in `DoraTrendQueryDto`)
- `@IsIn(['quarters', 'sprints'])` on `mode` (present in `DoraTrendQueryDto` — `@IsString()` alone does not validate the literal union)
- `@Type(() => Number)` from `class-transformer` on `limit` (required for NestJS to coerce the query-string string to a number before `@IsInt()` validates it — without this, `limit` will always fail `@IsInt()` validation because query params arrive as strings)

Without `@Type(() => Number)`, passing `?limit=8` in the query string will cause a validation error at runtime. The full correct DTO should match the structure of `DoraTrendQueryDto`. Update Section 4.4 with the complete, correct DTO including all imports.

---

**5. `getCycleTimeTrend` sprint mode is missing the `boardId` null guard.**

The `MetricsService.getCycleTimeTrend()` code in Section 4.6 does `const boardId = boardIds[0]` when `mode === 'sprints'` without first checking whether `query.boardId` was actually provided. If `boardId` is omitted from the request, `resolveBoardIds()` returns all boards from the env default (`'ACC,BPT,SPS,OCS,DATA,PLAT'`), so `boardIds[0]` silently resolves to `'ACC'` — a Scrum board — and the Kanban guard never fires. The Kanban board check also immediately follows without first checking if `boardId` was supplied.

Compare with `getDoraTrend()` in `metrics.service.ts` lines 325–330, which throws `BadRequestException('Sprint trend mode requires a single boardId.')` before proceeding.

Add the same guard to `getCycleTimeTrend()`:
```typescript
if (mode === 'sprints') {
  if (!query.boardId) {
    throw new BadRequestException('Sprint trend mode requires a single boardId.');
  }
  const boardId = boardIds[0];
  // ... rest of sprint mode
}
```

---

**6. `CycleTimeResult` and `CycleTimeObservation` are defined twice with no reconciliation.**

Section 4.2 defines `CycleTimeObservation` and `CycleTimeResult` as exported interfaces directly in `cycle-time.service.ts`. Section 4.4 defines the **same interfaces again** in `cycle-time-response.dto.ts`. The proposal does not state which definition is authoritative, which file imports from which, or whether they are intended to be duplicates or a shared source.

The existing pattern in this codebase is that service-layer types live in the service file (e.g. `LeadTimeResult` in `lead-time.service.ts`, `MttrResult` in `mttr.service.ts`) and the controller uses `type` imports from the service. The DTO file should not re-declare the same interfaces.

**Resolution:** Remove the duplicate interface definitions from `cycle-time-response.dto.ts`. The response DTO file should only contain the `CycleTimeResponse` and `CycleTimeTrendResponse` type aliases, importing `CycleTimeObservation`, `CycleTimeResult`, and `CycleTimeTrendPoint` from `cycle-time.service.ts`. Update Sections 4.4 and 4.5 to reflect these import paths.

---

**7. `CycleTimeService.calculate()` has no zero-observations fallback.**

`LeadTimeService.calculate()` has an explicit guard:
```typescript
if (leadTimeDays.length === 0) {
  return { boardId, medianDays: 0, p95Days: 0, band: classifyLeadTime(0), sampleSize: 0 };
}
```

The proposal's `CycleTimeService` description and algorithm make no mention of what `calculate()` returns when `observations` is empty (e.g. a board with no issues, or no issues with in-progress transitions). Calling `percentile([], 50)` returns `0` from `statistics.ts`, which is safe, but the return shape still needs to be explicit. Without a defined zero-case, `p50Days`, `p75Days`, `p85Days`, `p95Days` would all be `0` and `band` would be `'excellent'` — which misrepresents a no-data situation.

Add an explicit zero-observations guard to the `calculate()` description in Section 4.2, consistent with how `LeadTimeService` handles it. Consider using a sentinel value or a separate `hasData: boolean` flag to distinguish "no data" from "genuinely excellent ≤ 2 days".

---

### Non-blocking improvements (recommended but not blocking)

**A. `leadTimeDays` in `CycleTimeObservation` is misleading and should be documented more prominently.**

The note buried in Section 4.2 correctly states that `leadTimeDays = cycleTimeDays` for all issues that reach the observation (because they share the same start event). This means `queueTimeDays` will be `0` for every observation, rendering the Queue (d) column in the issue table always `0.0` — not `'—'` as the acceptance criteria imply. The misleading column will erode user trust.

The proposal should either: (a) document clearly in the interface definition that `leadTimeDays` and `queueTimeDays` will be `null` (not `0`) for all issues in the initial implementation, and the Queue column always shows `'—'`; or (b) move the `leadTimeDays` / `queueTimeDays` fields to an Open Questions resolution and exclude them from the v1 interface until true queue time is implemented. Option (b) is cleaner. If the fields are kept, add `// always null in v1 — see Open Question 1` as inline comments on the interface.

**B. `CycleTimeTrendChart` component guidance is ambiguous.**

Section 5.3 says the trend chart should be "inline in `cycle-time/page.tsx` or extracted as a shared `TrendChart` component", deferring the decision. However, the existing inline `TrendChart` in `dora/page.tsx` is tightly coupled to `TrendPoint` (the DORA type) through its `dataKey` constraint:

```typescript
dataKey: keyof Pick<TrendPoint, 'deploymentsPerDay' | 'medianLeadTimeDays' | ...>
```

A `CycleTimeTrendPoint` has different keys (`medianCycleTimeDays`, `p85CycleTimeDays`). The developer cannot reuse the existing `TrendChart` component without modification. The proposal should explicitly state: "inline a separate `CycleTimeTrendChart` component for v1; the Phase 4 extraction should generalise the `dataKey` type to `string` or use a render-prop pattern." This removes ambiguity.

**C. `doneStatusNames` column type mismatch worth noting.**

`BoardConfig.doneStatusNames` uses `@Column('simple-array', ...)` (comma-separated TEXT, TypeORM's legacy format) while all other array columns use `@Column('simple-json', ...)` (JSON array TEXT). The proposal correctly uses `simple-json` for `inProgressStatusNames` (matching the recent pattern). This inconsistency in `doneStatusNames` is pre-existing and out of scope here, but the implementer should be aware that `simple-array` columns cannot contain strings with commas — `inProgressStatusNames` does not share this limitation because it uses `simple-json`.

---

**Date:** 2026-04-11
**Status:** Draft — Changes Requested
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

The dashboard currently measures **Lead Time for Changes** (LT): the elapsed time from the
moment a Jira issue enters the board (first "In Progress" transition, or issue creation as a
Scrum fallback) to the moment it reaches a done status. This is a useful DORA metric, but it
conflates two distinct phases that teams need to see separately:

1. **Queue/wait time** — how long an issue sits in "To Do" (or equivalent) before anyone
   picks it up. High queue time indicates a resourcing or prioritisation problem.
2. **Cycle time** — how long active work takes once someone starts it. High cycle time
   indicates complexity, rework, or under-sizing.

Without this distinction, a team whose median lead time is 8 days cannot tell whether those
8 days are 1 day of work + 7 days of waiting, or 7 days of hard engineering + 1 day of
queue. The actions to improve each scenario are entirely different.

There is no `/cycle-time` page, no `CycleTimeService`, and `BoardConfig` has no
`inProgressStatusNames` column. The data needed to compute cycle time is already in
`jira_changelogs` (status transitions), but no service reads it for this purpose.

---

## Current State

### What exists

**`LeadTimeService`** (`backend/src/metrics/lead-time.service.ts`)
- `getLeadTimeObservations(boardId, startDate, endDate): Promise<number[]>` — returns
  sorted array of lead-time-days per issue.
- `calculate(boardId, startDate, endDate): Promise<LeadTimeResult>` — returns median, p95,
  band, and sample size.
- Start time logic (lines 108–118): looks for the **first** `toValue === 'In Progress'`
  changelog entry. Falls back to `issue.createdAt` for Scrum; skips the issue for Kanban.
- End time logic (lines 121–143): first done-status transition in period, or fixVersion
  `releaseDate` as fallback.

**`JiraChangelog`** (`backend/src/database/entities/jira-changelog.entity.ts`)
- Fields: `issueKey`, `field`, `fromValue`, `toValue`, `changedAt`.
- Status transitions are stored as `field = 'status'`, `toValue = <status name>`.
- All historical transitions are stored, not just the current state.

**`BoardConfig`** (`backend/src/database/entities/board-config.entity.ts`)
- Has `doneStatusNames: string[]` (default `['Done', 'Closed', 'Released']`).
- Has `boardType: string` (`'scrum'` | `'kanban'`).
- Does **not** have an `inProgressStatusNames` field.

**`statistics.ts`** (`backend/src/metrics/statistics.ts`)
- `percentile(sorted: number[], p: number): number`
- `round2(n: number): number`
Both are available for reuse.

**Frontend UI patterns**
- `OrgMetricCard` (`frontend/src/components/ui/org-metric-card.tsx`) — metric hero card
  with sparkline, band badge, contributing-boards count.
- `BandBadge` (`frontend/src/components/ui/band-badge.tsx`) — coloured band pill.
- `DataTable` (`frontend/src/components/ui/data-table.tsx`) — sortable table.
- `EmptyState` (`frontend/src/components/ui/empty-state.tsx`) — empty state component.
- `BoardChip` (`frontend/src/components/ui/board-chip.tsx`) — board selection chip.
- `TrendChart` pattern (inline in `dora/page.tsx`) — Recharts `LineChart` with standard
  styling; should be extracted to a shared component (see Section 7).

### What is missing

1. **`inProgressStatusNames` on `BoardConfig`** — no per-board configuration for which
   status names represent active work. The `LeadTimeService` hardcodes `'In Progress'`
   (line 109). This works for standard Jira project templates but fails for boards using
   `'In Development'`, `'Active'`, `'Doing'`, etc.

2. **`CycleTimeService`** — no service that computes start-from-active-work and
   end-at-done, nor one that returns per-issue observations for percentile analysis.

3. **Queue time derivation** — nothing computes `leadTime − cycleTime` per issue.

4. **No `/cycle-time` page or route** — the sidebar (`sidebar.tsx`) has no entry for it.

5. **No cycle-time API types in `api.ts`** — no wrappers or DTOs for cycle-time endpoints.

6. **No cycle-time band thresholds** — the existing `dora-bands.ts` files cover the four
   DORA metrics only; cycle time needs its own classification function.

---

## Proposed Solution

### Overview

1. Add `inProgressStatusNames: string[]` to `BoardConfig` with a sensible default
   (`['In Progress']`), with a reversible migration.
2. Implement `CycleTimeService` modelled directly after `LeadTimeService`, computing
   start time from the first transition into any `inProgressStatusNames` status.
3. Expose `GET /api/metrics/cycle-time` returning per-issue observations, percentiles,
   and per-board summaries.
4. Add a new **`/cycle-time` page** in the frontend with:
   - Percentile summary cards (p50/p75/p85/p95 cycle time + queue time)
   - Distribution scatter plot (cycle time per issue, coloured by band)
   - Trend line chart (median cycle time per sprint or quarter)
   - Per-issue table (filterable by board, period, issue type)
5. Surface queue time as a derived metric in the same report — not a separate page.
6. Extend `BoardConfig` UI in `/settings` to expose `inProgressStatusNames`.

### Data flow

```
GET /api/metrics/cycle-time?boardId=ACC,BPT&quarter=2026-Q1&issueType=Story

  MetricsController
    └── CycleTimeService.calculate(boardId, startDate, endDate, issueTypeFilter?)
          ├── boardConfigRepo.findOne → inProgressStatusNames, doneStatusNames
          ├── issueRepo.find({ boardId })           [filtered by issueType if provided]
          ├── changelogRepo.createQueryBuilder      [status field, all time]
          ├── Per issue:
          │     startTime = first toValue ∈ inProgressStatusNames  → cycleStart
          │     endTime   = first toValue ∈ doneStatusNames, in period → cycleEnd
          │     cycleTimeDays   = (cycleEnd - cycleStart) / ms_per_day
          │     [queueTimeDays computed separately — see §2.2]
          └── Returns CycleTimeResult:
                { boardId, p50, p75, p85, p95, medianDays, sampleSize,
                  band, observations: CycleTimeObservation[] }

Frontend: /cycle-time page
  ├── GET /api/metrics/cycle-time   → percentile summary + observations
  ├── GET /api/metrics/cycle-time/trend → median per period (sprints or quarters)
  └── [no separate queue-time endpoint — derived client-side from lead-time observations]
```

---

## Section 1 — Precise Cycle Time Definition

### 1.1 Start event: "work actively begun"

**Cycle time starts** at the timestamp of the **first** `JiraChangelog` entry where:
- `field = 'status'`
- `toValue` is a member of `BoardConfig.inProgressStatusNames` for the issue's board

This is the same "In Progress" detection already used in `LeadTimeService.getLeadTimeObservations()`
(line 108–109) and `MttrService.getMttrObservations()` (line 125–128), but generalised to
consult the configurable `inProgressStatusNames` array rather than hardcoding `'In Progress'`.

**Default `inProgressStatusNames`:** `['In Progress']`

This default is intentionally narrow. Teams using non-standard status names (e.g. `'In Dev'`,
`'Active'`, `'Doing'`) will need to configure their board in Settings. The narrow default is
preferable to a wide default (e.g. including `'In Review'`) because it represents the earliest
moment of active engineering work — the question cycle time answers is "how long did it take to
build once we started?", not "how long did the full active pipeline take?"

### 1.2 End event: "work done"

**Cycle time ends** at the same end event as lead time: the **first** `JiraChangelog` entry
where `field = 'status'` and `toValue ∈ BoardConfig.doneStatusNames`, with `changedAt` within
the query period (`startDate..endDate`). The `fixVersion.releaseDate` fallback used in
`LeadTimeService` also applies here.

This keeps cycle time and lead time comparable: same end event, different start event. The
difference `leadTimeDays − cycleTimeDays` is the queue/wait time.

### 1.3 Issues with no "In Progress" transition (skipped directly to done)

An issue may reach a done status without ever transitioning through an in-progress status (e.g.
issues resolved as duplicates, won't-fix, or auto-closed). These issues have **no meaningful
cycle time** and must be **excluded** from cycle time calculations.

**Rule:** if an issue has no changelog entry with `toValue ∈ inProgressStatusNames`, it is
excluded from cycle time observations. It is **not** excluded from lead time observations
(lead time's Scrum fallback uses `createdAt`).

This means `cycleTimeSampleSize ≤ leadTimeSampleSize` for Scrum boards. The difference is the
count of issues that were never actively worked — a useful signal in its own right (shown as
"issues skipped" in the per-board summary).

### 1.4 Re-opened issues (multiple "In Progress" transitions after Done)

An issue may be completed, re-opened, and worked on again. The changelog will contain:
```
... → In Progress → Done → To Do → In Progress → Done
```

**Rule:** use the **first** in-progress transition as the start time, and the **last** done
transition that falls within the query window as the end time.

Rationale: cycle time measures the full active-work lifespan of the issue from first pickup to
final completion within the reporting period. If the final done transition is within the period,
the issue counts once with `cycleTime = (lastDoneInPeriod - firstInProgress)`.

**Edge case — cycleTime > leadTime:** This can occur when the first "In Progress" transition
pre-dates the first "board entry" event used for lead time, or when a re-open extends the cycle
past the period. In practice this is a data anomaly; `CycleTimeService` should clamp
`cycleTimeDays = max(0, cycleTimeDays)` and log a warning when `cycleTimeDays > leadTimeDays`
for the same issue. It should not throw — noisy data is expected. See Section 10 for discussion.

### 1.5 Kanban vs. Scrum behaviour

**Scrum boards (ACC, BPT, SPS, OCS, DATA):**
- Same as lead time: issues without an in-progress transition are excluded from cycle time
  (no fallback to `createdAt` for cycle time — the fallback only applies to lead time).

**Kanban boards (PLAT):**
- Same rule. No in-progress transition → excluded. Kanban boards typically have good
  in-progress signal because work is pulled explicitly.
- Issues still in the backlog (i.e. `statusId ∈ BoardConfig.backlogStatusIds`, or never
  having a status changelog) are always excluded from both cycle time and lead time.

This means `CycleTimeService` works identically for both board types — no `isKanban` branch
is needed, unlike `LeadTimeService` which has a Kanban-specific `continue` for the `createdAt`
fallback path.

---

## Section 2 — Queue Time

### 2.1 Definition

**Queue time** is the interval from when an issue became visible to the team as work-to-be-done
to when active work began:

```
queueTimeDays = leadTimeDays − cycleTimeDays
```

For a given issue:
- `leadTimeDays` start = first in-progress transition (Scrum) or first in-progress transition
  (Kanban) — the same as `cycleTimeDays` start when a fallback is not involved.
- When Scrum's `createdAt` fallback is used: `leadTimeDays` start = `createdAt`,
  `cycleTimeDays` has no value (issue excluded) → queue time is also undefined.
- When an issue has both a lead time and a cycle time:
  `queueTimeDays = leadTimeDays − cycleTimeDays`

> **Note:** Because `LeadTimeService` and `CycleTimeService` use the **same** in-progress
> transition as their start event, the computed `queueTimeDays` for issues that do have an
> in-progress transition will be 0 when using the default `inProgressStatusNames`. The queue
> time is only non-zero when lead time uses `createdAt` (Scrum fallback). This is correct:
> for issues that were immediately picked up after creation (no To Do wait), cycle time ≈
> lead time.
>
> To surface meaningful queue time, a future enhancement could add a `boardEntryStatusNames`
> config (the statuses that represent "committed but not yet started", e.g. `['To Do', 'Open',
> 'Backlog']`) and compute queue time as `firstInProgress − firstBoardEntry`. This is an
> **open question** tracked in Section 10 below.

### 2.2 Surface queue time alongside cycle time

Queue time is shown in the same `/cycle-time` page, not a separate page. The UX shows:
- A side-by-side percentile table: Cycle Time | Queue Time | Lead Time
- A stacked bar in the per-issue table: `█████░░░` where filled = cycle, empty = queue

Queue time values are computed in the frontend from:
```typescript
queueTimeDays = (leadTimeDays ?? 0) - (cycleTimeDays ?? 0)
```
where `cycleTimeDays` comes from the cycle-time observations response and `leadTimeDays` comes
from the `SprintDetailIssue.leadTimeDays` field or a supplemental lead-time observations call.

To avoid a second backend call for lead-time observations, `CycleTimeService.calculate()` will
return both `cycleTimeDays` and `leadTimeDays` per issue in its observations array. The backend
computes both in one pass using the same changelog data.

---

## Section 3 — Performance Band Thresholds

Cycle time does not have industry-standard DORA thresholds the way lead time does. The DORA
research measures lead time; cycle time is a flow metric from Lean/Kanban literature. Thresholds
should be **configurable per board** rather than global, because:

- A team building complex platform features may have a healthy cycle time of 5–7 days.
- A team building small web features may be unhealthy at 5 days.
- Kanban flow metrics have different expected ranges than sprint-based Scrum.

### Proposed default thresholds (sensible starting points)

| Band | Median Cycle Time |
|---|---|
| Excellent | ≤ 2 days |
| Good | ≤ 5 days |
| Fair | ≤ 10 days |
| Poor | > 10 days |

These bands are **not stored in `BoardConfig`** at this stage to avoid premature schema
complexity. They are defined as constants in a new file:

```
backend/src/metrics/cycle-time-bands.ts
frontend/src/lib/cycle-time-bands.ts
```

The frontend `cycle-time-bands.ts` will be a duplication of the backend file, consistent with
the existing pattern for `dora-bands.ts` (documented in ADR-0007). The band names (`excellent`,
`good`, `fair`, `poor`) are kept separate from DORA's `elite/high/medium/low` to signal that
these are different classification systems.

**Future extension:** Add `cycleTimeBandThresholds: number[]` to `BoardConfig` so teams can
override the defaults per board. This requires a schema migration and Settings UI change; it is
out of scope for this proposal but the band functions should accept optional override thresholds
as a parameter to make the extension straightforward.

---

## Section 4 — Backend Changes

### 4.1 Database migration: `inProgressStatusNames` on `BoardConfig`

Add one new column to `board_configs`:

```typescript
// board-config.entity.ts — new field
@Column('simple-json', { default: '["In Progress"]' })
inProgressStatusNames!: string[];
```

**Migration file:** `backend/src/migrations/<timestamp>-AddInProgressStatusNamesToBoardConfigs.ts`

```typescript
export class AddInProgressStatusNamesToBoardConfigs<timestamp>
  implements MigrationInterface {

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs"
       ADD COLUMN IF NOT EXISTS "inProgressStatusNames" TEXT NOT NULL
       DEFAULT '["In Progress"]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs"
       DROP COLUMN IF EXISTS "inProgressStatusNames"`,
    );
  }
}
```

The `simple-json` column uses PostgreSQL `TEXT` with JSON serialisation by TypeORM. This
matches the existing pattern used by `failureIssueTypes`, `failureLabels`,
`incidentIssueTypes`, `recoveryStatusNames`, `backlogStatusIds`, and `incidentPriorities`.

The default `'["In Progress"]'` means all existing boards automatically work without
re-configuration, matching the hardcoded `'In Progress'` string currently in
`LeadTimeService` (line 109) and `MttrService` (line 127).

**Migration run:** `npm run build && npm run migration:run`

### 4.2 New `CycleTimeService`

**File:** `backend/src/metrics/cycle-time.service.ts`

This service is modelled after `LeadTimeService` in structure and DB access patterns. Key
differences:

- Uses `BoardConfig.inProgressStatusNames` (loaded from DB, not hardcoded).
- No `createdAt` fallback: issues without an in-progress transition are always excluded.
- Returns per-issue observations including both `cycleTimeDays` and `leadTimeDays` for
  queue time computation.
- No `isKanban` branch (see §1.5).

```typescript
export interface CycleTimeObservation {
  issueKey: string;
  summary: string;
  issueType: string;
  cycleTimeDays: number;
  leadTimeDays: number | null;   // null when Scrum fallback applies
  queueTimeDays: number | null;  // leadTimeDays - cycleTimeDays, or null
  startedAt: string;             // ISO — first in-progress transition
  completedAt: string;           // ISO — done transition
  jiraUrl: string;
}

export interface CycleTimeResult {
  boardId: string;
  p50Days: number;
  p75Days: number;
  p85Days: number;
  p95Days: number;
  medianDays: number;         // alias for p50Days for convenience
  sampleSize: number;
  skippedIssues: number;      // issues excluded (no in-progress transition)
  band: CycleTimeBand;        // 'excellent' | 'good' | 'fair' | 'poor'
  observations: CycleTimeObservation[];
}
```

**Key method signatures:**

```typescript
// Returns per-issue observations. Called by calculate() and by the trend endpoint.
async getCycleTimeObservations(
  boardId: string,
  startDate: Date,
  endDate: Date,
  issueTypeFilter?: string,   // optional — filter to one issue type
): Promise<{ observations: CycleTimeObservation[]; skipped: number }>

// Main public method — aggregates observations into CycleTimeResult.
async calculate(
  boardId: string,
  startDate: Date,
  endDate: Date,
  issueTypeFilter?: string,
): Promise<CycleTimeResult>
```

**Algorithm for `getCycleTimeObservations`:**

```
1. Load BoardConfig for boardId → inProgressStatusNames, doneStatusNames, boardType
2. Load all issues for boardId (filtered by issueType if provided)
3. Load all status changelogs for those issue keys (field='status', ordered ASC by changedAt)
4. For each issue:
   a. cycleStart = first changelog where toValue ∈ inProgressStatusNames
      → if none: skipped++ ; continue
   b. cycleEnd = first changelog where toValue ∈ doneStatusNames
                 AND changedAt ∈ [startDate, endDate]
      OR fixVersion.releaseDate ∈ [startDate, endDate] (fallback)
      → if none: continue (issue not completed in this period)
   c. cycleTimeDays = (cycleEnd - cycleStart) / ms_per_day
      → clamp to 0 if negative (data anomaly, log warning)
   d. leadTimeDays = compute using same logic as LeadTimeService:
        leadStart = cycleStart (same event) for issues with in-progress transition
                  = createdAt (Scrum fallback) if no in-progress transition
        Since we only reach this point if cycleStart exists, leadStart = cycleStart
        → leadTimeDays = cycleTimeDays in this code path (queue = 0)
        (True queue time requires a separate board-entry event; see §10 open question)
   e. Push CycleTimeObservation to results array
5. Sort observations by cycleTimeDays ASC
6. Return { observations, skipped }
```

> **Note on lead time / queue time relationship:** Because `LeadTimeService` uses the same
> first in-progress transition as the start event (not `createdAt`) when that transition
> exists, `leadTimeDays = cycleTimeDays` for the shared set of issues. Queue time is
> therefore 0 for issues with an in-progress transition, and undefined for issues using
> the `createdAt` fallback. The stacked bar visualisation in the issue table is therefore
> only meaningful for Scrum boards where some issues lack an in-progress transition. See the
> Open Questions section for the path to surfacing true queue time.

**DB query pattern:**
The service follows `LeadTimeService`'s bulk-fetch pattern: load all issues for the board in
one query, then all changelogs for those issue keys in one `IN (...)` query. No N+1 queries.

**Constructor injections:**
```typescript
constructor(
  @InjectRepository(JiraIssue) private readonly issueRepo: Repository<JiraIssue>,
  @InjectRepository(JiraChangelog) private readonly changelogRepo: Repository<JiraChangelog>,
  @InjectRepository(JiraVersion) private readonly versionRepo: Repository<JiraVersion>,
  @InjectRepository(BoardConfig) private readonly boardConfigRepo: Repository<BoardConfig>,
)
```
Identical set to `LeadTimeService` — no new repositories needed.

### 4.3 New cycle-time-bands file

**File:** `backend/src/metrics/cycle-time-bands.ts`

```typescript
export type CycleTimeBand = 'excellent' | 'good' | 'fair' | 'poor';

export function classifyCycleTime(
  medianDays: number,
  thresholds = [2, 5, 10],
): CycleTimeBand {
  if (medianDays <= thresholds[0]) return 'excellent';
  if (medianDays <= thresholds[1]) return 'good';
  if (medianDays <= thresholds[2]) return 'fair';
  return 'poor';
}

export function cycleTimeBandColor(band: CycleTimeBand): string {
  // Returns Tailwind classes — mirrors bandColor() in dora-bands.ts
  switch (band) {
    case 'excellent': return 'text-green-600 bg-green-50 border-green-200';
    case 'good':      return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'fair':      return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'poor':      return 'text-red-600 bg-red-50 border-red-200';
  }
}
```

The `thresholds` parameter future-proofs the function for per-board configuration without
requiring a signature change.

### 4.4 New DTOs

**File:** `backend/src/metrics/dto/cycle-time-query.dto.ts`

```typescript
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CycleTimeQueryDto {
  /** Comma-separated board IDs, or omitted for all boards */
  @ApiPropertyOptional() @IsOptional() @IsString() boardId?: string;

  /** YYYY-MM-DD:YYYY-MM-DD explicit range */
  @ApiPropertyOptional() @IsOptional() @IsString() period?: string;

  /** Single sprint ID */
  @ApiPropertyOptional() @IsOptional() @IsString() sprintId?: string;

  /** Quarter in YYYY-QN format */
  @ApiPropertyOptional() @IsOptional() @IsString() quarter?: string;

  /** Filter to a single Jira issue type, e.g. "Story" */
  @ApiPropertyOptional() @IsOptional() @IsString() issueType?: string;
}
```

**File:** `backend/src/metrics/dto/cycle-time-trend-query.dto.ts`

```typescript
export class CycleTimeTrendQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() boardId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() mode?: 'quarters' | 'sprints';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Max(20) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() issueType?: string;
}
```

**File:** `backend/src/metrics/dto/cycle-time-response.dto.ts`

```typescript
export interface CycleTimeObservation {
  issueKey: string;
  summary: string;
  issueType: string;
  cycleTimeDays: number;
  leadTimeDays: number | null;
  queueTimeDays: number | null;
  startedAt: string;
  completedAt: string;
  jiraUrl: string;
}

export interface CycleTimeResult {
  boardId: string;
  p50Days: number;
  p75Days: number;
  p85Days: number;
  p95Days: number;
  medianDays: number;
  sampleSize: number;
  skippedIssues: number;
  band: CycleTimeBand;
  observations: CycleTimeObservation[];
}

export type CycleTimeResponse = CycleTimeResult[];

export interface CycleTimeTrendPoint {
  label: string;
  start: string;
  end: string;
  medianCycleTimeDays: number;
  p85CycleTimeDays: number;
  sampleSize: number;
  band: CycleTimeBand;
}

export type CycleTimeTrendResponse = CycleTimeTrendPoint[];
```

### 4.5 New endpoints in `MetricsController`

Two new routes, declared **before** parameterised routes (consistent with `dora/aggregate` and
`dora/trend` ordering established in the existing controller):

```typescript
// backend/src/metrics/metrics.controller.ts — additions

@ApiOperation({ summary: 'Get cycle time observations and percentiles per board' })
@Get('cycle-time')
async getCycleTime(
  @Query() query: CycleTimeQueryDto,
): Promise<CycleTimeResponse> {
  return this.metricsService.getCycleTime(query);
}

@ApiOperation({ summary: 'Get cycle time trend across multiple periods' })
@Get('cycle-time/trend')
async getCycleTimeTrend(
  @Query() query: CycleTimeTrendQueryDto,
): Promise<CycleTimeTrendResponse> {
  return this.metricsService.getCycleTimeTrend(query);
}
```

**Route ordering note:** `cycle-time/trend` must be declared **before** `cycle-time` to
prevent NestJS treating `trend` as a path parameter. However, since neither endpoint uses a
path parameter and both are plain `@Get()` with different suffixes, NestJS will resolve them
correctly regardless of declaration order when no `@Param()` is in play. Declaring trend first
is still the safer convention, matching `dora/aggregate` before `dora`.

### 4.6 New methods in `MetricsService`

```typescript
// backend/src/metrics/metrics.service.ts — additions

async getCycleTime(query: CycleTimeQueryDto): Promise<CycleTimeResponse> {
  let { startDate, endDate } = this.resolvePeriod(query);
  const boardIds = this.resolveBoardIds(query.boardId);

  if (query.sprintId) {
    const sprint = await this.sprintRepo.findOne({ where: { id: query.sprintId } });
    if (sprint?.startDate && sprint?.endDate) {
      startDate = sprint.startDate;
      endDate = sprint.endDate;
    }
  }

  return Promise.all(
    boardIds.map((boardId) =>
      this.cycleTimeService.calculate(boardId, startDate, endDate, query.issueType),
    ),
  );
}

async getCycleTimeTrend(query: CycleTimeTrendQueryDto): Promise<CycleTimeTrendResponse> {
  const limit = query.limit ?? 8;
  const mode = query.mode ?? 'quarters';
  const boardIds = this.resolveBoardIds(query.boardId);

  if (mode === 'sprints') {
    // Single board only — same guard as getDoraTrend (RC-8 pattern)
    const boardId = boardIds[0];
    const boardConfig = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (boardConfig?.boardType === 'kanban') {
      throw new BadRequestException(
        `Sprint trend mode requires a Scrum board. ${boardId} is a Kanban board.`,
      );
    }
    const sprints = await this.sprintRepo.find({
      where: { boardId, state: 'closed' },
      order: { endDate: 'DESC' },
      take: limit,
    });
    const points = await Promise.all(
      sprints.map(async (sprint): Promise<CycleTimeTrendPoint> => {
        const start = sprint.startDate ?? new Date();
        const end = sprint.endDate ?? new Date();
        const result = await this.cycleTimeService.calculate(
          boardId, start, end, query.issueType,
        );
        return {
          label: sprint.name,
          start: start.toISOString(),
          end: end.toISOString(),
          medianCycleTimeDays: result.p50Days,
          p85CycleTimeDays: result.p85Days,
          sampleSize: result.sampleSize,
          band: result.band,
        };
      }),
    );
    return points.reverse(); // oldest → newest
  }

  // Quarter mode
  const quarters = listRecentQuarters(limit);
  const points = await Promise.all(
    quarters.map(async (q): Promise<CycleTimeTrendPoint> => {
      // Pool observations across all selected boards for a true cross-board median
      const results = await Promise.all(
        boardIds.map((boardId) =>
          this.cycleTimeService.getCycleTimeObservations(
            boardId, q.startDate, q.endDate, query.issueType,
          ),
        ),
      );
      const allObs = results.flatMap((r) => r.observations);
      const sorted = allObs.map((o) => o.cycleTimeDays).sort((a, b) => a - b);
      return {
        label: q.label,
        start: q.startDate.toISOString(),
        end: q.endDate.toISOString(),
        medianCycleTimeDays: round2(percentile(sorted, 50)),
        p85CycleTimeDays: round2(percentile(sorted, 85)),
        sampleSize: sorted.length,
        band: classifyCycleTime(percentile(sorted, 50)),
      };
    }),
  );
  return points.reverse(); // oldest → newest
}
```

### 4.7 Module registration

**`backend/src/metrics/metrics.module.ts`** — add `CycleTimeService` to `providers`:

```typescript
providers: [
  MetricsService,
  DeploymentFrequencyService,
  LeadTimeService,
  CfrService,
  MttrService,
  CycleTimeService,   // ← add
],
```

`CycleTimeService` reuses the already-registered `TypeOrmModule.forFeature` entities
(`JiraIssue`, `JiraChangelog`, `JiraVersion`, `BoardConfig`). No new entity registrations.

### 4.8 Board config changes: `UpdateBoardConfigDto` and `BoardsService`

Add `inProgressStatusNames` to the update DTO:

```typescript
// backend/src/boards/dto/update-board-config.dto.ts — addition
@ApiPropertyOptional({
  type: [String],
  example: ['In Progress', 'In Development'],
  description: 'Status names that indicate active work has begun (cycle time start)',
})
@IsOptional()
@IsArray()
@IsString({ each: true })
inProgressStatusNames?: string[];
```

No changes needed to `BoardsService` — it uses `boardConfigRepo.merge(config, dto)` which
automatically persists any new field present on `BoardConfig`.

---

## Section 5 — Frontend Changes

### 5.1 New page: `/cycle-time`

**File:** `frontend/src/app/cycle-time/page.tsx`

**State model:**

```typescript
type CycleTimePageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'
      results: CycleTimeResult[]
      trend: CycleTimeTrendPoint[]
    }
```

**API calls per filter change (two, in parallel):**
1. `GET /api/metrics/cycle-time?boardId=...&quarter=...&issueType=...`
   → `CycleTimeResult[]` (percentiles + observations per board)
2. `GET /api/metrics/cycle-time/trend?boardId=...&mode=quarters&limit=8`
   → `CycleTimeTrendPoint[]` (median per period for trend chart)

**Page layout** (described textually — see ASCII diagram in §5.2):
- Filter bar: board chips (single-select or multi-select), period toggle (sprint/quarter),
  issue type filter (All / Story / Bug / Task / etc.)
- Percentile summary section: four stat cards — p50, p75, p85, p95 cycle time (pooled across
  selected boards)
- Queue time footnote beneath the percentile cards: "Median queue time: X days"
- Distribution scatter plot: each issue as a dot, x-axis = completion date, y-axis =
  cycle time in days; dots coloured by `CycleTimeBand`
- Trend line chart: median cycle time per period (last 8 quarters or last 8 sprints)
- Per-issue table: sortable by cycle time, filterable; shows key, summary, issue type,
  cycle time, queue time, band badge

### 5.2 Page layout (ASCII)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cycle Time                          [Quarter ▾] [2026-Q1 ▾]        │
│  Time from work started to done — excluding pre-work queue           │
├─────────────────────────────────────────────────────────────────────┤
│  Board: [ACC ✓] [BPT ✓] [SPS ✓] [OCS ✓] [DATA ✓] [PLAT ✓]        │
│  Issue type: [All] [Story] [Bug] [Task] [Spike]                     │
├──────────────┬──────────────┬──────────────┬──────────────┐         │
│  p50 Cycle   │  p75 Cycle   │  p85 Cycle   │  p95 Cycle   │         │
│  Time        │  Time        │  Time        │  Time        │         │
│              │              │              │              │         │
│   3.1 days   │   5.8 days   │   9.2 days   │  18.4 days   │         │
│  [Good ●]    │  [Fair ●]    │  [Fair ●]    │  [Poor ●]    │         │
│  n=142       │  n=142       │  n=142       │  n=142       │         │
│              │  Median queue time: 1.4 days (42 issues had queue)   │
├─────────────────────────────────────────────────────────────────────┤
│ Distribution — 2026-Q1 (142 issues)                                 │
│  days                                                               │
│  30 │                           ●                                   │
│  20 │              ●      ●  ●     ●                                │
│  10 │     ●  ●  ●  ●  ● ●●  ●●●●  ●●●●  ●                         │
│   5 │  ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●                           │
│   0 ├────────────────────────────────────────────── date            │
│     Jan    Feb    Mar   [● Excellent ● Good ● Fair ● Poor]          │
├─────────────────────────────────────────────────────────────────────┤
│ Trend (last 8 quarters) — median cycle time                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  [line chart: p50 solid, p85 dashed]                         │   │
│  └──────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│ Issues (142)              [Search key or summary…]   [Export CSV]   │
│  Issue  │ Summary       │ Type  │ Cycle (d) │ Queue (d) │ Band      │
│  ───────┼───────────────┼───────┼───────────┼───────────┼────────   │
│  ACC-42 │ Auth refresh… │ Story │   2.1     │   1.4     │ Excellent │
│  ACC-71 │ Fix pipeline… │ Bug   │   3.8     │   0.0     │ Good      │
│  BPT-19 │ Migrate DB…   │ Task  │  12.4     │   0.5     │ Poor      │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 New components

**`CycleTimePercentileCard`** (`frontend/src/components/ui/cycle-time-percentile-card.tsx`)

```typescript
interface CycleTimePercentileCardProps {
  percentile: 'p50' | 'p75' | 'p85' | 'p95'
  days: number
  sampleSize: number
  band: CycleTimeBand
}
```

Renders: percentile label, value in days, `CycleTimeBandBadge`, sample size footnote.
Simpler than `OrgMetricCard` — no sparkline, no contributing-boards count.

**`CycleTimeBandBadge`** (`frontend/src/components/ui/cycle-time-band-badge.tsx`)

```typescript
interface CycleTimeBandBadgeProps {
  band: CycleTimeBand
}
```

Analogous to `BandBadge` but uses `cycleTimeBandColor()` from `frontend/src/lib/cycle-time-bands.ts`.

**`CycleTimeScatterPlot`** (`frontend/src/components/ui/cycle-time-scatter-plot.tsx`)

Uses Recharts `ScatterChart` (already available — no new npm dependencies). Data shape:

```typescript
interface ScatterPoint {
  x: number          // Unix ms timestamp of completedAt
  y: number          // cycleTimeDays
  issueKey: string
  band: CycleTimeBand
}
```

Dots are coloured by band using a custom `shape` renderer. X-axis shows month/week labels.
Tooltip shows `issueKey`, `cycleTimeDays`, `completedAt`.

**`CycleTimeTrendChart`** — inline in `cycle-time/page.tsx` or extracted as a shared
`TrendChart` component. The existing inline `TrendChart` in `dora/page.tsx` should be
extracted to `frontend/src/components/ui/trend-chart.tsx` so both pages share it (see §7
migration steps). If this extraction is not done first, duplicate the pattern inline.

**`CycleTimeIssueTable`** — uses existing `DataTable` component. No new table component
needed. Columns:

```typescript
const columns: Column<CycleTimeObservation>[] = [
  { key: 'issueKey',      label: 'Issue',     sortable: true,
    render: (v, row) => <a href={row.jiraUrl}>...</a> },
  { key: 'summary',       label: 'Summary',   sortable: true },
  { key: 'issueType',     label: 'Type',      sortable: true },
  { key: 'cycleTimeDays', label: 'Cycle (d)', sortable: true,
    render: (v) => Number(v).toFixed(1) },
  { key: 'queueTimeDays', label: 'Queue (d)', sortable: true,
    render: (v) => v !== null ? Number(v).toFixed(1) : '—' },
  { key: 'band',          label: 'Band',      sortable: true,
    render: (v) => <CycleTimeBandBadge band={v as CycleTimeBand} /> },
]
```

### 5.4 API client additions (`frontend/src/lib/api.ts`)

```typescript
// ---- Cycle Time types ----------------------------------------------------

export type CycleTimeBand = 'excellent' | 'good' | 'fair' | 'poor'

export interface CycleTimeObservation {
  issueKey: string
  summary: string
  issueType: string
  cycleTimeDays: number
  leadTimeDays: number | null
  queueTimeDays: number | null
  startedAt: string
  completedAt: string
  jiraUrl: string
}

export interface CycleTimeResult {
  boardId: string
  p50Days: number
  p75Days: number
  p85Days: number
  p95Days: number
  medianDays: number
  sampleSize: number
  skippedIssues: number
  band: CycleTimeBand
  observations: CycleTimeObservation[]
}

export type CycleTimeResponse = CycleTimeResult[]

export interface CycleTimeTrendPoint {
  label: string
  start: string
  end: string
  medianCycleTimeDays: number
  p85CycleTimeDays: number
  sampleSize: number
  band: CycleTimeBand
}

export type CycleTimeTrendResponse = CycleTimeTrendPoint[]

export interface CycleTimeQueryParams {
  boardId?: string
  period?: string
  sprintId?: string
  quarter?: string
  issueType?: string
}

export interface CycleTimeTrendParams {
  boardId?: string
  mode?: 'quarters' | 'sprints'
  limit?: number
  issueType?: string
}

// ---- Cycle Time endpoint wrappers ----------------------------------------

export function getCycleTime(
  params: CycleTimeQueryParams,
): Promise<CycleTimeResponse> {
  return apiFetch(
    `/api/metrics/cycle-time${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
      issueType: params.issueType,
    })}`,
  )
}

export function getCycleTimeTrend(
  params: CycleTimeTrendParams,
): Promise<CycleTimeTrendResponse> {
  return apiFetch(
    `/api/metrics/cycle-time/trend${toQueryString({
      boardId: params.boardId,
      mode: params.mode,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      issueType: params.issueType,
    })}`,
  )
}
```

### 5.5 Sidebar navigation

Add a `CycleTime` entry to `frontend/src/components/layout/sidebar.tsx`:

```typescript
import { BarChart3, Target, Map, Settings, Timer } from 'lucide-react'

const NAV_ITEMS: NavItem[] = [
  { label: 'DORA',       href: '/dora',       icon: <BarChart3 className="h-5 w-5" /> },
  { label: 'Cycle Time', href: '/cycle-time', icon: <Timer className="h-5 w-5" /> },
  { label: 'Planning',   href: '/planning',   icon: <Target className="h-5 w-5" /> },
  { label: 'Roadmap',    href: '/roadmap',    icon: <Map className="h-5 w-5" /> },
  { label: 'Settings',   href: '/settings',   icon: <Settings className="h-5 w-5" /> },
]
```

`Timer` is available in the existing `lucide-react` package — no new npm dependency.

### 5.6 Settings page: `inProgressStatusNames` editor

The Settings page (`frontend/src/app/settings/page.tsx`) already renders `BoardConfig` fields
as editable inputs. The `inProgressStatusNames` field should be exposed the same way
`doneStatusNames` is today: as a comma-separated text input that maps to `string[]` on save.

No new component is needed — follow the existing pattern. The `BoardConfig` type in `api.ts`
needs one new field:

```typescript
// frontend/src/lib/api.ts — BoardConfig interface addition
export interface BoardConfig {
  // ... existing fields ...
  inProgressStatusNames: string[]   // ← add
}
```

---

## Section 6 — Data Model Changes

| Entity | Change | Migration required |
|---|---|---|
| `BoardConfig` | Add `inProgressStatusNames: string[]`, default `['In Progress']` | Yes — `<timestamp>-AddInProgressStatusNamesToBoardConfigs.ts` |
| `JiraIssue` | None | No |
| `JiraChangelog` | None | No |
| `JiraVersion` | None | No |
| `JiraSprint` | None | No |

The migration is additive with a non-null default that preserves existing behaviour. No
existing rows are affected destructively.

**Index assessment:** The existing composite index on `jira_changelogs` (added in migration
`1775795358706-AddChangelogIndex.ts`) should already cover the query pattern used by
`CycleTimeService` (filter by `issueKey IN (...)`, `field = 'status'`, order by `changedAt`).
No new index is required at this stage. If cycle-time trend queries over 8 quarters prove slow,
an index on `jira_issues(boardId, issueType)` would help the issue-type filter path.

---

## Section 7 — Migration Path

All steps are additive and non-breaking. Existing endpoints are untouched throughout.

### Phase 1 — Schema (Day 1, ~15 min)

1. Add `inProgressStatusNames: string[]` to `BoardConfig` entity
   (`backend/src/database/entities/board-config.entity.ts`).
2. Write and run migration `<timestamp>-AddInProgressStatusNamesToBoardConfigs.ts`.
   Command: `npm run build && npm run migration:run`.
3. Verify: `SELECT "inProgressStatusNames" FROM board_configs LIMIT 3;` — expect
   `["In Progress"]` for all existing rows.

### Phase 2 — Backend service and endpoints (~2–3 hrs)

4. Create `backend/src/metrics/cycle-time-bands.ts`.
5. Create `backend/src/metrics/cycle-time.service.ts` with `getCycleTimeObservations()`
   and `calculate()`. Write unit tests in `cycle-time.service.spec.ts` following the
   pattern in `lead-time.service.spec.ts`.
6. Create DTOs: `cycle-time-query.dto.ts`, `cycle-time-trend-query.dto.ts`,
   `cycle-time-response.dto.ts`.
7. Add `getCycleTime()` and `getCycleTimeTrend()` to `MetricsService`.
8. Register `CycleTimeService` in `MetricsModule`.
9. Add `@Get('cycle-time/trend')` and `@Get('cycle-time')` routes to `MetricsController`
   (trend before main to preserve route-specificity convention).
10. Add `inProgressStatusNames` to `UpdateBoardConfigDto`.
11. **Smoke test:** `curl -H "X-API-Key: passyword" "http://localhost:3001/api/metrics/cycle-time?boardId=ACC&quarter=2026-Q1"` — expect a `CycleTimeResult[]` response.

### Phase 3 — Frontend (~3–4 hrs)

12. Add `CycleTimeBand`, `CycleTimeObservation`, `CycleTimeResult`, `CycleTimeTrendPoint`,
    `getCycleTime()`, `getCycleTimeTrend()` to `frontend/src/lib/api.ts`.
13. Add `inProgressStatusNames` to `BoardConfig` interface in `api.ts`.
14. Create `frontend/src/lib/cycle-time-bands.ts` (mirrors backend).
15. Create `frontend/src/components/ui/cycle-time-band-badge.tsx`.
16. Create `frontend/src/components/ui/cycle-time-percentile-card.tsx`.
17. Create `frontend/src/components/ui/cycle-time-scatter-plot.tsx`.
18. Create `frontend/src/app/cycle-time/page.tsx`.
19. Add `Timer` icon + `Cycle Time` nav item to `sidebar.tsx`.
20. Add `inProgressStatusNames` input to the Settings board-config editor.

### Phase 4 — Optional shared refactor (can be done independently)

21. Extract the `TrendChart` component inline in `dora/page.tsx` to
    `frontend/src/components/ui/trend-chart.tsx` and import it from both `/dora` and
    `/cycle-time`. This is optional — the cycle-time page can use an inline copy initially.

---

## Alternatives Considered

### Alternative A — Surface cycle time as a tab on the `/dora` page

Add a "Cycle Time" tab to the existing DORA page alongside Lead Time rather than a dedicated
route.

**Why ruled out:** The cycle-time report has qualitatively different visualisations from the
DORA page. DORA shows org-level aggregate hero cards with board breakdowns. Cycle time needs a
distribution scatter plot and a per-issue table — substantially different content. Combining
them would make the DORA page unwieldy. A separate `/cycle-time` route keeps concerns separated
and matches the established pattern (each major view has its own route: `/dora`, `/planning`,
`/roadmap`).

### Alternative B — Hardcode `inProgressStatusNames` as `['In Progress']` permanently

Do not add the `inProgressStatusNames` column to `BoardConfig` and keep the logic hardcoded
the way `LeadTimeService` currently does (line 109).

**Why ruled out:** This is technically simpler in the short term but creates a recurring support
problem. Teams using Jira project templates with non-standard status names (e.g. `'In Dev'`,
`'Doing'`, `'Active'`) will get zero cycle time observations and no diagnostic about why. The
`doneStatusNames` field was added precisely because hardcoded done-status strings (`'Done'`)
failed for boards with custom workflows. The same argument applies here. The migration cost is
low (one `TEXT` column with a safe default) and the Settings UI change is trivial.

### Alternative C — Compute cycle time as a subset of the existing lead-time endpoint

Extend `LeadTimeService.calculate()` to return both lead time and cycle time in a single
response, rather than a separate `CycleTimeService`.

**Why ruled out:** Violates single-responsibility. `LeadTimeService` is a well-defined unit
tested service with a clear contract. Mixing cycle-time computation into it would complicate
the existing DORA aggregate pipeline (0006 redesign) and make future independent evolution of
each metric harder. The `CycleTimeService` can share utility functions with `LeadTimeService`
(both use `percentile()`, `round2()` from `statistics.ts`) without coupling the services
themselves. The separate-service approach also allows cycle time to have its own band
classification system, trend endpoint, and DTO shape without retrofitting lead time's.

### Alternative D — Compute queue time as a first-class server-side metric

Add a `BoardEntryStatusNames` config (e.g. `['To Do', 'Open', 'Backlog']`) and compute true
queue time as `firstInProgress − firstBoardEntry` on the backend, returning it in a separate
`queueTime` field.

**Why ruled out for this proposal:** This requires an additional configurable array and a more
complex algorithm that must handle issues that arrive in an active status with no board-entry
event. As noted in §2.1, the current implementation results in `queueTimeDays ≈ 0` for most
issues (because lead time and cycle time share the same start event). True queue time
measurement is a meaningful enhancement but depends on clearer definition of "board entry"
which varies by project type. It is deferred to a follow-up proposal. The issue table in this
report will show the `queueTimeDays` column as `'—'` for most issues, which is honest about
the current data model's limitations.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | One new `TEXT NOT NULL DEFAULT` column on `board_configs`. Additive, reversible, safe default. |
| API contract | Additive only | Two new endpoints (`GET /api/metrics/cycle-time`, `GET /api/metrics/cycle-time/trend`). No existing endpoints changed. |
| Frontend | New page + 3 new components | `cycle-time/page.tsx` (new), `cycle-time-band-badge.tsx`, `cycle-time-percentile-card.tsx`, `cycle-time-scatter-plot.tsx`. `sidebar.tsx` gets one nav item. `api.ts` gets new types and wrappers. `settings/page.tsx` gets one new input field. |
| Tests | New unit tests | `cycle-time.service.spec.ts` (backend). Component tests for new UI components. |
| Jira API | No new calls | All required data is already in PostgreSQL from the existing sync. `inProgressStatusNames` uses the same `jira_changelogs` table as lead time. |
| Performance | Comparable to lead-time | `CycleTimeService` follows the same bulk-fetch pattern as `LeadTimeService`. Query count per board is identical. The trend endpoint uses `Promise.all` for parallel period computation (consistent with the pattern established in 0006). |
| Existing metrics | None | `LeadTimeService`, `MttrService`, and `DeploymentFrequencyService` are not modified. The DORA aggregate/trend endpoints are not changed. |

---

## Open Questions

1. **True queue time (board entry event):** As described in §2.1, the current data model
   causes `queueTimeDays = 0` for most issues because lead time and cycle time share the same
   start event (first in-progress transition). To surface meaningful queue time, a future
   proposal should define `boardEntryStatusNames` (e.g. `['To Do', 'Open', 'Backlog']`) and
   compute `firstInProgress − firstBoardEntry`. Should this be in scope for this proposal or
   a follow-up? **Proposed resolution: follow-up.** The cycle-time report ships with queue
   time shown as `'—'` for most issues, with an informational tooltip explaining the
   limitation.

2. **Issue type filter scope:** The `issueType` query param filters `CycleTimeService` to a
   single type. Should `'Story'` also implicitly exclude sub-tasks and bugs? Teams often want
   to see Stories-only cycle time (the core delivery unit). The current design passes the
   `issueType` string directly to `issueRepo.find({ where: { boardId, issueType } })` with
   no implicit exclusions. Is this correct, or should we exclude sub-task types regardless of
   filter? **Proposed resolution: no implicit exclusions** — the filter is exact-match. Teams
   can select `'Story'` to see only stories.

3. **Configurable band thresholds:** The proposed defaults (≤2d Excellent, ≤5d Good, ≤10d
   Fair) are reasonable but may not suit all teams. Should `cycleTimeBandThresholds` be
   persisted on `BoardConfig` from day one, or added as a follow-up? **Proposed resolution:
   follow-up.** The `classifyCycleTime()` function accepts optional threshold overrides as
   a parameter, so the extension path is open. The Settings UI for threshold configuration is
   out of scope for this proposal to avoid scope creep.

4. **Cycle time > lead time (data anomaly):** Can occur when a re-open event extends cycle
   time past what lead time measures, or due to timezone/DST edge cases in `changedAt`
   timestamps. The service should log a warning and clamp the value to `max(0, computed)`.
   Should anomalous issues be surfaced to the user (e.g. a warning count in the response)?
   **Proposed resolution:** include an `anomalyCount: number` field in `CycleTimeResult`
   (count of issues where `cycleTimeDays > leadTimeDays` or where negative before clamp).
   No UI change needed initially — this field is available for future diagnostic tooling.

5. **Scatter plot performance:** The scatter plot renders up to N dots (one per issue) for
   the selected period. For a board with 500 issues in a quarter, this is 500 SVG elements.
   Recharts `ScatterChart` handles this well below ~1000 points, but larger boards may need
   canvas-based rendering. At current data volumes (internal tool, 6 boards) this is not an
   issue. If it becomes one, replace the Recharts `ScatterChart` with a CSS-grid heatmap
   alternative.

6. **Sprint trend mode for multi-board selection:** The trend endpoint in sprint mode
   requires a single `boardId` (matching the pattern from `getDoraTrend` in 0006). The
   frontend should disable sprint mode when multiple boards are selected on the cycle-time
   page, using the same pattern as the DORA page (check `selectedBoards.length === 1 &&
   !kanbanBoardIds.has(selectedBoards[0])`).

---

## Acceptance Criteria

- [ ] **Migration:** After running `npm run build && npm run migration:run`, the
  `board_configs` table has a new `inProgressStatusNames` column with value `["In Progress"]`
  for all existing rows.

- [ ] **BoardConfig entity:** `BoardConfig.inProgressStatusNames: string[]` is declared with
  `@Column('simple-json', { default: '["In Progress"]' })` and round-trips correctly through
  `updateBoardConfig()`.

- [ ] **`CycleTimeService.calculate()`** returns `sampleSize > 0` and a non-zero `p50Days`
  for a board with issues that have status transitions through `inProgressStatusNames` to
  `doneStatusNames` within the query period. Verified by unit tests in
  `cycle-time.service.spec.ts`.

- [ ] **Issues without an in-progress transition** are excluded from `observations[]` and
  their count is reflected in `skippedIssues`. Verified by unit test with mock data
  containing issues that transition directly from `'To Do'` to `'Done'`.

- [ ] **Re-opened issues** are counted once, using the first in-progress transition as start
  and the last done-transition in the period as end. Verified by unit test.

- [ ] **`GET /api/metrics/cycle-time?boardId=ACC&quarter=2026-Q1`** returns
  `CycleTimeResponse` (array of `CycleTimeResult`) with the correct `boardId` and
  non-negative percentile values. Verifiable via curl with API key `passyword`.

- [ ] **`GET /api/metrics/cycle-time/trend?boardId=ACC&mode=quarters&limit=4`** returns
  4 `CycleTimeTrendPoint` objects in chronological order (oldest → newest).

- [ ] **`GET /api/metrics/cycle-time/trend?boardId=PLAT&mode=sprints`** returns HTTP 400
  with message `"Sprint trend mode requires a Scrum board. PLAT is a Kanban board."`.

- [ ] **Existing `GET /api/metrics/dora` and related endpoints** are unchanged. All existing
  tests continue to pass.

- [ ] **`/cycle-time` page** loads without error, makes exactly 2 API calls on initial
  render, and renders the percentile summary cards, scatter plot, trend chart, and issue
  table. Verifiable via browser Network tab.

- [ ] **`CycleTimeBandBadge`** renders the correct band label and Tailwind colour class for
  each of the four bands. Verified by Vitest component test.

- [ ] **Issue table** shows `'—'` for `queueTimeDays` when the value is `null`, and a
  numeric value (1 decimal place) when non-null. Verified by Vitest component test.

- [ ] **Sidebar** shows "Cycle Time" as a navigation item with the `Timer` icon, and the
  active link highlights correctly when on `/cycle-time` or any child route.

- [ ] **Settings page** shows an editable `inProgressStatusNames` field for each board's
  config form, and saving it updates the field in PostgreSQL.

- [ ] **Sprint mode** is automatically disabled (button greyed out, tooltip shown) when
  multiple boards or a Kanban board is selected on the `/cycle-time` page.

- [ ] **`anomalyCount`** is present in `CycleTimeResult`. When `anomalyCount > 0`, a
  visible indicator (e.g. an amber info icon with tooltip "N issues had data anomalies
  and were clamped to 0") is shown in the percentile summary section.
