# 0014 — Sprint Detail View: New SprintModule with Per-Issue Annotation Endpoint

**Date:** 2026-04-10
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0002 — Sprint Detail View](../proposals/0002-sprint-detail-view.md)

## Context

The existing Planning, DORA, and Roadmap dashboards surface aggregate sprint-level
metrics but provide no drill-through to the individual tickets driving those numbers.
Teams using the dashboard for retrospectives must leave the tool and manually
cross-reference Jira, defeating its purpose.

All the data required to produce per-issue annotations — sprint membership (from
changelog replay), roadmap linkage (from `JpdIdea.deliveryIssueKeys`), incident and
failure classification (from `BoardConfig`), lead time (from status changelogs) — is
already cached in Postgres. The missing piece is a service that assembles these
annotations per-issue for a single sprint and a UI page to display them.

## Options Considered

### Option A — New `SprintModule` with `SprintDetailService` and dedicated endpoint

- **Summary:** Create `backend/src/sprint/` as a new, narrow module with a single
  `GET /api/sprints/:boardId/:sprintId/detail` endpoint. The service reuses the
  changelog-replay algorithm from `PlanningService` and the JPD coverage logic from
  `RoadmapService` without introducing any cross-module dependency.
- **Pros:** Clean module boundary; no circular imports; calculation logic stays in a
  service; single typed endpoint replaces multiple round-trips; fully consistent with
  existing patterns
- **Cons:** Small amount of logic duplication (`sprintValueContains`, `wasInSprintAtDate`,
  `percentile`) that could eventually be extracted to a shared utility module

### Option B — Add the endpoint to `PlanningModule`

- **Summary:** Add `GET /api/sprints/:boardId/:sprintId/detail` to the existing
  `PlanningController` / `PlanningService`
- **Pros:** No new module required
- **Cons:** `PlanningService` would need to import `JpdIdea` and `RoadmapConfig`
  repositories to compute `roadmapLinked`, coupling planning concerns to roadmap
  concerns. Violates single-responsibility.

### Option C — Add the endpoint to `RoadmapModule`

- **Summary:** Add the endpoint to the existing `RoadmapController` / `RoadmapService`
- **Pros:** No new module required; `RoadmapModule` already has `JpdIdea`
- **Cons:** `RoadmapService` would need to import sprint-membership reconstruction
  logic, coupling roadmap concerns to planning concerns. Equally bad as Option B in
  the opposite direction.

### Option D — Client-side annotation computation

- **Summary:** Fetch raw data from existing endpoints; compute annotations in the
  browser
- **Pros:** No backend changes
- **Cons:** Duplicates all calculation logic in TypeScript on the client; requires
  multiple API round-trips; violates the project rule that calculation logic lives in
  services, not controllers or UI

## Decision

> We will create a new `SprintModule` at `backend/src/sprint/` containing a
> `SprintDetailService` and a thin `SprintController`. The service exposes a single
> endpoint `GET /api/sprints/:boardId/:sprintId/detail` that returns a fully
> annotated per-issue breakdown for the requested sprint.

## Rationale

Option A is the only option that satisfies all three constraints simultaneously:
(1) calculation logic in a service, (2) no circular module imports, (3) no coupling
between the planning and roadmap domains. The logic duplication (helper functions)
is minor and is explicitly deferred to a follow-on refactoring task (extraction to
`backend/src/utils/statistics.ts`).

## Consequences

### Positive

- Teams can drill from any sprint row in the Planning or Roadmap tables directly to a
  per-ticket breakdown, eliminating the need to cross-reference Jira manually.
- All annotation logic is server-side and co-located; the frontend receives a single
  typed `SprintDetailResponse` object.
- The `(issueKey, field)` index added to `jira_changelogs` as part of this feature
  benefits all existing services (`PlanningService`, `MttrService`, `LeadTimeService`,
  `RoadmapService`) — a free performance improvement.

### Negative / Trade-offs

- `sprintValueContains`, `wasInSprintAtDate`, and `percentile` are duplicated across
  `PlanningService`, and the new `SprintDetailService`. This is tracked as a known
  technical debt item (`// TODO: extract to shared utility`).
- The `completedInSprint` logic in `SprintDetailService` adds a `>= sprint.startDate`
  guard that `PlanningService` does not apply. This is a deliberate refinement (more
  correct behaviour for the detail view) but it is a subtle divergence that developers
  must be aware of.

### Constraints Carried Forward

- **Link-based CFR** (`failureLinkTypes`) is not evaluated at the per-issue level
  because `issuelinks` are not stored in Postgres. A future `jira_issue_links` table
  would be required to support this.
- **Removed issues** are counted in `summary.removedCount` but excluded from the
  `issues[]` array. A show/hide toggle for removed issues is deferred to a follow-on
  iteration.
- **Pagination** is not implemented. The endpoint returns all issues in a single
  response. This is acceptable for the known sprint sizes (10–40 issues) and is
  explicitly deferred.

## Key Implementation Details

### `SprintModule` entity imports

```typescript
TypeOrmModule.forFeature([
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  BoardConfig,
  JpdIdea,
  RoadmapConfig,   // required for coveredEpicKeys scoping
])
```

`RoadmapConfig` is required because `coveredEpicKeys` must be scoped to configured
JPD projects (mirroring `RoadmapService.loadCoveredEpicKeys()`). Loading all
`JpdIdea` rows without this scoping would be incorrect.

### `ConfigService` injection for `JIRA_BASE_URL`

`ConfigModule` is global in `AppModule`. `SprintDetailService` injects `ConfigService`
directly. If `JIRA_BASE_URL` is absent, `jiraUrl` is `''` for all issues.

### Migration: `jira_changelogs` index

The initial migration (`1775795358704-InitialSchema.ts`) creates no indexes on
`jira_changelogs` beyond the primary key. A new additive migration must add:

```sql
CREATE INDEX "IDX_jira_changelogs_issueKey_field"
  ON "jira_changelogs" ("issueKey", "field");
```

With a matching `DROP INDEX` in `down()`. This is required for acceptable query
performance at scale and benefits all existing services.

### Frontend entry points

- `frontend/src/app/planning/page.tsx` — `sprintName` column in sprint-mode
  `DataTable` gains a `<Link href={/sprint/${boardId}/${row.sprintId}}>` render
- `frontend/src/app/roadmap/page.tsx` — same change, sprint-mode only (Kanban
  quarter-mode rows use quarter-key strings, not sprint IDs)
- New page: `frontend/src/app/sprint/[boardId]/[sprintId]/page.tsx`
- `frontend/src/lib/api.ts` — new `SprintDetailBoardConfig`, `SprintDetailIssue`,
  `SprintDetailSummary`, `SprintDetailResponse` interfaces and `getSprintDetail()`
  function

## Related Decisions

- [ADR-0002](0002-cache-jira-data-in-postgres.md) — Sprint detail data is read from
  Postgres cache; no live Jira API calls are made per request
- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — Per-board
  `BoardConfig` rules drive all annotation logic (`isIncident`, `isFailure`,
  `completedInSprint`)
- [ADR-0005](0005-kanban-boards-excluded-from-planning-accuracy.md) — Kanban boards
  return `400 Bad Request` from the sprint detail endpoint (no sprint concept)
- [ADR-0006](0006-sprint-membership-reconstructed-from-changelog.md) — Sprint
  membership at start date is reconstructed from changelog; `SprintDetailService`
  reuses this algorithm
- [ADR-0009](0009-roadmap-accuracy-jpd-sync-strategy.md) — `roadmapLinked`
  annotation uses the same `RoadmapConfig`-scoped `coveredEpicKeys` set as the
  roadmap accuracy feature
