# 0022 — No DB Dependency in `JiraClientService`; Field IDs Passed as Parameters

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0028 — Jira Field ID and Instance-Specific Value Externalisation](../proposals/0028-jira-field-id-externalisation.md)

## Context

Proposal 0028 requires `JiraClientService` to build its `fields=` query parameter
dynamically from the configured `storyPointsFieldIds` list rather than using a hardcoded
string literal. This raised the question of how `JiraClientService` obtains the list.

Two approaches were evaluated: (a) inject the `JiraFieldConfig` TypeORM repository directly
into `JiraClientService` so it can load the list itself, or (b) have `SyncService` load the
`JiraFieldConfig` entity once and pass the relevant field IDs as parameters when calling
`JiraClientService.getSprintIssues()` / `searchIssues()`.

`JiraClientService` currently has no database dependency — it is a pure HTTP client wrapper
around the Jira REST API. The choice of injection pattern determines whether that property
is preserved.

---

## Options Considered

### Option A — Pass field IDs as `extraFields: string[]` parameters from `SyncService` (selected)

- **Summary:** `SyncService` loads `JiraFieldConfig` once at the start of each sync
  operation and passes `storyPointsFieldIds` (and `epicLinkFieldId` where needed) as
  explicit parameters to the relevant `JiraClientService` methods.
- **Pros:**
  - `JiraClientService` remains a stateless HTTP client with no database dependency.
    It can be instantiated and unit-tested in isolation without a database or TypeORM setup.
  - The data-access concern (loading config from Postgres) stays in `SyncService`, which is
    already the orchestration layer responsible for reading config entities.
  - The method signature clearly communicates what field IDs are being requested — callers
    can inspect or override the list without needing to understand how it was loaded.
  - No change to the `JiraModule` dependency graph.
- **Cons:**
  - Every call site in `SyncService` must pass the extra parameter. Minor verbosity increase.

### Option B — Inject `TypeOrmModule.forFeature([JiraFieldConfig])` into `JiraModule`

- **Summary:** `JiraClientService` receives the `JiraFieldConfig` repository in its
  constructor and loads the singleton row internally before building the `fields=` parameter.
- **Pros:**
  - `JiraClientService` is self-contained — callers need not know about field IDs.
- **Cons:**
  - Adds a database dependency to what is intentionally a thin HTTP client layer. Unit tests
    for `JiraClientService` now require a mock repository in addition to a mock `HttpService`.
  - DB access in the HTTP client layer violates the layered architecture: `JiraModule` is
    infrastructure (external API), not orchestration.
  - Creates a circular concern: the client that fetches Jira data now also fetches config
    about how to fetch that data from a different storage layer.
  - Future changes to `JiraFieldConfig` (adding fields, changing the entity) would require
    touching `JiraModule` in addition to `SyncModule` and `YamlConfigModule`.

---

## Decision

> `JiraClientService` retains zero database dependencies. The `JiraFieldConfig` singleton
> entity is loaded by `SyncService` once per sync operation. Configured field IDs are passed
> to `JiraClientService.getSprintIssues()` and `searchIssues()` via an `extraFields: string[]`
> parameter. The HTTP client layer remains stateless and independently testable.

---

## Rationale

Database access belongs in the orchestration layer (`SyncService`), not in the HTTP client
layer (`JiraClientService`). Keeping the client stateless preserves testability (no mock
repository needed) and maintains a clean separation between infrastructure concerns (Jira
API calls) and application concerns (config loading, data mapping). The verbosity cost of
passing an extra parameter is negligible compared to the clarity and testability benefit.

---

## Consequences

### Positive

- `JiraClientService` unit tests require only a mock `HttpService`; no TypeORM setup.
- The `JiraModule` dependency graph does not grow.
- The orchestration-layer responsibility for loading all config before a sync operation is
  explicit and concentrated in `SyncService`.

### Negative / Trade-offs

- Any new caller of `JiraClientService` that needs dynamic field IDs must also load
  `JiraFieldConfig` from the repository before calling the method. This is currently only
  `SyncService`, making the trade-off acceptable.

### Risks

- If a second caller of `JiraClientService` is introduced that also needs field IDs, the
  pattern of "load config before calling the client" must be repeated. A helper utility or
  a thin `SyncContextService` could consolidate this in future if the pattern spreads.

---

## Related Decisions

- [ADR-0021](0021-jira-field-ids-externalised-to-yaml-config.md) — The parent decision
  that introduced `JiraFieldConfig` and the need for dynamic field ID passing
- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Postgres is the config store; this
  decision clarifies which layer is responsible for reading from it in the sync path
