# 0041 — PostgreSQL Advisory Lock for Distributed Sync Serialisation

**Date:** 2026-04-25
**Status:** Accepted
**Deciders:** Architect Agent

## Context

App Runner can run multiple container instances simultaneously (horizontal scaling) and
restarts instances during deployments, resulting in a window where two instances are
live concurrently. With a scheduled cron sync (`@Cron('0 */30 * * * *')`) running on
every instance, two `syncAll()` calls can overlap:

- **Same-cron overlap** — both instances fire their cron at the same 30-minute mark.
- **Deployment overlap** — the old instance is still running a sync when the new
  instance starts and triggers its startup sync or the next cron fires.

Two concurrent `syncAll()` runs produce redundant Jira API calls (doubling rate-limit
consumption), redundant bulk upserts (wasted write I/O), and — critically — two
concurrent Lambda invocations per board immediately after sync (see ADR-0040). At the
current board count (6), two simultaneous Lambda invocations per board means 12 Lambda
executions plus 12 RDS connections opened simultaneously, exceeding the safe connection
budget for `db.t4g.micro` (~85 connections).

An application-level mutex (`InMemoryMutex`, `AsyncLocalStorage`, or a module-level
boolean flag) guards only within a single process instance and provides no protection
against the multi-instance case.

---

## Options Considered

### Option A — Application-level in-process flag (ruled out)

A module-level `isSyncing: boolean` flag in `SyncService` prevents re-entrant calls
within a single process. **Does not protect against multi-instance concurrency.**
Ruled out as insufficient.

### Option B — Redis distributed lock

A Redis `SET NX PX` lock (or Redlock) provides a true distributed mutex. Requires
adding an ElastiCache Redis cluster to the infrastructure, a new VPC security group
rule, the `ioredis` dependency, and lock TTL management.

**Pros:** Industry-standard distributed locking; battle-tested Redlock library.
**Cons:** Adds a persistent infrastructure component (~$15–25/mo for `cache.t3.micro`)
for a single use case. At current scale (6 boards, < 2 minutes per sync), the Redis
overhead is disproportionate to the problem.

### Option C — PostgreSQL advisory lock (selected)

PostgreSQL provides session-level advisory locks (`pg_try_advisory_lock(key bigint)`)
that are shared across all connections to the same database. A well-known integer key
is nominated for the sync lock. `pg_try_advisory_lock` returns `true` if the lock was
acquired and `false` if another session holds it — it is non-blocking (unlike
`pg_advisory_lock`). The lock is held for the duration of the sync and released with
`pg_advisory_unlock` (or automatically on connection close).

Because all App Runner instances connect to the same RDS PostgreSQL instance, this
achieves distributed mutual exclusion without any additional infrastructure.

---

## Decision

> `SyncService.syncAll()` acquires a PostgreSQL session-level advisory lock via
> `pg_try_advisory_lock` before beginning the sync loop. If the lock cannot be acquired
> (another instance is already syncing), the method returns immediately and the HTTP
> handler returns HTTP 409 Conflict with `{ status: 'conflict', message: 'Sync already in progress' }`.
> The lock is released unconditionally in a `finally` block after `syncAll()` completes
> or throws.

Implementation:

```typescript
// SyncService.syncAll()
const acquired = await this.dataSource.query(
  'SELECT pg_try_advisory_lock($1) AS acquired',
  [SYNC_ADVISORY_LOCK_KEY],  // well-known constant, e.g. 1234567890
);
if (!acquired[0].acquired) {
  this.logger.warn('Sync already in progress on another instance — skipping.');
  return { status: 'conflict' };
}
try {
  // ... per-board sync loop ...
} finally {
  await this.dataSource.query(
    'SELECT pg_advisory_unlock($1)',
    [SYNC_ADVISORY_LOCK_KEY],
  );
}
```

The lock key is a compile-time constant in `SyncService`. It does not need to be
configurable.

---

## Rationale

PostgreSQL advisory locks are already available (the database is always present),
cost nothing, and are sufficient for the single use case of serialising sync runs.
The non-blocking `pg_try_advisory_lock` variant is preferred over the blocking
`pg_advisory_lock` to avoid queueing sync runs: a queued sync that begins after the
first one completes would re-sync data that was just fetched, wasting Jira API quota.
A fast rejection (409) is preferable — the cron on the losing instance simply skips
that cycle and will retry at the next 30-minute mark.

Session-level locking is appropriate here: the lock scope matches the desired behaviour
(one sync at a time across all instances), and session locks are automatically released
if the holding connection drops unexpectedly (e.g. process crash), preventing permanent
deadlock.

---

## Consequences

### Positive

- Concurrent `syncAll()` calls across App Runner instances are serialised without any
  new infrastructure.
- Redundant Jira API calls and Lambda invocations during deployment rollovers are
  eliminated.
- The `finally` block guarantees the lock is released even if the sync throws, preventing
  a hung lock from blocking all future syncs.
- HTTP 409 from `POST /api/sync` is a clear, actionable signal when a manual sync is
  triggered while a cron sync is already running.

### Negative / Trade-offs

- The advisory lock occupies one PostgreSQL connection slot for the duration of the sync
  (~30–120 seconds). At current connection budgets this is immaterial.
- `pg_advisory_lock` is PostgreSQL-specific. A future migration away from PostgreSQL
  (unlikely given ADR-0002) would require replacing this mechanism.
- If the App Runner process crashes mid-sync (e.g. OOM kill, which ADR-0040 mitigates),
  the session lock is released by PostgreSQL automatically when the connection closes.
  No manual intervention is needed.

### Risks

- If `syncAll()` hangs indefinitely (e.g. a Jira API call stalls without a timeout), the
  lock is held indefinitely and all future cron and manual syncs are blocked. Mitigation:
  ensure `JiraClientService` has a request timeout (enforced by the Jira API client's
  `axios` / `fetch` configuration) and that the sync cron interval is longer than the
  maximum expected sync duration.

---

## Related Decisions

- [ADR-0036](0036-sync-endpoint-fire-and-forget-http-202.md) — Fire-and-forget sync
  pattern; the 409 response path is consistent with this (the controller returns
  immediately with an appropriate non-202 status)
- [ADR-0040](0040-lambda-post-sync-dora-snapshot-computation.md) — The Lambda
  invocations that this lock prevents from being doubled per sync cycle
- [ADR-0002](0002-cache-jira-data-in-postgres.md) — The RDS PostgreSQL instance that
  provides the advisory lock substrate
