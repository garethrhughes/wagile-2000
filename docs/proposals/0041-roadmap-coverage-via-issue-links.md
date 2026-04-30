# 0041 — Roadmap Coverage via Jira Issue Links

**Date:** 2026-04-30
**Status:** Draft
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance
**Related proposals:** [0012](0012-roadmap-coverage-semantics.md), [0020](0020-in-flight-roadmap-coverage.md)

---

## Problem Statement

The current roadmap coverage implementation classifies a sprint issue as `in-scope` or
`linked` (rather than `none`) only when `issue.epicKey` is present in the `epicIdeaMap` —
a map built by walking `JpdIdea.deliveryIssueKeys`, which are Epic-level keys populated
from JPD delivery links during `syncRoadmaps`.

This approach misses a real-world coverage signal: some sprint tickets are **not parented
under a tracked Epic** but are instead linked directly to a roadmap item (a Jira Plans /
JPD issue such as PT-389) via a Jira issue link (e.g. "is connected to"). These tickets
have no `epicKey` that appears in `epicIdeaMap` and therefore always show `roadmapStatus
= 'none'`, suppressing legitimate coverage and misleading engineering leads about the
health of roadmap delivery.

The `jira_issue_links` table and `JiraIssueLink` entity already exist and are populated
during sync; the `JpdIdea` table is already populated with roadmap items. The gap is
purely in the coverage classification logic: it has no path to treat a direct
`issue → roadmapItem` link (via `jira_issue_links`) as roadmap coverage, even when the
linked target is a known JPD idea.

---

## Codebase Findings

### 1. `JiraIssueLink` — entity and sync

`backend/src/database/entities/jira-issue-link.entity.ts` defines:

```typescript
@Entity('jira_issue_links')
@Index(['sourceIssueKey'])
@Index(['targetIssueKey'])
export class JiraIssueLink {
  id: number;           // PK
  sourceIssueKey: string;
  targetIssueKey: string;
  linkTypeName: string; // e.g. "is connected to", "is child of"
  isInward: boolean;
}
```

`SyncService.persistIssueLinks()` (lines 511–546 of `sync.service.ts`) already persists
both inward and outward links for every issue returned by the Jira API. Both Scrum and
Kanban paths call `persistIssueLinks`. **No schema change is required for this entity.**

The `JiraIssueLink` table is already indexed on both `sourceIssueKey` and
`targetIssueKey`, so join lookups in either direction are fast.

### 2. `JpdIdea` — the roadmap item identity

`backend/src/database/entities/jpd-idea.entity.ts` stores one row per Jira Plans idea,
keyed on `idea.key` (e.g. "PT-389"). The set of all known roadmap item keys is therefore
the set of `jpd_ideas.key` values. There is **no separate flag** on `JiraIssue` that
marks an issue as "a Plans item rather than a delivery issue" — the only authoritative
signal is whether the issue key appears in `jpd_ideas`.

### 3. Where "has roadmap coverage" is classified

Coverage classification happens in **two services** that must stay in sync:

**A. `roadmap.service.ts` → `calculateSprintAccuracy()` (lines 848–959)**

Iterates `filteredIssues` and checks `issue.epicKey` against `epicIdeaMap`. Issues where
`issue.epicKey === null` or the epic key is absent from `epicIdeaMap` are silently
skipped (count toward `uncoveredIssues`).

**B. `sprint-detail.service.ts` → `getDetail()` (lines 563–596)**

Per-issue `roadmapStatus` annotation: checks `issue.epicKey !== null` first, then looks
it up in `epicIdeaMap`. Issues with no `epicKey` always receive `roadmapStatus = 'none'`.

### 4. How the `epicIdeaMap` is built today

Both services build a `Map<epicKey, { targetDate: Date }>` by iterating
`JpdIdea.deliveryIssueKeys` (an array of Epic keys stored on each idea). This map only
covers the Epic→Idea link direction. It has **no knowledge of direct Issue→Idea links**
stored in `jira_issue_links`.

### 5. `GapsService.getGaps()` — the `noEpic` list

`gaps.service.ts` line 135 marks an issue as having no-epic if `issue.epicKey === null`.
This is the correct "epic missing" check for planning hygiene. Under the proposed change,
an issue can have roadmap coverage via a direct link to a roadmap item **without** having
an epic — it should remain in the `noEpic` gaps list. These are orthogonal concerns:
coverage (is this work tied to a roadmap commitment?) and hygiene (does this ticket have
proper hierarchy?).

### 6. `BoardConfig` — configurable rules

`BoardConfig` already holds all per-board tunable rules (failure types, incident types,
done status names, etc.). There is currently **no field for roadmap project keys** —
the set of project keys whose issues should be treated as roadmap items. The only
implicit signal today is whether an issue key appears in `jpd_ideas.key`, which is
determined by the set of `RoadmapConfig.jpdKey` entries.

### 7. No migration needed for issue links

The `jira_issue_links` table was introduced in an earlier migration and is already
populated. The proposal requires **one new column on `board_configs`** (see Schema
Changes below) and **no new tables**.

---

## Proposed Solution

### Overview

Extend the coverage classification in both `calculateSprintAccuracy` and
`sprint-detail.service.ts` with a **Condition C**: an issue is roadmap-linked if it has
a direct Jira issue link (via `jira_issue_links`) to a known JPD idea key, where the
link type name matches a per-board-configurable allowlist.

The full classification rule becomes:

```
roadmapCoverage(issue):
  epicLinked  = issue.epicKey ∈ epicIdeaMap           (existing Condition from 0012)
  directLinked = ∃ row in jira_issue_links where
                   sourceIssueKey = issue.key AND
                   targetIssueKey ∈ jpd_idea_keys AND
                   LOWER(linkTypeName) ∈ roadmapLinkTypes   (new Condition C)

  if !(epicLinked || directLinked): return 'none'

  targetDate = epicLinked
                 ? epicIdeaMap.get(issue.epicKey).targetDate
                 : directLinkIdeaMap.get(issue.key).targetDate

  // Condition A and B from proposals 0012 + 0020 unchanged
  deliveredOnTime = resolvedAt ≠ null AND resolvedAt ≤ endOfDay(targetDate)
  isInFlight      = sprint.active AND targetDate ≥ today AND !done AND !cancelled
  return (deliveredOnTime || isInFlight) ? 'in-scope' : 'linked'
```

### New `BoardConfig` field: `roadmapLinkTypes`

A new `simple-json` column on `board_configs` holds the set of link type name strings
(lower-cased, matched as exact values) that qualify an issue link as a roadmap coverage
signal.

```typescript
/**
 * Lower-cased link type names (e.g. ["is connected to", "is child of"])
 * that, when found between a sprint issue and a known JPD idea key in
 * jira_issue_links, qualify the issue as roadmap-linked even without
 * an epic-level link.
 *
 * An empty array (the default) disables the direct-link coverage path
 * entirely — preserving the existing behaviour for boards that have not
 * configured this feature.
 *
 * Values are matched case-insensitively against jira_issue_links.linkTypeName.
 */
@Column({ type: 'simple-json', default: '[]' })
roadmapLinkTypes!: string[];
```

**Default is empty** — this is a non-breaking additive change. Boards that leave
`roadmapLinkTypes` at `[]` behave exactly as today.

### Migration

One reversible TypeORM migration:

```typescript
// up()
await queryRunner.query(`
  ALTER TABLE board_configs
  ADD COLUMN IF NOT EXISTS "roadmapLinkTypes" text NOT NULL DEFAULT '[]'
`);

// down()
await queryRunner.query(`
  ALTER TABLE board_configs
  DROP COLUMN IF EXISTS "roadmapLinkTypes"
`);
```

### Data flow: bulk-loading direct links (no N+1)

Both affected services must load the set of `(issueKey → targetDate)` pairs for
direct-linked issues **in a single query per service invocation**, not per issue.

The pattern:

```
Step 1 — collect sprint issue keys (already done in both services).

Step 2 — collect the set of all known JPD idea keys:
  jpdIdeaKeys = new Set(allIdeas.map(i => i.key))
  (allIdeas already loaded from jpd_ideas in both services)

Step 3 — single bulk query:
  SELECT l.sourceIssueKey, l.targetIssueKey, l.linkTypeName
  FROM jira_issue_links l
  WHERE l.sourceIssueKey IN (:...sprintIssueKeys)
    AND LOWER(l.linkTypeName) IN (:...roadmapLinkTypes)

Step 4 — filter in memory to rows where targetIssueKey ∈ jpdIdeaKeys,
  then build directLinkIdeaMap: Map<issueKey, { targetDate: Date }>.

  For conflict resolution (same issue linked to multiple roadmap items):
  keep the idea with the latest targetDate — consistent with existing
  epicIdeaMap conflict resolution.
```

This is one additional query per service invocation when `roadmapLinkTypes` is non-empty.
When `roadmapLinkTypes` is empty (the default), the query is skipped entirely.

### Changes to `calculateSprintAccuracy` (`roadmap.service.ts`)

`RoadmapConfig` and `JpdIdea` are already loaded upstream in `getAccuracy()` and passed
in as `allIdeas`. The `JiraIssueLink` repository needs to be injected into
`RoadmapService`.

```typescript
// New constructor injection:
@InjectRepository(JiraIssueLink)
private readonly issueLinkRepo: Repository<JiraIssueLink>,

// In calculateSprintAccuracy — new Step after building epicIdeaMap:
const directLinkIdeaMap = await this.buildDirectLinkIdeaMap(
  allFilteredKeys,
  allIdeas,
  roadmapLinkTypes,   // from BoardConfig, passed in as new parameter
);

// In the per-issue loop — extend the roadmap lookup:
for (const issue of filteredIssues) {
  const epicIdea  = issue.epicKey ? epicIdeaMap.get(issue.epicKey) : undefined;
  const directIdea = directLinkIdeaMap.get(issue.key);
  const idea = epicIdea ?? directIdea;       // epic link wins on targetDate conflict
  if (!idea) continue;
  // ... Conditions A and B unchanged ...
}
```

### Changes to `getDetail` (`sprint-detail.service.ts`)

`JiraIssueLink` is already injected (used for `failureLinkTypes` AND-gate). The direct
link query can share the same `issueLinkRepo`.

```typescript
// In getDetail — after building epicIdeaMap (around line 464):
const roadmapLinkTypes = boardConfig?.roadmapLinkTypes ?? [];
const directLinkIdeaMap = roadmapLinkTypes.length > 0
  ? await this.buildDirectLinkIdeaMap(finalKeys, jpdIdeas, roadmapLinkTypes)
  : new Map<string, { targetDate: Date }>();

// In the per-issue annotation loop — extend roadmapStatus:
let roadmapStatus: 'in-scope' | 'linked' | 'none' = 'none';
if (!cancelledStatusNames.includes(issue.status)) {
  const epicIdea  = issue.epicKey ? epicIdeaMap.get(issue.epicKey) : undefined;
  const directIdea = directLinkIdeaMap.get(issue.key);
  const idea = epicIdea ?? directIdea;
  if (idea) {
    // ... Conditions A and B unchanged ...
  }
}
```

### Shared helper: `buildDirectLinkIdeaMap`

To avoid duplicating the query logic, extract a private helper. Because the same logic
is needed in two different services (both of which already import `JiraIssueLink`), the
helper should be a **static utility function** in a shared module:

```
backend/src/metrics/roadmap-link-utils.ts
```

```typescript
export async function buildDirectLinkIdeaMap(
  issueLinkRepo: Repository<JiraIssueLink>,
  issueKeys: string[],
  allIdeas: JpdIdea[],
  roadmapLinkTypes: string[],   // lower-cased values from BoardConfig
): Promise<Map<string, { targetDate: Date }>> {
  const result = new Map<string, { targetDate: Date }>();
  if (roadmapLinkTypes.length === 0 || issueKeys.length === 0) return result;

  const jpdIdeaByKey = new Map(
    allIdeas
      .filter((i) => i.targetDate !== null)
      .map((i) => [i.key, i] as const),
  );

  const linkRows = await issueLinkRepo
    .createQueryBuilder('l')
    .select(['l.sourceIssueKey', 'l.targetIssueKey', 'l.linkTypeName'])
    .where('l.sourceIssueKey IN (:...keys)', { keys: issueKeys })
    .andWhere('LOWER(l.linkTypeName) IN (:...types)', { types: roadmapLinkTypes })
    .getMany();

  for (const row of linkRows) {
    const idea = jpdIdeaByKey.get(row.targetIssueKey);
    if (!idea || idea.targetDate === null) continue;
    const existing = result.get(row.sourceIssueKey);
    if (!existing || idea.targetDate > existing.targetDate) {
      result.set(row.sourceIssueKey, { targetDate: idea.targetDate });
    }
  }

  return result;
}
```

### Settings UI / API

`BoardConfig` is already exposed via `PUT /api/boards/:boardId/config`. The new
`roadmapLinkTypes` field will be included automatically in the existing read/write
path. A new input in the Settings UI (e.g. a tag-input for link type strings) should
be added to the board configuration section, labelled "Roadmap link types (direct
coverage)". This is additive to the existing settings form.

### `GapsService.getGaps()` — `noEpic` unchanged

An issue that gains roadmap coverage via a direct link to a roadmap item still has
`epicKey === null`. It will therefore still appear in the `noEpic` list, which is
correct: roadmap coverage and epic hierarchy hygiene are orthogonal signals. **No
change to `GapsService`.**

---

## Alternatives Considered

### Alternative A — Use the JPD project key as a discriminator (no `roadmapLinkTypes` config)

Identify roadmap items by checking whether `targetIssueKey` belongs to the project(s)
configured in `RoadmapConfig.jpdKey` (e.g. all issues with key prefix "PT"). The
link type name is ignored; any issue linked to a PT-* issue is considered roadmap-linked.

**Ruled out.** This is fragile and over-inclusive:

1. Teams link to PT-* issues for reasons other than roadmap coverage (e.g. "blocks",
   "is blocked by", "relates to"). Treating all links as coverage signals would
   inflate coverage figures deceptively.
2. A project key prefix check violates the principle of no hardcoded project keys in
   source — the project key would have to be derived at query time from `RoadmapConfig`,
   which creates a join and is less explicit than an allowlist of link types.
3. The `roadmapLinkTypes` allowlist is the correct semantics: the _relationship_ between
   a delivery issue and a roadmap item ("is connected to", "is child of") is what
   determines whether the link represents a commitment, not the issue key prefix.

### Alternative B — Add a boolean flag `isRoadmapItem` to `JiraIssue`

Mark issues as roadmap items during sync by checking whether their key appears in
`jpd_ideas`. Coverage classification would then check `jira_issue_links` for links to
issues where `isRoadmapItem = true`.

**Ruled out.** This denormalises data that is already authoritative in `jpd_ideas`.
It also requires updating `JiraIssue` during every `syncRoadmaps` run (after JPD ideas
are upserted), creating a cross-module write dependency. The in-memory intersection of
`jira_issue_links.targetIssueKey ∈ jpd_ideas.key` achieves the same result without
schema cost.

### Alternative C — Fetch issue links live from Jira at query time (no DB persistence)

At coverage calculation time, for each sprint issue, call
`GET /rest/api/3/issue/{key}?fields=issuelinks` to retrieve its current links from
Jira.

**Ruled out.** This violates the architectural principle that all Jira HTTP calls go
through `JiraClient` and that metric services must not call Jira directly. It also
introduces N+1 Jira API calls per sprint (one per issue), with rate-limit exposure on
every roadmap accuracy request. The `jira_issue_links` table exists precisely to avoid
this.

### Alternative D — Store a `roadmapIdeaKey` denormalised column directly on `JiraIssue`

During `persistIssueLinks`, detect roadmap links and write `jiraIssue.roadmapIdeaKey`
directly if the target is a known JPD idea key.

**Ruled out.** This requires `persistIssueLinks` to have access to the full `jpd_ideas`
table during every issue sync, coupling the issue sync path to roadmap state. It also
means `roadmapIdeaKey` can become stale if a `JpdIdea` is added or removed between
issue syncs. The proposed approach (query at coverage-calculation time) is strictly
more accurate and avoids schema coupling.

### Alternative E — Use `RoadmapConfig.jpdKey` as the "roadmap project keys" list without a new `BoardConfig` field

Determine roadmap items implicitly — any issue whose key prefix matches a `jpdKey` in
`RoadmapConfig` is a roadmap item. No new `BoardConfig` field needed.

**Ruled out for the same reasons as Alternative A.** Additionally, `RoadmapConfig` is
a global list, not per-board. Different boards may have different link-type conventions,
so per-board `roadmapLinkTypes` in `BoardConfig` is the correct granularity.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | New `roadmapLinkTypes text NOT NULL DEFAULT '[]'` column on `board_configs`. Reversible. No new tables. |
| `JiraIssueLink` entity | None | Already exists and is populated. No schema change. |
| `JpdIdea` entity | None | No schema change. Used as read-only source of truth for roadmap item identity. |
| `BoardConfig` entity | Additive | New `roadmapLinkTypes: string[]` field. Existing rows default to `[]` (feature disabled). |
| `RoadmapService` | New injection + helper call | Inject `JiraIssueLink` repo; call `buildDirectLinkIdeaMap` from `calculateSprintAccuracy`. |
| `SprintDetailService` | New helper call only | `JiraIssueLink` repo already injected. Add `buildDirectLinkIdeaMap` call in `getDetail`. |
| `GapsService` | None | `noEpic` logic unchanged. An issue with a direct roadmap link but no epic still appears in the no-epic gaps list — correct by design. |
| API contract | Additive | `roadmapStatus` union type unchanged (`'in-scope' \| 'linked' \| 'none'`). `RoadmapSprintAccuracy` shape unchanged. New `roadmapLinkTypes` field in `GET /api/boards/:id/config` response. |
| Frontend | Settings UI addition | New tag-input for `roadmapLinkTypes` in the board settings form. No changes to roadmap page, sprint detail page, or `api.ts` coverage types. |
| Shared utility | New file | `backend/src/metrics/roadmap-link-utils.ts` — pure function, no DI, testable in isolation. |
| Sync | None | `persistIssueLinks` already stores all link types. No sync changes needed. |
| Tests | New unit tests | See Acceptance Criteria. |
| Jira API | No new calls | All data already cached in Postgres. |
| Kanban paths | None | `getKanbanAccuracy` and `getKanbanWeeklyAccuracy` are not changed by this proposal. |

---

## Open Questions

1. **Case sensitivity of `roadmapLinkTypes` matching.**

   Jira link type names may vary in capitalisation between instances (e.g. "Is Connected
   To" vs "is connected to"). The proposed implementation stores values as-entered and
   matches using `LOWER()` in Postgres and `.toLowerCase()` in the in-memory filter.
   The Settings UI should document that values are matched case-insensitively, so
   operators can enter either form.

2. **Should `roadmapLinkTypes` be per-board or global (in `JiraFieldConfig`)?**

   The proposed design makes it per-board (`BoardConfig`), consistent with all other
   coverage and classification rules. If the operator always uses the same link type
   name across all boards (e.g. "is connected to"), per-board configuration is slightly
   redundant. However, the consistency with the existing `BoardConfig` pattern outweighs
   the minor inconvenience of configuring it per board. A global default could be added
   later without a breaking change.

   **Recommended resolution:** Keep per-board. If a future need for a global default
   emerges, add a `roadmapLinkTypes` field to `JiraFieldConfig` as a fallback, applied
   when the board-level array is empty.

3. **Conflict resolution when an issue is linked to multiple roadmap items with different `targetDate` values.**

   The proposed rule is "keep the later targetDate" — identical to the existing
   `epicIdeaMap` conflict resolution. This is optimistic (the issue gets credit for the
   most lenient deadline). An alternative is "keep the earliest targetDate" (strictest
   commitment). Confirm the desired semantics before implementation.

   **Recommended resolution:** Consistent with current `epicIdeaMap` behaviour — keep
   the later `targetDate`. Document this choice in the service.

4. **What happens when an issue has BOTH an epic link (via `epicKey`) and a direct roadmap
   link (via `jira_issue_links`)?**

   The proposed logic uses `epicIdea ?? directIdea` — epic link wins on targetDate if
   both are present. This avoids double-counting and is predictable. Confirm this is
   the desired priority order.

---

## Acceptance Criteria

### Schema and migration

- [ ] A new migration adds `roadmapLinkTypes text NOT NULL DEFAULT '[]'` to `board_configs`
      with both `up()` and `down()` implemented.
- [ ] Existing `board_configs` rows receive the default value `'[]'` on migration;
      all existing coverage behaviour is unchanged.

### `buildDirectLinkIdeaMap` utility

- [ ] Returns an empty map when `roadmapLinkTypes` is `[]` without issuing any DB query.
- [ ] Returns an empty map when `issueKeys` is empty.
- [ ] For a given sprint issue key, maps it to the `targetDate` of the linked JPD idea
      when the link type name matches (case-insensitively) a value in `roadmapLinkTypes`
      AND the target issue key appears in `jpd_ideas`.
- [ ] Ignores links where the target issue key is NOT in `jpd_ideas`.
- [ ] Ignores links where the link type name does NOT match any value in `roadmapLinkTypes`.
- [ ] When an issue is linked to multiple roadmap items, the map entry uses the latest
      `targetDate` across all matching ideas.
- [ ] Issues a **single** bulk SQL query regardless of the number of issue keys
      (no N+1).

### `calculateSprintAccuracy` (`RoadmapService`)

- [ ] An issue with `epicKey = null` but a direct link to a JPD idea via a configured
      link type shows as `covered` (green) when the idea's `targetDate` is in the future
      and the sprint is active (Condition B satisfied).
- [ ] An issue with `epicKey = null` but a direct link to a JPD idea via a configured
      link type shows as `covered` (green) when `resolvedAt ≤ idea.targetDate`
      (Condition A satisfied).
- [ ] An issue with `epicKey = null` but a direct link to a JPD idea via a configured
      link type shows as `linkedNotCovered` (amber) when neither Condition A nor B is
      satisfied.
- [ ] An issue with `epicKey = null` and no qualifying direct link still shows as
      `uncovered` (not counted in `coveredIssues` or `linkedCount`).
- [ ] When `boardConfig.roadmapLinkTypes = []`, the `buildDirectLinkIdeaMap` query is
      not issued and behaviour is identical to the current implementation.
- [ ] An issue with both an epic link and a direct link uses the epic link's `targetDate`
      (epic link takes priority).

### `getDetail` (`SprintDetailService`)

- [ ] An issue with `epicKey = null` but a direct link to a known JPD idea via a
      configured link type shows `roadmapStatus = 'in-scope'` when eligible.
- [ ] An issue with `epicKey = null` but a direct link to a known JPD idea shows
      `roadmapStatus = 'linked'` when Conditions A and B both fail.
- [ ] An issue with `epicKey = null` and no qualifying direct link shows
      `roadmapStatus = 'none'`.
- [ ] `roadmapLinkedCount` in the sprint summary correctly counts issues with a direct
      roadmap link as `roadmapStatus !== 'none'`.

### `GapsService`

- [ ] An issue with `epicKey = null` that has a direct roadmap link still appears in
      `noEpic` — these are orthogonal concerns.
- [ ] No change to `noEpic` or `noEstimate` logic.

### `BoardConfig` API

- [ ] `GET /api/boards/:boardId/config` includes `roadmapLinkTypes: string[]` in the
      response.
- [ ] `PUT /api/boards/:boardId/config` accepts and persists `roadmapLinkTypes`.

### Frontend Settings UI

- [ ] The board settings form includes a configurable input for "Roadmap link types"
      (tag-input or comma-separated text field) that reads and writes
      `boardConfig.roadmapLinkTypes`.
- [ ] The input documents that values are matched case-insensitively.

### No regressions

- [ ] All existing tests for `roadmapStatus = 'in-scope'` (epic-linked, delivered on
      time) continue to pass.
- [ ] All existing tests for `roadmapStatus = 'linked'` (epic-linked, not delivered)
      continue to pass.
- [ ] All existing tests for `roadmapStatus = 'none'` (no epic) continue to pass when
      `roadmapLinkTypes` is `[]`.
- [ ] Kanban paths (`getKanbanAccuracy`, `getKanbanWeeklyAccuracy`) are unaffected.
- [ ] `GapsService.getGaps()` tests continue to pass with no modifications.
