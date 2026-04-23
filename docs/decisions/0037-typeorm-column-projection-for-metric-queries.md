# 0037 — TypeORM Column Projection as Standard Pattern for Metric Service Queries

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

Metric services (`LeadTimeService`, `CfrService`, `MttrService`, `TrendDataLoader`)
query `JiraIssue` rows using `repository.find({ where: { boardId } })` without a
`select` clause, causing TypeORM to load all columns including `summary`, `description`,
and other large text fields that are not consumed by any metric calculation. For boards
with hundreds or thousands of issues (e.g. PLAT with 1000+ Kanban issues), the
unneeded columns represent a significant fraction of total heap usage per query.

This was a contributing factor to the OOM kills described in ADR-0032. The fix is to
apply a `select` projection on every `find()` call in a metric service, restricting
the returned columns to those actually used by the calculation.

A second related pattern was introduced in `LeadTimeService`: instead of loading all
board issues into memory and then filtering in-process, the service now queries the
changelog first to find issue keys that actually completed within the measurement period,
then loads only those candidate issues. This is a query-first filtering strategy.

---

## Options Considered

### Option A — Load all columns, filter in memory (original pattern)

- `issueRepo.find({ where: { boardId } })` loads all columns for all board issues.
- **Pros:** Simple; no need to audit which columns each service needs.
- **Cons:** Loads large text fields (`summary`, `description`) that metric calculations
  never read; 2–3× more data transferred from PostgreSQL to Node.js than necessary;
  proportionally more heap used per board for the same computation. Ruled out.

### Option B — Column projection via TypeORM `select` (selected)

- Each `find()` call in a metric service specifies only the columns it consumes:
  - `CfrService`: `['key', 'issueType', 'fixVersion', 'labels']`
  - `MttrService`: `['key', 'issueType', 'labels', 'priority', 'createdAt']`
  - `TrendDataLoader`: `['key', 'issueType', 'fixVersion', 'labels', 'priority', 'createdAt']`
  - `IssueLinkRepository` queries: `['sourceIssueKey', 'linkTypeName']`
- `LeadTimeService` also applies a **changelog-first candidate filter**: it queries the
  changelog for issue keys that transitioned to a done status in the target period, then
  fetches only those keys' issue rows. This avoids loading all board issues when only a
  small fraction completed in the period.
- **Pros:** Reduces per-row memory by ~80% (omitting `summary` and `description`);
  reduces PostgreSQL wire-protocol transfer; candidate-key filtering in `LeadTimeService`
  further limits result set size for large Kanban boards.
- **Cons:** Every `find()` call in a metric service must be reviewed and updated when the
  service gains new fields; forgetting to add a column to the `select` list causes a
  runtime `undefined` value rather than a compile-time error (TypeORM does not enforce
  exhaustiveness on `select` at compile time).

### Option C — Database views or materialised aggregates

- Pre-aggregate metrics in the database and query aggregates rather than raw rows.
- **Pros:** Dramatically reduces data transfer; pushes computation to PostgreSQL.
- **Cons:** Requires a significant schema refactoring and migration; metric logic would
  be split between TypeScript services and SQL views, violating the principle that
  calculation logic lives in services (CLAUDE.md). Ruled out for this iteration.

---

## Decision

> All `repository.find()` calls in metric services (`LeadTimeService`, `CfrService`,
> `MttrService`, `TrendDataLoader`) must specify a `select` array containing only the
> columns consumed by that service's calculation. `LeadTimeService` additionally applies
> a changelog-first candidate-key filter to avoid loading historical issues that did not
> complete in the measurement period.

This becomes a standing convention: any new metric service or query added to an existing
metric service must include a column projection. A `find()` call without `select` in a
metric service is a code-review defect.

---

## Rationale

Column projection is the simplest available mechanism for reducing Node.js heap pressure
from metric queries. It requires no schema changes and is transparent to the calculation
logic (services only read the projected columns anyway). The ~80% reduction in per-row
memory (by omitting `summary` and `description`) is significant at 1000+ rows and
directly addresses the OOM-kill root cause identified in ADR-0032.

The changelog-first candidate filter in `LeadTimeService` is complementary: it reduces
the number of rows fetched, while column projection reduces the size of each row. Both
are needed for large Kanban boards where the full issue set is large but the period
filter is narrow.

---

## Consequences

### Positive

- Per-query heap usage is reduced by approximately 80% for boards with many issues.
- The pattern is explicit and auditable: each service's `select` list documents exactly
  which columns it depends on.
- `TrendDataLoader` benefits for every metric that uses it (trend charts, quarter views)
  without per-metric changes.

### Negative / Trade-offs

- Adding a new field to a metric calculation requires updating the `select` list;
  TypeORM will not raise a compile error if a column is missing from `select` —
  it simply returns `undefined` for that field. Unit tests that exercise the full
  calculation path will catch this, but only if they use real repository responses
  rather than mocked entities with all fields pre-populated.
- The `select` list in `MttrService` has a conditional: when `incidentLabels` is
  configured, all board issues must be loaded (to catch label-matched incidents);
  only when no label config is present can the query be scoped to `incidentIssueTypes`.
  This conditional query logic must be maintained carefully as config options evolve.

### Risks

- If a future metric service author omits the `select` clause, the service will
  silently load all columns. Code review must enforce the convention. Consider adding
  a lint rule or a shared query builder helper that requires explicit column selection
  for `JiraIssue` queries in metric services.

---

## Related Decisions

- [ADR-0032](0032-nodejs-heap-cap-and-apprunner-instance-sizing.md) — Instance sizing
  and heap cap that this optimisation complements
- [ADR-0002](0002-cache-jira-data-in-postgres.md) — The caching strategy that means
  all metric calculations query PostgreSQL directly, making query efficiency important
