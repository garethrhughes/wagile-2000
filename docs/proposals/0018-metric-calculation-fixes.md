# 0018 — Metric Calculation Fixes (P1 + P2)

**Date:** 2026-04-12
**Status:** Draft
**Author:** Architect Agent
**Supersedes:** N/A
**Related:** [0017-metric-calculation-audit.md](0017-metric-calculation-audit.md)

---

## Problem Statement

Proposal 0017 completed a full-coverage audit of every metric calculation in
the codebase.  It identified four P1 findings that must be fixed before any
production use, seven P2 findings that must be fixed before wider team rollout,
and six P3 findings deferred to a future proposal.

This proposal specifies the concrete implementation changes for all P1 and P2
findings, incorporating the following decisions already made by the project
owner:

1. **Timezone policy** — configure a `TIMEZONE` env var; default `UTC`.
2. **`boardId` vs `projectKey` mapping** — theoretical risk only; document as
   a known limitation; no code change.
3. **Lead Time Scrum fallback** — exclude no-in-progress issues as anomalies
   (same as Cycle Time); remove `createdAt` fallback; surface anomaly count.
4. **Kanban `deliveryRate` history** — acceptable to change historical numbers;
   no feature flag or `dataStartDate` boundary needed.
5. **`resolveBoardIds` async fix** — implement directly in `MetricsService`;
   no separate proposal required.
6. **Deployment Frequency model (P1-1)** — priority-based, mutually exclusive
   per issue: if an issue has a `fixVersion`, use the fixVersion release date;
   only issues without a `fixVersion` fall back to the Done transition date.
   Set union of both paths is explicitly rejected.

---

## Findings Addressed

### P1-1 — Deployment Frequency double-counting

**Audit reference:** 0017 §Finding 1.1 · `deployment-frequency.service.ts` line 82

#### Problem

`DeploymentFrequencyService.calculate()` combines two counts with
`Math.max(versionDeployments, transitionDeployments)` (line 82).  The first
count is distinct issues with a matching `fixVersion`; the second is raw
changelog *events* (not distinct issues), produced by `.getCount()` on the
changelog query (line 123).  An issue moved to Done, re-opened, and
re-resolved contributes `2` to `transitionDeployments` but should contribute
`1` to any meaningful deployment count.

Beyond the double-counting, `Math.max` also conflates two semantically
different deployment signals.  The Set union approach (combining both paths)
is not correct for this domain: a fixVersion release is an explicit, deliberate
deployment event, while a Done transition is only a proxy used when no explicit
release exists.  Treating them as additive sources would allow the same
deployment work to be counted twice via different paths.

#### Proposed Fix — Priority-Based (Mutually Exclusive) Model

Per owner decision, the two deployment signals are **mutually exclusive per
issue**, not combined.  The rule is:

> **If an issue has a `fixVersion`, use the fixVersion's release date as the
> deployment event for that issue.  Only if an issue has no `fixVersion` does
> it fall back to the Done status-transition date.**

This means:

- Issues **with** a `fixVersion` whose release date falls in `[startDate, endDate]`
  → counted via the version path.  Their Done transitions are **not** also counted.
- Issues **without** any `fixVersion` whose first Done transition falls in
  `[startDate, endDate]` → counted via the transition-fallback path.

The two sets are disjoint by definition.  The total deployed count is their
**combined size** (not a Set union, which would risk double-counting an issue
that has both a fixVersion and a Done transition in range).

**File:** `backend/src/metrics/deployment-frequency.service.ts`

1. **Remove** the private `countDoneTransitions` method (lines 97–126).

2. **Load all work-item issues for the board once**, with `fixVersion` selected:

```typescript
const allIssues = (await this.issueRepo.find({
  where: { boardId },
  select: ['key', 'issueType', 'fixVersion'],
})).filter((i) => isWorkItem(i.issueType));

// Partition into: issues with a fixVersion vs issues without
const issuesWithVersion = allIssues.filter((i) => i.fixVersion != null && i.fixVersion !== '');
const issuesWithoutVersion = allIssues.filter((i) => !i.fixVersion);
```

3. **Version path** — keep the existing version-release-date query, but
   scope it to `issuesWithVersion`:

```typescript
// Collect distinct issue keys whose fixVersion released in [startDate, endDate]
let versionDeployedKeys: string[] = [];
if (issuesWithVersion.length > 0) {
  // ... existing versionNames/versionRepo query unchanged ...
  versionDeployedKeys = issuesWithVersion
    .filter((i) => versionNames.includes(i.fixVersion!))
    .map((i) => i.key);
}
```

4. **Transition-fallback path** — query Done transitions **only** for
   `issuesWithoutVersion`:

```typescript
let fallbackDeployedKeys: string[] = [];
if (issuesWithoutVersion.length > 0) {
  const noVersionKeys = issuesWithoutVersion.map((i) => i.key);
  const doneTransitions = await this.changelogRepo
    .createQueryBuilder('cl')
    .select('DISTINCT cl."issueKey"', 'issueKey')
    .where('cl.issueKey IN (:...keys)', { keys: noVersionKeys })
    .andWhere('cl.field = :field', { field: 'status' })
    .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
    .andWhere('cl.changedAt BETWEEN :start AND :end', {
      start: startDate,
      end: endDate,
    })
    .getRawMany<{ issueKey: string }>();
  fallbackDeployedKeys = doneTransitions.map((t) => t.issueKey);
}
```

5. **Combine** the two disjoint sets:

```typescript
// The two sets are mutually exclusive by construction (partitioned above).
// Using a Set merely removes any key-level duplicates within each path
// (e.g. an issue reopened and re-resolved multiple times).
const deployedKeys = new Set([...versionDeployedKeys, ...fallbackDeployedKeys]);
const totalDeployments = deployedKeys.size;
```

6. **Remove the `Math.max` line** and all references to `versionDeployments`
   and `transitionDeployments` as separate variables.

> **Alignment with `CfrService`:** After this change `CfrService` must apply
> the same priority-based partition.  `CfrService` currently uses a Set union.
> That must be updated to match: issues with a fixVersion use the version path;
> issues without a fixVersion use the transition path.  Both services will then
> share the same `totalDeployments` denominator.

#### Acceptance Criteria

- An issue **with** a `fixVersion` released in-range whose Done transition is
  also in-range is counted **once** (via the version path), not twice.
- An issue **without** a `fixVersion` that is moved to Done, re-opened, and
  re-resolved within the period contributes `1` to `totalDeployments` (Set
  deduplication within the transition path).
- An issue **without** a `fixVersion` that is in Done status is **not** counted
  via the version path.
- `DeploymentFrequencyService.totalDeployments` and `CfrService.totalDeployments`
  return the same value when called with identical `boardId`, `startDate`,
  `endDate` inputs (after `CfrService` is updated to the same model).
- Existing unit tests in `deployment-frequency.service.spec.ts` pass; new test
  cases verify: (a) version-path-only issue, (b) transition-path-only issue,
  (c) issue with both version and Done transition in range counts once via
  version path only, (d) re-open/re-resolve scenario counts once.

---

### P1-2 — Lead Time ignores board config in-progress status names

**Audit reference:** 0017 §Finding 2.1 · `lead-time.service.ts` lines 109–111

#### Problem

`LeadTimeService.getLeadTimeObservations()` finds the work-start event with a
hard-coded single-string check (line 109–111):

```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue === 'In Progress',
);
```

`CycleTimeService` correctly reads the full `inProgressStatusNames` array from
`BoardConfig` (cycle-time.service.ts lines 97–124), which may contain 20+
active-work status synonyms.  Any board whose first active-work status is
`'In Review'`, `'IN TEST'`, or any other non-`'In Progress'` value will have
all Lead Time observations silently dropped (Kanban) or artificially inflated
(Scrum, via the `createdAt` fallback).

Per decision 3 above, the Scrum `createdAt` fallback is also removed — issues
with no in-progress transition are treated as anomalies (excluded from
percentile calculation) and counted in a new `anomalyCount` field, matching
`CycleTimeService`'s existing behaviour.

#### Proposed Fix

**File:** `backend/src/metrics/lead-time.service.ts`

1. **Update `LeadTimeResult` interface** to add `anomalyCount`:

```typescript
export interface LeadTimeResult {
  boardId: string;
  medianDays: number;
  p95Days: number;
  band: DoraBand;
  sampleSize: number;
  anomalyCount: number;   // ← ADD: issues excluded because no in-progress transition
}
```

2. **In `getLeadTimeObservations()`**, replace lines 97–119 with:

```typescript
// Load board config once at the top of getLeadTimeObservations()
// (config is already loaded above for doneStatuses — reuse it)
const inProgressNames = config?.inProgressStatusNames ?? [
  'In Progress', 'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
  'PEER CODE REVIEW', 'Ready for Review', 'In Test', 'IN TEST', 'QA',
  'QA testing', 'QA Validation', 'IN TESTING', 'Under Test', 'ready to test',
  'Ready for Testing', 'READY FOR TESTING', 'Ready for Release',
  'Ready for release', 'READY FOR RELEASE', 'Awaiting Release', 'READY',
];

// ... (existing issue/changelog loading code is unchanged)

let anomalyCount = 0;
const leadTimeDays: number[] = [];

for (const issue of issues) {
  const issueLogs = changelogsByIssue.get(issue.key) ?? [];

  // Find the first transition to any active-work status (board-config-aware)
  const inProgressTransition = issueLogs.find(
    (cl) => inProgressNames.includes(cl.toValue ?? ''),
  );

  if (!inProgressTransition) {
    // No in-progress transition found — anomaly for BOTH Scrum and Kanban.
    // Decision 3: remove the Scrum createdAt fallback. Anomaly is counted
    // but excluded from the percentile distribution.
    anomalyCount++;
    continue;
  }

  const startTime = inProgressTransition.changedAt;

  // (existing endTime / doneTransition logic unchanged)
  // ...
}
```

3. **Change the return signature of `getLeadTimeObservations()`** to include
   `anomalyCount`:

```typescript
async getLeadTimeObservations(
  boardId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ observations: number[]; anomalyCount: number }> {
  // ...
  return { observations: leadTimeDays, anomalyCount };
}
```

4. **Update `calculate()`** to propagate `anomalyCount`:

```typescript
async calculate(boardId: string, startDate: Date, endDate: Date): Promise<LeadTimeResult> {
  const { observations: leadTimeDays, anomalyCount } =
    await this.getLeadTimeObservations(boardId, startDate, endDate);

  if (leadTimeDays.length === 0) {
    return { boardId, medianDays: 0, p95Days: 0, band: classifyLeadTime(0),
             sampleSize: 0, anomalyCount };
  }
  // ...
  return { boardId, medianDays: round2(median), p95Days: round2(p95),
           band: classifyLeadTime(median), sampleSize: leadTimeDays.length,
           anomalyCount };
}
```

5. **Update all callers of `getLeadTimeObservations` in `MetricsService`**
   (`getDoraAggregate`, etc.) to destructure the new return shape:

```typescript
// Before:
const ltObs = await this.leadTimeService.getLeadTimeObservations(...);
// After:
const { observations: ltObs } = await this.leadTimeService.getLeadTimeObservations(...);
```

6. **Update the default array** in `getLeadTimeObservations` to match the
   identical default used in `CycleTimeService` (lines 97–124) word-for-word,
   so both services use the same fallback list.

> **Design note:** The `anomalyCount` field is additive to `LeadTimeResult`.
> Any existing API clients that ignore unknown fields are unaffected.  The
> frontend DORA page should display the anomaly count in the same style as the
> Cycle Time page's existing anomaly banner.

#### Acceptance Criteria

- A board whose `inProgressStatusNames` is `['In Review']` has all issues
  with an `'In Review'` transition included in Lead Time observations.
- Issues with no transition to any `inProgressStatusNames` status are excluded
  from `leadTimeDays` and counted in `anomalyCount`.
- `anomalyCount` appears in `LeadTimeResult` and is returned by the API.
- The Scrum `createdAt` fallback code path is deleted entirely.
- Unit tests in `lead-time.service.spec.ts` are updated to cover: board-config
  status names, anomaly counting, no-in-progress exclusion for Scrum.

---

### P1-3 — Kanban roadmap `issueActivityEnd` inverts done logic

**Audit reference:** 0017 §Finding 10.1 · `roadmap.service.ts` lines 434–438,
764–768

#### Problem

In both `getKanbanAccuracy()` (line 434–438) and `getKanbanWeeklyAccuracy()`
(lines 764–768), `issueActivityEnd` is assigned as follows:

```typescript
const issueActivityEnd = doneStatusNames.includes(i.status)
  ? null                              // ← WRONG: done → treated as in-flight
  : (completionDates.get(i.key) ?? null);
```

The intent was "conservative: don't exclude done issues."  However,
`isIssueEligibleForRoadmapItem` (line 565) treats `issueActivityEnd === null`
as *always qualifies* (the issue is in-flight and has not finished).  An issue
currently in `'Done'` status therefore always qualifies for any roadmap item
in any period, inflating `coveredCount`.

The sprint path (`calculateSprintAccuracy`, lines 859–860) correctly uses the
`completionDates` map with no special-casing for current status, which is the
right approach.

#### Proposed Fix

**File:** `backend/src/roadmap/roadmap.service.ts`

Replace the two inverted assignments with the direct `completionDates` lookup.
Both occurrences must be updated:

**Occurrence 1 — `getKanbanAccuracy()` (line ~434–438):**

```typescript
// BEFORE:
const issueActivityEnd = doneStatusNames.includes(i.status)
  ? null
  : (completionDates.get(i.key) ?? null);

// AFTER:
const issueActivityEnd = completionDates.get(i.key) ?? null;
// null = issue has never had a done-status changelog = in-flight = always qualifies.
// Non-null = issue was completed at that timestamp; eligibility uses that date.
```

**Occurrence 2 — `getKanbanWeeklyAccuracy()` (line ~764–768):**

```typescript
// BEFORE:
const issueActivityEnd = doneStatusNames.includes(i.status)
  ? null
  : (completionDatesWeekly.get(i.key) ?? null);

// AFTER:
const issueActivityEnd = completionDatesWeekly.get(i.key) ?? null;
```

> **Semantic clarification for future readers:** After this fix, `null` for
> `issueActivityEnd` means the issue has no done-status changelog entry and is
> genuinely in-flight.  An issue that is currently in `'Done'` status will
> have an entry in `completionDates`, so it will receive a non-null
> `issueActivityEnd` and will be assessed against the roadmap item's delivery
> window rather than unconditionally qualifying.  This aligns Kanban semantics
> with the sprint path.

#### Acceptance Criteria

- An issue currently in `'Done'` status whose `completionDate` falls *outside*
  the roadmap item's `[startDate, targetDate]` window is **not** counted in
  `coveredCount`.
- An issue with no done-transition changelog (genuinely in-flight) still
  qualifies for any roadmap item whose window overlaps its activity start.
- `roadmapOnTimeRate` for a Kanban quarter where all items finished late
  returns `0`, not `100`.
- Unit test added to `roadmap.service.spec.ts` covering: done-issue outside
  window → not covered; done-issue inside window → covered; in-flight issue
  → covered.

---

### P1-4 — `resolveBoardIds` reads removed `JIRA_BOARD_IDS` env var

**Audit reference:** 0017 §Finding 11.1 · `metrics.service.ts` lines 561–570

#### Problem

`MetricsService.resolveBoardIds()` (lines 561–570) falls back to reading
`JIRA_BOARD_IDS` from the environment when no `boardId` query param is
supplied:

```typescript
private resolveBoardIds(boardId: string | undefined): string[] {
  if (boardId) {
    return boardId.split(',').map((id) => id.trim());
  }
  const boardIdsStr = this.configService.get<string>(
    'JIRA_BOARD_IDS',
    'ACC,BPT,SPS,OCS,DATA,PLAT',    // ← hardcoded fallback
  );
  return boardIdsStr.split(',').map((id) => id.trim());
}
```

Proposal 0016 removed `JIRA_BOARD_IDS` from `SyncService`.  After 0016 is
deployed, this env var will not exist, and the fallback will silently serve
metrics for the hardcoded six boards regardless of what boards are actually
configured.  This is a silent correctness regression.

Per decision 5, the fix is implemented directly in `MetricsService` without a
separate proposal.  The fix also requires making `resolveBoardIds` async and
updating all callers.

#### Proposed Fix

**File:** `backend/src/metrics/metrics.service.ts`

1. **Change `resolveBoardIds` to `async`** and query `BoardConfig`:

```typescript
private async resolveBoardIds(boardId: string | undefined): Promise<string[]> {
  if (boardId) {
    return boardId.split(',').map((id) => id.trim());
  }
  const configs = await this.boardConfigRepo.find();
  return configs.map((c) => c.boardId);
}
```

2. **Remove `ConfigService` from the constructor** if it is only used by
   `resolveBoardIds` and `quarterToDates` (check usages; the deprecated
   `quarterToDates` wrapper already delegates to `period-utils.ts` and does
   not use `ConfigService`).  If `ConfigService` is needed for other purposes
   (e.g. `JIRA_BASE_URL` in `CycleTimeService`), retain the injection.

   > `MetricsService` itself uses `ConfigService` only for `JIRA_BOARD_IDS`.
   > After this fix the import can be removed from `MetricsService`.  Verify
   > at implementation time.

3. **Update every caller of `resolveBoardIds`** to `await` it:

| Method | Change required |
|---|---|
| `getDora` | `const boardIds = await this.resolveBoardIds(query.boardId);` |
| `getDeploymentFrequency` | same |
| `getLeadTime` | same |
| `getCfr` | same |
| `getMttr` | same |
| `getDoraAggregate` | same |
| `getDoraTrend` (quarter mode) | `const boardIds = await this.resolveBoardIds(query.boardId);` |
| `getCycleTime` | same |
| `getCycleTimeTrend` | same |

   Note: `getDoraTrend` in sprint mode already has a `boardId` guard that
   throws `BadRequestException` if `boardId` is absent; no change needed
   there beyond awaiting the (now-async) call.

#### Acceptance Criteria

- When no `boardId` query param is supplied, the metrics endpoints return data
  for all boards present in the `board_configs` table.
- When `JIRA_BOARD_IDS` is absent from the environment, no fallback to a
  hardcoded list occurs.
- The `ConfigService` import is removed from `MetricsService` if it has no
  remaining usages.
- All existing integration tests pass with the async change.

---

### P2-1 — MTTR uses hardcoded `'In Progress'` instead of board config

**Audit reference:** 0017 §Finding 4.1 · `mttr.service.ts` lines 126–128

#### Problem

`MttrService.getMttrObservations()` finds the MTTR start event with the same
hard-coded single-string check as the pre-fix Lead Time service:

```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue === 'In Progress',
);
```

If the incident board uses `'Assigned'`, `'In Review'`, or any other
first-active-work status, all MTTR observations will fall back to
`issue.createdAt` as start time, which measures time-from-creation rather than
time-from-assignment.

**MTTR fallback policy:** Unlike Lead Time (decision 3), the `createdAt`
fallback is **kept** for MTTR.  An incident ticket is "detected" when it is
created; if no "work started" transition exists, `createdAt` is the most
defensible MTTR start time.  However, the choice of which status names
represent "work started" must be board-config-aware, not hardcoded.

#### Proposed Fix

**File:** `backend/src/metrics/mttr.service.ts`

Replace lines 126–128 with a board-config-aware lookup.  `config` is already
loaded at the top of `getMttrObservations()`:

```typescript
// Load inProgressStatusNames from board config (same default list as CycleTimeService)
const inProgressNames = config?.inProgressStatusNames ?? [
  'In Progress', 'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
  'PEER CODE REVIEW', 'Ready for Review', 'In Test', 'IN TEST', 'QA',
  'QA testing', 'QA Validation', 'IN TESTING', 'Under Test', 'ready to test',
  'Ready for Testing', 'READY FOR TESTING', 'Ready for Release',
  'Ready for release', 'READY FOR RELEASE', 'Awaiting Release', 'READY',
];

// (inside the per-issue loop, replace lines 126–128)
const inProgressTransition = issueLogs.find(
  (cl) => inProgressNames.includes(cl.toValue ?? ''),
);
const startTime = inProgressTransition
  ? inProgressTransition.changedAt
  : issue.createdAt;  // createdAt fallback retained for MTTR (incident detection time)
```

No change to the `MttrResult` interface (anomaly count is not required for
MTTR because the `createdAt` fallback is semantically valid).

#### Acceptance Criteria

- A board with `inProgressStatusNames: ['Assigned']` uses the `'Assigned'`
  transition as MTTR start, not `'In Progress'`.
- When no transition to any `inProgressStatusNames` status exists, MTTR start
  falls back to `issue.createdAt` (unchanged behaviour, explicitly documented).
- Unit tests in `mttr.service.spec.ts` updated to cover board-config-aware
  start-time selection.

---

### P2-2 — Cycle Time band threshold mismatch between backend and frontend

**Audit reference:** 0017 §Finding 11.4 · `frontend/src/lib/dora-bands.ts`
lines 31–34, 45–49

#### Problem

The backend `dora-bands.ts` uses `<=` for the Lead Time "high" boundary
(`<= 7` days) while the frontend `dora-bands.ts` uses strict `<` (`< 7` days).
Identical mismatch for Change Failure Rate (`<= 5/10/15%` backend vs
`< 5/10/15%` frontend).

At exact boundary values the backend and frontend return different bands:

| Value | Backend | Frontend |
|---|---|---|
| Lead Time = 7 days | `'high'` | `'medium'` |
| CFR = 5% | `'elite'` | `'high'` |
| CFR = 10% | `'high'` | `'medium'` |
| CFR = 15% | `'medium'` | `'low'` |

The DORA hero card shows the backend's band.  The `BoardBreakdownTable`
re-classifies using the frontend function for row colouring.  Cycle Time bands
are already consistent (`<=` in both copies).

#### Proposed Fix

Standardise on `<=` (matching DORA 2023 report conventions and the backend
implementation) by updating the two mismatched frontend functions.

**File:** `frontend/src/lib/dora-bands.ts`

```typescript
// Replace classifyLeadTime (lines 30–35):
export function classifyLeadTime(medianDays: number): DoraBand {
  if (medianDays < 1) return 'elite';
  if (medianDays <= 7) return 'high';   // ← change < to <=
  if (medianDays <= 30) return 'medium'; // ← change < to <=
  return 'low';
}

// Replace classifyChangeFailureRate (lines 45–50):
export function classifyChangeFailureRate(percentage: number): DoraBand {
  if (percentage <= 5) return 'elite';   // ← change < to <=
  if (percentage <= 10) return 'high';   // ← change < to <=
  if (percentage <= 15) return 'medium'; // ← change < to <=
  return 'low';
}
```

No changes needed to `classifyDeploymentFrequency` or `classifyMTTR` (already
consistent between backend and frontend).  No changes needed to
`cycle-time-bands.ts` (already consistent).

> **Long-term note (P3 deferred):** The right architectural fix is to remove
> frontend classification functions for DORA entirely and use the backend-
> provided `band` values from the API response for row colouring.  That is
> deferred to a P3 proposal.  This fix is the minimal change to achieve
> consistency.

#### Acceptance Criteria

- `classifyLeadTime(7)` returns `'high'` in the frontend (was `'medium'`).
- `classifyChangeFailureRate(5)` returns `'elite'` in the frontend (was `'high'`).
- `classifyChangeFailureRate(10)` returns `'high'` in the frontend (was `'medium'`).
- `classifyChangeFailureRate(15)` returns `'medium'` in the frontend (was `'low'`).
- Frontend unit tests in `dora-bands.test.ts` are updated to cover boundary
  values.

---

### P2-3 — ISO week off-by-one on Monday boundaries

**Audit reference:** 0017 §Finding 8.1 · `planning.service.ts` line 878,
`roadmap.service.ts` line 588

#### Problem

Both `PlanningService.dateToWeekKey()` (line 878) and
`RoadmapService.dateToWeekKey()` (line 588) compute the ISO week number using:

```typescript
const dayOfYear = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
const weekNumber = Math.ceil(dayOfYear / 7);
```

`Math.ceil(dayOfYear / 7)` is not the ISO 8601 week number algorithm.  It
produces the wrong result for dates near year boundaries:

- 2026-12-28 (Monday) → ISO W53; algorithm produces `Math.ceil(362/7) = 52`.
  **Wrong.**

The companion `weekKeyToDates` function in both services correctly implements
ISO 8601 using the "Jan 4 is always in week 1" rule.  The mismatch means a
week key generated by `dateToWeekKey` will not round-trip correctly through
`weekKeyToDates` for boundary weeks, causing the week view to silently bucket
issues into the wrong week.

#### Proposed Fix

Replace `Math.ceil(dayOfYear / 7)` with the correct ISO 8601 calculation in
both files.  The Thursday-finding preamble is already correct in both; only
the final week-number computation changes.

The fix is identical in both files.  Replace the `dayOfYear`/`weekNumber`
block (3 lines) with the Monday-of-week-1 calculation already used in
`weekKeyToDates`:

```typescript
private dateToWeekKey(date: Date): string {
  // Step 1: find the Thursday of this week (ISO: weeks start Monday)
  const thursday = new Date(date);
  const day = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToThursday = day === 0 ? 4 : 4 - day;
  thursday.setDate(date.getDate() + daysToThursday);

  const isoYear = thursday.getFullYear();

  // Step 2: find Monday of ISO week 1 (Jan 4 is always in week 1)
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Day = jan4.getDay(); // 0=Sun, 1=Mon, ...
  const daysToMon = jan4Day === 0 ? -6 : 1 - jan4Day;
  const mondayOfWeek1 = new Date(isoYear, 0, 4 + daysToMon);

  // Step 3: count full weeks from Monday of week 1 to Monday of this week
  const mondayOfThisWeek = new Date(thursday);
  mondayOfThisWeek.setDate(thursday.getDate() - 3); // Thu - 3 = Mon
  const weekNumber =
    Math.floor(
      (mondayOfThisWeek.getTime() - mondayOfWeek1.getTime()) /
      (7 * 24 * 60 * 60 * 1000),
    ) + 1;

  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}
```

Apply this identical replacement to:
- `backend/src/planning/planning.service.ts` (lines 864–881)
- `backend/src/roadmap/roadmap.service.ts` (lines 576–591)

> **Local-time vs UTC:** `weekKeyToDates` uses `Date.UTC` for output, but
> `dateToWeekKey` operates on local-time `Date` objects (the input `date` is a
> local-time value from the database via TypeORM).  The fix above uses local-
> time arithmetic consistently with the existing Thursday-finding logic.  The
> timezone fix (P2-7) will address the wider UTC/local inconsistency; this fix
> is limited to the ISO algorithm correctness.

#### Acceptance Criteria

- `dateToWeekKey(new Date('2026-12-28'))` returns `'2026-W53'` (was `'2026-W52'`).
- `dateToWeekKey(new Date('2027-01-03'))` returns `'2026-W53'` (was `'2027-W01'`).
- `dateToWeekKey(new Date('2026-01-04'))` returns `'2026-W01'`.
- For any date `d`, `weekKeyToDates(dateToWeekKey(d)).weekStart` is the Monday
  of the same ISO week as `d`.
- Unit tests added for boundary weeks (last week of year, first week of year,
  year-boundary Mondays).

---

### P2-4 — Kanban `deliveryRate` uses current status snapshot

**Audit reference:** 0017 §Finding 7.2 · `planning.service.ts` lines 644–648,
796–800

#### Problem

Both `getKanbanQuarters()` (lines 644–648) and `getKanbanWeeks()` (lines
796–800) compute `completed` and `pointsDone` by checking the current issue
status:

```typescript
if (doneStatuses.includes(issue.status)) {
  completed++;
  pointsDone += pts;
}
```

`issue.status` is the status at the time of the most recent sync.  An issue
completed in Q1 2025 and still in `'Done'` status today is incorrectly counted
as "completed" in the Q1 2025 bucket *and* in every subsequent bucket into
which it might be grouped.  This over-counts `deliveryRate` in historical
periods.

Per decision 4, changing historical numbers is acceptable.

#### Proposed Fix

**File:** `backend/src/planning/planning.service.ts`

Completion must be determined by whether a done-transition changelog entry
falls within the issue's bucket period (quarter or week window), not by the
issue's current status.

**For `getKanbanQuarters()`:**

1. After loading `boardEntryChangelogs` and building `boardEntryDate`, add a
   **second bulk changelog query** to load all done-transition changelogs for
   the `boundedIssues` key set:

```typescript
// Load all status changelogs to determine per-issue completion dates
const allBoundedKeys = boundedIssues.map((i) => i.key);
const allStatusChangelogs = await this.changelogRepo
  .createQueryBuilder('cl')
  .where('cl.issueKey IN (:...keys)', { keys: allBoundedKeys })
  .andWhere('cl.field = :field', { field: 'status' })
  .orderBy('cl.changedAt', 'ASC')
  .getMany();

// Build map: issueKey → FIRST done-transition timestamp (all-time)
const completionDates = new Map<string, Date>();
for (const cl of allStatusChangelogs) {
  if (cl.toValue !== null && doneStatuses.includes(cl.toValue)) {
    if (!completionDates.has(cl.issueKey)) {
      completionDates.set(cl.issueKey, cl.changedAt);
    }
  }
}
```

2. In the per-quarter loop, replace the current-status completion check with a
   changelog-based check using the quarter's date window:

```typescript
// BEFORE (line ~644–648):
if (doneStatuses.includes(issue.status)) {
  completed++;
  pointsDone += pts;
}

// AFTER: an issue is "completed in this quarter" if its first done-transition
// falls within the quarter's [startDate, endDate] window.
const { startDate, endDate } = this.quarterToDates(qKey);
// ...
const completionDate = completionDates.get(issue.key);
const completedInPeriod =
  completionDate !== undefined &&
  completionDate >= startDate &&
  completionDate <= endDate;

if (completedInPeriod) {
  completed++;
  pointsDone += pts;
}
```

   > The `quarterToDates` call should be moved outside the issue loop (call
   > it once per quarter, not once per issue).

**For `getKanbanWeeks()`:**  Apply the identical pattern — load
`completionDates` after `boundedIssuesWeeks` is established, then check
`completionDate >= weekStart && completionDate <= weekEnd` in the per-week,
per-issue loop instead of `doneStatuses.includes(issue.status)`.

#### Acceptance Criteria

- An issue with board-entry date in Q1 2025 and a done-transition in Q2 2025
  is counted as `completed` in Q2 2025 only, not in Q1 2025.
- An issue currently in `'Done'` status but whose done-transition is in the
  future (data anomaly) is **not** counted as completed in any period.
- `deliveryRate` for a fully-historical quarter where all issues are done is
  calculated from completion dates, not current status.
- Existing test coverage for `getKanbanQuarters` and `getKanbanWeeks` is
  updated to assert changelog-based completion.

---

### P2-5 — Scrum roadmap may match stale JPD ideas

**Audit reference:** 0017 §Finding 10.2 · `roadmap.service.ts` lines 918–930

#### Problem

`calculateSprintAccuracy()` (line 823) calls `buildEpicIdeaMap(allIdeas)`,
which maps every idea with a `targetDate` to its epic keys — with no filter
for whether that `targetDate` overlaps the sprint's date range.  An idea
targeting 2020-Q4 is included, and any sprint-2026 issue linked to its epic
will be counted as roadmap-covered.

The Kanban path correctly uses `filterIdeasForWindow(allIdeas, startDate,
endDate)` (lines 429, 759) with an overlap filter.  The Scrum sprint path
should use the same function.

#### Proposed Fix

**File:** `backend/src/roadmap/roadmap.service.ts`

In `calculateSprintAccuracy()`, replace the `buildEpicIdeaMap` call with
`filterIdeasForWindow` scoped to the sprint's date window.

```typescript
private async calculateSprintAccuracy(
  sprint: JiraSprint,
  sprintIssues: JiraIssue[],
  doneStatusNames: string[],
  cancelledStatusNames: string[],
  allIdeas: JpdIdea[],
): Promise<RoadmapSprintAccuracy> {
  // ...existing issue filtering...

  // BEFORE (line 823):
  const epicIdeaMap = this.buildEpicIdeaMap(allIdeas);

  // AFTER: use the same window-filtered approach as the Kanban path
  const sprintStart = sprint.startDate ?? new Date(0);
  const sprintEnd = sprint.endDate ?? new Date();
  const activeIdeas = this.filterIdeasForWindow(allIdeas, sprintStart, sprintEnd);
  // activeIdeas is a Map<epicKey, RoadmapItemWindow> — same type as Kanban path uses
```

Update the downstream issue classification loop to use `activeIdeas` (type
`Map<string, RoadmapItemWindow>`) instead of `epicIdeaMap` (type
`Map<string, { targetDate: Date }>`).  The eligibility check for the sprint
path already uses `completionDates.get(issue.key)` correctly (lines 859–860),
so only the idea lookup needs to change:

```typescript
// BEFORE (line 855–860):
const idea = epicIdeaMap.get(issue.epicKey);
if (!idea) continue;
const targetEndOfDay = this.endOfDayUTC(idea.targetDate);
const resolvedAt = completionDates.get(issue.key) ?? null;
const deliveredOnTime = resolvedAt !== null && resolvedAt <= targetEndOfDay;

// AFTER:
const item = activeIdeas.get(issue.epicKey);
if (!item) continue;
const targetEndOfDay = this.endOfDayUTC(item.targetDate);
const resolvedAt = completionDates.get(issue.key) ?? null;
const deliveredOnTime = resolvedAt !== null && resolvedAt <= targetEndOfDay;
```

The `buildEpicIdeaMap` private method can be **deleted** once this change is
made — it has no remaining callers.

#### Acceptance Criteria

- An idea with `targetDate = 2020-12-31` does **not** contribute to
  `coveredIssues` in a sprint whose `endDate = 2026-04-30`.
- An idea with `targetDate = 2026-05-31` and `startDate = 2026-04-01` **does**
  contribute to `coveredIssues` for an April 2026 sprint.
- `buildEpicIdeaMap` is deleted; `filterIdeasForWindow` is used by both Kanban
  and Scrum paths.
- Unit tests added for stale-idea exclusion in the sprint path.

---

### P2-6 — Quarter `roadmapOnTimeRate` is a simple average of percentages

**Audit reference:** 0017 §Finding 10.3 · `frontend/src/app/roadmap/page.tsx`
lines 83–88

#### Problem

`groupByQuarter()` in `roadmap/page.tsx` computes `roadmapOnTimeRate` for a
quarter by averaging the per-sprint rate values:

```typescript
const totalOnTimeRateSum = group.reduce((acc, s) => acc + s.roadmapOnTimeRate, 0);
const roadmapOnTimeRate =
  group.length > 0
    ? Math.round((totalOnTimeRateSum / group.length) * 100) / 100
    : 0;
```

A sprint with 1 issue and `roadmapOnTimeRate = 100%` is weighted identically
to a sprint with 50 issues and `roadmapOnTimeRate = 20%`.  The resulting
quarter rate is not meaningful.

The `RoadmapSprintAccuracy` DTO already includes `coveredIssues` and
`uncoveredIssues` (both of which come from the backend per sprint).  A
weighted rate can be computed as:

```
roadmapOnTimeRate = coveredIssues / (coveredIssues + uncoveredIssues)
```

This is a sum-of-numerators divided by sum-of-denominators, which is the
correct aggregation for a rate metric (same as CFR org-level aggregation).

> Note: `uncoveredIssues` includes both linked-not-covered (amber) **and**
> unlinked (no roadmap link) issues.  The resulting rate is therefore the
> on-time rate across *all* sprint issues, not just roadmap-linked ones.  This
> is a deliberate simplification — an exact weighted rate would require
> `linkedNotCoveredCount` to be a separate field in the API response (a P3
> change).  The sum-of-counts approximation is still far more accurate than
> simple averaging.

#### Proposed Fix

**File:** `frontend/src/app/roadmap/page.tsx`

In `groupByQuarter()`, replace lines 83–88:

```typescript
// BEFORE:
const totalOnTimeRateSum = group.reduce((acc, s) => acc + s.roadmapOnTimeRate, 0);
const roadmapOnTimeRate =
  group.length > 0
    ? Math.round((totalOnTimeRateSum / group.length) * 100) / 100
    : 0;

// AFTER: weighted sum-of-counts (avoids averaging percentages)
const totalCovered  = group.reduce((acc, s) => acc + s.coveredIssues, 0);
const totalIssuesForRate = group.reduce((acc, s) => acc + s.totalIssues, 0);
const roadmapOnTimeRate =
  totalIssuesForRate > 0
    ? Math.round((totalCovered / totalIssuesForRate) * 10000) / 100
    : 0;
```

#### Acceptance Criteria

- A quarter containing Sprint A (1 issue, 100% on-time) and Sprint B (50 issues,
  20% on-time) produces `roadmapOnTimeRate ≈ 20.4%`, not `60%`.
- The existing `roadmapCoverage` computation (which already uses sum-of-counts)
  is unchanged.

---

### P2-7 — Timezone: add `TIMEZONE` env var

**Audit reference:** 0017 §Finding 11.2 · `planning.service.ts` line 855,
`roadmap.service.ts` line 951, `period-utils.ts` lines 28–32,
`planning/page.tsx` lines 38–45, `roadmap/page.tsx` lines 33–45

#### Problem

Quarter boundary dates are computed using `new Date(year, month, 1)` (local
timezone of the Node.js process) in multiple places on the backend, and using
`new Date()` (browser local time) in the frontend.  Week boundary dates in
`weekKeyToDates` use `Date.UTC` (UTC).  This inconsistency means:

- In a Docker container where `TZ=UTC`, quarter boundaries are at midnight UTC.
- A user in UTC+10 (AEST) sees quarter boundaries at 10:00 local time.
- A sprint starting at 23:50 AEST (13:50 UTC) is assigned to the previous UTC
  quarter, creating "ghost sprint" misattribution.

The fix is to introduce a `TIMEZONE` env var read by the backend via
`ConfigService` and used as the reference timezone for all quarter and week
boundary calculations.

#### Scope of change

The following sites must be updated to use the configured timezone:

**Backend:**

| File | Function | Lines | Current behaviour |
|---|---|---|---|
| `period-utils.ts` | `quarterToDates` | 28–32 | `new Date(year, month, 1)` (process-local) |
| `period-utils.ts` | `listRecentQuarters` | 43–46 | `new Date()` current quarter (process-local) |
| `planning.service.ts` | `quarterToDates` | 855–856 | `new Date(year, month, 1)` (process-local) |
| `planning.service.ts` | `dateToQuarterKey` | 835 | `date.getMonth()`, `date.getFullYear()` (process-local) |
| `planning.service.ts` | `getKanbanQuarters` | 617 | `dateToQuarterKey(now)` (process-local) |
| `roadmap.service.ts` | `quarterToDates` | 950–955 | `new Date(year, month, 1)` (process-local) |
| `roadmap.service.ts` | `issueToQuarterKey` | 571–574 | `date.getMonth()` (process-local) |
| `planning.service.ts` | `dateToWeekKey` | 864 | `date.getDay()` (process-local) |
| `roadmap.service.ts` | `dateToWeekKey` | 576 | `date.getDay()` (process-local) |

**Frontend:**

| File | Function | Lines | Current behaviour |
|---|---|---|---|
| `planning/page.tsx` | `getQuarterKey` | 38 | `new Date(isoDate)` → local browser month |
| `planning/page.tsx` | `getCurrentQuarterKey` | 44 | `new Date()` → browser local |
| `roadmap/page.tsx` | `getQuarterKey` | 37 | same |
| `roadmap/page.tsx` | `getCurrentQuarterKey` | 41 | same |

#### Implementation approach

**Do not** use a timezone library (no new dependency).  Use a targeted
helper function that computes the local-time-in-configured-timezone equivalent
for a UTC Date object, sufficient for the operations needed here (extracting
year, month, day; constructing midnight-of-day boundaries).

The recommended approach uses `Intl.DateTimeFormat` with `timeZone` option,
which is available in Node.js ≥ 18 and all modern browsers without additional
packages:

```typescript
// backend/src/metrics/tz-utils.ts  (new file)

/**
 * Returns the {year, month (0-indexed), day} for a Date in the configured
 * application timezone.  Uses Intl.DateTimeFormat — no external dependency.
 */
export function dateParts(
  date: Date,
  tz: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA format: "YYYY-MM-DD"
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return { year, month: month - 1, day }; // month is 0-indexed to match Date
}

/**
 * Returns a Date representing midnight (00:00:00.000) in `tz` for the given
 * calendar date components.  The returned Date is a UTC instant.
 */
export function midnightInTz(
  year: number,
  month: number, // 0-indexed
  day: number,
  tz: string,
): Date {
  // Use Intl to find the UTC offset at that local date
  const localIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;
  // Interpret the local ISO string as-if it were in tz, then convert to UTC
  // Trick: parse via Intl to find the UTC equivalent of midnight local
  const approx = new Date(`${localIso}Z`); // UTC approximation
  const parts = dateParts(approx, tz);
  const diff =
    (parts.year - year) * 365 * 86400000 +
    (parts.month - month) * 30 * 86400000 +
    (parts.day - day) * 86400000;
  return new Date(approx.getTime() - diff);
}
```

> **Note to implementer:** The `midnightInTz` trick above is an approximation.
> A more robust implementation uses the `Intl.DateTimeFormat` `formatToParts`
> API to find the exact UTC offset.  The recommended production implementation
> is:

```typescript
export function midnightInTz(year: number, month: number, day: number, tz: string): Date {
  // Binary-search or offset-probe approach:
  // 1. Form the target local datetime string
  const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;
  // 2. Treat as UTC first to get a rough candidate
  const candidate = new Date(iso + 'Z');
  // 3. Find what local date that candidate corresponds to in `tz`
  const localParts = dateParts(candidate, tz);
  // 4. Compute offset in ms from the shift
  const localMidnight = new Date(Date.UTC(localParts.year, localParts.month, localParts.day));
  const offsetMs = candidate.getTime() - localMidnight.getTime();
  // 5. Subtract the offset to get the UTC instant that is midnight in `tz`
  return new Date(candidate.getTime() - offsetMs);
}
```

**Reading the timezone in services:**

```typescript
// In any service constructor that needs timezone-aware dates:
import { ConfigService } from '@nestjs/config';
private readonly timezone: string;

constructor(private readonly configService: ConfigService) {
  this.timezone = configService.get<string>('TIMEZONE', 'UTC');
}
```

**Updating `quarterToDates` and `dateToQuarterKey`:**

The private `quarterToDates` methods in `PlanningService` and `RoadmapService`
(and the shared `period-utils.ts`) must replace `new Date(year, month, 1)`
with `midnightInTz(year, month, 1, this.timezone)`.

The private `dateToQuarterKey` / `issueToQuarterKey` methods must replace
`date.getMonth()` / `date.getFullYear()` with `dateParts(date, this.timezone).month`
/ `dateParts(date, this.timezone).year`.

The shared `period-utils.ts` functions (`quarterToDates`, `listRecentQuarters`)
must accept an optional `timezone` parameter:

```typescript
export function quarterToDates(quarter: string, tz = 'UTC'): QuarterDates { ... }
export function listRecentQuarters(n: number, tz = 'UTC'): QuarterDates[] { ... }
```

Callers in `MetricsService` must pass `this.timezone` to these functions.

**Frontend:**

The frontend `getQuarterKey` and `getCurrentQuarterKey` functions use
`new Date()` (browser local time).  The server already returns `startDate` as
an ISO string; the frontend derives the quarter key from that string.  After
this fix, the server's `startDate` timestamps will represent midnight in the
configured timezone (a UTC instant).  The frontend just needs to format that
timestamp in the **same timezone** as the backend, not in the browser's local
timezone.

Pass the configured timezone from the backend to the frontend via the existing
`/api/boards` or a new `/api/config` endpoint:

```typescript
// GET /api/config → { timezone: 'Australia/Sydney' }
```

The frontend `getQuarterKey` should then use:

```typescript
function getQuarterKey(isoDate: string | null, tz: string): string | null {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit',
  }).formatToParts(d);
  const year = parseInt(parts.find(p => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find(p => p.type === 'month')!.value, 10) - 1;
  const q = Math.floor(month / 3) + 1;
  return `${year}-Q${q}`;
}
```

**`.env.example` change:**

```bash
# Timezone for quarter/week boundary calculations (IANA timezone name).
# Defaults to UTC if absent. Example: TIMEZONE=Australia/Sydney
TIMEZONE=UTC
```

#### Env var specification

| Property | Value |
|---|---|
| Name | `TIMEZONE` |
| Read by | `ConfigService` in `MetricsService`, `PlanningService`, `RoadmapService`; and via `/api/config` endpoint for the frontend |
| Default | `UTC` |
| Valid values | Any IANA timezone name accepted by `Intl.DateTimeFormat` (e.g. `Australia/Sydney`, `America/New_York`, `Europe/London`) |
| Validation | At startup, attempt `new Intl.DateTimeFormat('en-CA', { timeZone: value })` and throw a startup error if it throws a `RangeError` |
| Example | `TIMEZONE=Australia/Sydney` |

#### Acceptance Criteria

- `TIMEZONE=Australia/Sydney`: `quarterToDates('2026-Q1')` returns a
  `startDate` of `2025-12-31T14:00:00.000Z` (midnight AEDT = UTC-11 offset
  from midnight 2026-01-01).
- `TIMEZONE=UTC` (default): behaviour is identical to the current
  implementation for all non-boundary dates.
- A sprint starting at `2026-03-31T23:50:00+10:00` (just before midnight
  AEDT, i.e. `2026-03-31T13:50:00Z`) is assigned to Q1 2026 when
  `TIMEZONE=Australia/Sydney`, not Q2.
- `TIMEZONE` is documented in `backend/.env.example`.
- Invalid `TIMEZONE` value causes a startup error with a clear message.

---

## Known Limitation: `boardId` vs `projectKey` Mapping

**Audit reference:** 0017 §Finding 2.2

**Decision (owner-confirmed):** No code change required.

The `versionRepo.find({ where: { projectKey: boardId } })` pattern in
`LeadTimeService` (line 88) and `CycleTimeService` (line 171) assumes
`boardId === projectKey`.  Jira's board ID and project key are not guaranteed
to be identical.

This is a **theoretical risk only** for the current board set (ACC, BPT, SPS,
OCS, DATA, PLAT).  These boards were all created with matching IDs and project
keys.

**Documented limitation:** If a new board is added whose Jira board ID differs
from its project key (e.g. a board named `MY-BOARD` scoped to project `MYPROJ`
where `boardId=MYBOARD`), version-based Lead Time and Cycle Time fallbacks will
return zero results for that board.  The fix — adding a `projectKey` column to
`BoardConfig` — is deferred until such a board is actually added.  The
developer adding the board must check for this condition and file a follow-on
issue if needed.

---

## P3 Findings — Deferred

The following findings from 0017 are acknowledged but deferred to a future
proposal.  No implementation work should be performed for these items as part
of this proposal's implementation.

| # | Finding | File | Why Deferred |
|---|---|---|---|
| P3-1 | `addedMidQuarter` grace period (14 days) hardcoded | `planning.service.ts` L631 | Requires `BoardConfig` schema migration; low user-visible impact |
| P3-2 | `planningAccuracy` not in quarter view | `planning/page.tsx` | Frontend-only table column add; cosmetic omission, not a calculation bug |
| P3-3 | `avgPlanningAccuracy` is simple mean of per-sprint percentages | `planning/page.tsx` L375–381 | Same class of bug as P2-6; acceptable until P2-6 is shipped and validated |
| P3-4 | `isWorkItem` exclusion list too narrow (misses `'Subtask'`, `'Initiative'`, custom types) | `issue-type-filters.ts` | Requires `BoardConfig` schema migration or a configurable exclusion list; no immediate production incident reported |
| P3-5 | Cycle time in calendar days (LinearB uses business days) | `cycle-time/page.tsx` | Add UI footnote minimum; optional configurable business-day mode is a significant feature |
| P3-6 | `boardEntryFromValue` hardcoded to `'To Do'` in Kanban flow metrics | `planning.service.ts`, `roadmap.service.ts` | Requires `BoardConfig.boardEntryFromStatus` field + migration; affects all Kanban boards whose backlog is not named `'To Do'` |

P3-6 (`boardEntryFromValue`) is a moderate-risk finding: teams whose Kanban
backlog status is not `'To Do'` will see all issues fall back to `createdAt`
for board-entry date.  The current `backlogStatusIds` exclusion logic (which
excludes pre-board issues) partially mitigates this.  A dedicated proposal
should address P3-6 together with P3-1 as a single `BoardConfig` schema
extension.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | No migration required | All changes are in service/frontend logic; `BoardConfig` entity is not changed by this proposal |
| API contract | Additive only | `LeadTimeResult.anomalyCount` is a new optional field; existing clients are unaffected |
| Frontend | Minor changes to `dora-bands.ts`, `roadmap/page.tsx`; new `/api/config` endpoint consumption for timezone | No new pages or components |
| Tests | New and updated unit tests in `deployment-frequency.service.spec.ts`, `lead-time.service.spec.ts`, `mttr.service.spec.ts`, `roadmap.service.spec.ts`, `dora-bands.test.ts`; new week-boundary tests | |
| Jira API | No new calls | All fixes operate on already-synced data |
| Historical data | `deliveryRate` (P2-4) will change historical numbers (decision 4 accepted this) | Other fixes do not affect historical data |

---

## Open Questions

None. All questions from 0017 have been resolved by owner decisions documented
at the top of this proposal.

---

## Acceptance Criteria (Summary)

The following must all be true for this proposal to be considered successfully
implemented:

**P1:**
- [ ] `DeploymentFrequencyService.totalDeployments` equals `CfrService.totalDeployments` for the same inputs; both use priority-based (version first, Done-transition fallback for no-version issues) model (P1-1).
- [ ] `LeadTimeService` uses `BoardConfig.inProgressStatusNames`; anomaly count returned in API response (P1-2).
- [ ] Scrum `createdAt` fallback removed from Lead Time (P1-2, decision 3).
- [ ] Kanban roadmap done-issue logic not inverted; done issues use `completionDates`, not `null` (P1-3).
- [ ] `MetricsService.resolveBoardIds` queries `boardConfigRepo`, not `JIRA_BOARD_IDS` env var (P1-4).

**P2:**
- [ ] `MttrService` uses `BoardConfig.inProgressStatusNames` for start-time detection (P2-1).
- [ ] `classifyLeadTime(7)` and `classifyChangeFailureRate(5/10/15)` return consistent results between backend and frontend (P2-2).
- [ ] `dateToWeekKey(new Date('2026-12-28'))` returns `'2026-W53'` in both `PlanningService` and `RoadmapService` (P2-3).
- [ ] Kanban `deliveryRate` uses done-transition changelog dates, not current issue status (P2-4).
- [ ] Scrum roadmap sprint path uses `filterIdeasForWindow` with sprint date bounds; stale ideas excluded (P2-5).
- [ ] Quarter `roadmapOnTimeRate` is sum-of-counts, not average of per-sprint percentages (P2-6).
- [ ] `TIMEZONE` env var is read; quarter/week boundary calculations use it; default is `UTC`; documented in `.env.example` (P2-7).

**Regression:**
- [ ] All existing passing tests continue to pass after the changes.
- [ ] No new `JIRA_BOARD_IDS` references appear in the codebase.
