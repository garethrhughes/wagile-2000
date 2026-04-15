# 0021 — Jira Instance-Specific Field IDs Externalised to YAML Config and Singleton DB Entity

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0028 — Jira Field ID and Instance-Specific Value Externalisation](../proposals/0028-jira-field-id-externalisation.md)

## Context

An audit of the backend source revealed three categories of Jira-instance-specific values
hardcoded in TypeScript:

1. **Story-points custom field IDs** — four `customfield_XXXXX` IDs were hardcoded in
   `jira-client.service.ts` and `sync.service.ts`. Jira Cloud allocates these IDs per tenant;
   they are not standardised. A tenant whose story-points field lives at a different ID silently
   receives `null` story points for every issue, corrupting planning-accuracy calculations.
2. **Legacy Epic Link field ID** — `customfield_10014` was requested and parsed on every sync
   regardless of whether the tenant's classic projects use it.
3. **JPD delivery link type names** — `sync.service.ts` matched Polaris link types using
   hardcoded substring strings (`'is implemented by'`, `'implements'`, etc.). Organisations that
   rename these link types would silently lose idea→Epic delivery linkage.

Without externalisation, any tenant not matching the hardcoded values must patch source code to
obtain correct data. The `boards.yaml` config file is already the established mechanism for
deployment-time, tenant-specific configuration in this project (see Proposal 0023).

---

## Options Considered

### Option A — Extend `boards.yaml` with a `jira:` stanza; persist to a singleton DB entity (selected)

- **Summary:** A new optional top-level `jira:` key in `boards.yaml` is read by
  `YamlConfigService` on boot and upserted into a new `JiraFieldConfig` singleton entity
  (table `jira_field_config`, PK=1). `SyncService` loads the entity once at sync start and
  passes field IDs to `JiraClientService` via parameters.
- **Pros:**
  - Keeps all operator config surface in one file alongside the existing `boards:` stanza.
  - Singleton entity pattern mirrors `BoardConfig` and is already established in the project.
  - Sensible defaults mean existing deployments with no `jira:` stanza work unchanged.
  - Field IDs are queryable at runtime (e.g. for a future Settings UI).
- **Cons:**
  - Requires a new DB migration (`jira_field_config` table).
  - Adds one more entity to the TypeORM entities array.

### Option B — New `config/jira.yaml` file

- **Summary:** A dedicated third YAML file, read by a new `JiraYamlConfigService`.
- **Pros:** Clean separation of concerns per config domain.
- **Cons:** Adds a third config file path for operators to manage, and duplicates the YAML
  loading/validation pattern already in `yaml-config.service.ts`. Ruled out.

### Option C — Environment variables

- **Summary:** Comma-separated env vars (e.g. `STORY_POINTS_FIELD_IDS=customfield_10016,...`).
- **Pros:** Simple to set in Docker / App Runner without a file.
- **Cons:** Multi-value fields are awkward in env vars; the `boards.yaml` pattern is already
  established for this class of config; env vars baked into App Runner Terraform are harder
  to update than a config file. Ruled out.

### Option D — Per-board columns on `BoardConfig`

- **Summary:** Each board row stores its own `storyPointsFieldIds`, `epicLinkFieldId`, etc.
- **Pros:** Configurable per board.
- **Cons:** These are tenant-wide Jira instance settings, not per-board. Repeating the same
  field ID on every board row creates update sprawl. Ruled out.

### Option E — Probe Jira Fields API at sync time

- **Summary:** Call `GET /rest/api/3/field` to discover the story-points field by name.
- **Pros:** Zero operator configuration.
- **Cons:** Field names are also instance-specific (operators can rename them); adds a Jira
  API call on every sync; couples the sync path to the Fields API. Ruled out.

---

## Decision

> Jira instance-specific field IDs (`storyPointsFieldIds`, `epicLinkFieldId`) and JPD delivery
> link type names (`jpdDeliveryLinkInward`, `jpdDeliveryLinkOutward`) are externalised from
> TypeScript source into an optional `jira:` stanza in `boards.yaml`. The stanza is read by
> `YamlConfigService` on boot and upserted into a singleton `JiraFieldConfig` entity
> (table `jira_field_config`, PK=1). `SyncService` passes the loaded field IDs to
> `JiraClientService` as `extraFields: string[]` parameters rather than injecting the DB
> repository directly into the HTTP client layer.

---

## Rationale

Centralising tenant-specific values in `boards.yaml` follows the precedent established by the
board configuration pattern (Proposal 0023). Sensible defaults in the entity columns preserve
existing behaviour for all current deployments — operators only need to act if their tenant
uses non-standard field IDs. Passing field IDs as parameters rather than injecting the
repository into `JiraClientService` keeps the HTTP client layer stateless and independently
testable (see ADR-0022 for that specific decision).

---

## Consequences

### Positive

- Any Jira Cloud tenant can configure their correct story-points field IDs without patching
  source code, eliminating silent `null` story-points corruption.
- Organisations with renamed JPD delivery link types regain correct idea→Epic linkage.
- Setting `epicLinkFieldId: null` suppresses the legacy fallback entirely for tenants that
  have migrated all projects to next-gen parent links.
- Defaults are unchanged for all existing deployments; no operator action is required unless
  current field IDs differ from the defaults.

### Negative / Trade-offs

- A new DB migration is required (`jira_field_config` table). Existing deployments must run
  the migration on upgrade.
- The `jira:` stanza in `boards.yaml` (and `boards.example.yaml`) adds surface area for
  operators to learn and maintain.

### Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Operator omits `jira:` stanza entirely | High | Low | Column defaults preserve the four known story-points field IDs; behaviour is unchanged. |
| Operator sets incorrect field ID | Low | High | Story points silently become null. Mitigation: `boards.example.yaml` documents the most common field IDs with comments. |
| Migration runs on a deployment with existing data | Low | Low | Migration is additive (new table); no existing rows or columns are modified. |

---

## Related Decisions

- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Jira data is cached in Postgres; field
  config follows the same singleton-entity persistence pattern
- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — Per-board config via
  `BoardConfig`; this decision consciously uses a global singleton because field IDs are
  tenant-wide, not per-board
- [ADR-0022](0022-no-db-dependency-in-jira-client-service.md) — The companion decision
  specifying how field IDs are passed to `JiraClientService` without a DB injection
