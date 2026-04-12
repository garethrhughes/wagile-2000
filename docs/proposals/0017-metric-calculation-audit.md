# 0017 — Metric Calculation Audit

**Date:** 2026-04-12
**Status:** Informational
**Author:** Architect Agent
**Related ADRs:** None — this is an audit document, not a change proposal. Individual
findings that require code changes should be addressed in dedicated follow-on proposals.

---

## Executive Summary

This document is a full-coverage audit of every metric calculation in the
`wagile-2000` codebase as of proposal 0016. Its purpose is to establish a
truthful baseline before the tool is used as a LinearB replacement and to
identify the highest-risk deviations from correct or consistent behaviour.

### Top three risks for LinearB replacement

1. **Deployment Frequency double-counts and is not comparable across metrics.**
   `DeploymentFrequencyService` uses `Math.max(versionDeployments, transitionDeployments)`
   (line 82), which counts raw transition *events* in the fallback path, not distinct
   issues. `CfrService` uses a correct `Set` union of deployed issue keys. The two
   services will produce different `totalDeployments` numbers for the same board and
   period, making the DF/CFR cards on the DORA page semantically inconsistent. Any
   executive comparing "we deployed 120 issues" (DF) with "18% of deployed issues
   caused failures" (CFR) will be working from different denominators.

2. **Lead Time ignores `inProgressStatusNames` board config.**
   `LeadTimeService` (line 109) hard-codes a single `toValue === 'In Progress'` string
   check. `CycleTimeService` (lines 97–124) correctly reads the full `inProgressStatusNames`
   array from `BoardConfig`, which may contain 20+ synonyms. Teams whose workflow uses
   `'In Review'`, `'IN TEST'`, or any other active-work status will have *all* of their
   Lead Time observations silently dropped (Kanban) or inflated by falling back to
   `createdAt` (Scrum). This is the single most likely cause of a "why is Lead Time
   different from LinearB?" complaint.

3. **Band thresholds differ between backend and frontend for Lead Time and CFR.**
   The backend `dora-bands.ts` uses `<=` for the Lead Time "high" boundary (`<= 7` days)
   and `<=` for CFR Elite/High/Medium boundaries (`<= 5%`, `<= 10%`, `<= 15%`). The
   frontend copy uses strict `<` for the same boundaries. At exact boundary values the
   backend returns `'high'` while the frontend returns `'medium'` for Lead Time, and
   backend returns `'elite'` while frontend returns `'high'` for CFR. The DORA page
   displays the band colour that the backend returns, but the frontend's `classifyLeadTime`
   and `classifyChangeFailureRate` functions are used in `pooledPercentiles` and
   per-observation row colouring, so the DORA page and the Cycle Time page can show
   different band colours for the same numeric value.

---

## Per-Metric Findings

### 1. Deployment Frequency

**File:** `backend/src/metrics/deployment-frequency.service.ts`

#### Finding 1.1 — `Math.max` is the wrong aggregation operator (P1)

**Line:** 82
**Formula today:**
```
totalDeployments = Math.max(versionDeployments, transitionDeployments)
```
`versionDeployments` counts distinct *issues* with a matching fixVersion.
`transitionDeployments` counts the number of *changelog events* where
`toValue ∈ doneStatuses` (line 123 — `getCount()` on the changelog query, not
`DISTINCT issueKey`). An issue moved to Done, re-opened, and re-resolved counts
as 2 transitions. Taking `Math.max` of a distinct-issue count and a raw event
count produces a number that is meaningful in neither case.

`CfrService` (lines 86–121) correctly builds a `Set` union of deployed issue keys
from both signals. `DeploymentFrequencyService` should mirror that approach.

**Proposed fix:** Replace with the same `Set` union used in `CfrService`:
```typescript
// After fix — mirrors cfr.service.ts lines 86–121
const doneTransitions = await this.changelogRepo
  .createQueryBuilder('cl')
  .select('DISTINCT cl.issueKey', 'issueKey')
  ...
  .getRawMany<{ issueKey: string }>();

const deployedKeys = new Set([
  ...doneTransitions.map(t => t.issueKey),
  ...versionIssueKeys,
]);
const totalDeployments = deployedKeys.size;
```

#### Finding 1.2 — Counts issues, not releases (Informational)

DF uses issues as a proxy for deployments. LinearB uses git deploys. This is the
correct approach for a Jira-only tool, but the metric label "deploys/day" may
confuse stakeholders. Consider renaming the unit in the UI to "issues shipped/day"
or adding a footnote.

---

### 2. Lead Time for Changes

**File:** `backend/src/metrics/lead-time.service.ts`

#### Finding 2.1 — Hardcoded `'In Progress'` ignores board config (P1)

**Line:** 109–111
```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue === 'In Progress',
);
```
This ignores `BoardConfig.inProgressStatusNames`, which can contain 20+ active-work
status names (see `CycleTimeService` lines 97–124 for the authoritative list).

Consequence per board type:
- **Kanban** (line 115–116): issues without an `'In Progress'` transition are
  silently skipped (`continue`). If the board uses `'IN TEST'` or `'In Review'`
  as its first active status, 100% of observations will be excluded.
- **Scrum** (line 117–118): falls back to `issue.createdAt`, which measures total
  ticket age, not lead time for changes. For long-lived boards this can inflate
  median Lead Time by weeks.

**Proposed fix:** Load `inProgressStatusNames` from `BoardConfig` (same as
`CycleTimeService`) and replace the single-string check with an array includes:
```typescript
const config = await this.boardConfigRepo.findOne({ where: { boardId } });
const inProgressNames = config?.inProgressStatusNames ?? [
  'In Progress', 'In Review', 'Peer-Review', 'In Test', /* … */
];
const inProgressTransition = issueLogs.find(
  (cl) => inProgressNames.includes(cl.toValue ?? ''),
);
```

#### Finding 2.2 — `projectKey` / `boardId` coupling (P2)

**Lines:** 87–90
```typescript
await this.versionRepo.find({
  where: { name: In(versionNames), projectKey: boardId },
});
```
This assumes `boardId === projectKey`. Jira's board ID and project key are not
guaranteed to be identical (a board can be scoped to a project with a different
key). The same pattern occurs in `CycleTimeService` lines 170–172. This is a
latent bug that would surface if a board were added whose boardId differed from
its Jira project key.

---

### 3. Change Failure Rate

**File:** `backend/src/metrics/cfr.service.ts`

#### Finding 3.1 — Correct union approach (No issue)

CFR correctly builds a `Set` union of deployed issue keys (lines 117–122). No
action required on the counting logic.

#### Finding 3.2 — Frontend band thresholds use strict `<` vs backend `<=` (P2)

**Backend** `dora-bands.ts` lines 19–24:
```typescript
if (percentage <= 5) return 'elite';   // ← <=
if (percentage <= 10) return 'high';
if (percentage <= 15) return 'medium';
```
**Frontend** `src/lib/dora-bands.ts` lines 45–50:
```typescript
if (percentage < 5) return 'elite';    // ← <
if (percentage < 10) return 'high';
if (percentage < 15) return 'medium';
```
At `percentage === 5`: backend → `'elite'`, frontend → `'high'`.
At `percentage === 10`: backend → `'high'`, frontend → `'medium'`.
At `percentage === 15`: backend → `'medium'`, frontend → `'low'`.

The DORA hero card shows the backend's band (correct). The `BoardBreakdownTable`
component re-classifies using the frontend function, so the table row colour
may differ from the card colour for boundary values.

**Proposed fix:** Either standardise on `<=` everywhere (matching the
[DORA 2023 report](https://dora.dev/research/) convention of ≤ 5%, ≤ 15%) or
eliminate the frontend copy entirely and include band classification in the API
response (which the backend already does — `band` is already in
`CfrResult.band`). The frontend functions are only needed for re-classification
of locally-computed pooled values.

---

### 4. MTTR

**File:** `backend/src/metrics/mttr.service.ts`

#### Finding 4.1 — Hardcoded `'In Progress'` start trigger (P2)

**Lines:** 126–128
```typescript
const inProgressTransition = issueLogs.find(
  (cl) => cl.toValue === 'In Progress',
);
```
Same problem as Lead Time finding 2.1. If the incident board uses a different
first active-work status, MTTR start times will fall back to `createdAt`, which
measures time-to-discovery + queue time + remediation time, not just remediation
time (MTTR proper).

**Proposed fix:** Same as 2.1 — read `inProgressStatusNames` from board config.
Note that MTTR semantics are slightly different from Lead Time (it measures time
from incident detection/assignment to recovery, not from code-commit). Consider
whether `createdAt` is actually the correct fallback for MTTR (it may be, since
an incident is "detected" when the ticket is created), but the choice should be
explicit and documented rather than inherited from a config-miss.

#### Finding 4.2 — `isWorkItem` applied to incident issues (Informational)

**Line:** 57
```typescript
const allIssues = (await this.issueRepo.find({ where: { boardId } }))
  .filter((i) => isWorkItem(i.issueType));
```
`isWorkItem` excludes `Epic` and `Sub-task`. The subsequent filter at lines 59–66
then narrows to `incidentIssueTypes` (default `['Bug', 'Incident']`). The net
effect is correct: non-Epic, non-Sub-task issues matching incident types are
included. However the ordering is semantically odd — `isWorkItem` should be
thought of as a scope filter, not a type filter. No bug, but worth noting.

---

### 5. Cycle Time

**File:** `backend/src/metrics/cycle-time.service.ts`

#### Finding 5.1 — Calendar days, not business days (P2 — LinearB parity gap)

`CycleTimeService` measures wall-clock days (line 236):
```typescript
const rawDays = (cycleEnd.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);
```
LinearB measures business days (excluding weekends). For a 2-week sprint a
wall-clock cycle time will be approximately 30% higher than the LinearB
equivalent. Teams migrating from LinearB should be briefed on this difference.
This is a known trade-off accepted implicitly in the project design (calendar
days are simpler and timezone-safe), but it is not documented anywhere visible
to the end-user.

**Proposed fix (P3):** Add a footnote to the Cycle Time UI that reads "Cycle
time measured in calendar days". Optionally, make business-day calculation
configurable per board.

#### Finding 5.2 — Individual row band classification (Cosmetic)

**Frontend** `cycle-time/page.tsx` line 407:
```typescript
<CycleTimeBandBadge band={classifyCycleTime(obs.cycleTimeDays)} />
```
Each observation row is classified using the same absolute thresholds (2/5/10
days) as the distribution p50. A P95 outlier at 45 days correctly shows `'poor'`,
but a standard story at 3 days may show `'good'` while the team's median is
also `'good'`, giving no differential signal. This is a display decision, not a
calculation bug.

#### Finding 5.3 — Frontend percentile rounds to 1 decimal, backend to 2 (Cosmetic)

**Frontend** `pooledPercentiles` (line 59): `Math.round(pct(50) * 10) / 10`
(1 decimal).
**Backend** `round2` (statistics.ts line 24): `Math.round(n * 100) / 100`
(2 decimals).

The percentile cards display the frontend-computed value (1 decimal). The
backend per-board percentiles use 2 decimals. Visually consistent within
the page (all cards use 1 decimal) but the per-board breakdown table in DORA
could differ.

---

### 6. Planning Accuracy (Scrum)

**File:** `backend/src/planning/planning.service.ts`

#### Finding 6.1 — `scopeChangePercent` denominator is non-standard (Informational)

**Lines:** 319–322
```typescript
const scopeChangePercent =
  commitment > 0
    ? Math.round(((added + removed) / commitment) * 10000) / 100
    : 0;
```
Most planning tools (including LinearB) define scope change as
`(added + removed) / initialScope`. This implementation uses `commitment`
(initial scope) as the denominator, which is correct. However, the `removed`
count in the numerator includes issues that were added *and then* removed
mid-sprint (double-counted in `added + removed`). An issue added and immediately
removed contributes `+2` to the numerator but `0` to net scope. This overstates
instability for volatile sprints.

A more conservative formula would be `|netChange| / commitment` where
`netChange = added - removed`. The current formula is a deliberate design choice
(measures total churn, not net change), but should be documented for users
comparing against LinearB.

#### Finding 6.2 — `planningAccuracy` not rolled up to quarter view (P3)

**Frontend** `planning/page.tsx` lines 54–111 (`groupByQuarter`): The quarter
aggregation omits `planningAccuracy`, `committedPoints`, and `completedPoints`
from the `QuarterRow` interface. The quarterly table has no Planning Accuracy
column. This is an omission — not incorrect — but reduces the value of the
quarter view for teams that want a points-based accuracy trend.

#### Finding 6.3 — `avgPlanningAccuracy` computed as simple mean across sprints (P3)

**Frontend** lines 375–381:
```typescript
const nonNullAccuracies = rawData
  .map(r => r.planningAccuracy)
  .filter((v): v is number => v !== null)
const avgPlanningAccuracy = nonNullAccuracies.length > 0
  ? nonNullAccuracies.reduce((s, v) => s + v, 0) / nonNullAccuracies.length
  : null
```
A simple mean of per-sprint percentages weights a 1-ticket sprint equally to a
20-ticket sprint. A weighted mean (`sum(completedFromCommitted) / sum(commitment)`)
would be more accurate. Low-commitment sprints (e.g. holiday sprints with 2
tickets) can artificially inflate or deflate the average.

---

### 7. Kanban Flow (Planning — Kanban Boards)

**File:** `backend/src/planning/planning.service.ts`

#### Finding 7.1 — Board-entry detection hardcoded to `'To Do'` (P1)

**Lines:** 540–545 (quarters) and 700–706 (weeks):
```typescript
.andWhere('cl.fromValue = :from', { from: 'To Do' })
```
If a team's backlog status is named `'Backlog'`, `'New'`, `'Open'`, or anything
other than exactly `'To Do'`, this query returns zero results. Every issue then
falls back to `createdAt` as the board-entry date (line 609/763), and all issues
appear in the quarter/week they were *created*, not when they were *started*.
This is the Kanban equivalent of the `'In Progress'` hardcoding problem in Lead
Time and inflates older periods artificially.

The `backlogStatusIds` field on `BoardConfig` exists precisely to solve this, but
the `fromValue` filter runs *before* the `backlogStatusIds` exclusion logic and
uses `fromValue` as the board-entry trigger, not `backlogStatusIds`. These are
two different things: a backlog status ID tells us what to *exclude*; the
board-entry trigger tells us when an issue was *pulled in*.

**Proposed fix:** Make the board-entry trigger configurable. Add a
`boardEntryStatusName` (or `boardEntryFromValue`) field to `BoardConfig`.
Default to `'To Do'`. The same fix applies to `RoadmapService.getKanbanAccuracy`
and `getKanbanWeeklyAccuracy` (same hardcoded `fromValue = 'To Do'` pattern at
lines 312–316 and 646–651).

#### Finding 7.2 — `deliveryRate` uses current issue status, not period completion (P2)

**Lines:** 644–648 and 796–800:
```typescript
if (doneStatuses.includes(issue.status)) {
  completed++;
  pointsDone += pts;
}
```
`issue.status` is the *current* status at the time of the last sync. An issue
that was completed in Q1 2025 and is still in `'Done'` status today will be
counted as "completed" in any quarter it was bucketed into. This creates
over-counting in historical periods: if a board has 50 issues created in 2024-Q1
and all are still in `'Done'`, that quarter reports 100% delivery rate even if
10 of them were actually completed in 2025.

**Proposed fix:** Determine completion per issue by checking whether a
done-transition changelog event falls within the quarter/week window, not by
checking current status. The `doneChangelogs` already loaded in
`getKanbanAccuracy` (lines 371–376) contain this information; use
`completionDates.get(issue.key)` and compare against the period window
boundaries.

#### Finding 7.3 — `addedMidQuarter` grace period (14 days) not configurable (P3)

**Line:** 631:
```typescript
const gracePeriodEnd = new Date(
  startDate.getTime() + 14 * 24 * 60 * 60 * 1000,
);
```
14 days is hardcoded. Some Kanban teams have 1-week cadences; others have
monthly cadences. A 14-day grace period is appropriate for monthly-cadence teams
but will classify everything as `addedMidQuarter` for weekly-cadence teams.
Store this as a `BoardConfig` field with default 14.

---

### 8. ISO Week Calculation

**File:** `backend/src/planning/planning.service.ts`
**Also:** `backend/src/roadmap/roadmap.service.ts`

#### Finding 8.1 — `dateToWeekKey` uses a non-standard ISO 8601 algorithm (P2)

**Lines:** 864–881 (planning) and 576–591 (roadmap):
```typescript
const dayOfYear = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
const weekNumber = Math.ceil(dayOfYear / 7);
```
`Math.ceil(dayOfYear / 7)` is **not** the ISO 8601 week number algorithm.
Correct ISO 8601 week numbers are based on the week that contains the first
Thursday of the year, not a simple day-of-year division.

Examples where this breaks:
- 2026-01-01 (Thursday): ISO W01. `Math.ceil(1/7) = 1`. Correct by coincidence.
- 2027-01-01 (Friday): ISO W53 of 2026. The algorithm computes `Math.ceil(1/7) = 1`
  of year 2027 (since Thursday = Dec 31, 2026, isoYear = 2026) but the Thursday
  mapping could put it in 2026 W53. The exact behaviour depends on edge cases in
  the Thursday-finding logic.
- 2026-12-31 (Thursday): ISO W53. `dayOfYear = 365`, `Math.ceil(365/7) = 53`.
  Appears correct. But 2026-12-28 (Monday) should be W53 too;
  `Math.ceil(362/7) = 52`. **Wrong** — it should be W53.

The `weekKeyToDates` function (lines 883–912 and 593–619) correctly implements
ISO 8601 using the "Jan 4 is always in week 1" rule. There is a mismatch between
the key generation (broken) and the key-to-dates conversion (correct), meaning
that a week key generated by `dateToWeekKey` will not round-trip correctly
through `weekKeyToDates` for boundary weeks.

**Proposed fix:** Replace `Math.ceil(dayOfYear / 7)` with a correct ISO 8601
week number. The Thursday-finding preamble is already correct; add the ISO week
number computation:
```typescript
// After the Thursday-finding logic:
const jan4 = new Date(isoYear, 0, 4);
const jan4Day = jan4.getDay(); // local time is fine here (date-only)
const daysToMon = jan4Day === 0 ? -6 : 1 - jan4Day;
const mondayOfWeek1 = new Date(isoYear, 0, 4 + daysToMon);
const weekNumber =
  Math.floor((thursday.getTime() - mondayOfWeek1.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
```
This is the same logic already used in `weekKeyToDates`, making the functions
consistent. Alternatively, use a well-tested library (e.g. `date-fns`
`getISOWeek` / `getISOWeekYear`).

---

### 9. Gaps Report

**File:** `backend/src/gaps/gaps.service.ts`

#### Finding 9.1 — Sprint membership uses `issue.sprintId` column (Informational)

**Line:** 87:
```typescript
if (issue.sprintId === null || !activeSprintIds.has(issue.sprintId)) continue;
```
The `sprintId` column on `JiraIssue` is overwritten on each sync with the
current sprint assignment. This is intentional (performance: avoids changelog
replay for the gaps report) and noted in the code comment. The consequence is
that issues moved out of the active sprint after the last sync will still appear
in the gaps report, and issues moved *into* the active sprint since the last sync
will be missed. This is acceptable for a "current hygiene snapshot" use case but
should be documented.

#### Finding 9.2 — Custom sub-task types not excluded (P3)

`isWorkItem` (issue-type-filters.ts line 2) only excludes `'Epic'` and
`'Sub-task'` (with hyphen). Teams using `'Subtask'` (no hyphen), `'Sub Task'`
(space), or custom sub-task types will see those items in both Gaps report lists.
The fix is to make the excluded list configurable per board or to broaden the
default exclusion pattern. This is the same issue as ADR 0018 addressed for
metrics, but the gaps report was not updated at that time.

---

### 10. Roadmap Accuracy

**File:** `backend/src/roadmap/roadmap.service.ts`

#### Finding 10.1 — Kanban `issueActivityEnd` assignment inverts done logic (P1)

**Lines:** 434–438 (`getKanbanAccuracy`) and 764–768 (`getKanbanWeeklyAccuracy`):
```typescript
const issueActivityEnd = doneStatusNames.includes(i.status)
  ? null                              // ← in done status → treat as in-flight
  : (completionDates.get(i.key) ?? null);
```
The comment says "conservative: issues already in done status get null (treated
as in-flight)". However, `null` for `issueActivityEnd` means the issue
**always qualifies** (see `isIssueEligibleForRoadmapItem` line 565:
`issueActivityEnd === null → afterStart = true`). An issue in done status
therefore always qualifies for any roadmap item, inflating `coveredCount`.

The intent should be: if the issue IS done, use its actual `completionDate` to
determine whether it was delivered within the idea's window. The "conservative"
comment appears to conflate "conservative about excluding issues" (i.e. prefer
to count them as covered) with "conservative about their activity end".

The sprint path (`calculateSprintAccuracy` lines 859–860) correctly uses the
`completionDates` map to determine whether an issue was delivered on time, with
no special-casing for current done status. The Kanban path should match the
sprint path semantics.

**Proposed fix:**
```typescript
// Replace the inverted logic with the sprint path's approach:
const resolvedAt = completionDates.get(i.key) ?? null;
const issueActivityEnd = resolvedAt; // null = in-flight (not yet resolved)
```

#### Finding 10.2 — `buildEpicIdeaMap` has no date-window filter (P2)

**Lines:** 918–930:
`buildEpicIdeaMap` (used only by the Scrum sprint path) builds a map of all
ideas with any `targetDate`, regardless of whether that target date overlaps the
sprint's date range. An idea with a `targetDate` in 2020 will be included, and
an issue linked to its epic will be counted as roadmap-covered in a 2026 sprint.

The Kanban path correctly uses `filterIdeasForWindow` (lines 429, 759), which
applies the overlap filter. The Scrum sprint path does not. This means Scrum
roadmap coverage can be inflated by stale ideas.

**Proposed fix:** In `calculateSprintAccuracy`, replace `buildEpicIdeaMap` with
`filterIdeasForWindow` using the sprint's `[startDate, endDate]` window. This
aligns both paths.

#### Finding 10.3 — Quarter `roadmapOnTimeRate` is a simple average (P2)

**Frontend** `roadmap/page.tsx` lines 83–88:
```typescript
const totalOnTimeRateSum = group.reduce((acc, s) => acc + s.roadmapOnTimeRate, 0);
const roadmapOnTimeRate =
  group.length > 0
    ? Math.round((totalOnTimeRateSum / group.length) * 100) / 100
    : 0;
```
A sprint with 1 issue and `roadmapOnTimeRate = 100%` is weighted equally to a
sprint with 50 issues and `roadmapOnTimeRate = 20%`. The correct approach is to
sum the raw `coveredIssues` and `coveredIssues + linkedNotCovered` counts across
sprints and divide:
```typescript
// Weighted approach
const totalCovered = group.reduce((acc, s) => acc + s.coveredIssues, 0);
const totalLinked  = group.reduce((acc, s) => acc + s.coveredIssues + (s.totalIssues - s.uncoveredIssues - /* non-linked */), 0);
```
Note: the `RoadmapSprintAccuracy` DTO does not currently include
`linkedNotCoveredCount` as a separate field — it is implicit in
`coveredIssues` + `(totalIssues - uncoveredIssues)`. An additive API change
would be needed to expose it and enable a correct weighted average.

For a minimal fix, `roadmapOnTimeRate` for quarters can be recomputed as
`coveredIssues / (coveredIssues + uncoveredIssues)`, which approximates the
weighted average:
```typescript
const totalCovered    = group.reduce((acc, s) => acc + s.coveredIssues, 0);
const totalUncovered  = group.reduce((acc, s) => acc + s.uncoveredIssues, 0);
const roadmapOnTimeRate = (totalCovered + totalUncovered) > 0
  ? Math.round((totalCovered / (totalCovered + totalUncovered)) * 10000) / 100
  : 0;
```
This is not identical to the true on-time rate (uncovered includes unlinked
issues) but is a better approximation than a simple average of percentages.

---

### 11. Cross-Cutting Concerns

#### Finding 11.1 — `metrics.service.ts` still reads `JIRA_BOARD_IDS` env var (P1)

**Lines:** 565–568:
```typescript
const boardIdsStr = this.configService.get<string>(
  'JIRA_BOARD_IDS',
  'ACC,BPT,SPS,OCS,DATA,PLAT',
);
```
Proposal 0016 removed `JIRA_BOARD_IDS` from `SyncService`, but
`MetricsService.resolveBoardIds()` still falls back to this env var (with a
hardcoded default!) when no `boardId` query param is supplied. After proposal
0016 is implemented, the env var will not exist, and this code will silently
serve metrics for `ACC,BPT,SPS,OCS,DATA,PLAT` regardless of what boards are
actually configured. This is a regression introduced by implementing 0016
partially.

**Proposed fix:** Replace the env var fallback with a `boardConfigRepo.find()`
call, consistent with the post-0016 `SyncService` pattern:
```typescript
private async resolveBoardIds(boardId: string | undefined): Promise<string[]> {
  if (boardId) {
    return boardId.split(',').map((id) => id.trim());
  }
  const configs = await this.boardConfigRepo.find();
  return configs.map((c) => c.boardId);
}
```
Note: this requires making `resolveBoardIds` async and updating all callers.

#### Finding 11.2 — Mixed UTC/local timezone in date calculations (P2)

Quarter boundary dates are computed using `new Date(year, month, 1)` (local
timezone in Node.js process) in:
- `PlanningService.quarterToDates` (line 855)
- `RoadmapService.quarterToDates` (line 951)
- Frontend `getQuarterKey` (planning/page.tsx line 38, roadmap/page.tsx line 37)
- Frontend `getCurrentQuarterKey` (planning/page.tsx line 44, roadmap/page.tsx line 44)

Week boundary dates are computed using `Date.UTC(...)` (UTC) in:
- `PlanningService.weekKeyToDates` (line 895)
- `RoadmapService.weekKeyToDates` (line 605)

If the Node.js process TZ is UTC (typical in Docker containers) and the user
is in UTC+8, quarters appear to start at 08:00 UTC rather than midnight local.
For a single-user internal tool this is likely acceptable, but it can cause
"ghost sprint" effects where a sprint starting at 23:50 local is assigned to the
previous quarter.

Week calculations using `Date.UTC` are immune to this issue.

**Recommended action:** Set `TZ=UTC` explicitly in `docker-compose.yml` and
document that all date boundaries are UTC. Optionally add a configurable
`timezone` field to `BoardConfig`.

#### Finding 11.3 — `isWorkItem` exclusion list is narrow (P3)

**File:** `backend/src/metrics/issue-type-filters.ts` line 2:
```typescript
export const EXCLUDED_ISSUE_TYPES = ['Epic', 'Sub-task'] as const;
```
Excludes only `'Epic'` and `'Sub-task'` (with hyphen). Does not exclude:
- `'Subtask'` (no hyphen — used in some Jira configurations)
- `'Sub Task'` (with space)
- `'Initiative'`
- Custom sub-task types specific to the organisation

Teams with non-standard type names will have sub-tasks included in all
metric calculations. The exclusion list should be configurable per board or at
minimum broadened.

#### Finding 11.4 — Backend/frontend band duplication with differing semantics (P2)

Both `dora-bands.ts` files and both `cycle-time-bands.ts` files are independent
copies. The `CycleTimeBands` files are in sync (both use `<=`). The
`DoraBands` files differ for Lead Time (backend `<=7`, frontend `<7`) and CFR
(backend `<=5/10/15`, frontend `<5/10/15`). There is no shared package or code
generation to keep them in sync.

**Proposed fix:** Move all band classification to the backend and include the
`band` value in every API response shape (which is already done for DORA metrics
— every result object has a `band` field). Remove the frontend classification
functions for DORA; use the backend-provided `band` values directly. Keep the
frontend `classifyCycleTime` only for the pooled-percentile cards where
locally-computed values need banding.

---

## What Is Working Well

The following aspects of the calculation logic are sound and require no changes:

1. **CFR deployment counting** — `Set` union approach is correct and defensible.
2. **Sprint membership reconstruction** — Changelog replay in `PlanningService`
   and `RoadmapService` is correct, includes grace period for Jira's bulk-add
   delay, handles exact sprint name matching (no "Sprint 1" / "Sprint 10"
   confusion), and is consistent between the two services.
3. **Cycle Time anomaly handling** — Issues with no in-progress transition are
   counted as anomalies and excluded from percentiles rather than silently
   dropped or counted as zero. The anomaly banner in the UI is clear.
4. **Percentile algorithm** — The linear-interpolation percentile in
   `statistics.ts` is correct and consistent between Lead Time, MTTR, and Cycle
   Time.
5. **`planningAccuracy` implementation** — Points-based accuracy with ticket-count
   fallback is well-implemented. The `null` guard for zero-commitment sprints
   is correct. The `committedPoints`/`completedPoints` tooltip in the sprint
   table aids interpretability.
6. **Kanban backlog exclusion** — The `backlogStatusIds` + changelog-heuristic
   fallback pattern for excluding pure-backlog issues is sophisticated and
   production-ready (per ADR 0017 and proposal 0005).
7. **`filterIdeasForWindow` overlap check** — The Kanban path correctly uses
   end-of-day UTC extension for date-only `targetDate` values.
8. **DORA aggregate org-level pooling** — Pooled median across boards' raw
   observation arrays is statistically correct. CFR uses ratio-of-sums (not
   average-of-ratios), which is the correct aggregation for a rate metric.

---

## Prioritised Recommended Changes

### P1 — Must fix before production use

| # | Finding | File | Line | Action |
|---|---|---|---|---|
| P1-1 | DF uses `Math.max` instead of set union | `deployment-frequency.service.ts` | 82 | Replace with `Set` union (same as CFR) |
| P1-2 | Lead Time ignores `inProgressStatusNames` | `lead-time.service.ts` | 109 | Load from `BoardConfig` |
| P1-3 | Kanban roadmap `issueActivityEnd` inverts done logic | `roadmap.service.ts` | 434, 764 | Use `completionDates.get(i.key)` directly |
| P1-4 | `MetricsService.resolveBoardIds` still reads `JIRA_BOARD_IDS` | `metrics.service.ts` | 565–568 | Query `boardConfigRepo` after proposal 0016 |

### P2 — Fix before wider team rollout

| # | Finding | File | Line | Action |
|---|---|---|---|---|
| P2-1 | MTTR uses hardcoded `'In Progress'` | `mttr.service.ts` | 126–128 | Load from `BoardConfig` |
| P2-2 | Frontend CFR/Lead Time bands differ from backend | `frontend/src/lib/dora-bands.ts` | 31, 45 | Standardise on `<=` or use backend band values |
| P2-3 | `boardId === projectKey` assumption in version queries | `lead-time.service.ts` L88, `cycle-time.service.ts` L171 | 88, 171 | Map boardId to projectKey via `BoardConfig` |
| P2-4 | `dateToWeekKey` non-standard ISO 8601 algorithm | `planning.service.ts` L878, `roadmap.service.ts` L588 | 878, 588 | Use correct ISO week computation |
| P2-5 | Kanban `deliveryRate` uses current status, not period completion | `planning.service.ts` | 644, 796 | Check changelog completion within period |
| P2-6 | `buildEpicIdeaMap` has no date window filter (Scrum path) | `roadmap.service.ts` | 823 | Use `filterIdeasForWindow` with sprint dates |
| P2-7 | Quarter `roadmapOnTimeRate` is a simple average | `frontend/src/app/roadmap/page.tsx` | 83–88 | Use weighted sum-of-counts |
| P2-8 | Mixed UTC/local timezone in quarter boundaries | Multiple files | Various | Standardise on UTC; document in docker-compose |

### P3 — Quality improvements

| # | Finding | File | Action |
|---|---|---|---|
| P3-1 | `addedMidQuarter` grace period not configurable | `planning.service.ts` L631 | Add `BoardConfig.kanbanGracePeriodDays` |
| P3-2 | `planningAccuracy` not in quarter view | `frontend/src/app/planning/page.tsx` | Add column to `QuarterRow` |
| P3-3 | `avgPlanningAccuracy` is simple mean | `frontend/src/app/planning/page.tsx` L375–381 | Weight by commitment count |
| P3-4 | `isWorkItem` exclusion list too narrow | `issue-type-filters.ts` | Make configurable or broaden |
| P3-5 | Cycle time in calendar days (LinearB parity gap) | `cycle-time/page.tsx` | Add UI footnote; consider optional business-day mode |
| P3-6 | `boardEntryFromValue` hardcoded to `'To Do'` | `planning.service.ts`, `roadmap.service.ts` | Add `BoardConfig.boardEntryFromStatus` field |

---

## Open Questions

1. **Timezone policy.** Should quarter boundaries be UTC or local time? The answer
   affects historical data interpretation. Recommend UTC + explicit documentation.

2. **`boardId` vs `projectKey` mapping.** Is there a Jira board today where these
   differ? If not, is the risk theoretical or real? If real, a `projectKey` field
   on `BoardConfig` is needed.

3. **Lead Time fallback for Scrum.** Should Lead Time fall back to `createdAt`
   for Scrum issues with no in-progress transition, or should they be excluded
   (anomaly) like Kanban? The current behaviour (fallback to `createdAt`) is
   intentional per code comments but makes the metric semantics inconsistent with
   Cycle Time's anomaly-count approach.

4. **Kanban `deliveryRate` history.** Fixing finding 7.2 (use changelog completion
   dates instead of current status) will change historical numbers. Should the fix
   be gated on a feature flag or a `dataStartDate` boundary?

5. **P1-4 async `resolveBoardIds`.** Making this async in `MetricsService` requires
   updating `getDora`, `getDoraTrend`, `getCycleTime`, and related methods. Is a
   follow-up proposal required or can this be implemented directly?
