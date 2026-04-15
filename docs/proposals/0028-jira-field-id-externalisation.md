# 0028 — Jira Field ID and Instance-Specific Value Externalisation

**Date:** 2026-04-15
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** None yet — will be created on acceptance

---

## Problem Statement

An audit of `backend/src/` reveals two categories of Jira-instance-specific values that are
currently hardcoded in TypeScript source files:

1. **Story-points custom field IDs** — four `customfield_XXXXX` IDs are hardcoded in
   `jira-client.service.ts` (the fields query string) and `sync.service.ts` (the extraction
   loop). Jira Cloud allocates these IDs per-tenant; they are not standardised. A tenant whose
   story-points field lives at `customfield_10106` (a common alternative) will silently receive
   `null` story points for every issue, corrupting planning-accuracy calculations.

2. **The `'Epic'` type name used to resolve `epicKey`** — `sync.service.ts` contains a
   `parent?.fields?.issuetype?.name === 'Epic'` guard. In some Jira instances this type is
   called `"Epic"` (en-US standard); in others it may differ (rare but possible). More
   critically, the legacy `customfield_10014` "Epic Link" fallback is already understood to be
   instance-specific and is included in the field request string on every API call regardless of
   whether the tenant uses it.

3. **The JPD delivery link type names** — `sync.service.ts` matches Polaris link types with
   `inward.includes('is implemented by')` etc. These strings are the Atlassian defaults for JPD
   delivery links, but some organisations rename these link types, making the delivery-issue
   association silently fail.

The first category is the only one where a wrong value produces silent data corruption at sync
time (points become null). Categories 2 and 3 affect a minority of tenants and are lower
severity. Without externalisation, any tenant not matching the hardcoded IDs must patch source
code to get correct data.

---

## Findings: Complete Audit

### Category A — Genuinely Instance-Specific (Vary Between Jira Cloud Tenants)

These are values that Atlassian does **not** standardise across all cloud tenants.

| # | Value | File | Lines | Severity |
|---|---|---|---|---|
| A1 | `customfield_10016`, `customfield_10026`, `customfield_10028`, `customfield_11031` (story points field IDs) | `jira/jira-client.service.ts` | 83, 112 | **High** — silent null story points |
| A1 | same four field IDs in extraction loop | `sync/sync.service.ts` | 299–302 | **High** — same |
| A2 | `customfield_10014` (legacy Epic Link field ID) | `jira/jira-client.service.ts` | 83, 112 | Medium — fallback; only triggers on classic projects without modern parent link |
| A2 | `customfield_10014` in extraction logic | `sync/sync.service.ts` | 320–321 | Medium — same |
| A3 | `'is implemented by'`, `'is delivered by'`, `'implements'`, `'delivers'` (JPD delivery link type names) | `sync/sync.service.ts` | 485–488 | Medium — silent loss of idea→Epic linkage for non-default tenants |

### Category B — Standard Jira Field Names That Are the Same Everywhere

These are **not** instance-specific; they are part of the Jira REST API specification and are
identical across all Jira Cloud instances.

| Value | Usage | Notes |
|---|---|---|
| `'status'` changelog field | DB queries in all metric/planning/roadmap services | This is the Jira API field name — always `"status"` |
| `'Sprint'` changelog field | 5 services: `planning.service.ts:173`, `roadmap.service.ts:164`, `gaps.service.ts:295`, `sprint-detail.service.ts:269`, `quarter-detail.service.ts:202` | Jira Cloud always uses `"Sprint"` as the changelog field name for sprint transitions |
| `'To Do'` as `fromValue` in changelog queries | `planning.service.ts:546,730`, `roadmap.service.ts:343,695`, `week-detail.service.ts:201`, `quarter-detail.service.ts:196` | ⚠️ **Partially instance-specific** — see note below |

> **Note on `'To Do'`:** The _backlog status name_ is **not standardised**. Most Jira Cloud
> projects use `"To Do"` as the default backlog/initial status, but teams frequently rename it
> (e.g. `"Open"`, `"New"`, `"Backlog"`, `"Ready for Development"`). This means the six
> occurrences of `fromValue = 'To Do'` in the Kanban board-entry-date logic are
> _functionally_ instance-specific even though the design assumes they are standard. However,
> the existing `backlogStatusIds` mechanism in `BoardConfig` was introduced precisely to handle
> this edge case: when `backlogStatusIds` is populated, the `'To Do'` queries become irrelevant
> because the board-entry date is derived from the status changelog at the `backlogStatusIds`
> boundary instead. The `'To Do'` fallback is therefore only a problem for tenants who have
> not configured `backlogStatusIds` **and** use a non-standard backlog status name.

### Category C — Configurable Defaults Already Wired Through BoardConfig

These appear as hardcoded strings but are correctly fronted by the existing `BoardConfig` entity
and `boards.yaml` YAML config. They are **already externalised**; no action required.

| Value | Entity column | Default |
|---|---|---|
| `"Done"`, `"Closed"`, `"Released"` | `doneStatusNames` | ✅ configurable |
| `"In Progress"` + long fallback list | `inProgressStatusNames` | ✅ configurable |
| `"Cancelled"`, `"Won't Do"` | `cancelledStatusNames` | ✅ configurable |
| `"Bug"`, `"Incident"` | `failureIssueTypes`, `incidentIssueTypes` | ✅ configurable |
| `"regression"`, `"incident"`, `"hotfix"` | `failureLabels` | ✅ configurable |
| `"is caused by"`, `"caused by"` | `failureLinkTypes` | ✅ configurable |
| `"Done"`, `"Resolved"` | `recoveryStatusNames` | ✅ configurable |
| `"Critical"` | `incidentPriorities` | ✅ configurable |

### Category D — Structurally Hardcoded But Deliberately So

| Value | File | Rationale |
|---|---|---|
| `'Epic'` in `parent.fields.issuetype.name === 'Epic'` | `sync/sync.service.ts:318` | This is the Jira REST API canonical name for the Epic type on Jira Cloud. It cannot be renamed in Jira Cloud (unlike Server/DC). Acceptable to leave hardcoded. |
| `['Epic', 'Sub-task']` in `issue-type-filters.ts` | `metrics/issue-type-filters.ts:2` | Same rationale — these are the Jira Cloud canonical type names for non-work-item types. |

---

## Proposed Solution

### Decision: Extend `boards.yaml`, do not introduce a new config file.

The story-points field IDs (A1) and the JPD delivery link type names (A3) require
different configuration scopes:

- **Story-points field IDs** are _global_ — the same fields are used for every board in a
  tenant. They belong in a tenant-level config.
- **JPD delivery link type names** are also _global_ — a single Jira instance has one link
  type schema.
- **`customfield_10014` Epic Link field ID** is _global_ — classic projects either use it or
  they don't, tenant-wide.

A new top-level `jira:` stanza in `boards.yaml` is the correct location. This avoids a third
config file, keeps the operator's config surface in one place, and follows the precedent set by
Proposal 0023. The `roadmap.yaml` file is JPD-specific and is the wrong home for instance-wide
Jira field settings.

### Schema Change to `boards.yaml`

A new optional top-level key `jira:` is added alongside the existing `boards:` list:

```yaml
jira:
  # Story-points custom field IDs to probe, in priority order.
  # The first field that returns a numeric value wins.
  # Add your tenant's actual field ID(s) here; remove those that don't apply.
  storyPointsFieldIds:
    - story_points          # legacy Jira Server / some older cloud projects
    - customfield_10016     # "Story point estimate" — classic projects
    - customfield_10026     # "Story Points" — classic projects (older)
    - customfield_10028     # "Story Points" — some cloud instances
    - customfield_11031     # "Story point estimate" — team-managed (next-gen)

  # Custom field ID for the legacy Epic Link field (pre-parent-link era).
  # Only needed for classic Jira projects that predate the modern "parent" link.
  # Set to null to disable the fallback entirely.
  epicLinkFieldId: customfield_10014

  # Link type names used by Jira Product Discovery to associate ideas with
  # delivery Epics. Matched case-insensitively as substrings.
  jpdDeliveryLinkInward:
    - "is implemented by"
    - "is delivered by"
  jpdDeliveryLinkOutward:
    - "implements"
    - "delivers"
```

### Data Flow

```
boards.yaml (jira: stanza)
        │
        ▼
YamlConfigService.applyBoardsYaml()
        │  reads jira.* keys and writes to new JiraFieldConfig entity
        ▼
JiraFieldConfig (Postgres table: jira_field_config, singleton row)
        │
        ├──▶ JiraClientService.getSprintIssues() / searchIssues()
        │         builds fields= query param from storyPointsFieldIds
        │
        └──▶ SyncService.mapJiraIssue()
                  reads storyPointsFieldIds for extraction loop
                  reads epicLinkFieldId for legacy fallback
                  reads jpdDeliveryLinkInward / jpdDeliveryLinkOutward
```

### New Entity: `JiraFieldConfig`

A singleton entity (single row, PK=1, upserted on YAML load) storing the tenant-wide
field configuration. Singleton is appropriate because these values are global to the Jira
instance, not per-board.

```typescript
// database/entities/jira-field-config.entity.ts
@Entity('jira_field_config')
export class JiraFieldConfig {
  @PrimaryColumn()
  id!: number; // Always 1 — singleton

  @Column({ type: 'simple-json', default: '["story_points","customfield_10016","customfield_10026","customfield_10028","customfield_11031"]' })
  storyPointsFieldIds!: string[];

  @Column({ type: 'varchar', nullable: true, default: 'customfield_10014' })
  epicLinkFieldId!: string | null;

  @Column({ type: 'simple-json', default: '["is implemented by","is delivered by"]' })
  jpdDeliveryLinkInward!: string[];

  @Column({ type: 'simple-json', default: '["implements","delivers"]' })
  jpdDeliveryLinkOutward!: string[];
}
```

### Affected Modules / Files

| File | Change |
|---|---|
| `database/entities/jira-field-config.entity.ts` | **New** — singleton entity |
| `database/entities/index.ts` | Export new entity |
| `app.module.ts` | Add `JiraFieldConfig` to TypeORM entities array |
| `migrations/NNNN-AddJiraFieldConfig.ts` | **New** — creates `jira_field_config` table (reversible) |
| `yaml-config/schemas/boards-yaml.schema.ts` | Add optional `jira:` stanza to `BoardsYamlFileSchema` |
| `yaml-config/yaml-config.service.ts` | Read `jira:` stanza; upsert `JiraFieldConfig` singleton |
| `jira/jira-client.service.ts` | Accept `storyPointsFieldIds` param (or inject `JiraFieldConfig`); build `fields=` query dynamically |
| `sync/sync.service.ts` | Load `JiraFieldConfig` once at sync start; pass to `mapJiraIssue()` and `syncJpdProject()` |
| `config/boards.example.yaml` | Document `jira:` stanza with inline comments |

### Handling the `'To Do'` Backlog Status Name (A2 partial)

The six hardcoded `fromValue = 'To Do'` queries in the Kanban board-entry logic should **not**
be addressed in this proposal. The correct fix is a documentation improvement: the
`boards.example.yaml` `backlogStatusIds` comment should be clarified to explain that operators
with non-`'To Do'` backlog status names **must** populate `backlogStatusIds`; the `'To Do'`
heuristic is only a reasonable default for standard configurations. This is a documentation
change, not a code change, and does not warrant a migration.

Rationale: making `backlogStatusName` configurable per-board would require passing it through
every Kanban board-entry query in four separate services. The existing two-tier mechanism
(primary: `backlogStatusIds`; fallback: `'To Do'` changelog heuristic) already gives operators
the right lever. The gap is awareness, not capability.

---

## Alternatives Considered

### Alternative A — New `config/jira.yaml` file

A third YAML file dedicated to Jira field configuration, read by a new `JiraYamlConfigService`.

**Ruled out** because it adds a third config file path operators must manage, and a new
`JiraYamlConfigService` module that duplicates the YAML loading/validation pattern already
established in `yaml-config.service.ts`. The Jira field settings are intimately related to the
board sync configuration — they belong together.

### Alternative B — Environment variables (e.g. `STORY_POINTS_FIELD_IDS=customfield_10016,customfield_10106`)

Simple comma-separated env vars set in `.env` or the App Runner runtime environment.

**Ruled out** because:
- Multi-value fields (the list of story points field IDs to try) are awkward in env vars.
- The existing `boards.yaml` mechanism is already the established pattern for this type of
  "deployment-time configuration that varies by tenant but not by release."
- Environment variables are baked into the App Runner service definition (Terraform), making
  them harder to update than a config file baked into the Docker image.

### Alternative C — Store field IDs directly on `BoardConfig` (per-board)

Each board row gets `storyPointsFieldIds`, `epicLinkFieldId`, etc.

**Ruled out** because these are _tenant-wide_ Jira instance settings, not per-board settings.
Repeating the same field ID on every board row is redundant and creates update sprawl when a
tenant needs to change one field ID.

### Alternative D — Probe Jira Fields API at sync time

Call `GET /rest/api/3/field` to discover which custom field corresponds to story points by
matching the field name string.

**Ruled out** because: (a) field _names_ are also instance-specific (operators can rename them);
(b) it adds a Jira API call on every sync; (c) it introduces coupling between the sync path and
the Fields API; (d) the explicit config approach is simpler to reason about and debug.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | Migration required | New `jira_field_config` table — singleton row |
| API contract | Additive only | New `GET /config/jira-fields` endpoint optional but recommended for Settings UI |
| Frontend | None | No frontend change required; the Settings page could surface these in a future proposal |
| Tests | New unit tests | `yaml-config.service.spec.ts` needs `jira:` stanza tests; `sync.service.spec.ts` needs updated field ID list |
| Jira API | No new endpoints | `fields=` query string content changes dynamically; no new Jira API calls |
| boards.yaml | Additive | New optional `jira:` stanza; no change to existing `boards:` structure |

---

## Open Questions

1. **Default field ID list** — should the default `storyPointsFieldIds` in the entity still
   include all four known variants (so new deployments work out of the box without any
   `boards.yaml` `jira:` stanza), or should the default be empty (forcing operators to
   explicitly configure)? Recommendation: keep the four known defaults so the current behaviour
   is preserved for all existing deployments.

2. **JiraClientService injection pattern** — `JiraClientService` currently has no dependency
   on the database. Injecting `JiraFieldConfig` from Postgres requires either (a) making
   `JiraClientService` depend on TypeORM, or (b) having `SyncService` pass the field IDs as a
   parameter to `getSprintIssues()` / `searchIssues()`. Option (b) is cleaner — it avoids adding
   a DB dependency to the HTTP client layer. Recommendation: **option (b)** — add an optional
   `extraFields: string[]` parameter to `getSprintIssues()` and `searchIssues()`, and have
   `SyncService` pass the configured IDs.

3. **`epicLinkFieldId` vs `customfield_10014`** — for tenants that have migrated all their
   classic projects to next-gen, should operators be able to set `epicLinkFieldId: null` to
   skip requesting and parsing `customfield_10014` entirely, thereby reducing the fields query
   length? Recommendation: yes — `null` should be a valid value and should suppress both the
   `fields=` entry and the extraction fallback.

---

## Acceptance Criteria

- [ ] `JiraFieldConfig` entity exists with a reversible migration; `id = 1` is seeded on first
      application boot if the row does not exist.
- [ ] `boards.yaml` (and `boards.example.yaml`) accepts an optional top-level `jira:` stanza
      validated by Zod; omitting the stanza leaves existing DB values untouched.
- [ ] `YamlConfigService` reads the `jira:` stanza and upserts the `JiraFieldConfig` singleton
      row on boot.
- [ ] `JiraClientService.getSprintIssues()` and `searchIssues()` build the `fields=` query
      parameter from the configured `storyPointsFieldIds` (injected by `SyncService`), not from
      a hardcoded string literal.
- [ ] `SyncService.mapJiraIssue()` iterates over the configured `storyPointsFieldIds` list.
- [ ] `SyncService.mapJiraIssue()` uses the configured `epicLinkFieldId` (or skips the fallback
      if null) rather than the literal `'customfield_10014'`.
- [ ] `SyncService.syncJpdProject()` matches delivery link types using the configured
      `jpdDeliveryLinkInward` / `jpdDeliveryLinkOutward` lists.
- [ ] A deployment with no `jira:` stanza in `boards.yaml` behaves identically to the current
      behaviour (defaults preserved).
- [ ] `boards.example.yaml` contains a fully documented `jira:` stanza.
- [ ] All existing unit tests pass; new unit tests cover: (a) custom field ID extraction with
      a non-default field ID; (b) `null` `epicLinkFieldId` disables the legacy fallback;
      (c) custom JPD link type names; (d) missing `jira:` stanza leaves DB row unchanged.
