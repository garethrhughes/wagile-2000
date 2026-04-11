# 0010 — Roadmap Accuracy Date Filtering

**Date:** 2026-04-12
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

Roadmap accuracy links a Jira issue to a roadmap item (JPD idea) by testing whether
`issue.epicKey` appears in any `JpdIdea.deliveryIssueKeys`. There is no date constraint.
This means an issue completed two years ago against the same epic inflates today's
`roadmapDeliveryRate`, and a future-dated issue whose epic is linked to a JPD idea
contributes to a sprint window it does not belong to.

Each JPD idea has a defined delivery window — a `startDate` and a `targetDate` — yet
the system does not currently store or use these fields. Because the accuracy calculation
in `backend/src/roadmap/roadmap.service.ts` (lines 527–593 for Scrum,
lines 262–296 for Kanban) treats all covered issues in a sprint/quarter as equally
relevant regardless of when the owning roadmap item was planned, the metric is unreliable:

- A roadmap item delivered in 2024 and a roadmap item planned for 2026-Q2 both cause
  issues touched in 2026-Q1 to count as "roadmap-covered," even though those issues have
  no logical relationship to either delivery window.
- Sprint-level `roadmapDeliveryRate` can reach 100 % for historical sprints because
  all their covered issues now have a done status, even if the roadmap item was not
  expected to be active during that sprint.
- Teams cannot answer "were the issues in sprint X part of a roadmap item that was
  supposed to be delivered in that period?" — the only question that roadmap accuracy
  is meant to answer.

---

## Current State

### How linking works today

**Sync** (`backend/src/sync/sync.service.ts`, lines 437–486 — `syncJpdProject`):

The sync fetches all issues from each configured JPD project via
`JiraClientService.getJpdIdeas()` (which calls `GET /rest/api/3/search/jql` with
`fields=summary,status,issuelinks`). For each issue it walks the `issuelinks` array and
collects the keys of linked Epics where the link type matches `"is implemented by"`,
`"is delivered by"`, `"implements"`, or `"delivers"` (case-insensitive). These epic keys
are written into `JpdIdea.deliveryIssueKeys` (a `simple-array` TEXT column).

No date fields from the JPD idea are fetched or stored.

**Accuracy calculation** (`backend/src/roadmap/roadmap.service.ts`):

*Scrum path* (`calculateSprintAccuracy`, lines 513–594):
1. Load sprint issues filtered by `boardId` + `sprintId`.
2. Build `coveredEpicKeys = Set(flatMap(allJpdIdeas, idea => idea.deliveryIssueKeys))`.
3. An issue is "covered" if `issue.epicKey !== null && coveredEpicKeys.has(issue.epicKey)`.
4. An issue is "completed" if its current `status` is in `doneStatusNames`, or if a
   changelog entry shows a done-status transition during the sprint window.
5. `linkedCompletedIssues` = covered ∩ completed.
6. `roadmapDeliveryRate = linkedCompletedIssues / coveredIssues × 100`.

*Kanban quarter path* (`getKanbanAccuracy`, lines 158–299) and *Kanban week path*
(`getKanbanWeeklyAccuracy`, lines 369–511) follow the same covered/completed logic —
there is no date guard on which JPD ideas are active for the period under review.

**The JPD idea entity** (`backend/src/database/entities/jpd-idea.entity.ts`):

```typescript
@Entity('jpd_ideas')
export class JpdIdea {
  @PrimaryColumn()          key!: string;
  @Column()                 summary!: string;
  @Column()                 status!: string;
  @Column()                 jpdKey!: string;
  @Column('simple-array', { nullable: true })
                            deliveryIssueKeys!: string[] | null;
  @UpdateDateColumn(...)    syncedAt!: Date;
}
```

There are no `startDate`, `targetDate`, `dueDate`, or `releaseDate` columns.

**The JiraIssue entity** (`backend/src/database/entities/jira-issue.entity.ts`):

```typescript
@Column({ type: 'timestamptz' }) createdAt!: Date;
@UpdateDateColumn(...)           updatedAt!: Date;
```

There is no `resolvedDate`, `doneDate`, or `completedAt` column. The only signal of
completion time is in `jira_changelogs` — specifically, a changelog entry with
`field = 'status'` and `toValue IN doneStatusNames`.

**The `loadCoveredEpicKeys` helper** (`roadmap.service.ts`, lines 302–313):

```typescript
private async loadCoveredEpicKeys(): Promise<Set<string>> {
  const configs = await this.roadmapConfigRepo.find();
  if (configs.length === 0) return new Set();
  const jpdKeys = configs.map((c) => c.jpdKey);
  const ideas = await this.jpdIdeaRepo.find({ where: { jpdKey: In(jpdKeys) } });
  return new Set<string>(
    ideas.flatMap((idea) => idea.deliveryIssueKeys ?? []).filter(Boolean),
  );
}
```

This is called from all three accuracy paths without any date filter. It returns the
union of **all** delivery epic keys across **all** ideas regardless of when those
ideas were planned.

---

## Data Availability

### Date fields on JPD ideas

Jira Product Discovery issues support the following date-style custom fields (available
via `GET /rest/api/3/search/jql` with the appropriate `fields` parameter):

| Jira field name | Typical custom field ID | Description |
|---|---|---|
| `Start date` | `customfield_10015` or `customfield_10020` | When work on the idea is planned to begin |
| `Target date` / `Due date` | `customfield_10021` / `duedate` | When the idea is planned to be delivered |

The exact custom field IDs are tenant-specific. The `duedate` field is the standard
Jira due-date field and is available on all issue types. `customfield_10015` / `customfield_10020`
for start date and `customfield_10021` for target/end date are the most common Polaris/JPD
field mappings.

**These fields are not currently synced.** The `getJpdIdeas()` call in
`jira-client.service.ts` (line 89) only requests `fields=summary,status,issuelinks`.
`JpdIdea` has no date columns.

### Date fields on JiraIssue

`JiraIssue` has no stored completion date. The only way to determine when an issue was
completed is via `jira_changelogs` — a row with `field = 'status'` and
`toValue IN doneStatusNames` whose `changedAt` gives the transition timestamp.
This data is already present in the database; no new sync is required for issues.

### What changes are needed

| Data point | Current availability | Change needed |
|---|---|---|
| JPD idea `startDate` | Not stored | Add to `jpd_ideas` schema + sync |
| JPD idea `targetDate` | Not stored | Add to `jpd_ideas` schema + sync |
| Issue completion date | Available via `jira_changelogs` | No new data; query pattern changes |
| Issue "in-flight" status | Available via `jira_changelogs` | No new data; query pattern changes |

---

## Proposed Solution

### Filtering rule

An issue counts toward a roadmap item's accuracy calculation **only if** the issue was
active (in-flight or completed) within the roadmap item's delivery window:

```
issue is eligible for roadmapItem if:
  issue.epicKey ∈ roadmapItem.deliveryIssueKeys
  AND
  issueCompletionDate(issue) <= roadmapItem.targetDate
    OR issueIsInFlight(issue) AND issueStartedDate(issue) <= roadmapItem.targetDate
    OR (roadmapItem.startDate IS NULL OR issueStartedDate >= roadmapItem.startDate)
```

More precisely, the rule applied at query time is:

> An issue is eligible for roadmap item R if its **activity window**
> `[issueStart, issueEnd]` overlaps with R's delivery window
> `[R.startDate, R.targetDate]`, where:
> - `issueEnd` = date of the first done-status transition from `jira_changelogs`
>   (or `NULL` / today if no such transition exists — issue is in-flight)
> - `issueStart` = date of the first non-backlog-status transition from `jira_changelogs`
>   (or `issue.createdAt` as fallback — consistent with the existing `LeadTimeService`
>   start-time logic)

This reduces to a simple two-sided overlap test:

```
overlap = (issueStart <= R.targetDate OR R.targetDate IS NULL)
          AND
          (issueEnd >= R.startDate OR issueEnd IS NULL OR R.startDate IS NULL)
```

For the **sprint accuracy path**, where the sprint already constrains the issue window,
the rule simplifies further: the sprint's `[startDate, endDate]` is the candidate window;
a covered issue counts if the roadmap item's `[startDate, targetDate]` window overlaps
with the sprint window.

### Architecture Overview

```
[Sync]
JiraClientService.getJpdIdeas()
  adds: startDate, targetDate fields
         │
         ▼
jpd_ideas table
  gains: startDate TIMESTAMPTZ NULL
         targetDate TIMESTAMPTZ NULL
         (migration 0010)
         │
         ▼
[Accuracy calculation]
RoadmapService
  loadCoveredEpicKeys()  →  replaced by  loadActiveIdeasForWindow(windowStart, windowEnd)
                                          returns Map<epicKey, { startDate, targetDate }>
         │
         ▼
calculateSprintAccuracy()  /  getKanbanAccuracy()  /  getKanbanWeeklyAccuracy()
  per issue: check overlap of issue activity window with roadmapItem window
```

### Section 1 — Database Changes

#### 1a. New columns on `jpd_ideas`

```sql
ALTER TABLE "jpd_ideas"
  ADD COLUMN IF NOT EXISTS "startDate"  TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS "targetDate" TIMESTAMP WITH TIME ZONE NULL;
```

Migration file: `backend/src/migrations/XXXXXXXXX-AddDateFieldsToJpdIdeas.ts`

`up`: adds both columns as nullable `timestamptz`.
`down`: drops both columns.

Both nullable because:
- Not all JPD ideas have explicit dates set.
- Null handling is defined in the edge case section below.

#### 1b. TypeORM entity update (`jpd-idea.entity.ts`)

```typescript
@Column({ type: 'timestamptz', nullable: true, default: null })
startDate!: Date | null;

@Column({ type: 'timestamptz', nullable: true, default: null })
targetDate!: Date | null;
```

### Section 2 — Sync Changes

#### 2a. `JiraClientService.getJpdIdeas()` — accept extra field IDs

Update the method signature to accept an optional `extraFields: string[]` parameter
(or simply accept the full `fields` string from the caller):

```typescript
async getJpdIdeas(
  jpdKey: string,
  extraFields: string[] = [],
): Promise<...> {
  const baseFields = ['summary', 'status', 'issuelinks'];
  const fields = [...baseFields, ...extraFields].join(',');
  // ... existing JQL search with `fields`
}
```

This keeps the client generic — the caller decides which date field IDs to request.

#### 2b. `SyncService.syncJpdProject()` — read field IDs from `RoadmapConfig`

In `syncJpdProject()`, load the `RoadmapConfig` row for the JPD project, read
`startDateFieldId` and `targetDateFieldId`, and pass them to `getJpdIdeas()`:

```typescript
const config = await this.roadmapConfigRepo.findOne({ where: { jpdKey } });
const extraFields: string[] = [];
if (config?.startDateFieldId)  extraFields.push(config.startDateFieldId);
if (config?.targetDateFieldId) extraFields.push(config.targetDateFieldId);

const response = await this.jiraClientService.getJpdIdeas(jpdKey, extraFields);
```

Then in the per-idea mapping loop:

```typescript
const rawStart  = config?.startDateFieldId
  ? (issue.fields[config.startDateFieldId] as string | null | undefined) ?? null
  : null;

const rawTarget = config?.targetDateFieldId
  ? (issue.fields[config.targetDateFieldId] as string | null | undefined) ?? null
  : null;

idea.startDate  = rawStart  ? new Date(rawStart)  : null;
idea.targetDate = rawTarget ? new Date(rawTarget) : null;
```

If either field ID is null (not yet configured), the corresponding date column stays
null and the idea is excluded from accuracy calculations (decision 2).

**Warning log:** after processing all ideas, if `ideas.length > 0` but every idea has
`targetDate === null`, emit a `Logger.warn()` prompting the operator to configure
`targetDateFieldId` in Settings.

### Section 3 — Service Changes (`roadmap.service.ts`)

#### 3a. Replace `loadCoveredEpicKeys()` with `loadActiveIdeasForWindow()`

The current helper returns a flat `Set<string>` of all epic keys. Replace it with a
method that returns a `Map` keyed by epic key, where each value carries the roadmap
item's date window:

```typescript
interface RoadmapItemWindow {
  ideaKey: string;
  startDate: Date | null;
  targetDate: Date | null;
}

private async loadActiveIdeasForWindow(
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, RoadmapItemWindow>> {
  const configs = await this.roadmapConfigRepo.find();
  if (configs.length === 0) return new Map();

  const jpdKeys = configs.map((c) => c.jpdKey);
  const ideas = await this.jpdIdeaRepo.find({ where: { jpdKey: In(jpdKeys) } });

  const result = new Map<string, RoadmapItemWindow>();

  for (const idea of ideas) {
    if (!idea.deliveryIssueKeys) continue;

    // Decision 2: ideas without BOTH dates are excluded entirely.
    if (idea.startDate === null || idea.targetDate === null) continue;

    // Date-window overlap filter:
    // idea is active for [windowStart, windowEnd] if:
    //   idea.targetDate >= windowStart
    //   AND idea.startDate <= windowEnd
    const targetOk = idea.targetDate >= windowStart;
    const startOk  = idea.startDate  <= windowEnd;

    if (!targetOk || !startOk) continue;

    for (const epicKey of idea.deliveryIssueKeys.filter(Boolean)) {
      // If multiple ideas link to the same epic, keep the one with the
      // tightest (most recent) targetDate so older completed items
      // do not re-admit the epic key.
      const existing = result.get(epicKey);
      if (!existing) {
        result.set(epicKey, {
          ideaKey: idea.key,
          startDate: idea.startDate,
          targetDate: idea.targetDate,
        });
      } else {
        // Prefer the window with the later targetDate (most recent delivery commitment)
        const existingTarget = existing.targetDate?.getTime() ?? Infinity;
        const newTarget      = idea.targetDate?.getTime()     ?? Infinity;
        if (newTarget > existingTarget) {
          result.set(epicKey, {
            ideaKey: idea.key,
            startDate: idea.startDate,
            targetDate: idea.targetDate,
          });
        }
      }
    }
  }

  return result;
}
```

The `windowStart` / `windowEnd` arguments are:
- Scrum: `sprint.startDate` / `sprint.endDate`
- Kanban quarter: `quarterStartDate` / `quarterEndDate`
- Kanban week: `weekStart` / `weekEnd`

#### 3b. Per-issue eligibility check

Add a private helper that decides whether a covered issue's activity overlaps the
roadmap item's window:

```typescript
private isIssueEligibleForRoadmapItem(
  issueActivityStart: Date,       // first non-backlog transition, or createdAt
  issueActivityEnd:   Date | null, // first done-transition, or null if in-flight
  item: RoadmapItemWindow,
): boolean {
  // Issue must have started before the roadmap item's target date
  const beforeTarget =
    item.targetDate === null || issueActivityStart <= item.targetDate;

  // Issue must not have been completed before the roadmap item's start date
  const afterStart =
    item.startDate === null ||
    issueActivityEnd === null ||          // in-flight: always qualifies
    issueActivityEnd >= item.startDate;

  return beforeTarget && afterStart;
}
```

#### 3c. `calculateSprintAccuracy()` — apply date filter

*Current behaviour (lines 527–593):* `coveredEpicKeys` is a flat set; every issue
whose `epicKey` is in the set is counted regardless of when the roadmap item was active.

*Proposed change:*

1. Call `loadActiveIdeasForWindow(sprint.startDate ?? new Date(0), sprint.endDate ?? new Date())`
   instead of `loadCoveredEpicKeys()`.
2. For each issue in `filteredIssues`:
   - Determine `issueActivityEnd`: already computed as `completedKeys.has(issue.key)`.
     Extend this to also capture the *time* of completion (the `changedAt` from the
     done-transition changelog). See §3e.
   - Determine `issueActivityStart`: the time of the first non-done-status transition
     from changelog, falling back to `issue.createdAt`. This can be computed lazily
     only when `issueActivityEnd` is needed for the overlap check.
   - Apply `isIssueEligibleForRoadmapItem(activityStart, activityEnd, item)`.

> **Performance note:** the sprint path already queries changelogs for issues not yet
> in done status (lines 546–563). The extension is: also record `changedAt` for issues
> whose done-transition is found in the changelog, and query activity-start timestamps
> in the same batch.

#### 3d. `getKanbanAccuracy()` and `getKanbanWeeklyAccuracy()` — apply date filter

Both methods already compute a window (quarter bounds or week bounds). Replace the
`loadCoveredEpicKeys()` call with `loadActiveIdeasForWindow(windowStart, windowEnd)`
and apply `isIssueEligibleForRoadmapItem()` per issue using the same logic as §3c.

For the Kanban paths, "completion date" is determined from `jira_changelogs` — the
existing changelog data is already loaded in bulk (`changelogs` map built at
lines 180–194). Extend the changelog load to also capture done-transition timestamps.

#### 3e. Changelog query extension for completion timestamps

The current done-transition check in `calculateSprintAccuracy()` (lines 546–563)
fetches changelogs during the sprint window and checks `toValue IN doneStatusNames`,
but discards the `changedAt` timestamp. Extend this to retain it:

```typescript
const completionDates = new Map<string, Date>(); // issueKey → first done changedAt

for (const cl of changelogs) {
  if (cl.toValue !== null && doneStatusNames.includes(cl.toValue)) {
    completedKeys.add(cl.issueKey);
    if (!completionDates.has(cl.issueKey)) {
      completionDates.set(cl.issueKey, cl.changedAt);
    }
  }
}
```

For issues already in done status (not needing changelog check), set their completion
date to `null` — meaning "completed before or during this window" — which is conservative
(the overlap check treats `null` issueActivityEnd as in-flight, qualifying the issue).
Alternatively, load a secondary query restricted to `toValue IN doneStatusNames` without
a sprint-window date filter to find their actual completion date. The conservative
approach is simpler and correct in the common case.

### Section 4 — No Frontend Changes Required

The `RoadmapSprintAccuracy` response shape (`roadmapCoverage`, `roadmapDeliveryRate`,
`coveredIssues`, `linkedCompletedIssues`, etc.) is unchanged. The filtering happens
entirely inside `RoadmapService`. No new fields are needed in the response for the
basic date-filtering feature.

The frontend page (`frontend/src/app/roadmap/page.tsx`) requires no changes.

The `api.ts` client types (`RoadmapSprintAccuracy`, `getRoadmapAccuracy`) require no
changes.

---

## Edge Cases

### E1 — `startDate` is null on the roadmap item

**The idea is excluded.** Per decision 2, both `startDate` and `targetDate` must be
set for an idea to participate in accuracy calculations. A null `startDate` means the
idea is incompletely planned and is skipped entirely (not treated as open-ended).

### E2 — `targetDate` is null on the roadmap item

**The idea is excluded.** Same rule as E1. An idea with no `targetDate` is skipped.

### E3 — Both `startDate` and `targetDate` are null

**The idea is excluded.** No participation in accuracy calculations until dates are set.

> **Note:** This is a behaviour change from the current implementation (where all covered
> issues count regardless of dates). Teams that have not set dates on their JPD ideas will
> see `roadmapCoverage = 0` and `roadmapDeliveryRate = 0` for all periods until they
> configure `startDateFieldId` / `targetDateFieldId` in Settings and trigger a resync.

### E4 — Issue has no done-transition in `jira_changelogs` (in-flight)

`issueActivityEnd = null`. The `isIssueEligibleForRoadmapItem()` helper treats `null`
as in-flight, so the issue qualifies as long as `issueActivityStart <= targetDate`
(or `targetDate` is null). This is correct: an in-flight issue is always considered
active today, so it should count toward a roadmap item that is still within its window.

### E5 — Issue has a done-transition but it predates `roadmapItem.startDate`

Example: issue was completed in 2024-Q4 but the roadmap item is planned for 2026-Q1.
`issueActivityEnd < roadmapItem.startDate` → the issue does not qualify. This is the
primary scenario the feature is designed to prevent.

### E6 — Issue completed after `roadmapItem.targetDate`

`issueActivityStart <= roadmapItem.targetDate` may still be true (the issue was started
before the target), but `issueActivityEnd > roadmapItem.targetDate`. The overlap rule
only requires the *start* of issue activity to precede the target date; completion after
the target still counts (late delivery is captured as a delivery-rate miss, not excluded
from coverage). This is intentional: a story that started during the roadmap window but
slipped past the target date was genuinely part of that roadmap item's work.

### E7 — Multiple ideas link to the same epic key

Two JPD ideas both list `ACC-EPIC-5` in their `deliveryIssueKeys`. The
`loadActiveIdeasForWindow()` method resolves this conflict by keeping the window with
the **latest `targetDate`** (most recent commitment). This is conservative — it gives
the epic the benefit of the longest qualifying window.

**Alternative:** count the issue as qualifying if *any* overlapping idea covers it.
This is actually more correct semantically but requires tracking multiple idea windows
per epic key in the eligibility check. The "latest targetDate wins" heuristic is
simpler and correct for the common case where duplicate links are data entry errors.

### E8 — Scrum: issue is in a sprint but has no `createdAt` in the sprint window

Sprint-assigned issues predate the sprint (carried over). The sprint window for
`calculateSprintAccuracy()` is `[sprint.startDate, sprint.endDate]`. The proposed
`loadActiveIdeasForWindow()` call uses this sprint window to filter ideas, not to filter
issues. Issues in the sprint are already the correct scope.

### E9 — Kanban: `dataStartDate` interaction

The existing `dataStartDate` lower-bound filter on Kanban boards
(`BoardConfig.dataStartDate`) filters issues by board-entry date. The roadmap item date
filter is an *additional, per-issue* filter applied after `dataStartDate` exclusions.
The two filters compose correctly — `dataStartDate` narrows the issue set;
`loadActiveIdeasForWindow()` narrows which ideas are active for that window.

### E10 — Custom field IDs for JPD dates are wrong for this tenant

If `customfield_10015`, `customfield_10020`, or `customfield_10021` do not exist or
return null for all ideas, the `startDate` and `targetDate` columns remain null for all
ideas. The system degrades gracefully to the current (date-free) behaviour (edge case E3).

A future enhancement could allow the custom field IDs to be configured via
`RoadmapConfig` or environment variables. This is out of scope for this proposal.

---

## Complete Change List

### Backend

| File | Change |
|---|---|
| `backend/src/database/entities/jpd-idea.entity.ts` | Add `startDate: Date \| null` and `targetDate: Date \| null` columns |
| `backend/src/database/entities/roadmap-config.entity.ts` | Add `startDateFieldId: string \| null` and `targetDateFieldId: string \| null` columns |
| `backend/src/roadmap/dto/update-roadmap-config.dto.ts` (new or existing) | Add `startDateFieldId?: string \| null` and `targetDateFieldId?: string \| null` fields |
| `backend/src/jira/jira-client.service.ts` | Extend `getJpdIdeas()` to accept a `fields` array (or concatenate the configured field IDs from caller) so date field IDs are not hardcoded |
| `backend/src/sync/sync.service.ts` | In `syncJpdProject()`, read `startDateFieldId` and `targetDateFieldId` from the `RoadmapConfig` row; extract and map those fields from raw Jira response onto `JpdIdea.startDate` / `JpdIdea.targetDate` |
| `backend/src/roadmap/roadmap.service.ts` | Replace `loadCoveredEpicKeys()` with `loadActiveIdeasForWindow(windowStart, windowEnd)`; add `isIssueEligibleForRoadmapItem()` helper; update all three accuracy paths; extend changelog queries to capture `changedAt` |
| `backend/src/migrations/XXXXXXXXX-AddDateFieldsToJpdIdeas.ts` | New migration: adds `startDate` and `targetDate` to `jpd_ideas` |
| `backend/src/migrations/XXXXXXXXX-AddDateFieldIdsToRoadmapConfigs.ts` | New migration: adds `startDateFieldId` and `targetDateFieldId` to `roadmap_configs` |

### Frontend

| File | Change |
|---|---|
| `frontend/src/lib/api.ts` | Add `startDateFieldId: string \| null` and `targetDateFieldId: string \| null` to the `RoadmapConfig` type; add to the update wrapper |
| `frontend/src/app/settings/page.tsx` | Add text input fields for `startDateFieldId` and `targetDateFieldId` in the Roadmap Config section |

---

## Migration

### Migration 1 — `AddDateFieldsToJpdIdeas`

```typescript
export class AddDateFieldsToJpdIdeas<TIMESTAMP> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas"
         ADD COLUMN IF NOT EXISTS "startDate"  TIMESTAMP WITH TIME ZONE DEFAULT NULL,
         ADD COLUMN IF NOT EXISTS "targetDate" TIMESTAMP WITH TIME ZONE DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas" DROP COLUMN IF EXISTS "startDate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas" DROP COLUMN IF EXISTS "targetDate"`,
    );
  }
}
```

### Migration 2 — `AddDateFieldIdsToRoadmapConfigs`

```typescript
export class AddDateFieldIdsToRoadmapConfigs<TIMESTAMP> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs"
         ADD COLUMN IF NOT EXISTS "startDateFieldId"  VARCHAR DEFAULT NULL,
         ADD COLUMN IF NOT EXISTS "targetDateFieldId" VARCHAR DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs" DROP COLUMN IF EXISTS "startDateFieldId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs" DROP COLUMN IF EXISTS "targetDateFieldId"`,
    );
  }
}
```

**Post-migration behaviour:** Existing `jpd_ideas` rows have `startDate = NULL` and
`targetDate = NULL`. Existing `roadmap_configs` rows have `startDateFieldId = NULL` and
`targetDateFieldId = NULL`. Because decision 2 requires both dates to be set for an idea
to participate in accuracy calculations, and because the sync will not populate dates
until the operator configures field IDs in Settings and triggers a resync, **roadmap
accuracy will return 0 coverage/delivery for all periods after deployment** until:

1. The operator opens Settings → Roadmap Config and enters the correct Jira custom field
   IDs for `startDateFieldId` and `targetDateFieldId`.
2. A roadmap sync runs (manually or via the next cron cycle).

This is a **breaking change** in metric values. Teams should be informed before deployment.

---

## Alternatives Considered

### Alternative A — Store a `completedAt` column on `JiraIssue`

Add a `completedAt: Date | null` column to `jira_issues`, populated during sync from
the done-transition changelog entry or from `resolutiondate` in the Jira API.

**Why ruled out:** Adds a schema change to `jira_issues` (a larger, more frequently
written table) and requires a changelog query or an additional API field during every
issue sync. The completion date is already derivable from `jira_changelogs.changedAt`
where `field = 'status' AND toValue IN doneStatusNames` — data that is already present
in the database. Querying it at accuracy-calculation time is consistent with how the
existing sprint completion check works (lines 546–563 of `roadmap.service.ts`) and
avoids the risk of a stale denormalised `completedAt` value if the issue is later
re-opened.

### Alternative B — Filter ideas by date in the frontend / API query params

Add `windowStart` and `windowEnd` query parameters to `GET /api/roadmap/accuracy` and
let the frontend pass the sprint or quarter bounds. The service filters ideas by those
dates.

**Why ruled out:** The date window is already intrinsic to the roadmap item — the
`targetDate` is stored on the JPD idea, not decided by the caller. Passing window dates
as query parameters would let callers override the roadmap item's own delivery schedule,
which is incorrect semantically. The correct source of truth for "is this idea active
during period P?" is the idea's own `startDate`/`targetDate`, not an externally supplied
window. Additionally, this would require frontend changes and would not fix the
historical data inflation problem for past periods.

### Alternative C — Add `isActiveForPeriod` as a boolean flag synced onto `JpdIdea`

Compute at sync time whether each idea is "currently active" (i.e. `NOW()` between
`startDate` and `targetDate`) and store this as a boolean column. Accuracy calculation
filters to `isActive = true` ideas only.

**Why ruled out:** This makes the data time-sensitive in a way that conflicts with
historical queries. A user looking at 2025-Q3 accuracy today would get the set of ideas
that are active *now*, not the ideas that were active during 2025-Q3. The overlap check
must be computed at query time against the period under review, not against the current
moment.

### Alternative D — Use `fixVersion.releaseDate` as a proxy for roadmap target date

Instead of storing `targetDate` on `JpdIdea`, use the `releaseDate` of the issue's
`fixVersion` (already stored in `jira_versions`) as a proxy for when the work was
expected to be delivered.

**Why ruled out:** `fixVersion` is set on delivery issues (stories/tasks), not on JPD
ideas. A single JPD idea may span multiple fix versions across multiple boards.
`fixVersion.releaseDate` answers "when was this specific release shipped?" rather than
"when was this roadmap item planned to be delivered?" — these are different questions.
The JPD idea's own `targetDate` is the canonical source of the roadmap commitment.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | Additive: two nullable `TIMESTAMPTZ` columns on `jpd_ideas`. Fully reversible. No data loss. |
| API contract | None | `RoadmapSprintAccuracy` response shape is unchanged. Existing API consumers unaffected. |
| Frontend | None | No component or type changes. |
| Tests | New unit tests required | `RoadmapService` tests must cover: ideas with no dates (unchanged behaviour), ideas with only `targetDate`, ideas with both dates, issue completed before `startDate` (excluded), issue in-flight within window (included), multiple ideas same epic key (conflict resolution). |
| Jira API | Additive field request | `getJpdIdeas()` adds 4 field names to the `fields` query param. No new endpoint. Rate-limit risk is minimal — JPD sync runs at most once per 30-minute cron cycle, same as today. |
| Sync | Minor change | `syncJpdProject()` extracts 2 additional fields per idea. No additional API calls. |
| Backwards compatibility | Full | Ideas with null dates behave identically to the current implementation. No flag day. |

---

## Risks

**R1 — Custom field IDs must be configured before the feature activates.**
`startDateFieldId` and `targetDateFieldId` are stored in `RoadmapConfig` and default to
`null`. Until the operator enters the correct Jira custom field IDs in Settings and
triggers a resync, all JPD ideas will have null dates and will be excluded from accuracy
calculations (decision 2). This means `roadmapCoverage = 0` for all periods immediately
after deployment. The operator must take an explicit action to activate the feature.
A `Logger.warn()` during sync will surface this state. Mitigation: include operator
instructions in the deployment notes.

**R2 — Roadmap accuracy drops to zero immediately after deployment.**
Because decision 2 excludes all ideas without both dates, and dates are not populated
until the operator configures field IDs and resyncs, `roadmapCoverage` and
`roadmapDeliveryRate` will be zero for all periods after deployment. This is a
**hard breaking change** in the metric, not a gradual degradation. Teams must be
informed before deployment and should configure field IDs immediately after deploying.
Once configured and resynced, the metrics will reflect the date-filtered values
(which will generally be lower than the pre-deployment values due to date filtering
excluding historical inflation).

**R3 — The "latest targetDate wins" conflict resolution (E7) may mis-attribute issues.**
If an epic is linked from two ideas with different delivery windows, the wider (later)
window wins. An issue that is actually only relevant to the earlier idea may be
incorrectly admitted into the later idea's window. Mitigation: in practice, dual-linking
the same epic to two ideas is a data quality problem in Jira; the heuristic is correct
for well-maintained roadmap data. A future proposal could surface dual-linked epics as
a data quality warning.

**R4 — Performance: completion-date lookups add changelog query overhead.**
The existing sprint accuracy path already queries changelogs for issues not yet in done
status. The proposed change retains `changedAt` from those rows (no extra query). For
the Kanban path, the changelog load is already bulk-loaded. No additional DB round-trips
are introduced. Impact is negligible.

---

## Decisions

The following open questions were resolved by the product owner before acceptance:

1. **Custom field ID discovery → configurable in `RoadmapConfig`.**
   The field IDs for JPD `startDate` and `targetDate` vary between Jira Cloud tenants.
   They will be stored as nullable string columns on `RoadmapConfig` (`startDateFieldId`
   and `targetDateFieldId`) so they can be configured per JPD project via the Settings UI.
   This requires an additional migration on `roadmap_configs` and a settings UI change.
   See the updated change list below.

2. **Ideas without both `startDate` and `targetDate` → excluded entirely.**
   If a JPD idea is missing either `startDate` or `targetDate`, it is **excluded** from
   all accuracy calculations. It does not fall through to open-ended behaviour. This
   ensures only fully-planned roadmap items influence the metric. Ideas with incomplete
   dates are silently skipped (not counted as covered or delivered).

3. **Date filter applies to `roadmapCoverage` as well as `roadmapDeliveryRate` → confirmed.**
   Both metrics share the same `loadActiveIdeasForWindow()` result. An issue does not
   count as "roadmap-covered" unless the covering roadmap item is active for the period
   under review. This is the correct and intended behaviour.

---

## Acceptance Criteria

- [ ] Migration `AddDateFieldsToJpdIdeas` adds `startDate` and `targetDate` as nullable
      `TIMESTAMPTZ` columns to `jpd_ideas`. Running `down` drops both columns cleanly.

- [ ] Migration `AddDateFieldIdsToRoadmapConfigs` adds `startDateFieldId` and
      `targetDateFieldId` as nullable `VARCHAR` columns to `roadmap_configs`. Running
      `down` drops both columns cleanly.

- [ ] The Settings page Roadmap Config section exposes text inputs for `startDateFieldId`
      and `targetDateFieldId`. Saving updates the `roadmap_configs` row.

- [ ] After a roadmap sync where `startDateFieldId` and `targetDateFieldId` are configured,
      `jpd_ideas` rows for ideas with matching Jira field values have non-null `startDate`
      and `targetDate`. Rows for ideas without those fields have null dates.

- [ ] A JPD idea with `startDate = NULL` or `targetDate = NULL` (or both) is **excluded**
      from all accuracy calculations — it contributes 0 to both `coveredIssues` and
      `linkedCompletedIssues`. Verified by unit test.

- [ ] An issue whose epic is linked to a JPD idea with `targetDate = 2025-06-30` does
      NOT appear in `linkedCompletedIssues` for a sprint ending 2025-09-30 where the
      issue was completed after `targetDate`. Verified by unit test.

- [ ] An issue whose epic is linked to a JPD idea with `startDate = 2026-01-01` and
      the issue was completed in 2025-Q4 does NOT appear in `linkedCompletedIssues` for
      the 2025-Q4 quarter. Verified by unit test.

- [ ] An in-flight issue (no done-transition in `jira_changelogs`) whose epic is linked
      to a JPD idea with a `targetDate` in the future DOES appear in `coveredIssues` for
      the current sprint. Verified by unit test.

- [ ] `loadActiveIdeasForWindow()` excludes ideas whose `targetDate < windowStart`.
      Verified by unit test.

- [ ] `loadActiveIdeasForWindow()` excludes ideas whose `startDate > windowEnd`.
      Verified by unit test.

- [ ] When two ideas link to the same epic key, the one with the later `targetDate` wins
      in the returned map. Verified by unit test.

- [ ] The `roadmapCoverage` and `roadmapDeliveryRate` values for a sprint where all
      active ideas have null dates are `0`. Verified by unit test.

- [ ] A logged `warn()` is emitted during `syncJpdProject()` when `ideas.length > 0`
      but all ideas have null `targetDate` after sync (field ID likely misconfigured).
      Verified by unit test on `SyncService`.

- [ ] The existing `GET /api/roadmap/accuracy` response shape is unchanged. Existing
      integration tests pass.

- [ ] The Kanban weekly accuracy path applies the same date filter as the Scrum sprint
      path. Verified by unit test covering a week window where one idea is active and
      one is outside the window.

- [ ] `roadmapCoverage` is filtered by the same `loadActiveIdeasForWindow()` result as
      `roadmapDeliveryRate` — an issue does not count as covered unless its covering
      roadmap item is active for the period. Verified by unit test.
