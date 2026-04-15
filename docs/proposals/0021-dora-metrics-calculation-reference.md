# 0021 — DORA Metrics Calculation Reference

**Date:** 2026-04-13
**Status:** Informational
**Author:** Architect Agent
**Related ADRs:** None — this is a reference document, not a change proposal.
**Related proposals:** [0006](0006-dora-metrics-redesign.md) (redesign),
[0017](0017-metric-calculation-audit.md) (audit),
[0018](0018-metric-calculation-fixes.md) (fixes),
[0029](0029-working-time-service.md) (working-time service)

---

## Purpose

This document is the authoritative reference for how each of the four DORA
metrics is computed in this codebase. It is aimed at new engineers who need to
understand exactly what the numbers mean, where the data comes from, and what
edge cases are handled. It reflects the **current implemented state** of the
code as of proposal 0029.

For a history of known bugs and how they were resolved, see proposals 0017
(audit) and 0018 (fixes). For the original architectural decision to add
org-level aggregation, see proposal 0006. For the working-time / weekend
exclusion design, see proposal 0029.

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
4. The total working milliseconds are divided by `hoursPerDay × 3,600,000` to
   convert to working-day units.

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
  (`released = false`):** The version is excluded from Path 1. If the issue
  has no Done transition in range, it is not counted at all.
- **Issue has `fixVersion` but `releaseDate` is outside the period:** The
  version is excluded from Path 1. The issue is also excluded from Path 2
  (because it has a `fixVersion`, even though the release is out-of-range).
  This is intentional — the issue will be counted in the period whose window
  contains the `releaseDate`.
- **`boardId` vs `projectKey`:** The version query uses `projectKey = boardId`.
  This is a known limitation: if a Jira board's ID differs from its project
  key, version-based deployments will return zero for that board. See proposal
  0017 §Finding 2.2.

### Org-level aggregation

When `getDoraAggregate()` is called:

```
orgDeploymentsPerDay = SUM(totalDeployments, all boards) / periodDays
```

Sum of totals — deploying on 6 boards is genuinely more frequent than deploying
on 1. The denominator `periodDays` is the same for all boards (they share the
same window).

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
excluded from the percentile distribution (see below).

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
work-item issue on the board (not just those within the period), then finds
the chronologically first match.

> **Why all-time changelogs?** An issue may have started work before the period
> window. Loading only in-range changelogs would miss the start event, causing
> a false anomaly or an inflated lead time using a later in-range transition as
> the start.

### End time — `endTime`

Two sources are tried in order:

1. **Done transition (primary):** The **last** `JiraChangelog` row for the
   issue where `cl.toValue IN doneStatusNames` and `cl.changedAt` is within
   `[startDate, endDate]`. The last done transition is used (not the first) to
   handle re-open/re-resolve workflows correctly.

2. **Version release date (fallback):** Used only when no done transition
   exists within the period **and** `issue.fixVersion` is non-null. Requires:
   - A `JiraVersion` with `version.name === issue.fixVersion` and
     `version.projectKey === boardId`.
   - `version.releaseDate` is non-null and falls within `[startDate, endDate]`.
   - `version.releaseDate >= inProgressTransition.changedAt` — the release date
     must not precede when work started (guards against stale version records
     pre-dating the actual work; see code comment referencing OCS-774).

   If these conditions are not met, the fallback is not used and the issue is
   skipped.

### Anomaly counting

An issue that has an `endTime` in range but **no transition to any
`inProgressStatusNames` status** in its entire changelog is counted as an
anomaly:

```typescript
anomalyCount++;
continue;   // excluded from leadTimeDays array
```

The anomaly count is returned in `LeadTimeResult.anomalyCount` and surfaced to
the caller (and ultimately to the frontend DORA page) so the user can see how
many issues were excluded. There is **no fallback to `issue.createdAt`** for
lead time — such a fallback would measure total ticket age, not lead time for
changes.

### Duration calculation

When `excludeWeekends: true` (default):

```typescript
const days = workingTimeService.workingDaysBetween(startTime, endTime);
leadTimeDays.push(Math.max(0, days));  // clamped to 0 for negative durations
```

When `excludeWeekends: false` (calendar fallback):

```typescript
const days = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
leadTimeDays.push(Math.max(0, days));
```

Negative lead times are clamped to `0` and a warning is logged. These arise
when a version's release date precedes the in-progress transition.

Durations are expressed in **working days by default** (wall-clock time minus
non-working days / `hoursPerDay`). When `excludeWeekends` is `false`, they
are in **calendar days**.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Identifies done-transition changelogs |
| `BoardConfig.inProgressStatusNames` | (22-item list above) | Identifies work-start changelogs |
| `WorkingTimeConfig.excludeWeekends` | `true` | Whether to use working-day or calendar-day duration |
| `WorkingTimeConfig.workDays` | `[1,2,3,4,5]` | Which ISO weekdays count as working days |
| `WorkingTimeConfig.hoursPerDay` | `8` | Normalisation divisor (working ms / (hoursPerDay × 3,600,000)) |
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

Note: the boundary values use `<=`, meaning exactly 7 days is `'high'` (not
`'medium'`). This matches the DORA 2023 report convention. When
`excludeWeekends` is `false`, "days" in the table above should be read as
calendar days.

### Edge cases

- **No issues or no observations:** `medianDays = 0`, `band = classifyLeadTime(0) = 'elite'`,
  `sampleSize = 0`.
- **Single observation:** Median and P95 are both that one value.
- **All issues are anomalies:** `sampleSize = 0`, result is as if no issues
  exist; `anomalyCount` will be non-zero.
- **Issue moved to Done before any in-progress transition:** Counted as anomaly.
- **Issue re-opened and re-resolved within the period:** The *last* done
  transition in the period is used as `endTime`. The *first* in-progress
  transition ever is used as `startTime`. This can produce a lead time that
  spans multiple work sessions; weekends and holidays within that span are
  excluded when `excludeWeekends` is `true`.

### Org-level aggregation

```
orgMedianDays = percentile_50(UNION of all observation arrays from all boards)
orgP95Days    = percentile_95(UNION of all observation arrays from all boards)
```

The pooled median is computed by `getDoraAggregate()`, which calls
`getLeadTimeObservations()` on each board (to get the raw sorted arrays),
concatenates them all, re-sorts, and computes percentiles. This is the
correct statistical approach — it models "if a randomly-picked change came
from anywhere in the org, how long did it take?"

---

## 3. Change Failure Rate

**Service:** `CfrService.calculate()`
(`backend/src/metrics/cfr.service.ts`)

**Formula:**

```
changeFailureRate (%) = (failureCount / totalDeployments) × 100
```

rounded to 2 decimal places (`Math.round(ratio * 10000) / 100`). Returns `0`
if `totalDeployments === 0`.

> **Note:** CFR is a count ratio, not a time-based metric. Working-time
> configuration does not affect CFR.

### Step 1 — Count total deployments

The total deployment denominator is computed using the **same two-path logic as
Deployment Frequency** (version-based primary, Done-transition fallback for
no-version issues):

- **Version path:** Issues with a `fixVersion` where the matching `JiraVersion`
  has `released = true` and `releaseDate` within `[startDate, endDate]`. The
  result is the set of matching issue keys: `versionIssueKeys`.
- **Transition-fallback path:** Issues with no `fixVersion` (and not already in
  `versionIssueKeys`) that have a Done-status transition within the period,
  using `DISTINCT cl.issueKey`. Result: `transitionIssueKeys`.

```typescript
const deployedKeys = new Set([...versionIssueKeys, ...transitionIssueKeys]);
const totalDeployments = deployedKeys.size;
```

The two sets are disjoint (same guard as DF service). The `totalDeployments`
values from `DeploymentFrequencyService` and `CfrService` are consistent for
identical inputs.

### Step 2 — Identify failure issues (OR-gate)

For each issue key in `deployedKeys`, the corresponding `JiraIssue` record is
checked. An issue is a **candidate failure** if **either** condition holds:

1. **By issue type:** `issue.issueType IN failureIssueTypes`
   (default: `['Bug', 'Incident']`)
2. **By label:** `issue.labels.some(l => failureLabels.includes(l))`
   (default: `['regression', 'incident', 'hotfix']`)

This is an OR-gate: matching either condition makes the issue a candidate.

### Step 3 — Apply causal-link AND-gate

If `BoardConfig.failureLinkTypes` is non-empty (default:
`['caused by', 'is caused by']`), the service applies an additional filter:
a candidate failure is **only counted** if it has at least one `JiraIssueLink`
where:

- `link.sourceIssueKey = issue.key`
- `LOWER(link.linkTypeName) IN failureLinkTypes` (compared case-insensitively)

This AND-gate ensures that a Bug or Incident is only counted as a change
failure if it is causally linked to a change — a standalone quality issue that
is not linked to a deployment does not inflate CFR.

```typescript
const keysWithCausalLink = new Set(causalLinks.map(l => l.sourceIssueKey));
filteredFailures = failureIssues.filter(i => keysWithCausalLink.has(i.key));
```

If `failureLinkTypes` is empty, the AND-gate is skipped and all OR-gate
candidates count as failures.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Identifies done-transition deployments in Path 2 |
| `BoardConfig.failureIssueTypes` | `['Bug', 'Incident']` | OR-gate: issue type check |
| `BoardConfig.failureLabels` | `['regression', 'incident', 'hotfix']` | OR-gate: label check |
| `BoardConfig.failureLinkTypes` | `['caused by', 'is caused by']` | AND-gate: causal link filter (compared case-insensitively) |

The flag `usingDefaultConfig: boolean` in the result is `true` when
`boardConfigRepo.findOne()` returned `null` for the board — i.e. no
`board_configs` row exists and all four defaults above are in use. This flag
propagates to `OrgCfrResult.anyBoardUsingDefaultConfig` as an amber warning
signal on the DORA page.

### Output shape

```typescript
interface CfrResult {
  boardId: string;
  totalDeployments: number;    // denominator
  failureCount: number;        // numerator (post AND-gate)
  changeFailureRate: number;   // percentage, 2 dp
  band: DoraBand;              // classified by classifyChangeFailureRate()
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

All boundaries are `<=` (inclusive). Exactly 5% is `'elite'`, exactly 10% is
`'high'`, exactly 15% is `'medium'`.

### Edge cases

- **No work-item issues on board:** Returns `changeFailureRate = 0`,
  `band = 'elite'` immediately (early-exit guard).
- **`failureLinkTypes` is an empty array:** The AND-gate is entirely bypassed;
  all OR-gate candidates count as failures without requiring a causal link.
- **A Bug is in `failureIssueTypes` but was not deployed in the period:** It is
  not included in `deployedKeys` and is therefore never evaluated as a failure
  candidate. Only deployed issues (within the period) can contribute to CFR.
- **Causal-link comparison is case-insensitive:** `'Caused By'`, `'CAUSED BY'`,
  and `'caused by'` all match the default `failureLinkTypes` entry `'caused by'`.

### Org-level aggregation

```
orgChangeFailureRate (%) = SUM(failureCount, all boards) /
                           SUM(totalDeployments, all boards) × 100
```

This is a **ratio of sums**, not an average of ratios. A board with 0
deployments contributes 0 to both numerator and denominator without distorting
the aggregate. The org-level denominator is `totalDeplForCfr` — the sum of
per-board `totalDeployments`.

---

## 4. Mean Time to Recovery (MTTR)

**Service:** `MttrService.calculate()` and `MttrService.getMttrObservations()`
(`backend/src/metrics/mttr.service.ts`)

**Formula:**

```
recovery(incident) = recoveryTime(incident) - startTime(incident)  [in calendar hours]
medianHours = percentile_50(all recovery observations in period)
```

Only incidents whose first recovery transition falls within `[startDate, endDate]`
contribute an observation.

> **Important:** MTTR is always measured in **calendar hours**. It does **not**
> use `WorkingTimeService` and is not affected by `excludeWeekends` or any
> `workingTime:` configuration. Incidents are production events; their resolution
> clock does not pause on weekends or public holidays. This is a deliberate
> design decision — see proposal 0029 §Design Decision: MTTR Exception.

### Step 1 — Identify incident issues

From all work-item issues on the board, an issue is classified as an **incident
candidate** if **either** condition holds:

1. **By issue type:** `issue.issueType IN incidentIssueTypes`
   (default: `['Bug', 'Incident']`)
2. **By label (only if `incidentLabels` is non-empty):**
   `issue.labels.some(l => incidentLabels.includes(l))`
   (default: `[]` — disabled by default)

This is an OR-gate. If `incidentLabels` is empty (the default), only the
issue-type check applies.

### Step 2 — Apply priority AND-gate

If `BoardConfig.incidentPriorities` is non-empty (default: `['Critical']`),
the candidate set is filtered further: an incident is only retained if
`issue.priority !== null && incidentPriorities.includes(issue.priority)`.

If `incidentPriorities` is empty, all candidates from Step 1 pass through.

The test suite fixture (`mttr.service.spec.ts`) explicitly sets
`incidentPriorities: []` to disable the priority gate and test the base
type/label matching logic in isolation.

### Step 3 — Find recovery time (`recoveryTime`)

For the filtered incident issues, all status changelogs are loaded in a single
bulk query (all time, not just within the period — the start-time detection
needs pre-period changelogs, see below).

A recovery event is the **first** `JiraChangelog` row for an issue where:

- `cl.toValue IN recoveryStatuses` (default: `['Done', 'Resolved']`)
- `cl.changedAt >= startDate AND cl.changedAt <= endDate`

Only the chronologically first qualifying recovery transition is used. If an
incident is resolved, re-opened, and resolved again within the period, only
the first resolution counts.

```typescript
const firstRecoveryByIssue = new Map<string, Date>();
for (const cl of recoveryChangelogs) {
  if (!firstRecoveryByIssue.has(cl.issueKey)) {
    firstRecoveryByIssue.set(cl.issueKey, cl.changedAt);
  }
}
```

Incidents with no recovery transition in the period do not contribute an
observation.

### Step 4 — Find start time (`startTime`)

For each incident that has a recovery event in the period:

1. **Primary:** The first `JiraChangelog` transition for the issue where
   `cl.toValue IN inProgressStatusNames` (the same board-config-aware list used
   by Lead Time — 22 default entries). The search covers the **entire** changelog
   for the issue, not just the period window.
2. **Fallback:** If no in-progress transition exists, `issue.createdAt` is used.
   This models the incident as having started at detection time (when the ticket
   was filed). The `createdAt` fallback is kept for MTTR because an incident
   is "detected" at creation time — unlike Lead Time, there is no analogous
   concept of anomaly exclusion.

```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
);
const startTime = inProgressTransition
  ? inProgressTransition.changedAt
  : issue.createdAt;
```

### Step 5 — Duration calculation

```typescript
const hours = (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
if (hours >= 0) {
  recoveryHours.push(hours);
}
```

Negative durations (where recovery precedes start — a data anomaly) are
**silently discarded** (not pushed to the array). This differs from Lead Time,
which clamps to 0 and logs a warning.

Durations are in **calendar hours** (not days, not working hours), reflecting
that recovery is expected to be faster than lead time and that incidents do not
pause on weekends.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.incidentIssueTypes` | `['Bug', 'Incident']` | Step 1: OR-gate by type |
| `BoardConfig.incidentLabels` | `[]` | Step 1: OR-gate by label (disabled when empty) |
| `BoardConfig.incidentPriorities` | `['Critical']` | Step 2: AND-gate by priority |
| `BoardConfig.recoveryStatusNames` | `['Done', 'Resolved']` | Step 3: recovery transition detection |
| `BoardConfig.inProgressStatusNames` | (22-item list) | Step 4: work-start transition detection |

### Output shape

```typescript
interface MttrResult {
  boardId: string;
  medianHours: number;   // percentile_50, rounded to 2 dp (calendar hours)
  band: DoraBand;        // classified by classifyMTTR(medianHours)
  incidentCount: number; // number of observations (incidents with recovery in period)
}
```

### Band thresholds (`classifyMTTR`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `medianHours < 1` | Less than one hour |
| `'high'` | `medianHours < 24` | Less than one day (1 hour to 24 hours) |
| `'medium'` | `medianHours < 168` | Less than one week (24 hours to 168 hours) |
| `'low'` | `medianHours >= 168` | One week or more |

Note: boundaries are strict `<` for MTTR (unlike CFR and Lead Time which use
`<=` for the upper boundary). Exactly 24 hours is `'medium'`, exactly 168 hours
is `'low'`.

### Edge cases

- **No qualifying incidents:** Returns `medianHours = 0`,
  `band = classifyMTTR(0) = 'elite'`, `incidentCount = 0`.
- **`incidentPriorities` is empty:** Priority filter is entirely bypassed; any
  issue matching the OR-gate in Step 1 is counted regardless of priority.
- **`incidentLabels` is empty (default):** The label OR-gate branch is skipped;
  only the `incidentIssueTypes` check applies.
- **Incident resolved before in-progress transition:** Start time falls back to
  `createdAt`. If `createdAt > recoveryDate` (a data anomaly, e.g. clocks
  wrong), `hours < 0` and the observation is silently discarded.
- **Incident has recovery event before the period but `startTime` (createdAt)
  is in the period:** The recovery event is outside the period window, so no
  observation is produced for this incident.
- **`isWorkItem` filter:** Epics and Sub-tasks are excluded before the incident
  type filter is applied. This means a `Sub-task` with `issueType = 'Bug'` is
  not counted as an incident.
- **Weekend / public holiday during incident:** Does NOT reduce the measured
  duration. MTTR is always calendar hours.

### Org-level aggregation

```
orgMttrMedianHours = percentile_50(UNION of all recovery-hours arrays from all boards)
```

Same pooled-median approach as Lead Time. `getMttrObservations()` returns the
pre-sorted raw array for each board; `getDoraAggregate()` concatenates all
arrays, re-sorts, and computes the percentile. Boards with zero incidents
contribute no data points and do not distort the aggregate with a phantom 0-hour
recovery.

---

## 5. DORA Band Reference

All band classification functions are in `dora-bands.ts`. This is the **single
source of truth**. The frontend has a separate copy in `frontend/src/lib/dora-bands.ts`
which must be kept in sync.

```typescript
export type DoraBand = 'elite' | 'high' | 'medium' | 'low';
```

### Summary table

| Metric | Elite | High | Medium | Low |
|---|---|---|---|---|
| Deployment Frequency | ≥ 1/day | ≥ 1/week | ≥ 1/month | < 1/month |
| Lead Time for Changes | < 1 day | ≤ 7 days | ≤ 30 days | > 30 days |
| Change Failure Rate | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| MTTR | < 1 hour | < 24 hours | < 168 hours | ≥ 168 hours |

> "Days" for Lead Time are **working days** when `excludeWeekends: true` (the
> default). The band thresholds themselves are unchanged; only the unit of
> measurement differs.

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

**DF and CFR** use sum-of-totals / ratio-of-sums. A board with zero deployments
contributes 0 to both numerator and denominator without distorting the average.

**Lead Time and MTTR** use pooled median. To avoid double DB queries,
`getDoraAggregate()` calls `getLeadTimeObservations()` and `getMttrObservations()`
(which return raw arrays) rather than `calculate()` (which returns only
summaries). The per-board `LeadTimeResult` and `MttrResult` are then
reconstructed from the observation arrays within `getDoraAggregate()` itself.

---

## 7. Known Limitations

These are documented issues that are not bugs but represent conscious trade-offs
or deferred work:

1. **Working days, not calendar days (for Lead Time and Cycle Time).** Lead Time
   and Cycle Time are measured in working days by default (`excludeWeekends: true`).
   MTTR remains in calendar hours. If you compare Fragile's lead time numbers to
   a tool that uses calendar days, expect Fragile to report lower values (weekends
   excluded). Toggle `excludeWeekends: false` in `boards.yaml` to switch to
   calendar-day measurement for direct comparison.

2. **`boardId === projectKey` assumption.** Version-based queries in
   `DeploymentFrequencyService`, `LeadTimeService`, and `CfrService` use
   `projectKey = boardId`. If a future board has a Jira board ID that differs
   from its project key, version-based deployments and lead time fallbacks will
   return zero for that board. See proposal 0017 §Finding 2.2 and proposal 0018
   §Known Limitation.

3. **`isWorkItem` exclusion is narrow.** Only `'Epic'` and `'Sub-task'`
   (hyphenated) are excluded. Teams using `'Subtask'` (no hyphen), `'Sub Task'`
   (with space), or custom sub-task types will see those items in metric
   calculations. See proposal 0017 §Finding 11.3.

4. **CFR and MTTR share the same default issue types (`Bug`, `Incident`).** A
   Bug that is both a failure (CFR) and an incident (MTTR) will appear in both
   metrics. This is intentional — these are independent signal types that
   happen to share default values.

5. **30-minute sync staleness.** Jira data is synced every ~30 minutes. A
   change made in Jira (sprint start, issue completion) may not be reflected
   for up to 30 minutes. All metric calculations operate on the cached state
   at the time of the query.

6. **Holiday exclusion uses tenant-local dates.** Holidays in `workingTime.holidays`
   are matched against the date in the `TIMEZONE` environment variable. If
   `TIMEZONE` is set incorrectly, holidays may be excluded on the wrong UTC day.

---

## Consequences

This document should be updated whenever:

- A board configuration field is added or renamed in `BoardConfig`.
- A classification threshold in `dora-bands.ts` is changed.
- The deployment-detection logic (fixVersion / Done-transition) changes.
- The lead time start or end event definition changes.
- The incident / failure identification rules change.
- New org-level aggregation formulas are introduced.
- The working-time calculation algorithm or its configuration schema changes.

Failing to update this document when the code changes will cause it to
diverge from the implementation and lose its value as a reference.

---

## Purpose

This document is the authoritative reference for how each of the four DORA
metrics is computed in this codebase. It is aimed at new engineers who need to
understand exactly what the numbers mean, where the data comes from, and what
edge cases are handled. It reflects the **current implemented state** of the
code as of proposal 0020.

For a history of known bugs and how they were resolved, see proposals 0017
(audit) and 0018 (fixes). For the original architectural decision to add
org-level aggregation, see proposal 0006.

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

---

## Entities Used

| Entity | Table | Key fields used by DORA services |
|---|---|---|
| `JiraIssue` | `jira_issues` | `key`, `boardId`, `issueType`, `fixVersion`, `labels`, `priority`, `createdAt` |
| `JiraChangelog` | `jira_changelogs` | `issueKey`, `field`, `toValue`, `changedAt` |
| `JiraVersion` | `jira_versions` | `name`, `projectKey`, `releaseDate`, `released` |
| `JiraIssueLink` | `jira_issue_links` | `sourceIssueKey`, `targetIssueKey`, `linkTypeName` |
| `BoardConfig` | `board_configs` | `boardId`, `doneStatusNames`, `inProgressStatusNames`, `failureIssueTypes`, `failureLabels`, `failureLinkTypes`, `incidentIssueTypes`, `incidentLabels`, `incidentPriorities`, `recoveryStatusNames` |

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
  deploymentsPerDay: number;  // totalDeployments / periodDays
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
  (`released = false`):** The version is excluded from Path 1. If the issue
  has no Done transition in range, it is not counted at all.
- **Issue has `fixVersion` but `releaseDate` is outside the period:** The
  version is excluded from Path 1. The issue is also excluded from Path 2
  (because it has a `fixVersion`, even though the release is out-of-range).
  This is intentional — the issue will be counted in the period whose window
  contains the `releaseDate`.
- **`boardId` vs `projectKey`:** The version query uses `projectKey = boardId`.
  This is a known limitation: if a Jira board's ID differs from its project
  key, version-based deployments will return zero for that board. See proposal
  0017 §Finding 2.2.

### Org-level aggregation

When `getDoraAggregate()` is called:

```
orgDeploymentsPerDay = SUM(totalDeployments, all boards) / periodDays
```

Sum of totals — deploying on 6 boards is genuinely more frequent than deploying
on 1. The denominator `periodDays` is the same for all boards (they share the
same window).

---

## 2. Lead Time for Changes

**Service:** `LeadTimeService.calculate()` and
`LeadTimeService.getLeadTimeObservations()`
(`backend/src/metrics/lead-time.service.ts`)

**Formula:**

```
leadTime(issue) = endTime(issue) - startTime(issue)  [in days]
medianDays = percentile_50(all leadTime observations in period)
p95Days    = percentile_95(all leadTime observations in period)
```

Only issues whose `endTime` falls within `[startDate, endDate]` contribute an
observation. Issues with no `endTime` in range are silently skipped. Issues
with an `endTime` in range but no `startTime` are counted as anomalies and
excluded from the percentile distribution (see below).

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
work-item issue on the board (not just those within the period), then finds
the chronologically first match.

> **Why all-time changelogs?** An issue may have started work before the period
> window. Loading only in-range changelogs would miss the start event, causing
> a false anomaly or an inflated lead time using a later in-range transition as
> the start.

### End time — `endTime`

Two sources are tried in order:

1. **Done transition (primary):** The **last** `JiraChangelog` row for the
   issue where `cl.toValue IN doneStatusNames` and `cl.changedAt` is within
   `[startDate, endDate]`. The last done transition is used (not the first) to
   handle re-open/re-resolve workflows correctly.

2. **Version release date (fallback):** Used only when no done transition
   exists within the period **and** `issue.fixVersion` is non-null. Requires:
   - A `JiraVersion` with `version.name === issue.fixVersion` and
     `version.projectKey === boardId`.
   - `version.releaseDate` is non-null and falls within `[startDate, endDate]`.
   - `version.releaseDate >= inProgressTransition.changedAt` — the release date
     must not precede when work started (guards against stale version records
     pre-dating the actual work; see code comment referencing OCS-774).

   If these conditions are not met, the fallback is not used and the issue is
   skipped.

### Anomaly counting

An issue that has an `endTime` in range but **no transition to any
`inProgressStatusNames` status** in its entire changelog is counted as an
anomaly:

```typescript
anomalyCount++;
continue;   // excluded from leadTimeDays array
```

The anomaly count is returned in `LeadTimeResult.anomalyCount` and surfaced to
the caller (and ultimately to the frontend DORA page) so the user can see how
many issues were excluded. There is **no fallback to `issue.createdAt`** for
lead time — such a fallback would measure total ticket age, not lead time for
changes.

### Duration calculation

```typescript
const days = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
leadTimeDays.push(Math.max(0, days));  // clamped to 0 for negative durations
```

Negative lead times (where `endTime < startTime`) are clamped to `0` and a
warning is logged. These arise when a version's release date precedes the
in-progress transition — the release date guard (see above) should prevent
most cases, but the clamp provides a safety net.

Durations are in **calendar days** (wall-clock elapsed time), not business
days.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Identifies done-transition changelogs |
| `BoardConfig.inProgressStatusNames` | (22-item list above) | Identifies work-start changelogs |

### Output shape

```typescript
interface LeadTimeResult {
  boardId: string;
  medianDays: number;    // percentile_50, rounded to 2 dp
  p95Days: number;       // percentile_95, rounded to 2 dp
  band: DoraBand;        // classified by classifyLeadTime(medianDays)
  sampleSize: number;    // number of observations included
  anomalyCount: number;  // issues excluded due to missing in-progress transition
}
```

### Band thresholds (`classifyLeadTime`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `medianDays < 1` | Less than one day |
| `'high'` | `medianDays <= 7` | One day to one week (inclusive of 7 days) |
| `'medium'` | `medianDays <= 30` | One week to one month (inclusive of 30 days) |
| `'low'` | `medianDays > 30` | More than one month |

Note: the boundary values use `<=`, meaning exactly 7 days is `'high'` (not
`'medium'`). This matches the DORA 2023 report convention.

### Edge cases

- **No issues or no observations:** `medianDays = 0`, `band = classifyLeadTime(0) = 'elite'`,
  `sampleSize = 0`.
- **Single observation:** Median and P95 are both that one value.
- **All issues are anomalies:** `sampleSize = 0`, result is as if no issues
  exist; `anomalyCount` will be non-zero.
- **Issue moved to Done before any in-progress transition:** Counted as anomaly.
- **Issue re-opened and re-resolved within the period:** The *last* done
  transition in the period is used as `endTime`. The *first* in-progress
  transition ever is used as `startTime`. This can produce a lead time that
  spans multiple work sessions.

### Org-level aggregation

```
orgMedianDays = percentile_50(UNION of all observation arrays from all boards)
orgP95Days    = percentile_95(UNION of all observation arrays from all boards)
```

The pooled median is computed by `getDoraAggregate()`, which calls
`getLeadTimeObservations()` on each board (to get the raw sorted arrays),
concatenates them all, re-sorts, and computes percentiles. This is the
correct statistical approach — it models "if a randomly-picked change came
from anywhere in the org, how long did it take?"

---

## 3. Change Failure Rate

**Service:** `CfrService.calculate()`
(`backend/src/metrics/cfr.service.ts`)

**Formula:**

```
changeFailureRate (%) = (failureCount / totalDeployments) × 100
```

rounded to 2 decimal places (`Math.round(ratio * 10000) / 100`). Returns `0`
if `totalDeployments === 0`.

### Step 1 — Count total deployments

The total deployment denominator is computed using the **same two-path logic as
Deployment Frequency** (version-based primary, Done-transition fallback for
no-version issues):

- **Version path:** Issues with a `fixVersion` where the matching `JiraVersion`
  has `released = true` and `releaseDate` within `[startDate, endDate]`. The
  result is the set of matching issue keys: `versionIssueKeys`.
- **Transition-fallback path:** Issues with no `fixVersion` (and not already in
  `versionIssueKeys`) that have a Done-status transition within the period,
  using `DISTINCT cl.issueKey`. Result: `transitionIssueKeys`.

```typescript
const deployedKeys = new Set([...versionIssueKeys, ...transitionIssueKeys]);
const totalDeployments = deployedKeys.size;
```

The two sets are disjoint (same guard as DF service). The `totalDeployments`
values from `DeploymentFrequencyService` and `CfrService` are consistent for
identical inputs.

### Step 2 — Identify failure issues (OR-gate)

For each issue key in `deployedKeys`, the corresponding `JiraIssue` record is
checked. An issue is a **candidate failure** if **either** condition holds:

1. **By issue type:** `issue.issueType IN failureIssueTypes`
   (default: `['Bug', 'Incident']`)
2. **By label:** `issue.labels.some(l => failureLabels.includes(l))`
   (default: `['regression', 'incident', 'hotfix']`)

This is an OR-gate: matching either condition makes the issue a candidate.

### Step 3 — Apply causal-link AND-gate

If `BoardConfig.failureLinkTypes` is non-empty (default:
`['caused by', 'is caused by']`), the service applies an additional filter:
a candidate failure is **only counted** if it has at least one `JiraIssueLink`
where:

- `link.sourceIssueKey = issue.key`
- `LOWER(link.linkTypeName) IN failureLinkTypes` (compared case-insensitively)

This AND-gate ensures that a Bug or Incident is only counted as a change
failure if it is causally linked to a change — a standalone quality issue that
is not linked to a deployment does not inflate CFR.

```typescript
const keysWithCausalLink = new Set(causalLinks.map(l => l.sourceIssueKey));
filteredFailures = failureIssues.filter(i => keysWithCausalLink.has(i.key));
```

If `failureLinkTypes` is empty, the AND-gate is skipped and all OR-gate
candidates count as failures.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.doneStatusNames` | `['Done', 'Closed', 'Released']` | Identifies done-transition deployments in Path 2 |
| `BoardConfig.failureIssueTypes` | `['Bug', 'Incident']` | OR-gate: issue type check |
| `BoardConfig.failureLabels` | `['regression', 'incident', 'hotfix']` | OR-gate: label check |
| `BoardConfig.failureLinkTypes` | `['caused by', 'is caused by']` | AND-gate: causal link filter (compared case-insensitively) |

The flag `usingDefaultConfig: boolean` in the result is `true` when
`boardConfigRepo.findOne()` returned `null` for the board — i.e. no
`board_configs` row exists and all four defaults above are in use. This flag
propagates to `OrgCfrResult.anyBoardUsingDefaultConfig` as an amber warning
signal on the DORA page.

### Output shape

```typescript
interface CfrResult {
  boardId: string;
  totalDeployments: number;    // denominator
  failureCount: number;        // numerator (post AND-gate)
  changeFailureRate: number;   // percentage, 2 dp
  band: DoraBand;              // classified by classifyChangeFailureRate()
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

All boundaries are `<=` (inclusive). Exactly 5% is `'elite'`, exactly 10% is
`'high'`, exactly 15% is `'medium'`.

### Edge cases

- **No work-item issues on board:** Returns `changeFailureRate = 0`,
  `band = 'elite'` immediately (early-exit guard).
- **`failureLinkTypes` is an empty array:** The AND-gate is entirely bypassed;
  all OR-gate candidates count as failures without requiring a causal link.
- **A Bug is in `failureIssueTypes` but was not deployed in the period:** It is
  not included in `deployedKeys` and is therefore never evaluated as a failure
  candidate. Only deployed issues (within the period) can contribute to CFR.
- **Causal-link comparison is case-insensitive:** `'Caused By'`, `'CAUSED BY'`,
  and `'caused by'` all match the default `failureLinkTypes` entry `'caused by'`.

### Org-level aggregation

```
orgChangeFailureRate (%) = SUM(failureCount, all boards) /
                           SUM(totalDeployments, all boards) × 100
```

This is a **ratio of sums**, not an average of ratios. A board with 0
deployments contributes 0 to both numerator and denominator without distorting
the aggregate. The org-level denominator is `totalDeplForCfr` — the sum of
per-board `totalDeployments`.

---

## 4. Mean Time to Recovery (MTTR)

**Service:** `MttrService.calculate()` and `MttrService.getMttrObservations()`
(`backend/src/metrics/mttr.service.ts`)

**Formula:**

```
recovery(incident) = recoveryTime(incident) - startTime(incident)  [in hours]
medianHours = percentile_50(all recovery observations in period)
```

Only incidents whose first recovery transition falls within `[startDate, endDate]`
contribute an observation.

### Step 1 — Identify incident issues

From all work-item issues on the board, an issue is classified as an **incident
candidate** if **either** condition holds:

1. **By issue type:** `issue.issueType IN incidentIssueTypes`
   (default: `['Bug', 'Incident']`)
2. **By label (only if `incidentLabels` is non-empty):**
   `issue.labels.some(l => incidentLabels.includes(l))`
   (default: `[]` — disabled by default)

This is an OR-gate. If `incidentLabels` is empty (the default), only the
issue-type check applies.

### Step 2 — Apply priority AND-gate

If `BoardConfig.incidentPriorities` is non-empty (default: `['Critical']`),
the candidate set is filtered further: an incident is only retained if
`issue.priority !== null && incidentPriorities.includes(issue.priority)`.

If `incidentPriorities` is empty, all candidates from Step 1 pass through.

The test suite fixture (`mttr.service.spec.ts`) explicitly sets
`incidentPriorities: []` to disable the priority gate and test the base
type/label matching logic in isolation.

### Step 3 — Find recovery time (`recoveryTime`)

For the filtered incident issues, all status changelogs are loaded in a single
bulk query (all time, not just within the period — the start-time detection
needs pre-period changelogs, see below).

A recovery event is the **first** `JiraChangelog` row for an issue where:

- `cl.toValue IN recoveryStatuses` (default: `['Done', 'Resolved']`)
- `cl.changedAt >= startDate AND cl.changedAt <= endDate`

Only the chronologically first qualifying recovery transition is used. If an
incident is resolved, re-opened, and resolved again within the period, only
the first resolution counts.

```typescript
const firstRecoveryByIssue = new Map<string, Date>();
for (const cl of recoveryChangelogs) {
  if (!firstRecoveryByIssue.has(cl.issueKey)) {
    firstRecoveryByIssue.set(cl.issueKey, cl.changedAt);
  }
}
```

Incidents with no recovery transition in the period do not contribute an
observation.

### Step 4 — Find start time (`startTime`)

For each incident that has a recovery event in the period:

1. **Primary:** The first `JiraChangelog` transition for the issue where
   `cl.toValue IN inProgressStatusNames` (the same board-config-aware list used
   by Lead Time — 22 default entries). The search covers the **entire** changelog
   for the issue, not just the period window.
2. **Fallback:** If no in-progress transition exists, `issue.createdAt` is used.
   This models the incident as having started at detection time (when the ticket
   was filed). The `createdAt` fallback is kept for MTTR because an incident
   is "detected" at creation time — unlike Lead Time, there is no analogous
   concept of anomaly exclusion.

```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
);
const startTime = inProgressTransition
  ? inProgressTransition.changedAt
  : issue.createdAt;
```

### Step 5 — Duration calculation

```typescript
const hours = (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
if (hours >= 0) {
  recoveryHours.push(hours);
}
```

Negative durations (where recovery precedes start — a data anomaly) are
**silently discarded** (not pushed to the array). This differs from Lead Time,
which clamps to 0 and logs a warning.

Durations are in **hours** (not days), reflecting that recovery is expected to
be faster than lead time.

### Board configuration

| Config field | Default | Usage |
|---|---|---|
| `BoardConfig.incidentIssueTypes` | `['Bug', 'Incident']` | Step 1: OR-gate by type |
| `BoardConfig.incidentLabels` | `[]` | Step 1: OR-gate by label (disabled when empty) |
| `BoardConfig.incidentPriorities` | `['Critical']` | Step 2: AND-gate by priority |
| `BoardConfig.recoveryStatusNames` | `['Done', 'Resolved']` | Step 3: recovery transition detection |
| `BoardConfig.inProgressStatusNames` | (22-item list) | Step 4: work-start transition detection |

### Output shape

```typescript
interface MttrResult {
  boardId: string;
  medianHours: number;   // percentile_50, rounded to 2 dp
  band: DoraBand;        // classified by classifyMTTR(medianHours)
  incidentCount: number; // number of observations (incidents with recovery in period)
}
```

### Band thresholds (`classifyMTTR`)

| Band | Condition | Human meaning |
|---|---|---|
| `'elite'` | `medianHours < 1` | Less than one hour |
| `'high'` | `medianHours < 24` | Less than one day (1 hour to 24 hours) |
| `'medium'` | `medianHours < 168` | Less than one week (24 hours to 168 hours) |
| `'low'` | `medianHours >= 168` | One week or more |

Note: boundaries are strict `<` for MTTR (unlike CFR and Lead Time which use
`<=` for the upper boundary). Exactly 24 hours is `'medium'`, exactly 168 hours
is `'low'`.

### Edge cases

- **No qualifying incidents:** Returns `medianHours = 0`,
  `band = classifyMTTR(0) = 'elite'`, `incidentCount = 0`.
- **`incidentPriorities` is empty:** Priority filter is entirely bypassed; any
  issue matching the OR-gate in Step 1 is counted regardless of priority.
- **`incidentLabels` is empty (default):** The label OR-gate branch is skipped;
  only the `incidentIssueTypes` check applies.
- **Incident resolved before in-progress transition:** Start time falls back to
  `createdAt`. If `createdAt > recoveryDate` (a data anomaly, e.g. clocks
  wrong), `hours < 0` and the observation is silently discarded.
- **Incident has recovery event before the period but `startTime` (createdAt)
  is in the period:** The recovery event is outside the period window, so no
  observation is produced for this incident.
- **`isWorkItem` filter:** Epics and Sub-tasks are excluded before the incident
  type filter is applied. This means a `Sub-task` with `issueType = 'Bug'` is
  not counted as an incident.

### Org-level aggregation

```
orgMttrMedianHours = percentile_50(UNION of all recovery-hours arrays from all boards)
```

Same pooled-median approach as Lead Time. `getMttrObservations()` returns the
pre-sorted raw array for each board; `getDoraAggregate()` concatenates all
arrays, re-sorts, and computes the percentile. Boards with zero incidents
contribute no data points and do not distort the aggregate with a phantom 0-hour
recovery.

---

## 5. DORA Band Reference

All band classification functions are in `dora-bands.ts`. This is the **single
source of truth**. The frontend has a separate copy in `frontend/src/lib/dora-bands.ts`
which must be kept in sync.

```typescript
export type DoraBand = 'elite' | 'high' | 'medium' | 'low';
```

### Summary table

| Metric | Elite | High | Medium | Low |
|---|---|---|---|---|
| Deployment Frequency | ≥ 1/day | ≥ 1/week | ≥ 1/month | < 1/month |
| Lead Time for Changes | < 1 day | ≤ 7 days | ≤ 30 days | > 30 days |
| Change Failure Rate | ≤ 5% | ≤ 10% | ≤ 15% | > 15% |
| MTTR | < 1 hour | < 24 hours | < 168 hours | ≥ 168 hours |

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

**DF and CFR** use sum-of-totals / ratio-of-sums. A board with zero deployments
contributes 0 to both numerator and denominator without distorting the average.

**Lead Time and MTTR** use pooled median. To avoid double DB queries,
`getDoraAggregate()` calls `getLeadTimeObservations()` and `getMttrObservations()`
(which return raw arrays) rather than `calculate()` (which returns only
summaries). The per-board `LeadTimeResult` and `MttrResult` are then
reconstructed from the observation arrays within `getDoraAggregate()` itself.

---

## 7. Known Limitations

These are documented issues that are not bugs but represent conscious trade-offs
or deferred work:

1. **Calendar days, not business days.** Lead Time and Cycle Time measure
   wall-clock elapsed time. LinearB measures business days. For a 2-week sprint
   a wall-clock lead time is approximately 30% higher than the LinearB
   equivalent. This is a known and accepted difference for simplicity and
   timezone safety.

2. **`boardId === projectKey` assumption.** Version-based queries in
   `DeploymentFrequencyService`, `LeadTimeService`, and `CfrService` use
   `projectKey = boardId`. If a future board has a Jira board ID that differs
   from its project key, version-based deployments and lead time fallbacks will
   return zero for that board. See proposal 0017 §Finding 2.2 and proposal 0018
   §Known Limitation.

3. **`isWorkItem` exclusion is narrow.** Only `'Epic'` and `'Sub-task'`
   (hyphenated) are excluded. Teams using `'Subtask'` (no hyphen), `'Sub Task'`
   (with space), or custom sub-task types will see those items in metric
   calculations. See proposal 0017 §Finding 11.3.

4. **CFR and MTTR share the same default issue types (`Bug`, `Incident`).** A
   Bug that is both a failure (CFR) and an incident (MTTR) will appear in both
   metrics. This is intentional — these are independent signal types that
   happen to share default values.

5. **30-minute sync staleness.** Jira data is synced every ~30 minutes. A
   change made in Jira (sprint start, issue completion) may not be reflected
   for up to 30 minutes. All metric calculations operate on the cached state
   at the time of the query.

---

## Consequences

This document should be updated whenever:

- A board configuration field is added or renamed in `BoardConfig`.
- A classification threshold in `dora-bands.ts` is changed.
- The deployment-detection logic (fixVersion / Done-transition) changes.
- The lead time start or end event definition changes.
- The incident / failure identification rules change.
- New org-level aggregation formulas are introduced.

Failing to update this document when the code changes will cause it to
diverge from the implementation and lose its value as a reference.
