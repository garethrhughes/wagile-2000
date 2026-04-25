# 0040 — Lambda Post-Sync DORA Snapshot Computation

**Date:** 2026-04-25
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0037 — Lambda Post-Sync DORA Snapshot Computation](../proposals/0037-lambda-post-sync-dora-computation.md)

## Context

The DORA metrics page was crashing the App Runner backend process with OOM kills
(exit 137). The root cause was identified as two independently memory-intensive
workloads co-located in the same Node.js heap:

1. **Sync phase** — Jira API HTTP responses mapped to TypeORM entities plus bulk
   upsert arrays accumulated before flushing to RDS (spike: hundreds of MB per board).
2. **Metric calculation** — `TrendDataLoader` loading all issues, changelogs, versions,
   and issue links for a board across 8 quarters to compute DORA trend data (comparable
   memory profile to sync).

When a DORA metric request arrived concurrently with a running sync cycle, the combined
working sets exceeded the 1800 MB heap cap (ADR-0032), killing the process. Even without
concurrent requests, post-sync in-process snapshot computation (options A and B from
proposal 0036) was evaluated and ruled out: they run immediately after sync at the peak
of heap occupancy, compounding rather than relieving pressure.

The secondary failure mode was the 60-second CloudFront origin timeout (ADR-0033):
on-the-fly DORA computation across 8 quarters exceeds this limit on the first request
after App Runner scales from zero.

Prior mitigations (instance sizing, column projection, sequential sprint-report
generation) had been applied to saturation. A structural separation of the two workloads
was required.

---

## Options Considered

Full analysis is in [proposal 0036](../proposals/0036-dora-page-reliability-options.md).
The shortlist after the OOM constraint was established:

### Option C — Lambda for post-sync snapshot computation (selected)

After each board's sync completes and data is persisted to RDS, invoke a small Lambda
function asynchronously (`InvocationType: Event`). The Lambda reads from RDS, computes
DORA metrics for 8 quarters, and writes to a `dora_snapshots` table. App Runner API
endpoints read the pre-computed snapshot rather than computing on demand.

Memory separation guarantee: by the time the Lambda reads RDS, `syncBoard()` has
returned and App Runner has GC'd the Jira response buffers and entity arrays for that
board. The sync and computation working sets never coexist in any single process.

### Option D — Step Functions state machine (deferred)

Extract both sync and metric computation to a Step Functions / Lambda architecture.
The correct long-term architecture but estimated at 3–5 days of implementation; Option C
was sufficient to resolve the confirmed failure mode (metric computation OOM) and
preserves local dev parity. Deferred until sync itself proves to be the memory bottleneck.

### In-process options (A and B) — ruled out

Both keep snapshot computation in the App Runner heap at its post-sync peak. They solve
the CloudFront timeout problem but not the OOM. Definitively ruled out.

---

## Decision

> After each board's sync completes, `SyncService.syncBoard()` invokes a Lambda function
> (`fragile-dora-snapshot`) asynchronously via `LambdaInvokerService`. The Lambda reads
> from RDS and writes pre-computed DORA results to the `dora_snapshots` table.
> `GET /api/metrics/dora/aggregate` and `GET /api/metrics/dora/trend` read exclusively
> from `dora_snapshots`; they return HTTP 202 with `{ status: 'pending' }` when no
> snapshot exists, and attach `X-Snapshot-Stale: true` / `X-Snapshot-Age` headers when
> the snapshot is older than the staleness threshold.

Key design elements:

- **`dora_snapshots` table** — composite primary key `(boardId, snapshotType)` where
  `snapshotType ∈ { 'aggregate', 'trend', 'trend-display' }` (see ADR-0042). JSONB
  `payload` column stores the full serialised result opaquely. An `UpdateDateColumn`
  `computedAt` tracks the last write time.
- **Lambda handler** — `backend/src/lambda/snapshot.handler.ts`. Bootstraps a bare
  TypeORM `DataSource` (no NestJS IoC) and instantiates metric services via direct
  `new` calls. DB password is fetched from Secrets Manager on cold start and cached
  module-scope for warm reuse.
- **`LambdaInvokerService`** — NestJS injectable in `SyncModule`. Wraps the AWS Lambda
  SDK. `USE_LAMBDA === 'true'` is opt-in; all other values fall through to
  `InProcessSnapshotService` for local development.
- **`InProcessSnapshotService`** — NestJS injectable that performs identical computation
  within the App Runner process. Used when `USE_LAMBDA` is not `'true'` (local dev,
  CI). Accepts OOM risk in local contexts where memory is not constrained.
- **Board config invalidation** — `PUT /api/boards/:boardId/config` also invokes the
  Lambda (or in-process service) to refresh the snapshot immediately after a config change.
- **`DoraSnapshotReadService`** — reads from `dora_snapshots` and computes staleness
  against `SNAPSHOT_STALE_THRESHOLD_MINUTES` (default 60).
- **Lambda sizing** — 512 MB memory, 120-second timeout. Handler path in the zip:
  `lambda/snapshot.handler.handler`.
- **Deployment zip** — `backend/snapshot-worker.zip` (outside `dist/` to survive
  `nest build` `deleteOutDir`). Built by `make lambda-build` before `terraform apply`.

---

## Rationale

Lambda is the lightest-weight out-of-process compute available. The Lambda handler is
short-lived (10–30 seconds), reads only from RDS, and requires no Jira API credentials.
The App Runner process's Jira response buffers are fully GC'd before the Lambda runs,
guaranteeing the two peak working sets never overlap in any process.

`InvocationType: Event` makes the invocation fire-and-forget. Invocation failure is
logged as a warning and does not fail the sync, which has already persisted its results.
A stale snapshot is returned with a header rather than an error, which is acceptable
for a metrics dashboard where eventual consistency is appropriate.

Keeping the handler in `backend/src/lambda/` (rather than a separate package) avoids
duplicating TypeORM entities and metric service code; the same `tsc` compilation
produces the Lambda artifact from the same source.

---

## Consequences

### Positive

- DORA metric API endpoints are now `O(1)` reads from a single JSONB row regardless of
  board size or history depth. The CloudFront 60-second timeout is no longer a risk.
- App Runner's peak heap during sync is bounded by the sync working set for a single board
  only; metric computation never coexists with sync data in the same heap.
- `InProcessSnapshotService` preserves full local dev parity without requiring Lambda or
  LocalStack.

### Negative / Trade-offs

- A new AWS service (Lambda) and deployment artifact (`snapshot-worker.zip`) are
  introduced. The Lambda must be kept in sync with TypeORM entity schema changes.
- On first deploy before any sync has run, `dora_snapshots` is empty; the DORA page
  shows a pending state until a sync completes and the Lambda runs (~30 seconds after
  the first sync).
- Lambda invocation failure causes the snapshot to grow stale silently until the next
  sync. A CloudWatch alarm on Lambda error rate is the recommended mitigation.
- `InProcessSnapshotService` and `snapshot.handler.ts` contain near-duplicate computation
  logic. A shared `computeDoraSnapshots(repos, boardId)` helper should consolidate this
  if the duplication diverges.

### Risks

- If sync itself (not just metric computation) causes OOM as board count grows, Option D
  (Step Functions) will be required. Monitor App Runner `container_memory_utilization`
  during sync with no concurrent DORA requests to establish the sync-only memory baseline.

---

## Related Decisions

- [ADR-0032](0032-nodejs-heap-cap-and-apprunner-instance-sizing.md) — Instance sizing
  and heap cap context
- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront 60-second timeout
  that makes on-the-fly computation untenable
- [ADR-0036](0036-sync-endpoint-fire-and-forget-http-202.md) — Fire-and-forget principle
  that Lambda invocation extends to the compute path
- [ADR-0037](0037-typeorm-column-projection-for-metric-queries.md) — Column projection
  preserved in the Lambda `TrendDataLoader` path
- [ADR-0041](0041-postgres-advisory-lock-for-sync-serialisation.md) — Distributed sync
  lock introduced in the same batch of work
- [ADR-0042](0042-trend-display-snapshot-type-and-org-merge-strategy.md) — Snapshot shape
  evolution introduced alongside this architecture
