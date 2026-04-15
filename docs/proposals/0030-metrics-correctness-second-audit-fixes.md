# 0030 — Metrics Correctness: Second Audit Fix Batch

**Date:** 2026-04-15
**Status:** Draft
**Author:** Architect Agent
**Related ADRs:** None yet — will be created on acceptance
**Related:** [0017-metric-calculation-audit.md](0017-metric-calculation-audit.md),
[0018-metric-calculation-fixes.md](0018-metric-calculation-fixes.md),
[0026-metric-fixes-validation-report.md](0026-metric-fixes-validation-report.md)

---

## Problem Statement

Two independent audits performed after the 0017/0018 fix cycle identified a
further set of correctness issues in the metrics and planning layers.  The
first audit reviewed general metric calculation logic; the second specifically
reviewed how incident and failure labels are applied consistently across the
sprint, quarter, and week detail views.

The combined finding list includes one bug whose effect is binary (CFR always
reads zero on teams that do not use Jira causal links), one bug that silently
discards open incidents from MTTR, a timezone defect that produces wrong
quarter boundaries for every negative-offset timezone, and a class of
inconsistency where `incidentPriorities` filtering is applied by some views
but not others.  Without fixing these issues the dashboard cannot be trusted
as a LinearB replacement for any team operating in the Americas timezone or
any team that measures incident severity by priority rather than type alone.

---

## Scope of This Proposal

The fixes are grouped into four logical themes:

| Theme | Items |
|---|---|
| **A — Timezone correctness** | Bug 1 (`midnightInTz` negative-offset) |
| **B — Issue classification consistency** | Bug 2 (`'Subtask'` exclusion), Issues A / B / C / D (incident priority alignment) |
| **C — DORA definition and metric accuracy** | Issues 3, 4, 5, 8 (CFR defaults, MTTR open incidents, Kanban board-entry, DF counting) |
| **D — Documentation** | Issues 6, 9, 10 (hoursPerDay, DORA lead time vs cycle time, dora-bands label) |

Each theme has its own section below containing the full problem description,
proposed fix, affected files, expected post-fix behaviour, and risk level.

---

## Theme A — Timezone Correctness

### Fix A-1 — `midnightInTz` wrong for negative-offset timezones

**Risk level:** Medium

**Audit reference:** General audit Bug 1 ·
`backend/src/metrics/tz-utils.ts` lines 45–70

#### Problem

`midnightInTz(year, month, day, tz)` uses an offset-probe algorithm that
computes the UTC equivalent of midnight in the target timezone.  The probe
logic has an arithmetic sign error that causes the returned instant to land on
the wrong calendar day for any timezone with a **negative UTC offset**
(Americas, e.g. `America/New_York` = UTC−5, `America/Los_Angeles` = UTC−8).

Because `midnightInTz` is the foundation of quarter-boundary construction in
`period-utils.ts` and `planning.service.ts`, the defect means that for
negative-offset deployments:

- Q1 starts on `2025-12-31` instead of `2026-01-01`.
- Q2 starts on `2026-03-31` instead of `2026-04-01`.
- All quarter-based metrics (planning accuracy, delivery rate, roadmap coverage)
  silently include one extra day from the preceding quarter and exclude the
  last day of the current quarter.

The `working-time.service.ts` introduced in Proposal 0029 already contains a
correct implementation named `startOfDayInTz()` that uses a binary-search
probe and is known to work correctly for both positive and negative offsets.
The two implementations should be unified.

#### Proposed Fix

**Step 1 — Promote `startOfDayInTz()` from `WorkingTimeService` to a shared
export in `backend/src/metrics/tz-utils.ts`.**

The function signature is:

```typescript
/**
 * Returns the UTC instant corresponding to 00:00:00.000 on the given
 * calendar date in the specified IANA timezone.
 *
 * Uses a binary-search / offset-probe approach that is correct for both
 * positive and negative UTC offsets, including DST transitions.
 *
 * @param year  — Full year, e.g. 2026
 * @param month — 0-indexed month (0 = January, 11 = December)
 * @param day   — 1-indexed day of month
 * @param tz    — IANA timezone name, e.g. 'America/New_York'
 */
export function startOfDayInTz(
  year: number,
  month: number, // 0-indexed
  day: number,
  tz: string,
): Date
```

The implementation from `working-time.service.ts` is moved here verbatim and
exported so that it can be imported by any service without requiring injection
of `WorkingTimeService`.

**Step 2 — Replace all `midnightInTz(...)` call sites with
`startOfDayInTz(...)`.**

| File | Affected lines | Change |
|---|---|---|
| `backend/src/metrics/tz-utils.ts` | 45–70 | Replace `midnightInTz` implementation body; deprecate the name via a thin alias: `export const midnightInTz = startOfDayInTz;` |
| `backend/src/metrics/period-utils.ts` | All calls to `midnightInTz` | Update imports; use `startOfDayInTz` directly |
| `backend/src/planning/planning.service.ts` | All calls to `midnightInTz` | Same |

The alias means any other callers that already use `midnightInTz` continue to
compile without changes, while the underlying algorithm is the correct one.
The alias can be removed in a future cleanup pass.

**Step 3 — Update `WorkingTimeService` to import `startOfDayInTz` from
`tz-utils.ts`** rather than maintaining its own copy, eliminating the
duplication.

**Step 4 — Update the failing unit test.**

`backend/src/metrics/tz-utils.spec.ts` lines 73–80 assert the wrong expected
value for a negative-offset timezone (the test was written against the broken
implementation).  The expected value must be corrected to the true UTC instant
of midnight in the tested timezone.

#### Expected behaviour after fix

`midnightInTz(2026, 0, 1, 'America/New_York')` returns
`2026-01-01T05:00:00.000Z` (midnight EST = UTC−5).  Previously it returned
`2026-01-01T19:00:00.000Z` (the wrong direction).

Quarter boundaries for all negative-offset timezones are correct; no
off-by-one-day misattribution of issues to quarters.

---

## Theme B — Issue Classification Consistency

### Fix B-1 — `'Subtask'` (next-gen Jira) not excluded from work items

**Risk level:** Low

**Audit reference:** General audit Bug 2 ·
`backend/src/metrics/issue-type-filters.ts` line 2

#### Problem

The `isWorkItem()` guard excludes issue types that should not appear in flow
metrics (subtasks, epics, initiatives).  The exclusion array currently contains
only `'Sub-task'` — the issue type name used by Jira's **classic** project
format.  Jira **next-gen** (team-managed) projects use `'Subtask'` (no hyphen).

On a next-gen board, child issues of type `'Subtask'` pass the `isWorkItem()`
check and are included in Cycle Time, Lead Time, Deployment Frequency, and
MTTR calculations.  This inflates issue counts (each parent story appears
alongside its subtasks), distorts cycle-time distributions (subtasks have
shorter cycle times than stories), and artificially increases Deployment
Frequency.

#### Proposed Fix

**File:** `backend/src/metrics/issue-type-filters.ts` line 2

Add `'Subtask'` to the `EXCLUDED_TYPES` array alongside the existing
`'Sub-task'` entry:

```typescript
// Before:
const EXCLUDED_TYPES = ['Sub-task', 'Epic', 'Initiative'];

// After:
const EXCLUDED_TYPES = ['Sub-task', 'Subtask', 'Epic', 'Initiative'];
```

No schema change, no configuration change, no migration.

> **Relation to P3-4 from 0017:** Proposal 0017 deferred full configurable
> exclusion-list support (P3-4) because it required a `BoardConfig` schema
> migration.  This fix is a targeted, zero-migration addition of the single
> most common missing value.  The full configurable exclusion list remains
> deferred.

#### Expected behaviour after fix

Issues of type `'Subtask'` on next-gen Jira boards are excluded from all flow
metric calculations — identical to how `'Sub-task'` issues are already
excluded on classic boards.

---

### Fix B-2 — Sprint view ignores `incidentPriorities`

**Risk level:** Medium

**Audit reference:** Sprint/failure label audit Issue A ·
`backend/src/sprint/sprint-detail.service.ts` line 449

#### Problem

`SprintDetailService` classifies an issue as an incident when its type is in
`failureIssueTypes` — but it does **not** also check `incidentPriorities`.
`MttrService` applies both an issue-type check **and** a priority AND-gate
(an issue must match both `failureIssueTypes` and `incidentPriorities` to be
counted as an incident).

The result is that a `Bug` at `Medium` priority (below the configured incident
threshold) appears in the sprint view's incident list and counts towards the
sprint's failure rate, but is excluded from MTTR — creating a permanent
discrepancy between the sprint-level incident count and the MTTR calculation
for the same sprint.

#### Proposed Fix

**File:** `backend/src/sprint/sprint-detail.service.ts` around line 449

Load `incidentPriorities` from `BoardConfig` (the same value already read by
`MttrService`) and add the AND-gate to the incident-classification predicate:

```typescript
// Load from BoardConfig (already loaded earlier in the method)
const incidentPriorities: string[] =
  config?.incidentPriorities ?? ['Critical', 'Highest', 'P1', 'P2'];

// Replace the existing type-only check:
// BEFORE:
const isIncident = failureIssueTypes.includes(issue.issueType);

// AFTER:
const isIncident =
  failureIssueTypes.includes(issue.issueType) &&
  (incidentPriorities.length === 0 ||
    incidentPriorities.includes(issue.priority ?? ''));
```

The `incidentPriorities.length === 0` guard preserves the existing behaviour
when no priorities are configured — an empty list means "any priority qualifies"
(consistent with `MttrService`'s semantics).

#### Expected behaviour after fix

An issue classified as an incident in the sprint view will always be classified
as an incident by `MttrService` for the same board, and vice versa.  A `Bug`
at `Medium` priority on a board whose `incidentPriorities = ['Critical',
'Highest']` no longer appears in the sprint incident list.

---

### Fix B-3 — Quarter and week detail views hardcode `'Critical'`

**Risk level:** Medium

**Audit reference:** Sprint/failure label audit Issue B ·
`backend/src/metrics/quarter-detail.service.ts` line 292 ·
`backend/src/metrics/week-detail.service.ts` line 291

#### Problem

`QuarterDetailService` and `WeekDetailService` classify incidents for the
per-period failure breakdown by hardcoding the priority check to `'Critical'`:

```typescript
// quarter-detail.service.ts line ~292 (same pattern in week-detail.service.ts)
const isIncident =
  failureIssueTypes.includes(issue.issueType) &&
  issue.priority === 'Critical';
```

This is inconsistent with `MttrService`, which reads `incidentPriorities` from
`BoardConfig` and supports a configurable list of qualifying priorities.  On
boards where incidents are tracked at `'Highest'` or `'P1'` severity rather
than `'Critical'`, these detail views show zero incidents and zero failures
even when MTTR is reporting non-zero values.

#### Proposed Fix

**Files:**
- `backend/src/metrics/quarter-detail.service.ts` line ~292
- `backend/src/metrics/week-detail.service.ts` line ~291

In both services, replace the hardcoded `'Critical'` check with a read from
`BoardConfig.incidentPriorities`, following the same pattern as the fix in
Fix B-2:

```typescript
// Load from BoardConfig (already loaded earlier in both services)
const incidentPriorities: string[] =
  config?.incidentPriorities ?? ['Critical', 'Highest', 'P1', 'P2'];

// Replace:
// BEFORE:
const isIncident =
  failureIssueTypes.includes(issue.issueType) &&
  issue.priority === 'Critical';

// AFTER:
const isIncident =
  failureIssueTypes.includes(issue.issueType) &&
  (incidentPriorities.length === 0 ||
    incidentPriorities.includes(issue.priority ?? ''));
```

#### Expected behaviour after fix

Quarter and week detail views classify incidents using the same board-configured
priority rules as `MttrService`.  The incident counts shown in detail views are
consistent with MTTR observations for the same period and board.

---

### Fix B-4 — Sprint view falls back to `[]` for missing `BoardConfig`

**Risk level:** Low

**Audit reference:** Sprint/failure label audit Issue C ·
`backend/src/sprint/sprint-detail.service.ts` lines 229–232

#### Problem

When no `BoardConfig` row exists for a board, `SprintDetailService` initialises
`failureIssueTypes` to `[]` (an empty array), meaning **no** issues are ever
classified as failures.  All other DORA services (`MttrService`, `CfrService`,
`DeploymentFrequencyService`) fall back to `['Bug', 'Incident']` when no config
is found, following the entity-level default.

This inconsistency means a newly-configured board with no persisted
`BoardConfig` row shows zero failures in the sprint view but non-zero failures
in the MTTR and CFR metric pages — contradictory results from the same
underlying data.

#### Proposed Fix

**File:** `backend/src/sprint/sprint-detail.service.ts` lines 229–232

Replace the empty-array fallback with the canonical entity-level default used
by all other DORA services:

```typescript
// BEFORE:
const failureIssueTypes: string[] = config?.failureIssueTypes ?? [];

// AFTER:
const failureIssueTypes: string[] =
  config?.failureIssueTypes ?? ['Bug', 'Incident'];
```

Apply the same correction to any other `BoardConfig` field read by
`SprintDetailService` that currently uses `[]` as a fallback where the entity
default is a non-empty array (verify `doneStatusNames`, `cancelledStatusNames`,
and `inProgressStatusNames` at the same site).

#### Expected behaviour after fix

A board with no persisted `BoardConfig` row produces identical failure
classification in the sprint view and in all DORA metric endpoints — namely,
issues of type `Bug` or `Incident` are treated as failures everywhere.

---

### Fix B-5 — `failureLinkTypes` AND-gate undocumented in detail views

**Risk level:** Low (documentation only)

**Audit reference:** Sprint/failure label audit Issue D

#### Problem

`CfrService` applies a causal-link AND-gate: an issue only counts as a failure
if it is linked to another issue via one of the `failureLinkTypes` (e.g.
`'caused by'`).  This gate is absent from the sprint, quarter, and week detail
views, which classify failures by type and priority alone without consulting
link types.

For the sprint view this is a documented design decision (Proposal 0003).  For
`QuarterDetailService` and `WeekDetailService` the omission is undocumented,
leaving future maintainers uncertain whether the absence of the link check is
intentional or an oversight.

#### Proposed Fix

No code change.  Add inline documentation comments at the failure-classification
site in both files:

**File:** `backend/src/metrics/quarter-detail.service.ts` (near line 292)

```typescript
// NOTE: The causal-link AND-gate used by CfrService (failureLinkTypes) is
// intentionally not applied here.  The quarter detail view shows all issues
// that match failureIssueTypes + incidentPriorities regardless of whether
// they carry a causal link to a deployment.  This provides a broader
// "incidents in this period" view rather than the strict CFR numerator.
// See proposal 0030 §Fix B-5 for rationale.
```

**File:** `backend/src/metrics/week-detail.service.ts` (near line 291)

Add an identical comment.

#### Expected behaviour after fix

No runtime change.  Future maintainers reading either file understand that the
`failureLinkTypes` check is an intentional omission, not a bug.

---

## Theme C — DORA Definition and Metric Accuracy

### Fix C-1 — CFR default `failureLinkTypes` silently zeroes CFR

**Risk level:** High

**Audit reference:** General audit Issue 3 ·
`backend/src/metrics/cfr.service.ts` lines 62–65, 151–166

#### Problem

`CfrService` classifies a failure by checking two conditions with AND logic:

1. The issue type and label match `failureIssueTypes` / `failureLabels`.
2. The issue has at least one issue link whose `type` is in `failureLinkTypes`.

The default value for `failureLinkTypes` (used when no `BoardConfig` row
exists, or when the field is not set) is `['caused by', 'is caused by']`.

Most Jira projects do not maintain causal links between deployments and
incidents.  On those projects, condition 2 is never satisfied and CFR is
permanently 0.0% regardless of how many high-priority bugs are resolved in each
period.  This is the **most common silent failure mode** in the DORA dashboard:
a team sees 0% CFR every period without realising the figure is a data
artefact, not a genuine quality signal.

#### Proposed Fix

**File:** `backend/src/metrics/cfr.service.ts` lines 62–65

Change the default value of `failureLinkTypes` from `['caused by', 'is caused
by']` to `[]`:

```typescript
// BEFORE:
const failureLinkTypes: string[] =
  config?.failureLinkTypes ?? ['caused by', 'is caused by'];

// AFTER:
const failureLinkTypes: string[] = config?.failureLinkTypes ?? [];
```

When `failureLinkTypes` is empty, the link AND-gate is skipped entirely —
an issue qualifies as a CFR failure based on type/label alone.  This is the
correct default: the link check is an optional filter for teams that
explicitly configure it, not a mandatory gate.

Update the link-AND-gate logic to explicitly check the empty-list case:

```typescript
// Skip the link check when failureLinkTypes is not configured (empty)
const passesLinkGate =
  failureLinkTypes.length === 0 ||
  issue.links?.some((l) => failureLinkTypes.includes(l.type));

const isFailure = passesTypeGate && passesLinkGate;
```

> **`boards.yaml` / `boards.example.yaml`:** The `failureLinkTypes` field
> description in the example file should be updated to clarify that an empty
> array (the default) disables the link gate, and that setting specific link
> type strings enables the strict causal-link mode.

#### Expected behaviour after fix

Teams not using Jira causal links see a CFR value derived from issue type and
label matching only.  Teams that explicitly set `failureLinkTypes` in their
board config continue to use the strict causal-link AND-gate.  CFR is no
longer silently zero for new or unconfigured boards.

---

### Fix C-2 — MTTR undercounts; open incidents silently discarded

**Risk level:** Medium

**Audit reference:** General audit Issue 4 ·
`backend/src/metrics/mttr.service.ts` lines 150–166

#### Problem

`MttrService.getMttrObservations()` only includes incidents in the MTTR
calculation when they have a Done-status transition that falls within the query
period.  Incidents that were opened during the period but are still open at
query time are silently dropped — they count neither in the MTTR average nor
in a visible "open incidents" counter.

Two side effects arise:

1. **MTTR is understated** on teams with long-running incidents: if five
   incidents opened this quarter and two are still open, the MTTR is computed
   from only three observations.  The team appears to recover faster than they
   do.

2. **Data anomalies go undetected**: a negative recovery time (i.e.
   `recoveredAt < startTime`, a data error) is silently discarded by the
   `hours < 0` branch with no visibility to the operator.

#### Proposed Fix

**File:** `backend/src/metrics/mttr.service.ts` lines 150–166

**Step 1 — Add `openIncidentCount` to `MttrResult`:**

```typescript
export interface MttrResult {
  boardId: string;
  medianHours: number;
  band: DoraBand;
  sampleSize: number;
  anomalyCount: number;
  openIncidentCount: number; // ← ADD: incidents opened in period but not yet recovered
}
```

**Step 2 — Track open incidents in `getMttrObservations()`:**

```typescript
let openIncidentCount = 0;

for (const issue of incidentIssues) {
  const doneTransition = issueLogs.find(
    (cl) => doneStatuses.includes(cl.toValue ?? ''),
  );

  if (!doneTransition) {
    // Incident has no recovery transition — it is still open.
    openIncidentCount++;
    continue;  // exclude from MTTR sample (same as before)
  }

  const hours =
    (doneTransition.changedAt.getTime() - startTime.getTime()) / 3_600_000;

  if (hours < 0) {
    // Data anomaly: recovery timestamp precedes detection timestamp.
    // Log a warning so operators can investigate the underlying Jira data.
    this.logger.warn(
      `MTTR anomaly: issue ${issue.key} has recovery before detection ` +
      `(${doneTransition.changedAt.toISOString()} < ${startTime.toISOString()}).` +
      ` Excluding from MTTR sample.`,
    );
    anomalyCount++;
    continue;
  }

  mttrHours.push(hours);
}
```

**Step 3 — Propagate `openIncidentCount` through `calculate()` and the API
response.**  The `MttrController` (or `MetricsService` aggregation) must
include `openIncidentCount` in the JSON response so the frontend can surface
it as an informational badge (e.g. "3 incidents still open — MTTR may be
understated").

No change to how the MTTR median is calculated — open incidents continue to be
excluded from the sample, which is correct (an MTTR cannot be computed for an
incident that has not recovered).

#### Expected behaviour after fix

- `MttrResult.openIncidentCount` is present in all MTTR API responses.
- Operators can see how many incidents were not resolved in the period and
  contextualise a low MTTR sample size appropriately.
- Data anomalies (negative recovery time) are visible in server logs rather
  than silently discarded.
- MTTR median computation is unchanged; only observability is improved.

---

### Fix C-3 — Kanban board-entry date hardcoded to `'To Do'`

**Risk level:** Medium

**Audit reference:** General audit Issue 5 ·
`backend/src/planning/planning.service.ts` lines 541–548

#### Problem

Kanban flow metrics (cycle time, delivery rate, and board-entry date for
roadmap accuracy) determine when an issue "entered the board" by looking for
a status-transition changelog entry where `toValue === 'To Do'`.  Boards that
use `'Backlog'`, `'Open'`, `'New'`, or any custom initial status fall back to
`issue.createdAt` as the board-entry date.

The `createdAt` fallback is often months before a Jira issue is ever triaged
onto the active board.  This inflates cycle times for the affected boards and
causes issues to be attributed to quarters where they were merely created
rather than when they entered active work.

#### Proposed Fix

**File:** `backend/src/planning/planning.service.ts` lines 541–548

Extend the default board-entry status list to cover the most common names used
across classic and next-gen Jira:

```typescript
// BEFORE (single hardcoded value):
const boardEntryFromValue = 'To Do';
const boardEntryTransition = issueLogs.find(
  (cl) => cl.toValue === boardEntryFromValue,
);

// AFTER (configurable with extended default list):
const boardEntryStatuses: string[] =
  config?.boardEntryStatuses ??
  ['To Do', 'Backlog', 'Open', 'New', 'TODO', 'OPEN', 'Selected for Development'];

const boardEntryTransition = issueLogs.find(
  (cl) => boardEntryStatuses.includes(cl.toValue ?? ''),
);
```

> **`BoardConfig` schema:** The `boardEntryStatuses` field does not yet exist
> on the `BoardConfig` entity.  Adding it requires a database migration.
> The migration is a simple nullable column addition with `DEFAULT NULL`;
> when `NULL`, the extended default list above is used.  This migration is
> small and reversible.

**Migration (new):**

```typescript
// migrations/NNNN-AddBoardEntryStatuses.ts (up)
await queryRunner.addColumn('board_configs', new TableColumn({
  name: 'boardEntryStatuses',
  type: 'text',
  isNullable: true,
  default: null,
}));

// (down)
await queryRunner.dropColumn('board_configs', 'boardEntryStatuses');
```

The column stores a JSON-encoded string array when set, `NULL` when unset
(uses the code-level default).  This mirrors the pattern used for
`inProgressStatusNames` and `doneStatusNames`.

> **Relation to 0017 P3-6:** Proposal 0017 deferred this as P3-6 and
> suggested bundling it with P3-1 (`addedMidQuarter` grace period) in a
> single `BoardConfig` schema extension.  P3-1 remains deferred.  The
> board-entry status fix is promoted here because it is the higher-impact
> item — a `createdAt` fallback on an active Kanban board corrupts all
> planning and roadmap metrics for that board.

#### Expected behaviour after fix

Boards using `'Backlog'`, `'Open'`, `'New'`, or `'Selected for Development'`
as their initial status detect board-entry correctly without requiring manual
`boardEntryStatuses` configuration.  Teams with custom initial status names
can set `boardEntryStatuses` in `boards.yaml` to override the default list.

---

### Fix C-4 — Deployment Frequency counts issues, not releases

**Risk level:** High

**Audit reference:** General audit Issue 8 ·
`backend/src/metrics/deployment-frequency.service.ts`,
`backend/src/metrics/cfr.service.ts`

#### Problem

The DORA definition of a deployment is: **one release event** (one version
published, one pipeline run, one deploy-to-production action).  The current
implementation counts **deployed issues**: a release containing 20 stories
returns `totalDeployments = 20`, not `1`.

The impact:

- A team releasing weekly with 15 stories per release reports a Deployment
  Frequency of ~15/week when the true DORA DF is ~1/week — an order of
  magnitude difference that maps to a different DORA band entirely.
- CFR's denominator (`totalDeployments`) is the same inflated count, so CFR
  is also understated by a factor proportional to average release size.
- Two teams with identical release cadences but different story sizes (one
  team ships micro-changes, the other ships features) produce incomparable
  DORA numbers.

The `JiraVersion` entity (`releaseDate`, `released`, `projectKey`) already
provides the necessary data: each distinct released version is one deployment
event.

#### Proposed Fix

**File:** `backend/src/metrics/deployment-frequency.service.ts`

Change the primary deployment count from "distinct deployed issue keys" to
"distinct `JiraVersion.releaseDate` dates within the period":

```typescript
// Step 1: Count distinct release events (one per unique release date within period)
const releasedVersions = await this.versionRepo.find({
  where: {
    projectKey: boardId,
    released: true,
    releaseDate: Between(startDate, endDate),
  },
});

// Each unique releaseDate represents one deployment event.
// Multiple versions released on the same date = still one deployment day
// (one "deploy" from DORA perspective — teams often release multiple components
// in a coordinated push on the same day).
const releaseDays = new Set(
  releasedVersions.map((v) => v.releaseDate!.toISOString().split('T')[0]),
);
const versionDeployments = releaseDays.size;
```

The existing **issue-transition fallback** (for issues with no `fixVersion`)
remains, but the fallback count is a count of distinct **fallback transition
days** rather than distinct issue keys:

```typescript
// Fallback path: issues with no fixVersion that transitioned to Done in period.
// Count distinct done-transition calendar days (not distinct issue keys).
const fallbackDoneTransitions = await this.changelogRepo
  .createQueryBuilder('cl')
  .select(`DATE(cl."changedAt") AS "transitionDay"`)
  .where('cl.issueKey IN (:...keys)', { keys: noVersionKeys })
  .andWhere('cl.field = :field', { field: 'status' })
  .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
  .andWhere('cl.changedAt BETWEEN :start AND :end', { start: startDate, end: endDate })
  .groupBy('"transitionDay"')
  .getRawMany<{ transitionDay: string }>();

const fallbackDeployments = fallbackDoneTransitions.length;
```

**Denominator alignment in `CfrService`:** `CfrService` must use the same
release-day counting for its `totalDeployments` denominator to keep CFR
semantically consistent with DF.  Apply the same version-counting change to
`backend/src/metrics/cfr.service.ts`.

> **Database query:** No schema change is required.  `JiraVersion` already has
> `releaseDate` and `released` columns.  The existing `Between` TypeORM helper
> is sufficient.

> **DORA period divisor:** `deploymentFrequency = versionDeployments /
> periodDays` — the period-length divisor remains calendar days, unchanged.

> **Boards with no versions:** Boards that never use Jira fix versions fall
> entirely through to the transition-fallback path.  The fallback now counts
> distinct days rather than distinct issues.  This is still a proxy metric
> but a more accurate proxy: a day on which the team merged and deployed work
> is one deployment event regardless of how many tickets were closed.

#### Expected behaviour after fix

A board that releases weekly (7 versions released in a 28-day window) reports
`totalDeployments = 7` and `deploymentFrequency ≈ 0.25/day`.  The prior
implementation would have reported `totalDeployments = 7 × (avg stories per
release)`.

---

## Theme D — Documentation Fixes

### Fix D-1 — `DORA_METRICS.md` documents `hoursPerDay` as MTTR divisor

**Risk level:** Low (documentation only)

**Audit reference:** General audit Issue 6

#### Problem

`docs/DORA_METRICS.md` (or the equivalent project documentation file)
describes the MTTR calculation as dividing total hours by `hoursPerDay` to
convert to "business day" units.  The actual divisor in
`backend/src/metrics/working-time.service.ts` line 202 (introduced in
Proposal 0029) is `24` — MTTR is expressed in **calendar hours**, not
working-day-adjusted hours.  The `hoursPerDay` config value controls
working-day duration for cycle-time and lead-time conversions; it has no
effect on MTTR.

A reader following the documentation to understand why MTTR appears as a
raw-hours figure (not business-day-adjusted) will not find an accurate
explanation.

#### Proposed Fix

**File:** `docs/DORA_METRICS.md` (or the documentation file that describes
MTTR calculation)

Update the MTTR section to state:

> MTTR is measured in **calendar hours** (raw wall-clock time from detection
> to recovery).  Unlike cycle time and lead time, MTTR does not exclude
> weekends — incidents do not pause on weekends and must be resolved regardless
> of the day.  The `hoursPerDay` configuration value applies only to
> cycle-time and lead-time calculations and has no effect on MTTR.
> See `working-time.service.ts` and Proposal 0029 for full rationale.

---

### Fix D-2 — Lead time described as DORA definition; it is cycle time

**Risk level:** Low (UI documentation only)

**Audit reference:** General audit Issue 9 ·
`backend/src/metrics/lead-time.service.ts`

#### Problem

The DORA research definition of Lead Time for Changes is the elapsed time
from **code commit to production deployment** (commit → merge → deploy
pipeline → live).  This application measures the elapsed time from **first
in-progress status transition to done transition** — which is technically
**cycle time** in most engineering workflow frameworks (sometimes called
"flow time" or "coding time").

While the measurement is acknowledged to be an approximation of the DORA
metric, neither the API response nor the UI surface this distinction to the
user.  A team comparing this dashboard's "Lead Time" figure against a
LinearB or DORA State of DevOps report will find the numbers incomparable
without understanding why.

#### Proposed Fix

No code change.  Surface the distinction in the frontend UI:

**File:** `frontend/src/app/dora/` (the DORA metrics page component)

Add a tooltip or footnote beneath the Lead Time metric card:

> **Note:** This metric measures *cycle time* (first active-work status →
> done), not the DORA definition of lead time (commit → deploy).  It is a
> proxy for DORA lead time for teams without commit-level Jira integration.
> See the DORA Metrics Reference (Proposal 0021) for details.

Update the backend API documentation (inline JSDoc on `LeadTimeResult` or in
`DORA_METRICS.md`) to record the same clarification.

---

### Fix D-3 — `dora-bands.ts` band comment labels cycle time thresholds as lead time

**Risk level:** Low (documentation only)

**Audit reference:** General audit Issue 10 ·
`backend/src/metrics/dora-bands.ts` line 13

#### Problem

The comment above `classifyLeadTime()` in `backend/src/metrics/dora-bands.ts`
reads (approximately):

```typescript
/** DORA Lead Time for Changes thresholds (2023 report) */
function classifyLeadTime(medianDays: number): DoraBand { ... }
```

As described in Fix D-2, the thresholds are applied to cycle-time
observations, not to DORA lead time (commit → deploy).  A future maintainer
reading this comment will believe the thresholds are directly from the DORA
research; in fact they are the DORA Lead Time thresholds re-applied to a
cycle-time proxy.

#### Proposed Fix

**File:** `backend/src/metrics/dora-bands.ts` line 13

Update the JSDoc comment to clarify:

```typescript
/**
 * Classifies a cycle-time median (first active-work status → done) using the
 * DORA Lead Time for Changes band thresholds from the 2023 State of DevOps
 * report.
 *
 * NOTE: This application measures cycle time, not the full DORA lead time
 * (commit → deploy).  The thresholds are re-applied to the cycle-time proxy
 * because it is the closest available signal without commit-level integration.
 * See Proposal 0030 Fix D-2 and the DORA Metrics Reference (0021) for full
 * rationale.
 */
```

No code change.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required for Fix C-3 only | New nullable `boardEntryStatuses` column on `board_configs`; reversible |
| API contract | Additive for Fix C-2 | `MttrResult.openIncidentCount` is a new field; existing clients that ignore unknown fields are unaffected |
| Frontend | Minor for Fix C-2 and Fix D-2 | MTTR card may show open-incident badge; Lead Time card gains tooltip/footnote |
| Tests | New and updated unit tests | See per-fix notes below |
| Jira API | No new calls | All fixes operate on already-synced data |
| Historical data | Fix C-4 changes `totalDeployments` values | DF and CFR metric history changes; values will be lower and more DORA-accurate |
| `boards.yaml` | Additive for Fixes C-1, C-3 | `failureLinkTypes` default behaviour documented; new optional `boardEntryStatuses` field |

### Test changes by fix

| Fix | Test changes |
|---|---|
| A-1 | `tz-utils.spec.ts` lines 73–80: update expected value for negative-offset timezone; add test for `America/Los_Angeles`; add round-trip test (midnight in tz → dateParts should return the input date) |
| B-1 | `issue-type-filters.spec.ts` (new or existing): add `'Subtask'` to excluded-type assertion list |
| B-2 | `sprint-detail.service.spec.ts`: add test case where `Bug` at `Medium` priority is NOT classified as incident; add test where `Bug` at `Critical` IS classified |
| B-3 | `quarter-detail.service.spec.ts`, `week-detail.service.spec.ts`: add test cases for `incidentPriorities` filtering |
| B-4 | `sprint-detail.service.spec.ts`: add test with no `BoardConfig` — verify `failureIssueTypes` defaults to `['Bug', 'Incident']` |
| B-5 | No test change (documentation comment only) |
| C-1 | `cfr.service.spec.ts`: add test where `failureLinkTypes = []` → link gate skipped; add test where `failureLinkTypes = ['caused by']` → link gate applied |
| C-2 | `mttr.service.spec.ts`: add test with unresolved incident → `openIncidentCount = 1`; add test with negative recovery time → logged warning, anomalyCount incremented |
| C-3 | `planning.service.spec.ts`: add test where initial status is `'Backlog'` → board-entry date detected from changelog, not `createdAt` |
| C-4 | `deployment-frequency.service.spec.ts`: add test with 3 issues in 1 version → `totalDeployments = 1`; add test with no versions → fallback counts distinct days |
| D-1, D-2, D-3 | No test changes (documentation only) |

---

## Rollout Order

The fixes are ordered to minimise risk and maximise reversibility.  Fixes in
the same numbered group can be implemented in parallel.

**Round 1 — Zero-risk, no-migration fixes (implement first, ship together):**

1. **B-1** (`'Subtask'` exclusion) — one-line array change, no deps, no risk.
2. **B-4** (sprint view `[]` → `['Bug', 'Incident']` fallback) — aligns to
   existing entity defaults.
3. **B-5** (documentation comments for detail views) — code comments only.
4. **D-1** (`DORA_METRICS.md` hoursPerDay correction) — documentation only.
5. **D-3** (`dora-bands.ts` comment correction) — documentation only.

**Round 2 — Service-layer logic changes, no schema change:**

6. **A-1** (`midnightInTz` negative-offset fix) — fix the shared utility;
   update the failing test.  Validates immediately in any Americas-timezone
   deployment.
7. **C-1** (CFR `failureLinkTypes` default → `[]`) — changes live CFR values
   for teams not using causal links; deploy with a release note.
8. **B-2** (`SprintDetailService` `incidentPriorities` AND-gate) — depends on
   understanding that B-4 has already standardised the fallback.
9. **B-3** (Quarter/Week detail `incidentPriorities` from config) — same
   pattern as B-2; implement together.

**Round 3 — Metric accuracy changes with API surface impact:**

10. **C-2** (MTTR `openIncidentCount`) — new field on API response; update
    frontend MTTR card to display open-incident badge.
11. **D-2** (Lead Time tooltip in UI) — depends on agreement on tooltip copy;
    can ship independently.

**Round 4 — Schema migration and highest-impact metric change:**

12. **C-3** (`boardEntryStatuses` column + migration) — requires a migration;
    run migration in a maintenance window; validate Kanban planning metrics
    before and after.
13. **C-4** (Deployment Frequency counts releases not issues) — highest user-
    visible impact; deploy last after all other metrics are stable; include
    explicit release notes explaining why DF and CFR values will change.

---

## Open Questions

1. **Fix C-4 — DF fallback counting by day vs by issue:** The proposal changes
   the no-fixVersion fallback from "distinct issue keys" to "distinct
   transition days".  On a board that deploys continuously (many small issues
   closed every day), "days with at least one closure" may undercount
   deployments.  Should the fallback count distinct days, or should it remain
   issue-based but be clearly documented as an approximation?  Recommendation:
   count distinct days (closer to DORA intent) but document the approximation
   clearly in the API response.

2. **Fix C-2 — Frontend MTTR open-incident display:** Should `openIncidentCount
   > 0` show as a warning badge on the MTTR card, or only appear in a detail
   view?  Recommendation: show an amber badge "N open" on the MTTR card when
   `openIncidentCount > 0` so operators see it immediately without drilling
   down.

3. **Fix A-1 — `midnightInTz` alias retention:** How long should the
   `midnightInTz` alias be kept before it is removed?  Recommendation: retain
   the alias for one release cycle (to catch any external callers not updated
   by this proposal's implementation), then remove it in a follow-on cleanup
   PR.

4. **Fix C-3 — `boardEntryStatuses` storage:** The proposal encodes the list
   as a JSON string in a `text` column, following the existing `simple-json`
   pattern for `inProgressStatusNames`.  Should it use the same TypeORM
   `simple-json` column type for consistency?  Recommendation: yes, use
   `simple-json` to match the existing `BoardConfig` column style.

---

## Acceptance Criteria

### Theme A

- [ ] `midnightInTz(2026, 0, 1, 'America/New_York')` returns
      `2026-01-01T05:00:00.000Z` (Fix A-1).
- [ ] `midnightInTz(2026, 0, 1, 'Australia/Sydney')` returns a UTC instant
      that is midnight AEDT, i.e. `2025-12-31T13:00:00.000Z` (Fix A-1 —
      positive-offset not regressed).
- [ ] `tz-utils.spec.ts` lines 73–80 assert the corrected expected value and
      pass (Fix A-1).
- [ ] `WorkingTimeService` imports `startOfDayInTz` from `tz-utils.ts` and
      does not maintain its own copy of the algorithm (Fix A-1).

### Theme B

- [ ] `isWorkItem('Subtask')` returns `false` (Fix B-1).
- [ ] `isWorkItem('Sub-task')` still returns `false` (Fix B-1 — not regressed).
- [ ] A `Bug` at `Medium` priority on a board with `incidentPriorities:
      ['Critical', 'Highest']` is **not** counted as an incident in the sprint
      view (Fix B-2).
- [ ] A `Bug` at `Critical` priority on the same board **is** counted as an
      incident (Fix B-2).
- [ ] `QuarterDetailService` and `WeekDetailService` both read
      `incidentPriorities` from `BoardConfig` for incident classification; a
      board with `incidentPriorities: ['Highest']` shows incidents of priority
      `'Highest'` only in the detail view (Fix B-3).
- [ ] `SprintDetailService` with no `BoardConfig` defaults `failureIssueTypes`
      to `['Bug', 'Incident']` (Fix B-4).
- [ ] `quarter-detail.service.ts` and `week-detail.service.ts` contain the
      `failureLinkTypes` intentional-omission comment (Fix B-5).

### Theme C

- [ ] `CfrService` with no configured `failureLinkTypes` skips the link AND-gate;
      `Bug` issues matching type/label are counted as CFR failures without
      requiring a causal link (Fix C-1).
- [ ] `CfrService` with `failureLinkTypes: ['caused by']` still requires the
      link AND-gate (Fix C-1 — not regressed).
- [ ] `MttrResult` includes `openIncidentCount`; an incident opened in the
      query period with no recovery transition contributes `openIncidentCount =
      1` and is excluded from the MTTR median (Fix C-2).
- [ ] A negative-hours MTTR anomaly logs a `WARN`-level message and increments
      `anomalyCount` (Fix C-2).
- [ ] `PlanningService` detects board-entry for an issue whose first status
      transition is to `'Backlog'` (Fix C-3).
- [ ] The `board_configs` migration adds `boardEntryStatuses` as a nullable
      `text`/`simple-json` column; the `down` migration removes it cleanly
      (Fix C-3).
- [ ] `DeploymentFrequencyService` with one version containing 20 issues returns
      `totalDeployments = 1` (or `= 1` distinct release day) (Fix C-4).
- [ ] `CfrService.totalDeployments` and `DeploymentFrequencyService.totalDeployments`
      return the same value for the same inputs after Fix C-4 (Fix C-4).

### Theme D

- [ ] `DORA_METRICS.md` MTTR section states that MTTR uses calendar hours and
      that `hoursPerDay` does not apply (Fix D-1).
- [ ] The DORA page Lead Time card displays a tooltip or footnote clarifying
      that the metric is a cycle-time proxy (Fix D-2).
- [ ] `backend/src/metrics/dora-bands.ts` `classifyLeadTime` JSDoc states
      explicitly that the thresholds are applied to cycle-time observations
      (Fix D-3).
- [ ] No existing passing tests are broken by any change in this proposal.
