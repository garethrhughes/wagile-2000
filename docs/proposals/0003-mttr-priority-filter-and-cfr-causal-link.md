# 0003 — MTTR Priority Filter and CFR Causal-Link Requirement

**Date:** 2026-04-10
**Status:** Proposed
**Author:** Architect Agent
**Related ADRs:** [ADR-0015](../decisions/0015-board-config-as-metric-filter-composition-point.md) (to be created on acceptance), [ADR-0003](../decisions/0003-per-board-configurable-rules-for-cfr-and-mttr.md) (extended by this proposal)

---

## Problem Statement

Two deficiencies in the current DORA metric calculations have been identified:

1. **MTTR over-counts non-critical incidents.** `MttrService` classifies any issue
   matching `incidentIssueTypes` or `incidentLabels` as an incident, regardless of
   priority. A P4 / Low-priority bug logged as type "Bug" on a board that uses
   `incidentIssueTypes: ['Bug']` is therefore included in the MTTR median, inflating
   the number and dragging the band down. There is no mechanism to restrict MTTR
   calculation to high-severity (e.g. Critical) issues only.

2. **CFR counts every Bug/label match as a deployment failure**, even when those issues
   were not caused by a deployment. A Bug raised for a pre-existing data issue or a
   third-party API change is unrelated to deployment quality, yet it currently
   increments the failure counter. `BoardConfig.failureLinkTypes` already exists
   (default `["is caused by", "caused by"]`) and is correctly surfaced in the settings
   UI, but `CfrService` never reads it. No `jira_issue_links` table or entity exists in
   the codebase — the column is defined but the data backing it is absent.

---

## Proposed Solution

### Overview

```
Change 1 (MTTR):                     Change 2 (CFR):
────────────────────────────────     ──────────────────────────────────────
BoardConfig                          BoardConfig
  + incidentPriorities: string[]       failureLinkTypes: string[]  ← exists
                                                │
JiraIssue                            JiraIssueLink  ← NEW entity + table
  + priority: string | null             linkType: string
        │                               sourceKey: string
        │                               targetKey: string
        ▼                                     │
MttrService.calculate()              CfrService.calculate()
  AND filter on priority               IN sub-query / join
  when incidentPriorities.length > 0  when failureLinkTypes.length > 0
```

Both changes follow the established pattern defined in ADR-0003: calculation rules
are stored as per-board configuration in `BoardConfig` and evaluated at query time
inside the relevant metric service. No rules are hardcoded; all fields default to
backward-compatible values.

---

### Change 1 — MTTR Priority Filter

#### 1a. New `BoardConfig` column: `incidentPriorities`

| Property | Value |
|---|---|
| Column name | `incidentPriorities` |
| TypeORM type | `simple-json` |
| TypeScript type | `string[]` |
| Entity default | `'[]'` (empty array — filter disabled) |
| Semantics | Empty = no priority filter (all priorities pass). Non-empty = issue `priority` must be in this list. |

The empty-list-means-disabled pattern is consistent with `incidentLabels` (also
defaults to `[]`) already on the entity.

```typescript
// board-config.entity.ts addition
@Column('simple-json', { default: '[]' })
incidentPriorities!: string[];
```

#### 1b. New `JiraIssue` column: `priority`

The `JiraIssue` entity and `jira_issues` table do **not** currently have a `priority`
column. The task brief states the column "already exists" but this is **incorrect** —
confirmed by reading `jira-issue.entity.ts` (45 lines, no `priority`) and the initial
migration `InitialSchema1775795358704` (column absent from `CREATE TABLE`).

A new column must be added to both the entity and the DB via migration.

| Property | Value |
|---|---|
| Column name | `priority` |
| TypeORM type | `varchar`, nullable |
| TypeScript type | `string \| null` |
| Default | `null` |

```typescript
// jira-issue.entity.ts addition
@Column({ type: 'varchar', nullable: true })
priority!: string | null;
```

The Jira sync service (`JiraSyncService` or equivalent) must be updated to populate
`priority` from `issue.fields.priority.name` on each sync. If `priority` is absent in
the Jira response, store `null`.

#### 1c. DB migration

A new migration file must be created at:
```
backend/src/migrations/<timestamp>-AddIncidentPriorityFilter.ts
```

The timestamp must be strictly greater than `1775795358706` (the current highest).

```typescript
// Up
await queryRunner.query(
  `ALTER TABLE "jira_issues"
   ADD COLUMN IF NOT EXISTS "priority" character varying`
);
await queryRunner.query(
  `ALTER TABLE "board_configs"
   ADD COLUMN IF NOT EXISTS "incidentPriorities" text NOT NULL DEFAULT '[]'`
);

// Down
await queryRunner.query(
  `ALTER TABLE "board_configs"
   DROP COLUMN IF EXISTS "incidentPriorities"`
);
await queryRunner.query(
  `ALTER TABLE "jira_issues"
   DROP COLUMN IF EXISTS "priority"`
);
```

#### 1d. `MttrService` algorithm change

The filter change is an AND-gate applied **after** the existing OR-gate that identifies
incident issues. The existing type/label logic is unchanged.

**New config read:**
```typescript
const incidentPriorities = config?.incidentPriorities ?? [];
```

**New filter (applied after the existing incident OR-gate):**
```typescript
const incidentIssues = allIssues.filter((issue) => {
  // Step 1: existing OR-gate (unchanged)
  const isIncidentType = incidentIssueTypes.includes(issue.issueType);
  const hasIncidentLabel =
    incidentLabels.length > 0
      ? issue.labels.some((l) => incidentLabels.includes(l))
      : false;
  const isIncident = isIncidentType || hasIncidentLabel;

  if (!isIncident) return false;

  // Step 2: NEW AND-gate — priority filter
  // Empty list = disabled (all priorities pass)
  if (incidentPriorities.length === 0) return true;
  return incidentPriorities.includes(issue.priority ?? '');
});
```

**Key behaviours:**
- `incidentPriorities = []` (default): filter is disabled; behaviour is identical to
  today. No regression for existing boards.
- `incidentPriorities = ['Critical']`: only issues with `priority === 'Critical'` that
  also match incidentIssueTypes/incidentLabels are included.
- `issue.priority === null` with a non-empty `incidentPriorities` list: the
  `issue.priority ?? ''` coercion means `null` priority never matches any named
  priority. The issue is excluded. This is the correct behaviour: an issue with no
  recorded priority does not meet an explicit priority requirement.

#### 1e. Frontend settings change

A new `CsvField` entry must be added to the Board Configuration section in
`frontend/src/app/settings/page.tsx` within the existing `sm:grid-cols-2` grid:

```tsx
<CsvField
  label="Incident Priorities"
  value={config.incidentPriorities}
  onChange={(v) => updateField('incidentPriorities', v)}
/>
```

The `BoardConfig` interface in `frontend/src/lib/api.ts` gains one field:
```typescript
incidentPriorities: string[];
```

**Label copy guidance:** "Incident Priorities" with placeholder text
`"Critical, Blocker"`. A tooltip or helper text is desirable (e.g. "Leave blank to
include all priorities") but is optional for the initial implementation.

---

### Change 2 — CFR Causal-Link Requirement

#### 2a. Current state of `failureLinkTypes`

`BoardConfig.failureLinkTypes` already exists with the correct default
`'["is caused by","caused by"]'` in:
- Entity (`board-config.entity.ts` line 17–18)
- Initial migration (`board_configs` CREATE TABLE, confirmed)
- Frontend `api.ts` `BoardConfig` type (line 23)
- Frontend settings page (`CsvField` for "Failure Link Types" at lines 327–331)

**No changes are needed** to `BoardConfig`, the migration, or the frontend settings
page for the `failureLinkTypes` field itself.

#### 2b. Missing: `jira_issue_links` table and entity

The task brief states a `jira_issue_links` table and entity exist — they do **not**.
The glob of all entity files shows no link entity. The initial migration creates no
such table. This is the highest-risk gap in this proposal.

To implement the link filter, the following must be created:

**New entity: `JiraIssueLink`**

```typescript
// backend/src/database/entities/jira-issue-link.entity.ts

import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('jira_issue_links')
@Index(['sourceKey'])
@Index(['targetKey'])
export class JiraIssueLink {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The issue key this link originates from (outward direction) */
  @Column()
  sourceKey!: string;

  /** The issue key this link points to (inward direction) */
  @Column()
  targetKey!: string;

  /**
   * The link type name as returned by Jira, e.g. "caused by", "is caused by",
   * "blocks", "is blocked by".
   * Stored normalised to lower-case.
   */
  @Column()
  linkType!: string;
}
```

**New DB migration** (same migration file as `incidentPriorities`, or a separate file
at the same timestamp batch — see §Migration Strategy below):

```sql
-- Up
CREATE TABLE IF NOT EXISTS "jira_issue_links" (
  "id" SERIAL NOT NULL,
  "sourceKey" character varying NOT NULL,
  "targetKey" character varying NOT NULL,
  "linkType"  character varying NOT NULL,
  CONSTRAINT "PK_jira_issue_links" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "IDX_jira_issue_links_sourceKey"
  ON "jira_issue_links" ("sourceKey");
CREATE INDEX IF NOT EXISTS "IDX_jira_issue_links_targetKey"
  ON "jira_issue_links" ("targetKey");

-- Down
DROP TABLE IF EXISTS "jira_issue_links";
```

**`entities/index.ts`** must be updated to export `JiraIssueLink`.

#### 2c. Sync requirement: populating `jira_issue_links`

The link table is only useful if it is populated. The Jira issue response
(`GET /rest/api/3/issue/{key}`) includes `fields.issuelinks`, an array of objects
with shape:

```json
{
  "type": { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" },
  "inwardIssue": { "key": "ACC-10" },   // present when this issue is the inward end
  "outwardIssue": { "key": "ACC-20" }   // present when this issue is the outward end
}
```

The sync service must, for each issue synced, upsert rows in `jira_issue_links`.

**Upsert strategy:** Delete all existing links for the issue key (`sourceKey = key`)
before re-inserting, to handle removed links. Store one row per link direction
present in the Jira response. Both `inwardIssue` (store with `targetKey`) and
`outwardIssue` (store with `targetKey`) are stored from the perspective of the issue
being synced as `sourceKey`.

**Link type normalisation:** Store `linkType` as the **inward** or **outward** name
in lower-case, whichever side the current issue occupies. For example:

| Jira link entry for ACC-5 | Stored row |
|---|---|
| `type.name="Caused by"`, `outwardIssue.key="ACC-10"` | `sourceKey=ACC-5, targetKey=ACC-10, linkType="caused by"` |
| `type.name="Caused by"`, `inwardIssue.key="ACC-20"` | `sourceKey=ACC-5, targetKey=ACC-20, linkType="is caused by"` |

This matches the existing default `failureLinkTypes: ["is caused by", "caused by"]`.

> **Open question §5.1:** Should the sync also store the link direction separately
> (e.g. an `isInward: boolean` column), or is normalising the link type name to the
> directional label sufficient? The current proposal stores only the directional label.

#### 2d. `CfrService` algorithm change

**New config read (already loaded, confirm null coalesce):**
```typescript
const failureLinkTypes = config?.failureLinkTypes ?? ['is caused by', 'caused by'];
```

**New: load qualifying linked issue keys**

When `failureLinkTypes` is non-empty, the service must determine which failure
candidates have at least one qualifying link. The most efficient approach is a single
set-membership query against `jira_issue_links` for all failure candidate keys before
the final count:

```typescript
// Pseudocode — applied AFTER identifying failure-candidate keys

let linkedFailureKeys: Set<string> | null = null;

if (failureLinkTypes.length > 0 && failureCandidateKeys.length > 0) {
  const linkedRows = await this.issueLinkRepo
    .createQueryBuilder('lnk')
    .select('DISTINCT lnk.sourceKey', 'sourceKey')
    .where('lnk.sourceKey IN (:...keys)', { keys: failureCandidateKeys })
    .andWhere('lnk.linkType IN (:...types)', { types: failureLinkTypes })
    .getRawMany<{ sourceKey: string }>();

  linkedFailureKeys = new Set(linkedRows.map((r) => r.sourceKey));
}
```

**Updated failure counting loop:**

```typescript
for (const key of deployedKeys) {
  const issue = issueMap.get(key);
  if (!issue) continue;

  const isFailureType = failureIssueTypes.includes(issue.issueType);
  const hasFailureLabel = issue.labels.some((l) => failureLabels.includes(l));

  if (!(isFailureType || hasFailureLabel)) continue;

  // NEW: causal link gate
  // If failureLinkTypes is empty, the gate is open (all candidates count).
  // If non-empty, the issue must have at least one qualifying link.
  if (linkedFailureKeys !== null && !linkedFailureKeys.has(key)) continue;

  failureCount++;
}
```

**Key behaviours:**
- `failureLinkTypes = []`: `linkedFailureKeys` stays `null`; the link gate is
  skipped entirely. All type/label matches count as failures. No regression.
- `failureLinkTypes = ['caused by', 'is caused by']` (default): only failure
  candidates that have a matching link row are counted. Issues raised for
  pre-existing bugs without a deployment cause link are excluded.
- If `failureCandidateKeys` is empty when `failureLinkTypes` is non-empty: the
  `IN` query is skipped (guard on `.length > 0`) and `linkedFailureKeys` remains
  an empty `Set`. No SQL error from empty `IN (...)`.

**`JiraIssueLink` repository injection:**

`CfrService` must inject `JiraIssueLink` via `@InjectRepository(JiraIssueLink)` and
`CfrModule` (or `MetricsModule`) must add `JiraIssueLink` to its
`TypeOrmModule.forFeature([...])` imports.

#### 2e. Migration strategy: single file for both changes

Both DB changes from Change 1 and Change 2 are packaged into a **single migration
file**. This keeps the migration log clean (one conceptual change = one migration)
and ensures the two are applied or rolled back atomically.

```
backend/src/migrations/<timestamp>-AddIncidentPriorityAndIssueLinkTable.ts
```

The timestamp must be greater than `1775795358706`. Recommended: use the current
Unix timestamp in milliseconds at the time of implementation.

---

### Migration File (full pseudocode)

```typescript
export class AddIncidentPriorityAndIssueLinkTable<timestamp>
  implements MigrationInterface {
  name = 'AddIncidentPriorityAndIssueLinkTable<timestamp>';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add priority to jira_issues
    await queryRunner.query(
      `ALTER TABLE "jira_issues"
       ADD COLUMN IF NOT EXISTS "priority" character varying`
    );

    // 2. Add incidentPriorities to board_configs
    await queryRunner.query(
      `ALTER TABLE "board_configs"
       ADD COLUMN IF NOT EXISTS "incidentPriorities" text NOT NULL DEFAULT '[]'`
    );

    // 3. Create jira_issue_links table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "jira_issue_links" (
        "id" SERIAL NOT NULL,
        "sourceKey" character varying NOT NULL,
        "targetKey" character varying NOT NULL,
        "linkType"  character varying NOT NULL,
        CONSTRAINT "PK_jira_issue_links" PRIMARY KEY ("id")
      )
    `);

    // 4. Indexes on jira_issue_links
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_jira_issue_links_sourceKey"
       ON "jira_issue_links" ("sourceKey")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_jira_issue_links_targetKey"
       ON "jira_issue_links" ("targetKey")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_jira_issue_links_targetKey"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_jira_issue_links_sourceKey"`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "jira_issue_links"`);
    await queryRunner.query(
      `ALTER TABLE "board_configs"
       DROP COLUMN IF EXISTS "incidentPriorities"`
    );
    await queryRunner.query(
      `ALTER TABLE "jira_issues"
       DROP COLUMN IF EXISTS "priority"`
    );
  }
}
```

---

### Affected Files Summary

| File | Change |
|---|---|
| `backend/src/database/entities/board-config.entity.ts` | Add `incidentPriorities: string[]` column |
| `backend/src/database/entities/jira-issue.entity.ts` | Add `priority: string \| null` column |
| `backend/src/database/entities/jira-issue-link.entity.ts` | **New file** — `JiraIssueLink` entity |
| `backend/src/database/entities/index.ts` | Export `JiraIssueLink` |
| `backend/src/migrations/<timestamp>-AddIncidentPriorityAndIssueLinkTable.ts` | **New migration** |
| `backend/src/metrics/mttr.service.ts` | Read `incidentPriorities`; add AND-gate after incident OR-gate |
| `backend/src/metrics/cfr.service.ts` | Inject `JiraIssueLinkRepository`; add link sub-query and gate |
| `backend/src/metrics/metrics.module.ts` (or wherever `CfrService` is provided) | Add `JiraIssueLink` to `TypeOrmModule.forFeature([...])` |
| `backend/src/sync/jira-sync.service.ts` (or equivalent) | Populate `jira_issue_links` during issue sync |
| `frontend/src/lib/api.ts` | Add `incidentPriorities: string[]` to `BoardConfig` |
| `frontend/src/app/settings/page.tsx` | Add `CsvField` for "Incident Priorities" |

---

## Alternatives Considered

### Alternative A — Filter MTTR by priority in the query layer (SQL WHERE)

Rather than loading all board issues and filtering in TypeScript, add a `WHERE priority
IN (...)` clause to the `issueRepo.find()` call.

**Ruled out** because: (a) the current service loads all issues and filters in memory
for all other conditions — departing from this for priority alone would be inconsistent;
(b) when `incidentPriorities` is empty the WHERE clause must be omitted entirely, which
requires conditional query building that adds complexity for marginal performance gain
on boards with O(100s) of issues; (c) the in-memory filter is negligible at this scale.

### Alternative B — Store issue links on `JiraIssue` as a JSON column

Rather than a separate `jira_issue_links` table, store links as a `simple-json` column
on `JiraIssue` (e.g. `links: Array<{ type: string; targetKey: string }>`).

**Ruled out** because: (a) it prevents efficient querying — finding all issues linked to
any issue in a set requires loading and deserialising every issue; (b) the JSON blob
grows unbounded with many links; (c) it cannot be indexed; (d) a normalised table is
cleaner and consistent with how other related entities (`jira_changelogs`,
`jira_sprints`) are modelled in this project.

### Alternative C — Fetch links live from Jira at CFR query time

Call `JiraClientService` to fetch issue links for each failure candidate at metric
calculation time, bypassing the database.

**Ruled out** because: it violates the core caching architecture (ADR-0002 — all Jira
data is cached in Postgres and served from there, never queried live per metric
request); it would introduce unbounded latency proportional to the number of failure
candidates; and it risks Jira API rate limits.

### Alternative D — Skip the link filter if `jira_issue_links` is empty

Rather than adding the full sync pipeline, implement CFR to check `failureLinkTypes`
but silently fall back to no-link-filter when the table is empty.

**Ruled out** because: silent fallback makes the feature undetectable — a board
operator who configures `failureLinkTypes` would see no change in CFR if the sync has
not run. The correct behaviour is to make the empty table visible through zero-match
results, which surfaces the sync dependency clearly. An empty `jira_issue_links` table
with a non-empty `failureLinkTypes` config will produce `failureCount = 0`, which is a
clear signal that links need to be synced.

### Alternative E — Two separate migration files (one per change)

Each change (priority filter + issue links table) gets its own migration file.

**Ruled out for the default recommendation** because the two changes are delivered
together and are logically atomic (both are needed for the `BoardConfig` changes to
be fully functional). However, see Open Question §5.2 — a developer may legitimately
prefer two files for rollback granularity.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required — two `ALTER TABLE`, one new table, two indexes | See §2e for migration structure. Reversible via `down()`. |
| API contract | None / Additive | No existing endpoints changed. `BoardConfig` response shape gains `incidentPriorities`. |
| Frontend | Additive | One new `CsvField` in settings. One new field on `BoardConfig` type in `api.ts`. |
| Tests | New unit tests for both services | See Acceptance Criteria. |
| Jira API | No new endpoint, but sync must read `fields.issuelinks` | This is a new field read from the existing issue fetch response. Check whether current sync already requests this field via `fields=...` query param. |
| Sync pipeline | New write path for `jira_issue_links` | Upsert (delete + re-insert) on every issue sync. Adds O(links per issue) rows — typically 0–5. |
| `SprintDetailService` (0002) | Potential future alignment | Proposal 0002 explicitly deferred link-based `isFailure` annotation (Open Question §7.3). If this proposal is accepted, a follow-on to 0002 could add link-based `isFailure` to the sprint detail view using `JiraIssueLink`. This is out of scope here. |

---

## Open Questions

### 5.1 — Link direction storage: directional label vs. separate column

The current proposal stores `linkType` as the directional label of the link from
`sourceKey`'s perspective (e.g. `"caused by"` or `"is caused by"`). An alternative is
to store the canonical link type name (e.g. `"Caused by"`) plus an `isInward: boolean`
column, and derive the directional label at query time.

**Recommendation:** Directional label is simpler and sufficient for the current use
case. Accept this unless the team foresees queries that need to navigate links
bidirectionally by type without knowing direction.

### 5.2 — Single vs. two migration files

Should the `priority` column + `incidentPriorities` column share one migration with
the `jira_issue_links` table? The two changes are logically independent and could be
deployed separately if needed.

**Recommendation:** Single file (simpler migration log). If the team wants granular
rollback, split into two files. Either approach is valid.

### 5.3 — Sync field inclusion: does current sync request `issuelinks`?

The Jira REST API v3 `GET /rest/api/3/issue/{key}` only returns `fields.issuelinks`
if `issuelinks` is included in the `fields` query parameter (or if no `fields`
parameter is specified, in which case all fields are returned). The current sync
implementation must be checked to confirm `issuelinks` is included. If the sync uses
an explicit `fields=...` parameter, `issuelinks` must be added.

**Resolution required before implementation.** The developer must inspect
`JiraClientService` / sync service to confirm field inclusion.

### 5.4 — Handling duplicate links in the Jira response

Jira can return the same logical link from both sides of a linked pair: if ACC-5 "is
caused by" ACC-10, and both ACC-5 and ACC-10 are on the same board, the sync will
create rows for both. The query in `CfrService` uses `DISTINCT sourceKey` so
duplicate link rows for the same `(sourceKey, targetKey, linkType)` tuple do not
inflate the count. However, the delete + re-insert upsert strategy is based on
`sourceKey` only, which naturally deduplicates within a single issue sync.

No action required; documented for awareness.

### 5.5 — `priority` field sync: what value does Jira return?

Jira priority names are project-configurable (e.g. some projects use "Critical" /
"Major" / "Minor", others use "P1" / "P2" / "P3"). The `incidentPriorities` config
accepts free-form strings, so this is flexible. However, the developer must verify
that the sync service reads `issue.fields.priority?.name` (not `.id`) to store the
human-readable name. Storing the ID would require the settings UI to use IDs, which
is not user-friendly.

---

## Acceptance Criteria

### Change 1 — MTTR Priority Filter

- [ ] A new migration adds `"priority" character varying` (nullable) to `jira_issues`
      with a matching `DROP COLUMN` in `down()`.
- [ ] A new migration adds `"incidentPriorities" text NOT NULL DEFAULT '[]'` to
      `board_configs` with a matching `DROP COLUMN` in `down()`.
- [ ] `JiraIssue` entity has `priority: string | null` with `@Column({ type: 'varchar', nullable: true })`.
- [ ] `BoardConfig` entity has `incidentPriorities: string[]` with
      `@Column('simple-json', { default: '[]' })`.
- [ ] `MttrService.calculate()` reads `incidentPriorities` from config (defaulting to `[]`).
- [ ] When `incidentPriorities = []`, MTTR output is identical to the current behaviour
      for all existing test cases (backwards compatibility).
- [ ] When `incidentPriorities = ['Critical']`, an incident issue with
      `priority = 'High'` is excluded from the MTTR calculation.
- [ ] When `incidentPriorities = ['Critical']`, an incident issue with
      `priority = 'Critical'` is included in the MTTR calculation.
- [ ] When `incidentPriorities = ['Critical']`, an incident issue with
      `priority = null` is excluded from the MTTR calculation (null does not match any priority).
- [ ] The priority filter is applied AFTER the type/label OR-gate (not before): a
      `priority = 'Critical'` issue that is not an incident type/label is still excluded.
- [ ] The Jira sync service writes `priority` from `issue.fields.priority?.name ?? null`
      to `jira_issues.priority` on every sync.
- [ ] `frontend/src/lib/api.ts` `BoardConfig` type includes `incidentPriorities: string[]`.
- [ ] Settings page renders a "Incident Priorities" `CsvField` bound to
      `config.incidentPriorities`.
- [ ] No TypeScript `any` types introduced. No new npm packages added.
- [ ] All new backend files use `.js` ESM import suffixes.

### Change 2 — CFR Causal-Link Requirement

- [ ] A new entity `JiraIssueLink` exists at
      `backend/src/database/entities/jira-issue-link.entity.ts` with columns
      `id`, `sourceKey`, `targetKey`, `linkType`.
- [ ] `JiraIssueLink` is exported from `backend/src/database/entities/index.ts`.
- [ ] A new migration creates `jira_issue_links` with `sourceKey` and `targetKey`
      indexes, with a matching `DROP TABLE` in `down()`.
- [ ] `CfrService` injects `@InjectRepository(JiraIssueLink)`.
- [ ] The metrics module (or wherever `CfrService` is provided) includes `JiraIssueLink`
      in `TypeOrmModule.forFeature([...])`.
- [ ] When `failureLinkTypes = []`, `CfrService` does not query `jira_issue_links`,
      and all type/label matched issues count as failures (backwards compatible).
- [ ] When `failureLinkTypes = ['caused by', 'is caused by']` and
      `jira_issue_links` is empty, `failureCount = 0` for all failure candidates
      (correct — links not yet synced).
- [ ] When `failureLinkTypes = ['caused by', 'is caused by']` and a failure candidate
      has a matching `jira_issue_links` row, it is counted.
- [ ] When `failureLinkTypes = ['caused by', 'is caused by']` and a failure candidate
      has **no** matching link row, it is NOT counted.
- [ ] The link query uses `DISTINCT sourceKey` to avoid double-counting if multiple
      qualifying link rows exist for the same issue.
- [ ] The link query is skipped entirely when `failureCandidateKeys.length === 0`
      (guard against empty `IN (...)` SQL error).
- [ ] The Jira sync service upserts `jira_issue_links` on each issue sync: deletes
      existing rows for `sourceKey` then re-inserts from `fields.issuelinks`.
- [ ] `failureLinkTypes` default remains `["is caused by", "caused by"]` — no change
      to entity or migration required.
- [ ] "Failure Link Types" `CsvField` is already present in the settings page — confirm
      no duplicate is added.
- [ ] No TypeScript `any` types introduced. No new npm packages added.
- [ ] All new backend files use `.js` ESM import suffixes.

### Shared

- [ ] Both changes are covered by unit tests in the metrics module using mocked
      repositories.
- [ ] The single migration file has both `up()` and `down()` fully implemented and
      has been run against the local Docker DB (`ai_starter`) without error.
- [ ] Existing MTTR and CFR tests (if any) continue to pass unchanged, confirming
      backwards compatibility of empty-list defaults.
