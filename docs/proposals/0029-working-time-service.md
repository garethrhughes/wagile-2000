# 0029 — Working-Time Service: Exclude Weekends from Flow Metrics

**Date:** 2026-04-15
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** None yet — will be created on acceptance

---

## Problem Statement

Every duration calculation in the project today uses raw calendar milliseconds.
`CycleTimeService` computes `(cycleEnd - cycleStart) / 86_400_000`; `LeadTimeService` and
`SprintDetailService.leadTimeDays` do the same; `MttrService` divides by `3_600_000` for
hours. None of these subtract weekend time.

The practical effect: an issue started at 17:00 Friday and completed at 09:00 Monday
registers as **2.67 calendar days** of cycle time when the actual engineering effort was
**~0.1 working days**. Weekend inflation skews every percentile upward, pushes DORA
classifications one band lower than warranted, and makes Sprint Report composite scores
worse than reality. For teams that routinely finish issues over multi-day spans that straddle
weekends, the distortion can be a full band (e.g. the median appearing in the "medium" band
when the true working-day median is "high").

Five separate services contain independent `getTime()` subtraction expressions that are
all affected. There is no shared utility: fixing one service does not fix the others.

---

## Scope: Which Metrics Are Affected and How

| Metric | Affected? | Rationale |
|---|---|---|
| **Cycle time** (`CycleTimeService`) | ✅ Yes — exclude weekends | Engineering work does not happen on weekends. A 3-day calendar span Mon→Thu = 3 working days; a span Fri→Tue = 1 working day. |
| **Lead time** (`LeadTimeService`, `SprintDetailService`) | ✅ Yes — exclude weekends | Same rationale as cycle time. Lead time measures customer-perceived flow; pausing the clock over weekends is the industry norm for internal engineering tools. |
| **MTTR** (`MttrService`) | ⚠️ No — keep calendar hours | Incidents do not pause on weekends. A P1 outage that starts Saturday must be restored regardless of the day. Using calendar hours here is correct and matches industry standard. |
| **Deployment frequency** (`DeploymentFrequencyService`) | ❌ No — keep calendar days | Frequency is measured as deployments-per-calendar-day. Working-day normalisation would inflate this metric and produce misleadingly high rates. |
| **CFR** (`CfrService`) | ❌ No change needed | CFR is a ratio (failures / deployments) with no duration component. |
| **Sprint planning metrics** (`PlanningService`, `SprintDetailService`) | ❌ No change needed | Sprint dates, grace periods, and membership reconstruction all operate on calendar-time windows that should not be truncated. |
| **Kanban quarter/week bucketing** (`PlanningService`) | ❌ No change needed | Bucketing uses board-entry dates to assign issues to calendar periods. This is correct behaviour — a Friday board-entry belongs in the Friday week. |
| **Deployment frequency `periodDays`** (`DeploymentFrequencyService:104`) | ❌ No change needed | The denominator is the calendar length of the query window, which is correct. |

### Precise Code Locations Requiring Change

```
backend/src/metrics/cycle-time.service.ts:242
  const rawDays = (cycleEnd.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);

backend/src/metrics/lead-time.service.ts:181
  const days = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);

backend/src/sprint/sprint-detail.service.ts:529-536
  const rawDays = (doneTransition.changedAt.getTime() - startTime.getTime()) / 86_400_000;
```

The `MttrService` duration at `mttr.service.ts:157` (`/ (1000 * 60 * 60)`) should be
explicitly left as calendar hours (unchanged) with a comment documenting the decision.

---

## Proposed Solution

### 1. New `WorkingTimeService`

A single, pure-utility NestJS provider in `backend/src/metrics/working-time.service.ts`.
It is the **only** place in the codebase that converts a `[start, end]` interval into a
working-time duration. All other services call it instead of doing their own arithmetic.

#### Public API

```typescript
/**
 * Returns the number of working hours between two dates, excluding weekends
 * (Saturday and Sunday) and optionally a list of public holidays.
 *
 * The calculation is performed in the configured IANA timezone (TIMEZONE env var)
 * so that a Saturday in Sydney is not counted as Friday UTC.
 *
 * @param start  — Inclusive start instant (e.g. first In Progress transition)
 * @param end    — Inclusive end instant (e.g. Done transition)
 * @param config — Working-time rules; defaults used when omitted
 * @returns      — Non-negative number of working hours (fractional)
 */
workingHoursBetween(
  start: Date,
  end: Date,
  config?: WorkingTimeConfig,
): number;

/**
 * Convenience wrapper: converts working hours to working days using the
 * configured `hoursPerDay` (default 8).
 */
workingDaysBetween(
  start: Date,
  end: Date,
  config?: WorkingTimeConfig,
): number;
```

#### `WorkingTimeConfig` interface

```typescript
export interface WorkingTimeConfig {
  /** IANA timezone in which weekdays are evaluated. Default: TIMEZONE env var. */
  timezone: string;

  /** Days of the working week, 0 = Sunday, 6 = Saturday. Default: [1,2,3,4,5] (Mon–Fri). */
  workDays: number[];  // e.g. [0,1,2,3,4] for Sun–Thu teams

  /** Number of working hours per day. Used by workingDaysBetween(). Default: 8. */
  hoursPerDay: number;

  /** ISO date strings (YYYY-MM-DD) to treat as non-working regardless of weekday. */
  holidays: string[];
}
```

#### Algorithm

The algorithm counts working time by iterating over calendar-day boundaries between
`start` and `end` in the configured timezone:

```
1. If start >= end, return 0.
2. Split the interval at calendar-day boundaries in `tz`:
   For each day boundary from ceil(start) to floor(end):
     - Classify the day (working vs non-working) using `workDays` and `holidays`.
     - Accumulate the overlap of [start, end] that falls within working hours.
3. Working hours per day = full day if it is a working day; 0 otherwise.
   (This implementation uses "working day = any time that day"; not clock-hour bounded.)
4. Add fractional time for partial first and last days:
   - First partial day: if it is a working day, count the portion from `start`
     to midnight (local).
   - Last partial day: if it is a working day, count the portion from midnight (local)
     to `end`.
5. Return total accumulated hours.
```

**Important edge case — Kanban boards, no sprints**: The algorithm is stateless and date-
only; it does not need to know whether the board is Scrum or Kanban. It will work for any
two timestamps.

**Important edge case — start and end on the same weekend day**: Returns 0. This is the
correct result — no working time elapsed.

**Important edge case — partial weekday**: If an issue starts at 23:59 Friday and completes
at 00:01 Monday, the result is approximately 2/1440 days (the Friday fraction) + 1/1440
days (the Monday fraction). This is correct and intentional — we count all hours within a
working day, not just business hours within a working day (see Alternatives § for the
clock-hours variant).

#### Implementation Notes

- Uses `tz-utils.ts:dateParts()` already in the codebase for timezone-aware calendar day
  boundaries — no new timezone dependency.
- No external libraries. Pure TypeScript using `Intl.DateTimeFormat` (already used by
  `tz-utils.ts`).
- Deterministic and testable: given two fixed timestamps and a config, the result is always
  the same.

---

### 2. Configuration: Where Working-Time Rules Live

Working-time configuration has **two levels** of scope in this system:

| Setting | Scope | Rationale |
|---|---|---|
| `workDays` | Global (all boards) | A team's working week is an org-wide setting, not per-board. |
| `hoursPerDay` | Global | Same rationale. |
| `holidays` | Global | Public holidays are country-wide. Teams working different public holiday schedules is an edge case not worth supporting initially. |
| `excludeWeekendsFromCycleTime` | Global (toggle) | Provides a kill-switch while teams calibrate to the new metric values. |

**Decision: extend `boards.yaml` with a new top-level `workingTime:` stanza**, following
the precedent of the `jira:` stanza introduced in Proposal 0028. This keeps all deployment-
time configuration in one file.

#### New YAML stanza

```yaml
workingTime:
  # Set to false to revert to calendar-day durations across all boards.
  # Default: true
  excludeWeekends: true

  # Days of the week considered working days.
  # 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  # Default: [1, 2, 3, 4, 5]  (Mon–Fri)
  workDays:
    - 1
    - 2
    - 3
    - 4
    - 5

  # Number of working hours per day.
  # Used to convert working hours to working days.
  # Default: 8
  hoursPerDay: 8

  # Optional list of public holidays to exclude (YYYY-MM-DD format).
  # Treated as non-working days regardless of the weekday setting.
  # Default: []
  holidays:
    - "2026-01-01"  # New Year's Day
    - "2026-12-25"  # Christmas Day
```

#### Where it is persisted

A new **`WorkingTimeConfig` entity** (singleton row, PK=1, table `working_time_config`)
mirrors the pattern of `JiraFieldConfig` introduced in Proposal 0028. The YAML stanza is
read by `YamlConfigService.applyBoardsYaml()` and upserted on boot.

```typescript
// database/entities/working-time-config.entity.ts
@Entity('working_time_config')
export class WorkingTimeConfigEntity {
  @PrimaryColumn()
  id!: number; // Always 1 — singleton

  @Column({ type: 'boolean', default: true })
  excludeWeekends!: boolean;

  @Column({ type: 'simple-json', default: '[1,2,3,4,5]' })
  workDays!: number[];

  @Column({ type: 'integer', default: 8 })
  hoursPerDay!: number;

  @Column({ type: 'simple-json', default: '[]' })
  holidays!: string[];  // ISO date strings "YYYY-MM-DD"
}
```

**Rationale for a Postgres entity vs reading from env**: The existing pattern in this
project stores all operator-tunable config in Postgres (loaded from YAML). This makes the
values queryable, auditable, and consistent with how `BoardConfig`, `JiraFieldConfig`, and
`RoadmapConfig` are managed.

---

### 3. Integration Points

`WorkingTimeService` is injected into the three affected services. It loads
`WorkingTimeConfigEntity` once per request (or cached within a single service invocation)
and passes the resolved `WorkingTimeConfig` object to `workingDaysBetween()`.

#### `CycleTimeService`

```typescript
// Before:
const rawDays =
  (cycleEnd.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);

// After:
const rawDays = config.excludeWeekends
  ? this.workingTimeService.workingDaysBetween(cycleStart, cycleEnd, wtConfig)
  : (cycleEnd.getTime() - cycleStart.getTime()) / 86_400_000;
```

Same substitution applies to `LeadTimeService` and `SprintDetailService`.

**API surface change**: `cycleTimeDays`, `medianDays`, `p95Days`, `leadTimeDays` all
continue to be named `*Days`. They now mean **working days** when `excludeWeekends: true`.
The API response does not need a new field name — the semantic is clarified in the API docs
and surfaced in the UI (see §4 below).

---

### 4. UI Changes

#### Metric display labels

Where the frontend currently shows plain "days", it should contextually show:
- `"working days"` (or abbreviated `"wd"`) when `excludeWeekends` is `true`
- `"calendar days"` (or `"cd"`) when `false`

The simplest implementation: expose `excludeWeekends: boolean` from the existing
`GET /config/boards` endpoint (or a new `GET /config/working-time` endpoint), read it
once at app load, and pass it to display components as a prop.

No existing chart or table structure needs to change — only the unit label string.

#### Toggle (deferred)

A per-request toggle (`?calendarDays=true` query parameter) is **explicitly deferred**
to a future proposal. Providing a toggle requires computing both calendar and working-day
durations for every observation and returning both, doubling the computation in every
metrics endpoint. The primary use case for this project is internal engineering visibility
— the team will decide once which mode they want, configure it, and leave it. A live toggle
adds implementation complexity without demonstrable need at this stage.

---

### 5. Data Flow

```
boards.yaml (workingTime: stanza)
        │
        ▼
YamlConfigService.applyBoardsYaml()
        │  reads workingTime.* and upserts WorkingTimeConfigEntity (singleton, id=1)
        ▼
WorkingTimeConfigEntity (Postgres table: working_time_config)
        │
        ▼
WorkingTimeService (singleton NestJS provider in MetricsModule)
        │  injects Repository<WorkingTimeConfigEntity>
        │  exposes workingHoursBetween() / workingDaysBetween()
        │
        ├──▶ CycleTimeService.getCycleTimeObservations()
        │         replaces lines 242 rawDays calculation
        │
        ├──▶ LeadTimeService.getLeadTimeObservations()
        │         replaces lines 181 days calculation
        │
        └──▶ SprintDetailService (lines 529-536)
                  replaces rawDays calculation for leadTimeDays
```

---

### 6. Module Placement

`WorkingTimeService` belongs in `MetricsModule` (`backend/src/metrics/`). It is a pure
calculation utility — it has no Jira API dependency, no issue/changelog dependency, and its
only DB dependency is the singleton config row. `SprintDetailService` lives in `SprintModule`
and will need `MetricsModule` exported for `WorkingTimeService` to be injectable, which is
already the case (MetricsModule is imported by SprintReportModule).

Verify that `SprintModule` already imports `MetricsModule`. If not, add the import.
`WorkingTimeConfigEntity` must be added to the `imports: [TypeOrmModule.forFeature([...])]`
array in `MetricsModule`.

---

### 7. Migration Strategy

A single reversible migration creates the `working_time_config` table and seeds the
default row (id=1, all defaults). No existing data is changed.

```typescript
// migrations/NNNN-AddWorkingTimeConfig.ts (up)
await queryRunner.createTable(new Table({
  name: 'working_time_config',
  columns: [
    { name: 'id', type: 'integer', isPrimary: true },
    { name: 'excludeWeekends', type: 'boolean', default: true },
    { name: 'workDays', type: 'text', default: "'[1,2,3,4,5]'" },
    { name: 'hoursPerDay', type: 'integer', default: 8 },
    { name: 'holidays', type: 'text', default: "'[]'" },
  ],
}));
// Seed the singleton row
await queryRunner.query(
  `INSERT INTO working_time_config (id, "excludeWeekends", "workDays", "hoursPerDay", holidays)
   VALUES (1, true, '[1,2,3,4,5]', 8, '[]')`,
);
```

**No existing metric data** (sprint reports, cached DORA results) is invalidated
automatically. Sprint reports are stored as denormalised JSON blobs in the `sprint_reports`
table. On the next time a sprint report is regenerated (manually via the UI or on next
sync), the new working-day figures will appear automatically. There is no batch back-fill
job; the next request transparently recomputes with the new algorithm.

Operators should be advised (in release notes) that previously cached sprint report
scores may shift upward after enabling `excludeWeekends: true`, which is expected and
correct behaviour.

---

## Alternatives Considered

### Alternative A — Clock-Hour Bounded Working Hours (e.g. 09:00–17:00)

Count only the hours within `[09:00, 17:00)` on working days, discarding all other time.
This gives a tighter answer (an issue done at 08:55 does not credit 8 hours for that day).

**Ruled out** because:
1. It requires configuring `workStartHour` and `workEndHour` per board or globally,
   adding two more config fields and a more complex algorithm.
2. Jira timestamps are recorded when the user clicks — engineers often transition issues
   outside core hours (before standup, late evening) without that being meaningful.
3. The project is measuring team-level flow throughput, not individual engineer hours.
   Day-level granularity (Fri afternoon → Mon morning = 0 working days) is the appropriate
   resolution for this use case.
4. The industry-standard DORA metrics use calendar days, not clock hours. This proposal
   already moves away from strict DORA semantics; adding sub-day precision increases
   divergence without proportional insight.

### Alternative B — Per-Board `excludeWeekends` Toggle

Allow each board to independently opt in or out of weekend exclusion. Some boards might
want calendar days; others might want working days.

**Ruled out** because:
1. The project's teams all work the same working week (this is an internal single-
   organisation tool).
2. Inconsistent metric semantics across boards would make cross-board comparisons
   impossible, which undermines the multi-board DORA aggregate view.
3. The `excludeWeekends` flag on `WorkingTimeConfigEntity` can always be promoted to
   `BoardConfig` in a future proposal if per-board control is required.

### Alternative C — Compute Working Days as Integer Day Count Only

Count the number of complete working days between two timestamps, ignoring fractions
(i.e. round everything to the nearest day boundary).

**Ruled out** because:
1. For short cycle times (< 3 working days), rounding to an integer loses most of the
   signal. An issue done in 4 working hours would show as 1 day regardless of how much
   of that day it occupied.
2. The existing calendar-day implementation already uses fractional days and the DORA
   band thresholds (`< 1 day`, `≤ 7 days`) depend on sub-day precision.
3. There is no implementation simplicity benefit: the boundary-iteration algorithm needed
   for integer days is the same as for fractional days.

### Alternative D — Store `workingDays` Pre-Computed on `JiraChangelog` or `JiraIssue`

Add a `workingDaysCycleTime` column to `JiraIssue` and compute it at sync time.

**Ruled out** because:
1. If the `workDays` or `holidays` config changes, all pre-computed values are stale and
   a full re-sync is required.
2. Sync is triggered from Jira; the computation has no dependency on Jira — it is purely
   a local calculation over already-synced timestamps.
3. The current architecture separates raw data (changelogs) from metric derivation
   (services). Moving computation into the sync layer violates that separation and makes
   the metric logic harder to test.

### Alternative E — Introduce a `working-time` NestJS Module

Create `backend/src/working-time/` as a first-class module with its own controller,
service, and entity.

**Ruled out** because:
1. The service has no controller (it is not an HTTP-exposed endpoint).
2. The entity is a singleton config row tightly coupled to the `YamlConfigService`
   boot-time loading pattern already in `MetricsModule`'s dependency graph.
3. A new module adds more ceremony (module file, `app.module.ts` import) without adding
   modularity: `WorkingTimeService` has only one downstream consumer group (the three
   duration-computing services).

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | New `working_time_config` table — singleton row, reversible migration |
| API contract | Additive | Metric response shapes unchanged; values change semantically when `excludeWeekends: true`. New `GET /config/working-time` endpoint (optional, for UI display of unit label) |
| Frontend | Minor | Unit label changes from "days" to "working days" or "calendar days" contextually. No chart or table structural changes. |
| Tests | New unit tests + updated assertions | `WorkingTimeService` needs exhaustive unit tests (Mon–Fri spans, Fri–Mon spans, multi-week spans, holiday exclusion, same-day, zero-span). Existing `cycle-time.service.spec.ts`, `lead-time.service.spec.ts` assertion values will change (working-day durations ≤ calendar durations). |
| Jira API | None | No new Jira API calls |
| `boards.yaml` | Additive | New optional `workingTime:` stanza; omitting it leaves defaults (excludeWeekends=true, Mon–Fri, 8h/day, no holidays) |
| Sprint reports | Values shift upward on regeneration | Working-day cycle/lead times will be lower than calendar-day values. Sprint composite scores may improve. Expected and correct. |
| MTTR | No change | Calendar hours intentionally preserved; add code comment explaining the decision |

---

## Open Questions

1. **Default `excludeWeekends` value**: Should new deployments default to `true`
   (exclude weekends) or `false` (preserve existing calendar-day behaviour)?
   Recommendation: **`true`** — excluding weekends is the correct default for an
   engineering flow tool, and the improvement in metric quality justifies a one-time
   upward shift in scores. Teams who prefer calendar days can opt out explicitly.

2. **Holiday calendar source**: Should `holidays` be manually maintained in `boards.yaml`
   or automatically fetched from a public holiday API?
   Recommendation: **manual** for now. Automatic fetching introduces an external network
   dependency at startup, a new API integration, and country/region configuration. Manual
   maintenance is adequate for an internal tool where the holiday list changes at most
   once a year. A future proposal can introduce API-backed holiday calendars.

3. **Sprint reports invalidation**: When `excludeWeekends` is toggled, should the
   application automatically invalidate all cached sprint report blobs on boot so they
   regenerate with the new algorithm?
   Recommendation: **No automatic invalidation** — let users regenerate on demand. A bulk
   `DELETE FROM sprint_reports` is easy to run manually and avoids a thundering herd
   of report regeneration blocking the first boot after the config change. Document this
   in the release notes.

4. **`WorkingTimeService` in `SprintDetailService`**: `SprintDetailService` is in
   `SprintModule`. Does `SprintModule` currently import `MetricsModule`? If not, the
   import must be added. This needs a quick code verification before implementation.

5. **`GET /config/working-time` endpoint**: Is a dedicated endpoint needed, or is it
   sufficient to include `excludeWeekends: boolean` in the existing `GET /boards` or
   `GET /settings` response? Recommendation: add a lightweight property to an existing
   settings-type endpoint rather than creating a new route, unless the frontend needs
   to independently refetch this value.

---

## Acceptance Criteria

- [ ] `WorkingTimeConfigEntity` entity exists with a reversible migration; `id = 1` is
      seeded with defaults on first application boot.
- [ ] `boards.yaml` (and `boards.example.yaml`) accepts an optional top-level
      `workingTime:` stanza, validated by Zod; omitting the stanza leaves DB values
      unchanged (identical to `jira:` stanza behaviour from Proposal 0028).
- [ ] `YamlConfigService` reads the `workingTime:` stanza and upserts the
      `WorkingTimeConfigEntity` singleton row on boot.
- [ ] `WorkingTimeService.workingDaysBetween(start, end, config)` is implemented and
      satisfies at least the following test cases:
      - `Mon 09:00 → Mon 17:00` = 0.333 working days (8h / 24h/day = 0.333)
      - `Fri 17:00 → Mon 09:00` ≈ 0.125 working days (3h Friday partial + 0h weekend + 1h Mon partial on a 8h day basis using the day-boundary approach)
        *(exact value depends on the chosen day-boundary algorithm — the spec test
        must match the implemented algorithm, not the above approximation)*
      - `Fri 00:00 → Mon 00:00` = 1.0 working day (Friday only)
      - `Sat 00:00 → Sun 23:59` = 0.0 working days
      - `start === end` = 0.0 working days
      - A span including a configured holiday = same as that day being Saturday
      - `workDays: [0,1,2,3,4]` (Sun–Thu) counts Sunday and excludes Saturday
- [ ] `CycleTimeService` uses `WorkingTimeService.workingDaysBetween()` when
      `excludeWeekends: true`, and falls back to calendar-day arithmetic when `false`.
- [ ] `LeadTimeService` uses `WorkingTimeService.workingDaysBetween()` under the same
      condition.
- [ ] `SprintDetailService.leadTimeDays` uses `WorkingTimeService.workingDaysBetween()`
      under the same condition.
- [ ] `MttrService` is **not changed** and contains a comment explicitly stating that
      calendar hours are intentional (incidents do not pause on weekends).
- [ ] `DeploymentFrequencyService` is **not changed**.
- [ ] Existing spec files (`cycle-time.service.spec.ts`, `lead-time.service.spec.ts`)
      continue to pass; where date-arithmetic assertions change values, the new values
      are verified to be correct working-day figures.
- [ ] The frontend displays "working days" (or "wd") for cycle-time and lead-time metrics
      when `excludeWeekends: true`, and "calendar days" (or "cd") when `false`.
- [ ] A deployment with no `workingTime:` stanza in `boards.yaml` uses `excludeWeekends:
      true` (the default), and behaves correctly.
- [ ] `boards.example.yaml` contains a fully documented `workingTime:` stanza with the
      default values shown and a comment explaining the `workDays` integer encoding.
