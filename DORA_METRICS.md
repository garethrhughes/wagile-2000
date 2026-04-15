# DORA Metrics Calculation Reference

> **Canonical source:** This file is published from
> [`docs/proposals/0021-dora-metrics-calculation-reference.md`](docs/proposals/0021-dora-metrics-calculation-reference.md).
> The proposal document contains the full change history and links to related
> design decisions. This root-level copy is intended for quick access.

**Last updated:** 2026-04-15
**Reflects:** Proposals 0006 (redesign), 0017 (audit), 0018 (fixes), 0029 (working-time service)

---

## Purpose

This document is the authoritative reference for how each of the four DORA
metrics is computed in this codebase. It is aimed at engineers who need to
understand exactly what the numbers mean, where the data comes from, and what
edge cases are handled.

---

## High-Level Architecture

All four DORA metrics share the same structural pattern:

```
MetricsController  (backend/src/metrics/metrics.controller.ts)
    │
    └── MetricsService  (metrics.service.ts)
            │
            ├── DeploymentFrequencyService  (deployment-frequency.service.ts)
            ├── LeadTimeService             (lead-time.service.ts)
            ├── CfrService                  (cfr.service.ts)
            └── MttrService                 (mttr.service.ts)
```

**Design rules enforced:**
- All Jira-synced data is read from PostgreSQL. No metric service calls the
  Jira API directly.
- Board configuration (status names, failure types, labels) is read from the
  `board_configs` table at calculation time. Nothing is hardcoded in the
  service beyond the default values used when no `BoardConfig` row exists.
- Calculation logic lives in the four leaf services. `MetricsService` only
  orchestrates calls and applies org-level aggregation formulas.
- `classifyDeploymentFrequency`, `classifyLeadTime`, `classifyChangeFailureRate`,
  and `classifyMTTR` in `dora-bands.ts` are the single source of truth for
  DORA band thresholds.

### Issue Scope Filter

All four metrics apply `isWorkItem(issue.issueType)` before any metric-specific
logic. This function (`issue-type-filters.ts`) excludes `'Epic'` and `'Sub-task'`
issue types from all calculations. Stories, Tasks, Bugs, and Incidents (and any
other non-Epic, non-Sub-task types) pass through.

### Statistical Utilities

`statistics.ts` provides two shared functions used by Lead Time and MTTR:

- **`percentile(sorted, p)`** — Linear-interpolation percentile on a
  pre-sorted array. Returns `0` for an empty array.
- **`round2(n)`** — Rounds to at most 2 decimal places
  (`Math.round(n * 100) / 100`).

### Period Resolution

Every metric endpoint accepts the same `MetricsQueryDto` query parameters.
`MetricsService.resolvePeriod()` applies this priority order:

1. **`quarter=YYYY-QN`** — Converts to calendar-quarter boundaries using
   `quarterToDates()` from `period-utils.ts`, which uses `midnightInTz()` and
   the `TIMEZONE` environment variable (default `'UTC'`). Quarter starts are
   the first day of January, April, July, or October; ends are the last
   millisecond of the final day of the quarter (`23:59:59.999`).
2. **`period=YYYY-MM-DD:YYYY-MM-DD`** — Parses both dates directly as UTC.
3. **`sprintId=<id>`** — Looks up `JiraSprint.startDate` and `JiraSprint.endDate`
   from the database and uses them as the window.
4. **Default** — Last 90 calendar days ending now.

### Board Resolution

When no `boardId` query param is supplied, `MetricsService.resolveBoardIds()`
queries the `board_configs` table and returns all configured board IDs. When a
`boardId` is supplied (comma-separated), it is split on commas and trimmed.

### Working-Time Service

`WorkingTimeService` (`backend/src/metrics/working-time.service.ts`) provides
duration calculations that exclude non-working time from cycle-time and
lead-time results. Its configuration is read from the `working_time_config`
singleton table (PK = 1), which is seeded by the `AddWorkingTimeConfig`
migration.

```typescript
// Calculates elapsed working time between two timestamps, in working days.
workingDaysBetween(start: Date, end: Date): number
```

**Algorithm:**

1. Walk from `start` to `end` in day-sized increments, using
   `Intl.DateTimeFormat` with the configured `TIMEZONE` to determine the
   local weekday for each boundary.
2. A binary-search within each day finds the exact millisecond at which the
   day boundary occurs, correctly handling DST transitions.
3. Time accumulated within each day is multiplied by whether that day is a
   working day (per `workDays`) and whether it is not a configured holiday.
4. The total working milliseconds are divided by `24 × 3,600,000` (24 calendar
   hours) to convert to day units. `hoursPerDay` is **not** used as a divisor
   in the working-day calculation — it is available for display purposes only.
   See Proposal 0029, §Algorithm Design for full rationale.

**MTTR exception:** MTTR is always computed in **calendar hours**, regardless
of `excludeWeekends`. Incidents are production events; their resolution clock
does not pause on weekends.

**Deployment Frequency exception:** Deployment frequency uses **calendar days**
for its `deploymentsPerDay` denominator, unchanged by working-time config.

---

## Entities Used

| Entity | Table | Key fields used by DORA services |
|---|---|---|
| `JiraIssue` | `jira_issues` | `key`, `boardId`, `issueType`, `fixVersion`, `labels`, `priority`, `createdAt` |
| `JiraChangelog` | `jira_changelogs` | `issueKey`, `field`, `toValue`, `changedAt` |
| `JiraVersion` | `jira_versions` | `name`, `projectKey`, `releaseDate`, `released` |
| `JiraIssueLink` | `jira_issue_links` | `sourceIssueKey`, `targetIssueKey`, `linkTypeName` |
| `BoardConfig` | `board_configs` | `boardId`, `doneStatusNames`, `inProgressStatusNames`, `failureIssueTypes`, `failureLabels`, `failureLinkTypes`, `incidentIssueTypes`, `incidentLabels`, `incidentPriorities`, `recoveryStatusNames` |
| `WorkingTimeConfig` | `working_time_config` | `id` (always 1), `excludeWeekends`, `workDays`, `hoursPerDay`, `holidays` |

`JiraChangelog.field` is always `'status'` for the changelog rows queried by
these services. `JiraChangelog.toValue` is the status name transitioned *to*
(not the status ID). All timestamps are stored as `timestamptz` and loaded as
JavaScript `Date` objects by TypeORM.

---

## 1. Deployment Frequency

**Service:** `DeploymentFrequencyService.calculate()`
(`backend/src/metrics/deployment-frequency.service.ts`)

**Formula:**

```
deploymentsPerDay = totalDeployments / periodDays
```

where `periodDays = max(periodMs / 86_400_000, 1)` (minimum 1 day to avoid
division-by-zero for zero-length windows).

> **Note:** `periodDays` is always in **calendar days**. Working-time
> configuration does not affect Deployment Frequency.

### What constitutes a deployment

A deployment is a **distinct work-item issue** that reached production during
the period. The service uses two mutually exclusive signals, applied in
priority order per issue:

#### Path 1 — Version-based (primary)

An issue is counted as deployed if **all three** of the following are true:

1. `issue.fixVersion` is non-null.
2. A `JiraVersion` record exists where `version.name === issue.fixVersion`,
   `version.projectKey === boardId`, and `version.released === true`.
3. `version.releaseDate` falls within `[startDate, endDate]` (inclusive).

Issues qualifying via this path are collected into `versionIssueKeys` (a
`Set<string>`).

#### Path 2 — Status-transition fallback

An issue is counted via this path only if it has **no `fixVersion`** and it
does not already appear in `versionIssueKeys`. It must have at least one
`JiraChangelog` row where:

- `cl.field = 'status'`
- `cl.toValue IN (doneStatusNames)`
- `cl.changedAt BETWEEN startDate AND endDate`

The query uses `DISTINCT cl.issueKey` so that an issue moved to Done,
re-opened, and re-resolved within the period still counts as **1** deployment.

#### Combining the two paths

```typescript
const totalDeployments = versionIssueKeys.size + transitionKeys.size;
```

The two sets are **disjoint by construction** (Path 2 explicitly filters to
`!fixVersion && !versionIssueKeys.has(key)`). There is no double-counting.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | `toValue IN (doneStatuses)` in Path 2 changelog query |

### Output shape

```typescript
interface DeploymentFrequencyResult {
  boardId: string;
  totalDeployments: number;   // distinct issues deployed in period
  deploymentsPerDay: number;  // totalDeployments / periodDays (calendar days)
  band: DoraBand;             // classified by classifyDeploymentFrequency()
  periodDays: number;         // Math.round(periodDays)
}
```

### Band thresholds (`classifyDeploymentFrequency`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `deploymentsPerDay >= 1` | At least once per day (on-demand) |
| `'high'` | `deploymentsPerDay >= 1/7` | At least once per week |
| `'medium'` | `deploymentsPerDay >= 1/30` | At least once per month |
| `'low'` | `deploymentsPerDay < 1/30` | Less than monthly |

### Edge cases

- **No issues on board:** Returns `totalDeployments = 0`, `band = 'low'`.
- **Zero-length period:** `periodDays` is clamped to minimum 1 to avoid
  division-by-zero.
- **Issue has `fixVersion` but the version is not yet released
  (`released = false`):** Excluded from Path 1. If there is no Done transition
  in range, the issue is not counted at all.
- **Issue has `fixVersion` but `releaseDate` is outside the period:** Excluded
  from Path 1 and also from Path 2 (because it has a `fixVersion`). The issue
  will be counted in the period whose window contains the `releaseDate`.
- **`boardId` vs `projectKey`:** The version query uses `projectKey = boardId`.
  If a board's ID differs from its project key, version-based deployments will
  return zero for that board.

### Org-level aggregation

```
orgDeploymentsPerDay = SUM(totalDeployments, all boards) / periodDays
```

---

## 2. Lead Time for Changes

**Service:** `LeadTimeService.calculate()` and
`LeadTimeService.getLeadTimeObservations()`
(`backend/src/metrics/lead-time.service.ts`)

**Formula:**

```
leadTime(issue) = workingDaysBetween(startTime(issue), endTime(issue))
medianDays = percentile_50(all leadTime observations in period)
p95Days    = percentile_95(all leadTime observations in period)
```

When `WorkingTimeConfig.excludeWeekends` is `true` (the default), durations
are calculated by `WorkingTimeService.workingDaysBetween()`, which excludes
weekend days and configured public holidays and divides by `hoursPerDay` to
normalise to working-day units.

When `excludeWeekends` is `false`, durations fall back to raw calendar days:

```typescript
(endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24)
```

Only issues whose `endTime` falls within `[startDate, endDate]` contribute an
observation. Issues with no `endTime` in range are silently skipped. Issues
with an `endTime` in range but no `startTime` are counted as anomalies and
excluded from the percentile distribution.

### Start time — `startTime`

`startTime` is the timestamp of the **first changelog transition** for the
issue where `cl.toValue` is in `inProgressStatusNames`. The full list of
default status names is:

```
'In Progress', 'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
'PEER CODE REVIEW', 'Ready for Review', 'In Test', 'IN TEST', 'QA',
'QA testing', 'QA Validation', 'IN TESTING', 'Under Test', 'ready to test',
'Ready for Testing', 'READY FOR TESTING', 'Ready for Release',
'Ready for release', 'READY FOR RELEASE', 'Awaiting Release', 'READY'
```

The list is overridden by `BoardConfig.inProgressStatusNames` if a config row
exists for the board. The service reads **all** status changelogs for every
work-item issue on the board (not just those within the period) so that issues
which began work before the period window are handled correctly.

### End time — `endTime`

Two sources are tried in order:

1. **Done transition (primary):** The **last** `JiraChangelog` row for the
   issue where `cl.toValue IN doneStatusNames` and `cl.changedAt` is within
   `[startDate, endDate]`.

2. **Version release date (fallback):** Used only when no done transition
   exists within the period **and** `issue.fixVersion` is non-null. Requires a
   matching `JiraVersion` with `released = true`, `releaseDate` in the period,
   and `releaseDate >= inProgressTransition.changedAt`.

### Anomaly counting

An issue that has an `endTime` in range but **no transition to any
`inProgressStatusNames` status** in its entire changelog is counted as an
anomaly (`anomalyCount++`) and excluded from the distribution. There is **no
fallback to `issue.createdAt`** — that would measure ticket age, not lead time
for changes.

### Duration calculation

When `excludeWeekends: true` (default — **working days**):

```typescript
const days = workingTimeService.workingDaysBetween(startTime, endTime);
leadTimeDays.push(Math.max(0, days));
```

When `excludeWeekends: false` (**calendar days**):

```typescript
const days = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
leadTimeDays.push(Math.max(0, days));
```

Negative lead times are clamped to `0` and a warning is logged.

### Board / working-time configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Identifies done-transition changelogs |
| `BoardConfig.inProgressStatusNames` | (22-item list above) | Identifies work-start changelogs |
| `WorkingTimeConfig.excludeWeekends` | `true` | Working-day vs calendar-day duration |
| `WorkingTimeConfig.workDays` | `[1,2,3,4,5]` | Which ISO weekdays count as working days |
| `WorkingTimeConfig.hoursPerDay` | `8` | Normalisation divisor |
| `WorkingTimeConfig.holidays` | `[]` | Dates excluded from working-time accumulation |

### Output shape

```typescript
interface LeadTimeResult {
  boardId: string;
  medianDays: number;    // percentile_50, rounded to 2 dp (working days by default)
  p95Days: number;       // percentile_95, rounded to 2 dp
  band: DoraBand;        // classified by classifyLeadTime(medianDays)
  sampleSize: number;    // number of observations included
  anomalyCount: number;  // issues excluded due to missing in-progress transition
}
```

### Band thresholds (`classifyLeadTime`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `medianDays < 1` | Less than one (working) day |
| `'high'` | `medianDays <= 7` | One to seven (working) days |
| `'medium'` | `medianDays <= 30` | One to thirty (working) days |
| `'low'` | `medianDays > 30` | More than thirty (working) days |

> "Days" are **working days** when `excludeWeekends: true` (default) and
> **calendar days** when `excludeWeekends: false`. The numeric thresholds are
> the same either way.

### Org-level aggregation

```
orgMedianDays = percentile_50(UNION of all observation arrays from all boards)
orgP95Days    = percentile_95(UNION of all observation arrays from all boards)
```

---

## 3. Change Failure Rate

**Service:** `CfrService.calculate()`
(`backend/src/metrics/cfr.service.ts`)

**Formula:**

```
changeFailureRate (%) = (failureCount / totalDeployments) × 100
```

rounded to 2 decimal places. Returns `0` if `totalDeployments === 0`.

> **Note:** CFR is a count ratio, not a time-based metric. Working-time
> configuration does not affect CFR.

### Step 1 — Count total deployments

Uses the **same two-path logic as Deployment Frequency** (version-based
primary, Done-transition fallback). The two sets are disjoint by construction.

```typescript
const deployedKeys = new Set([...versionIssueKeys, ...transitionIssueKeys]);
const totalDeployments = deployedKeys.size;
```

### Step 2 — Identify failure issues (OR-gate)

For each issue key in `deployedKeys`, the corresponding `JiraIssue` record is
checked. An issue is a **candidate failure** if **either** condition holds:

1. **By issue type:** `issue.issueType IN failureIssueTypes`
   (default: `['Bug', 'Incident']`)
2. **By label:** `issue.labels.some(l => failureLabels.includes(l))`
   (default: `['regression', 'incident', 'hotfix']`)

### Step 3 — Apply causal-link AND-gate

If `BoardConfig.failureLinkTypes` is non-empty (default:
`['caused by', 'is caused by']`), a candidate failure is **only counted** if
it has at least one `JiraIssueLink` where:

- `link.sourceIssueKey = issue.key`
- `LOWER(link.linkTypeName) IN failureLinkTypes` (case-insensitive)

If `failureLinkTypes` is empty, the AND-gate is skipped.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Deployment detection (Path 2) |
| `BoardConfig.failureIssueTypes` | `['Bug', 'Incident']` | OR-gate: issue type |
| `BoardConfig.failureLabels` | `['regression', 'incident', 'hotfix']` | OR-gate: label |
| `BoardConfig.failureLinkTypes` | `['caused by', 'is caused by']` | AND-gate: causal link |

### Output shape

```typescript
interface CfrResult {
  boardId: string;
  totalDeployments: number;    // denominator
  failureCount: number;        // numerator (post AND-gate)
  changeFailureRate: number;   // percentage, 2 dp
  band: DoraBand;
  usingDefaultConfig: boolean; // true when no BoardConfig row exists
}
```

### Band thresholds (`classifyChangeFailureRate`)

| Band | Condition |
|---|---|
| `'elite'` | `changeFailureRate <= 5` |
| `'high'` | `changeFailureRate <= 10` |
| `'medium'` | `changeFailureRate <= 15` |
| `'low'` | `changeFailureRate > 15` |

### Org-level aggregation

```
orgChangeFailureRate (%) = SUM(failureCount, all boards) /
                           SUM(totalDeployments, all boards) × 100
```

---

## 4. Mean Time to Recovery (MTTR)

**Service:** `MttrService.calculate()` and `MttrService.getMttrObservations()`
(`backend/src/metrics/mttr.service.ts`)

**Formula:**

```
recovery(incident) = recoveryTime(incident) - startTime(incident)  [calendar hours]
medianHours = percentile_50(all recovery observations in period)
```

> **Important:** MTTR is always measured in **calendar hours**. It does **not**
> use `WorkingTimeService` and is not affected by `excludeWeekends` or any
> `workingTime:` configuration. Incidents are production events; their
> resolution clock does not pause on weekends or public holidays.

### Step 1 — Identify incident issues (OR-gate)

An issue is an **incident candidate** if:

1. `issue.issueType IN incidentIssueTypes` (default: `['Bug', 'Incident']`)
2. **OR** (when `incidentLabels` is non-empty):
   `issue.labels.some(l => incidentLabels.includes(l))`

### Step 2 — Apply priority AND-gate

If `BoardConfig.incidentPriorities` is non-empty (default: `['Critical']`),
only issues where `issue.priority IN incidentPriorities` are retained.

### Step 3 — Find recovery time (`recoveryTime`)

The **first** `JiraChangelog` row for the issue where:

- `cl.toValue IN recoveryStatuses` (default: `['Done', 'Resolved']`)
- `cl.changedAt` is within `[startDate, endDate]`

If an incident is resolved, re-opened, and resolved again within the period,
only the first resolution counts.

### Step 4 — Find start time (`startTime`)

1. **Primary:** First `JiraChangelog` transition where `cl.toValue IN inProgressStatusNames`.
2. **Fallback:** `issue.createdAt` — models the incident as starting at detection time.
   Unlike Lead Time, there is no anomaly exclusion; `createdAt` is always available.

### Step 5 — Duration calculation

```typescript
const hours = (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
if (hours >= 0) {
  recoveryHours.push(hours);   // negative durations are silently discarded
}
```

Weekends and public holidays during an incident do **not** reduce the measured
duration. MTTR is always calendar hours.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.incidentIssueTypes` | `['Bug', 'Incident']` | Step 1: OR-gate by type |
| `BoardConfig.incidentLabels` | `[]` | Step 1: OR-gate by label (disabled when empty) |
| `BoardConfig.incidentPriorities` | `['Critical']` | Step 2: AND-gate by priority |
| `BoardConfig.recoveryStatusNames` | `['Done', 'Resolved']` | Step 3: recovery detection |
| `BoardConfig.inProgressStatusNames` | (22-item list) | Step 4: work-start detection |

### Output shape

```typescript
interface MttrResult {
  boardId: string;
  medianHours: number;   // percentile_50, rounded to 2 dp (calendar hours)
  band: DoraBand;
  incidentCount: number; // observations with a recovery event in the period
}
```

### Band thresholds (`classifyMTTR`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `medianHours < 1` | Less than one hour |
| `'high'` | `medianHours < 24` | Less than one day |
| `'medium'` | `medianHours < 168` | Less than one week |
| `'low'` | `medianHours >= 168` | One week or more |

Note: MTTR boundaries use strict `<`. Exactly 24 hours is `'medium'`; exactly
168 hours is `'low'`.

### Org-level aggregation

```
orgMttrMedianHours = percentile_50(UNION of all recovery-hours arrays from all boards)
```

---

## 5. DORA Band Reference

All band classification functions are in `dora-bands.ts` (backend) and
`frontend/src/lib/dora-bands.ts` (frontend — must be kept in sync).

```typescript
export type DoraBand = 'elite' | 'high' | 'medium' | 'low';
```

### Summary table

| Metric | Unit | Elite | High | Medium | Low |
|---|---|---|---|---|---|
| Deployment Frequency | deploys/day (calendar) | ≥ 1/day | ≥ 1/week | ≥ 1/month | < 1/month |
| Lead Time for Changes | **working days** (default) | < 1 day | ≤ 7 days | ≤ 30 days | > 30 days |
| Change Failure Rate | % | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| MTTR | **calendar hours** | < 1 hour | < 24 hours | < 168 hours | ≥ 168 hours |

> Lead Time is in **working days** when `excludeWeekends: true` (default), and
> **calendar days** when `excludeWeekends: false`. The numeric thresholds are
> unchanged in both cases.

### Boundary behaviour (exact values)

| Value | Metric | Band |
|---|---|---|
| 1.0 deploys/day | DF | `'elite'` (>= 1) |
| 1/7 deploys/day | DF | `'high'` (>= 1/7) |
| 1/30 deploys/day | DF | `'medium'` (>= 1/30) |
| 0.99 days | Lead Time | `'elite'` (< 1) |
| 1.0 days | Lead Time | `'high'` (<= 7) |
| 7.0 days | Lead Time | `'high'` (<= 7) |
| 7.01 days | Lead Time | `'medium'` (<= 30) |
| 5.0% | CFR | `'elite'` (<= 5) |
| 10.0% | CFR | `'high'` (<= 10) |
| 15.0% | CFR | `'medium'` (<= 15) |
| 0.99 hours | MTTR | `'elite'` (< 1) |
| 1.0 hours | MTTR | `'high'` (< 24) |
| 24.0 hours | MTTR | `'medium'` (< 168) |
| 168.0 hours | MTTR | `'low'` (>= 168) |

---

## 6. Org-Level Aggregation Summary

`MetricsService.getDoraAggregate()` calls each per-board service in parallel
via `Promise.all(boardIds.map(...))`. The aggregation formulas:

| Metric | Formula |
|---|---|
| Deployment Frequency | `orgDeploymentsPerDay = SUM(totalDeployments) / sharedPeriodDays` |
| Lead Time | `orgMedianDays = percentile_50(UNION of all per-board observation arrays)` |
| Change Failure Rate | `orgCFR = SUM(failureCount) / SUM(totalDeployments) × 100` |
| MTTR | `orgMedianHours = percentile_50(UNION of all per-board recovery-hours arrays)` |

DF and CFR use sum-of-totals / ratio-of-sums. Lead Time and MTTR use pooled
median across all boards.

---

## 7. Known Limitations

1. **Working days, not calendar days (Lead Time and Cycle Time).** By default,
   Lead Time and Cycle Time are measured in working days (`excludeWeekends: true`).
   MTTR remains in calendar hours. If comparing to a tool that uses calendar days,
   Fragile will report lower Lead Time values. Toggle `excludeWeekends: false` in
   `boards.yaml` for calendar-day measurement.

2. **`boardId === projectKey` assumption.** Version-based queries use
   `projectKey = boardId`. If a Jira board ID differs from its project key,
   version-based deployments and lead time fallbacks return zero for that board.

3. **`isWorkItem` exclusion is narrow.** Only `'Epic'` and `'Sub-task'`
   (hyphenated) are excluded. Teams using `'Subtask'` or custom sub-task types
   will see those items in metric calculations.

4. **CFR and MTTR share the same default issue types (`Bug`, `Incident`).** A
   Bug that is both a failure (CFR) and an incident (MTTR) will appear in both
   metrics. This is intentional.

5. **30-minute sync staleness.** Jira data is synced on demand. Changes made in
   Jira may not be reflected until the next sync. All metric calculations operate
   on the cached state at the time of the query.

6. **Holiday exclusion uses tenant-local dates.** Holidays in `workingTime.holidays`
   are matched against the date in the `TIMEZONE` environment variable. If
   `TIMEZONE` is set incorrectly, holidays may be excluded on the wrong UTC day.

---

## Configuration Reference

### Working-time configuration (`workingTime:` stanza in `boards.yaml`)

```yaml
workingTime:
  excludeWeekends: true      # false = use calendar days for cycle/lead time
  workDays: [1, 2, 3, 4, 5] # ISO weekday numbers (0=Sun … 6=Sat)
  hoursPerDay: 8             # display label only; does NOT affect numeric threshold calculations
  holidays:                  # YYYY-MM-DD, matched in TIMEZONE
    - "2026-01-01"
```

See [`backend/config/boards.example.yaml`](backend/config/boards.example.yaml)
for the full annotated reference.

### `GET /api/config`

The backend exposes the active working-time settings to the frontend:

```json
{
  "timezone": "Australia/Sydney",
  "excludeWeekends": true
}
```

The frontend uses `excludeWeekends` to adapt duration unit labels ("working
days" vs "calendar days") on metric cards.
