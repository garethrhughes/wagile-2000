# 0036 — DORA Page Reliability in AWS Environment: Options Analysis

**Date:** 2026-04-23
**Status:** Draft (revised — OOM constraint added)
**Author:** Architect Agent
**Related ADRs:** ADR-0032, ADR-0033, ADR-0036, ADR-0037

---

## Revision Note

This proposal was revised after the initial draft to incorporate a critical constraint that
was under-weighted in the first analysis: **the App Runner backend process is crashing with
OOM kills**, not merely timing out. This changes the ranking of options materially. Option B
(previously recommended) does not survive re-analysis under this constraint. See §Revised
Recommendation.

---

## Problem Statement

The DORA metrics page is unreliable in the AWS environment. The proximate symptoms are:

- The DORA page fails to load, or loads stale/empty data.
- App Runner logs show the backend container exiting with **exit code 137 (SIGKILL from the
  OOM killer)** or a V8 `JavaScript heap out of memory` error, crashing the process entirely.
- After a process restart, the DORA page may recover temporarily until the next sync cycle,
  at which point the OOM recurs.

### Primary failure mode: Out-of-Memory crash

The backend runs on 1 vCPU / 2 GB RAM with the Node.js heap capped at 1800 MB (ADR-0032).
The **sync process and on-request metric calculation share a single heap**. A full sync
across all configured boards involves:

1. Hundreds of Jira API HTTP responses held in memory while being mapped to TypeORM entities.
2. Bulk upserts of `JiraIssue`, `JiraChangelog`, `JiraVersion`, and `JiraIssueLink` rows
   — large arrays accumulated in-process before being flushed to RDS.
3. Sequential sprint report generation per board (ADR-0032 made this sequential rather than
   concurrent to reduce peak memory, but it still runs in the same heap immediately after sync).
4. If a DORA metric request arrives *concurrently* with steps 1–3, the request loads
   additional datasets from RDS — issues, changelogs, versions, issue links — for metric
   calculation on top of the already-elevated sync heap.

The combined peak of (sync working set) + (metric calculation dataset) exceeds 1800 MB,
causing the process to crash. The DORA page is most likely to fail immediately after a
sync — exactly when the user navigates to it to see fresh data.

### Secondary failure mode: CloudFront timeout

Even when the process does not crash, on-the-fly metric calculation on a cold cache can
exceed the **60-second CloudFront origin timeout** (ADR-0033, which is the binding
constraint — tighter than App Runner's own 120-second timeout), returning a `504` to the
browser.

### What has already been tried

Prior mitigations (ADR-0032, ADR-0037) reduced but did not eliminate the problem:

- Instance upsized to 1 vCPU / 2 GB (maximum for this tier).
- Heap cap set to `--max-old-space-size=1800` to force GC before OOM-kill.
- Column projection on all metric service queries (~80% per-row memory reduction).
- Sprint report generation made sequential across boards post-sync.
- Debouncing on board selection to reduce request fan-out.

These are the current mitigations at saturation. There is no remaining headroom on the
existing instance size short of upgrading to a larger tier (see Option F). The problem
is fundamentally architectural: **too much memory-intensive work is co-located in a single
process on a constrained instance.**

---

## Current Architecture (Baseline)

```
Browser
  │  GET /api/metrics/dora/aggregate
  │  GET /api/metrics/dora/trend
  └──► CloudFront (60s origin timeout)
          └──► App Runner: NestJS backend (1 vCPU / 2 GB, heap cap 1800 MB)
                 │
                 ├── @Cron('0 */30 * * * *')  → SyncService.syncAll()   ← memory spike here
                 ├── POST /api/sync            → SyncService.syncAll() [fire-and-forget]
                 ├── MetricsService            → on-the-fly calc from RDS ← concurrent with above
                 │     └── TrendDataLoader     → 4 queries/board, in-memory fan-out
                 └── In-memory TTL cache       → 60s live / 15min historical
                          │
                          ▼
                    RDS PostgreSQL 16
                    (JiraIssue, JiraChangelog, JiraVersion, ...)
```

**Confirmed constraints from Terraform (`apprunner/main.tf`):**
- Backend: `cpu = "1024"`, `memory = "2048"` (1 vCPU / 2 GB) — maximum for the 1 vCPU tier
- `min_size = 1`
- App Runner default request timeout: 120 seconds (not overridden in Terraform)
- CloudFront origin timeout: **60 seconds** (ADR-0033 — binding constraint for browser requests)

**The ceiling has been reached on the current instance size.** App Runner's 1 vCPU tier tops
out at 2 GB RAM. Moving to the 2 vCPU tier unlocks up to 4 GB (or 8 GB on the 4 vCPU tier).

---

## OOM Analysis by Option

Before evaluating options, it is necessary to be explicit about which phases of work consume
memory and which options actually relocate those phases out of the App Runner process.

| Phase | Memory profile | Currently runs in App Runner? |
|---|---|---|
| Jira API calls (sync) | High: JSON response bodies + TypeORM entity arrays in-flight | ✅ Yes |
| Bulk upserts to RDS | Medium: large arrays before flush | ✅ Yes |
| Sprint report generation | Medium: changelog traversal per sprint | ✅ Yes |
| DORA metric calculation (request-time) | High: `TrendDataLoader` loads all issues + changelogs per board | ✅ Yes |
| DORA metric calculation (post-sync snapshot) | High: identical dataset to above | ✅ Yes (if in-process) |
| DORA snapshot read (from RDS) | Negligible: single JSONB row | ✅ Yes (but trivially cheap) |

**Critical observation**: Options A and B both move metric calculation to *post-sync time*
but keep it in the *same process*. The post-sync moment is the worst time to add more memory
work — the heap is at its fullest after accumulating Jira API responses and bulk upsert
buffers. Option B is not a fix for OOM; it is a rescheduling of the OOM trigger.

---

## Options

### Option F — Instance Upsize (Stopgap) ⭐ Immediate relief

> **This option is new in the revised analysis.** It was not present in the initial draft.

**Summary:** Upgrade the App Runner backend instance from 1 vCPU / 2 GB to 2 vCPU / 4 GB
(or 4 vCPU / 8 GB). This is a single Terraform variable change. It provides immediate relief
from OOM crashes while a proper architectural fix is designed and implemented.

**How it addresses OOM:**
Doubling available RAM to 4 GB and raising the heap cap to ~3600 MB (or 7200 MB at 8 GB)
gives the combined sync + metric calculation workload substantially more headroom. The peak
heap usage (sync working set + concurrent metric request) is currently marginally exceeding
1800 MB. At 4 GB / 3600 MB heap, the current workload fits comfortably.

**This does not fix the root cause.** It buys time. As board count grows, issue history
accumulates, or a large Jira board (e.g. PLAT) hits the 1000+ Kanban issue threshold, the
same OOM problem recurs at a higher ceiling.

**Infrastructure changes required:**
- `infra/terraform/modules/apprunner/main.tf`: change `cpu = "1024"` to `cpu = "2048"` and
  `memory = "2048"` to `memory = "4096"` (2 vCPU / 4 GB). Also update the `CMD` in
  `backend/Dockerfile` to `--max-old-space-size=3600`.
- No code changes. No new AWS services. No migration.

**Cost impact:**
- 2 vCPU / 4 GB App Runner: ~$0.064–0.096/hour active compute (~$6–10/mo at 1 instance
  running 24/7) vs ~$0.064/hour for the current 1 vCPU / 2 GB. Estimated additional
  cost: **~$10–20/mo**.
- 4 vCPU / 8 GB if 4 GB proves insufficient: approximately double again (~$20–40/mo additional).

**Complexity:** Trivial. Two Terraform variables and one Dockerfile line.

**Time to implement:** < 1 hour. Deployable immediately.

**Risks and trade-offs:**
- Does not solve the architectural problem; the fix will need to be revisited.
- If board count doubles (6 → 12) or PLAT grows to 2000+ issues, the same OOM recurs at
  the new ceiling.
- 4 vCPU / 8 GB is the largest App Runner instance available. If that ceiling is breached,
  the only remaining option is to move compute out of App Runner entirely — which means
  implementing one of Options D or E at that point under time pressure.
- App Runner bills for active compute time only (min 1 instance always on, per `min_size = 1`).
  At low traffic the cost delta is mostly the baseline instance cost.

**OOM impact:** ✅ Eliminates OOM for current workload. ❌ Does not address root cause.

---

### Option A — Pre-Compute In-Process + `DoraSnapshot` Table (with live-calc fallback)

**Summary:** After each board sync, call `DoraSnapshotService.computeAndPersist(boardId)`
in-process. API endpoints read from the snapshot table first; fall back to live calculation
if no snapshot exists. No new AWS services.

**OOM impact:** ❌ **Does NOT resolve OOM.** Snapshot computation runs immediately after
sync in the same process heap — at the peak of heap occupancy. The `TrendDataLoader` bulk
load (all issues + all changelogs for a board across 8 quarters) requires the same memory
as the current trend endpoint. Running it post-sync compounds, rather than relieves, heap
pressure. The OOM crash will now occur during snapshot computation rather than during a
request, but it still occurs.

Additionally, Option A retains a live-calculation fallback. When the snapshot is missing
(e.g. because the post-sync computation just OOM-crashed), the fallback fires — adding
memory pressure to an already fragile state.

**Fit with OOM constraint:** ❌ Ruled out as a standalone fix for OOM.
**Still useful as:** The `DoraSnapshot` table schema and read path are required by all
other options. This option defines what the snapshot looks like; its in-process computation
step is replaced by an out-of-process step in Options C, D, and E.

---

### Option B — Pre-Compute In-Process Only (no live-calc fallback)

**Summary:** Same as Option A but without the live-calculation fallback. API returns HTTP
202/pending when no snapshot exists.

**OOM impact:** ❌ **Does NOT resolve OOM.** Identical analysis to Option A. The snapshot
computation step runs in the same heap immediately after sync. Removing the live-calculation
fallback avoids one concurrent memory spike, but the post-sync snapshot computation itself
still exhausts the heap.

**This was the original recommendation. It is demoted.** Option B solves the timeout
problem (API reads become fast DB lookups) but leaves the process vulnerable to OOM during
the post-sync compute phase, which is the primary failure mode.

**Fit with OOM constraint:** ❌ Ruled out as a standalone fix for OOM.

---

### Option C — Lambda for Post-Sync Snapshot Computation ⭐ Viable intermediate fix

**Summary:** Sync continues to run in-process (Jira API calls, bulk upserts to RDS). After
`syncBoard()` completes and all data is written to RDS, the NestJS process invokes a
**single Lambda function** asynchronously with `InvocationType: 'Event'`. The Lambda reads
the now-persisted RDS data and computes the `DoraSnapshot` for that board. The App Runner
process does **not** hold Jira API response data and metric calculation datasets in memory
at the same time.

```
App Runner NestJS (sync phase):
  SyncService.syncBoard(boardId)
    → Jira API calls → write to RDS → release memory
    → lambda.invoke({ boardId }, InvocationType: 'Event' )  ← fire-and-forget
    → return (heap pressure drops here as Jira data is GC'd)

Lambda (compute phase — separate process, separate memory):
  handler({ boardId })
    → TypeORM connect to RDS
    → TrendDataLoader.load(boardId, ...)     ← loads from RDS, not from Jira
    → DoraSnapshotService.computeAndPersist(boardId)
    → exit

App Runner NestJS (API phase):
  GET /api/metrics/dora/aggregate → SELECT from dora_snapshots
```

**Why this split matters for OOM:** By the time the Lambda runs, the App Runner process has
finished `syncBoard()` and released the Jira API response buffers, entity arrays, and bulk
upsert buffers. The App Runner heap drops back to its idle baseline before the next board's
sync begins. The metric computation dataset (which is comparably large) now lives entirely
in the Lambda's separate memory allocation — it never coexists with the Jira sync data.

**Infrastructure changes required:**
- New Terraform resources: one Lambda function (`fragile-dora-snapshot`), Lambda execution
  role with RDS VPC access (subnet + security group config), IAM permission for App Runner
  task role to call `lambda:InvokeFunction` on this function.
- Lambda is VPC-attached (same private subnets as App Runner backend, same security group
  rules to reach RDS on port 5432).
- Lambda deployment package: a standalone Node.js bundle containing only the TypeORM
  entities, `TrendDataLoader`, and the four metric calculation services. Does **not** need
  `JiraClientService` — it reads from RDS only.
- `dora_snapshots` table: new TypeORM migration (same across all snapshot-capable options).
- Lambda memory: 512 MB–1 GB is sufficient (reads RDS data, no Jira HTTP responses).

**Code changes required (high-level):**
1. `dora_snapshots` entity + TypeORM migration (needed for all snapshot options).
2. New `packages/snapshot-worker/` (or `backend/src/lambda/snapshot.handler.ts`): a slim
   Lambda handler that bootstraps a TypeORM DataSource, runs `TrendDataLoader.load()` and
   all four `calculateFromData()` methods, writes to `dora_snapshots`, and exits.
   **Key**: no NestJS IoC container needed in the Lambda — `TrendDataLoader` and the metric
   services are plain TypeScript classes; they can be instantiated directly.
3. `SyncService.syncBoard()`: after the changelog sync completes, call
   `this.lambdaClient.invoke('fragile-dora-snapshot', { boardId })` with
   `InvocationType: 'Event'`. No await. Add a `.catch()` handler.
4. `MetricsController` / `MetricsService`: read from `dora_snapshots` (no live-calc fallback
   for the snapshot path; return pending response if snapshot absent).
5. Remove `TrendDataLoader` and metric service imports from `SyncService` (it no longer
   calls them directly).

**Complexity:** Medium. The Lambda package is small and does not require NestJS. The key
risk is that TypeORM entity definitions must be shared between the NestJS app and the
Lambda handler — this is achieved by importing directly from `backend/src/database/entities/`
rather than duplicating. The Lambda and the NestJS app share a monorepo, making this
straightforward with a `tsconfig` path alias.

**Code duplication risk:** Low. Calculation logic lives in the metric services, which are
plain TypeScript and are imported (not copied) by the Lambda handler.

**Cost impact:**
- Lambda: 512 MB memory, ~5–15 seconds execution per board × 6 boards = ~90 seconds per
  sync. At 48 syncs/day: ~72 Lambda-minutes/day × 30 days = ~2,160 Lambda-minutes/month.
  Free tier covers 400,000 GB-seconds = ~800,000 Lambda-seconds at 512 MB. This workload
  is **~1,080 GB-seconds/month — well within free tier. Cost: ~$0.**
- New Terraform resources (Lambda, IAM): no ongoing cost beyond compute.
- **Total incremental cost: ~$0.**

**Risks and trade-offs:**
- **Lambda cold start for VPC-attached functions**: 1–5 seconds for the first invocation
  after a period of inactivity. Not a problem for async post-sync computation.
- **Connection management**: Lambda connects to RDS directly. Each invocation opens a
  connection and closes it on exit. With sequential per-board invocations from App Runner
  (to mirror the existing sequential sync pattern), only 1 Lambda runs at a time — 1 RDS
  connection. If parallelised, up to 6 simultaneous connections. `db.t4g.micro` supports
  ~85 connections — not a risk at this scale.
- **Lambda timeout**: default 3 seconds is too short. Set to 60 seconds (ample for
  `TrendDataLoader` + 4 metric calculations from RDS).
- **Deployment artefact**: the Lambda package must be built and deployed alongside the
  NestJS app in CI. This is additive complexity but is a single new step in the GitHub
  Actions workflow.
- **Sync itself remains in App Runner**: this is the correct design choice. Sync must
  hold Jira API credentials (via ConfigService/SSM) and manage the Jira client's rate
  limiting logic. Keeping sync in App Runner avoids duplicating the Jira client. The
  per-board sync working set is released after each board before the Lambda is invoked,
  so the Jira response data and the metric calculation data never coexist in the same heap.

**OOM impact:** ✅ **Resolves OOM for metric calculation.** The computation dataset
(issues + changelogs + versions) never coexists in the App Runner heap with the Jira sync
dataset. App Runner's peak heap is now bounded by the sync working set for a single board
only — a known-manageable size.

**Fit with existing ADRs:**
- ✅ ADR-0032: App Runner heap is freed from metric computation. The sync-only heap
  profile (single board at a time) is the validated safe workload per ADR-0032.
- ✅ ADR-0036 (fire-and-forget): Lambda invocation is async, consistent with the
  fire-and-forget principle.
- ✅ ADR-0037 (column projection): `TrendDataLoader` already applies column projection;
  this is preserved in the Lambda path.
- ⚠️  New AWS service (Lambda) increases infrastructure surface. Small but real.
- ⚠️  Lambda package must be kept in sync with TypeORM entity schema changes.

---

### Option D — AWS Step Functions for Sync + Pre-Computation (User's Suggestion) ⭐ Best long-term architecture

**Summary:** Extract the per-board sync loop **and** post-sync metric computation from NestJS
into an AWS Step Functions state machine. Each board executes as a parallel branch. The
state machine writes raw Jira data AND pre-computed DORA snapshots to RDS. NestJS App Runner
becomes purely read-only and stateless.

**How it resolves OOM:**
Both sync (Jira API calls, bulk upserts) and metric calculation run in Lambda functions with
dedicated, isolated memory allocations. App Runner never holds a Jira sync working set.
The App Runner heap contains only: active HTTP request handlers, TypeORM connection pool
state, and the snapshot read path. This is a trivially small memory footprint — well under
500 MB for any foreseeable request load.

**Architecture diagram:**

```
EventBridge Scheduler (every 30 min)
  │  OR  POST /api/sync → SyncController → SFN StartExecution (202)
  ▼
Step Functions State Machine
  ├── LoadBoardConfigs (Lambda: read BoardConfig from RDS)
  ├── Map (parallel per board — each board is isolated):
  │     ├── SyncSprints    (Lambda: Jira API → RDS)
  │     ├── SyncIssues     (Lambda: Jira API → RDS)
  │     ├── SyncChangelogs (Lambda: Jira API → RDS)
  │     ├── SyncVersions   (Lambda: Jira API → RDS)
  │     ├── ComputeDora    (Lambda: RDS read → DoraSnapshot write)
  │     └── WriteSyncLog   (Lambda: RDS write)
  └── Done

App Runner: NestJS backend (read-only, lightweight)
  ├── GET /api/metrics/dora/aggregate  → SELECT from dora_snapshots
  ├── GET /api/metrics/dora/trend      → SELECT from dora_snapshots
  ├── GET /api/boards, GET /api/sync/status, etc. → normal RDS reads
  └── POST /api/sync → sfn.startExecution(...) → return 202
```

**Infrastructure changes required:**
- Step Functions state machine (ASL definition in Terraform or CDK-style HCL).
- Multiple Lambda functions with VPC access to RDS.
- EventBridge Scheduler rule.
- IAM roles: SFN execution role, Lambda execution roles, App Runner task role permission
  to call `sfn:StartExecution`.
- Lambda VPC subnet attachments (same private subnets as App Runner backend).
- `dora_snapshots` table (same migration as other options).
- Jira credentials (Secrets Manager / SSM) accessible from Lambda execution roles.

**Code changes required (high-level):**
1. Extract `JiraClientService`, `SyncService`, metric services, and `TrendDataLoader` into
   a deployable Lambda package (`packages/sync-worker/`).
2. Write Lambda handlers for each SFN step.
3. Write ASL state machine definition.
4. Remove `@Cron` from NestJS `SyncService`. Replace `SyncService` with a thin SFN invoker.
5. API endpoints read from `dora_snapshots`.

**Revised assessment vs original proposal:**

In the original draft, Option D was characterised as "over-engineered for the current problem
scale." That assessment was made under the assumption that Option B (in-process pre-compute)
would work. Now that the OOM constraint shows Option B does not solve the problem, the
complexity cost of Option D must be weighed against the alternatives that do work (C and E).

Option D's genuine advantages over Option C:
- **Sync also moves out of App Runner**: Option C keeps sync in App Runner. If sync itself
  (not just metric computation) continues to cause OOM as board count or issue count grows,
  Option C will need to be revisited. Option D addresses both sync and computation.
- **Operational visibility**: Step Functions execution history gives a complete audit trail
  of every sync run — which board failed, at which step, with which error. Debugging
  currently requires parsing App Runner CloudWatch logs.
- **Durability**: a Lambda in a Step Functions Map state has its own retry policy and
  error handling. A sync board failure does not crash the App Runner process; it is
  isolated to that board's execution branch.
- **Parallelism**: boards sync in parallel in the SFN Map state, reducing total sync
  wall time from (N_boards × per_board_time) to (max per_board_time). Currently boards
  sync sequentially.

Option D's disadvantages:
- **Implementation cost**: estimated 3–5 days to extract the Jira client, write the ASL,
  configure VPC Lambda, and test end-to-end. Option C is 1–2 days.
- **Local dev parity**: `docker-compose up` no longer runs sync end-to-end. The Lambda
  steps must be mocked or run via LocalStack.
- **Sync Jira client in Lambda**: `JiraClientService` has a concurrency-limiting semaphore
  designed for a long-lived Node.js process. In a Lambda, each invocation is a new process;
  the semaphore resets on each cold start. This is actually *fine* (each Lambda handles one
  board), but the implementation must be reviewed for this context.

**Complexity:** High. This is the most complex option.
**Time to implement:** 3–5 days.

**OOM impact:** ✅ **Definitively resolves OOM.** App Runner heap never contains Jira sync
data or metric computation datasets. Its memory profile becomes purely request-serving.

**Cost impact:** Same as original analysis — ~$2–5/mo incremental above baseline. NAT
Gateway already exists (ADR-0035).

**Fit with existing ADRs:**
- ✅ ADR-0032: App Runner freed from all heavy computation.
- ✅ ADR-0036: fire-and-forget is superseded by durable SFN execution — strictly better.
- ✅ ADR-0037: column projection preserved in Lambda compute path.
- ⚠️  3+ new AWS service types; operational model changes.

---

### Option E — Separate NestJS Worker Service (App Runner)

**Summary:** Extract sync + metric computation into a second NestJS process running as a
dedicated App Runner service. The API service is read-only. The worker service handles
all sync and snapshot computation.

**OOM impact:** ✅ **Resolves OOM for the API service.** The worker may still OOM if the
same heap-exhaustion pattern recurs in the worker process — but the API service is
protected. This is an improvement but not a complete resolution unless the worker is
sized appropriately or the worker implements the sync/compute memory separation that
Option C achieves via process isolation.

**Key distinction from Option C:** Option C separates sync from compute at the process
boundary (App Runner sync → Lambda compute). Option E separates API-serving from
sync+compute at the process boundary, but keeps sync and compute co-located in the
worker — so the OOM risk is displaced to the worker rather than eliminated.

**If sync itself is the OOM cause** (not just metric computation): Option E does not help
unless the worker is sized larger than the current App Runner instance. A 2 vCPU / 4 GB
worker (Option F sizing applied to a dedicated worker) would resolve this.

**Cost impact:** ~$10–15/mo incremental (second App Runner service + possible second VPC
connector).

**Complexity:** Medium-High. NestJS module split is straightforward; IPC mechanism for
`POST /api/sync` triggering is the main friction point.

**Fit with OOM constraint:** Partial — displaces OOM rather than eliminating it.
Weaker than Options C and D for OOM resolution. Higher cost than Option C for equivalent
benefit.

---

## Revised Options Comparison

| | F (Instance Upsize) | A (In-process snapshot + fallback) | B (In-process snapshot only) | C (Lambda compute) | D (Step Functions) | E (Worker service) |
|---|---|---|---|---|---|---|
| **Resolves OOM (API serving)** | ✅ (more headroom) | ❌ | ❌ | ✅ | ✅ | ✅ |
| **Resolves OOM (root cause)** | ❌ (deferred) | ❌ | ❌ | ✅ (compute) | ✅ (sync+compute) | Partial |
| **Resolves 60s CloudFront timeout** | ❌ (without snapshot) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **No new AWS services** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Sync stays in App Runner** | ✅ | ✅ | ✅ | ✅ | ❌ | Partial |
| **No code duplication** | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| **Local dev parity** | ✅ | ✅ | ✅ | ⚠️ | ❌ | Partial |
| **Implementation complexity** | Trivial | Medium | Medium | Medium | High | Medium-High |
| **Cost delta vs current** | +$10–20/mo | ~$0 | ~$0 | ~$0 | ~$2–5/mo | +$10–15/mo |
| **Time to implement** | < 1 hour | 1–2 days | 0.5–1 day | 1–2 days | 3–5 days | 2–3 days |
| **OOM impact** | Deferred ceiling | ❌ still crashes | ❌ still crashes | ✅ compute off-heap | ✅ fully off-heap | ✅ API protected |
| **Recommended** | ✅ Stopgap | ❌ | ❌ | ✅ Near-term fix | ✅ Long-term target | ❌ Weaker than C |

---

## Revised Recommendation

### Step 1 — Immediate stopgap: Option F (instance upsize)

Apply within hours. Change two Terraform variables:

```hcl
# infra/terraform/modules/apprunner/main.tf
instance_configuration {
  cpu    = "2048"   # was "1024"
  memory = "4096"   # was "2048"
  ...
}
```

And update `backend/Dockerfile`:
```dockerfile
CMD ["node", "--max-old-space-size=3600", "dist/main"]
```

This stops the crashes immediately at the cost of ~$10–20/mo. It buys the time needed to
implement the proper fix without the DORA page being broken for users.

**This does not close the ticket.** It is explicitly a stopgap. The proper fix must follow.

### Step 2 — Near-term proper fix: Option C (Lambda for post-sync snapshot computation)

Implement within the next sprint. The `DoraSnapshot` table is introduced, and snapshot
computation is moved to a small Lambda that runs after each board's sync completes. The
Lambda reads from RDS (never holds Jira API responses) and writes the snapshot. App Runner
never computes DORA metrics on the request path.

This resolves the OOM root cause for metric computation while keeping sync (Jira API
calls) in App Runner where it has the necessary credentials, rate-limiting logic, and
ConfigService integration. It introduces one new AWS service (Lambda) and one new
deployment artefact, but no code duplication — the Lambda imports the existing metric
services directly.

**Combined result of Steps 1 + 2:** The DORA page is reliable. OOM is resolved. The
CloudFront 60-second timeout is no longer a risk for metric endpoints. The instance can
be downgraded back to 1 vCPU / 2 GB after Step 2 is deployed (or kept at 2 vCPU / 4 GB
as headroom for sync itself, which still runs in-process).

### Step 3 (future) — Option D if sync itself becomes the bottleneck

If post-Step 2 monitoring shows that **sync itself** (not metric computation) is still
causing OOM in App Runner, or if board count grows significantly (>10 boards), implement
Option D to extract sync into Step Functions / Lambda. At that point the
`dora_snapshots` infrastructure from Step 2 is already in place; the compute Lambda step
moves into the SFN Map state with minimal change to the snapshot write path.

### Why not skip to Option D immediately?

Option D is the correct long-term architecture. However:

1. The DORA page is broken *now*. Option F (< 1 hour) stops the bleeding.
2. Option D requires 3–5 days to implement correctly. Option C requires 1–2 days and
   resolves the OOM root cause for the confirmed problem (metric computation OOM).
3. Sync OOM may not be a problem at the current board count. ADR-0032's sequential
   sprint-report pattern was introduced specifically to bound sync memory. If sync
   itself is not currently causing OOM (it is the concurrent sync + metric calculation
   that tips the heap over), Option C is sufficient.
4. Preserving local dev parity (`docker-compose up` runs sync end-to-end) is a real
   productivity benefit that Option D sacrifices.

The two-step approach (C now, D if needed) avoids over-engineering while leaving the door
open to migrate to D when justified. The `DoraSnapshot` schema is the same in both;
the only change when migrating from C to D is where the Lambda is invoked from (NestJS
post-sync vs SFN Map state).

### Options A and B: ruled out

Both are **definitively ruled out** as fixes for OOM. They move metric computation to
post-sync time but keep it in the same heap at its peak occupancy. Option B was the
previous recommendation; it is revised here because the OOM constraint was not fully
weighted in the initial analysis.

Options A and B remain valid for the schema they introduce (the `dora_snapshots` table)
and for the API read path (snapshot-first, pending-response if absent). That infrastructure
is required by Options C and D.

---

## Quick-Wins Applicable Regardless of Option Chosen

These are low-risk, immediately applicable, and beneficial under all remaining viable options.

### QW-1: Explicit App Runner request timeout in Terraform

Set `request_timeout_seconds = 120` explicitly on the backend App Runner service in Terraform.
Currently this relies on the AWS default, which is fragile to future provider updates.

### QW-2: Raise CloudFront origin timeout to 60s for API paths

Set `origin_response_timeout = 60` in the `cdn` Terraform module for the backend distribution.
The default is 30 seconds. Even with snapshot reads, this provides headroom for cold DB
connections on the first request after App Runner scales up.

### QW-3: Add `GET /api/metrics/dora/snapshot/status` endpoint

Returns `{ boardId, snapshotAge: number, isStale: boolean, computedAt: Date | null }` per
board. Allows the frontend to show "data last computed X minutes ago" and distinguish
"no snapshot yet — sync required" from a server error. Prevents the browser from showing
an indefinite spinner.

### QW-4: Add CloudWatch alarm on App Runner memory utilisation

Set a CloudWatch alarm at 85% `container_memory_utilization` on the backend App Runner
service. This gives early warning before the next OOM crash rather than discovering it
from user reports.

### QW-5: Add CloudWatch alarm on container exit code 137

App Runner emits deployment events to CloudWatch. Configure a metric filter on
`exit code 137` in the App Runner service log group to trigger an SNS notification.
This makes OOM crashes immediately visible rather than discovered retrospectively.

---

## Impact Assessment (for Option C, the recommended near-term fix)

| Area | Impact | Notes |
|---|---|---|
| Database | New `dora_snapshots` table (1 migration) | ~50–200 KB JSONB per board; reversible migration required |
| API contract | Additive only | `GET /api/metrics/dora/snapshot/status` is new; existing endpoints unchanged in shape |
| Frontend | None | Existing DORA page works unchanged against snapshot-backed endpoints |
| Tests | New unit tests for Lambda handler; existing metric service tests unchanged | Lambda handler is plain TypeScript — no NestJS test infrastructure needed |
| Jira API | No new calls | Lambda reads from RDS only |
| Cost | ~$0 incremental (Lambda free tier) | Step 1 (instance upsize) adds ~$10–20/mo as a stopgap |
| Operational complexity | Low-medium | One new Lambda deployment artefact + Terraform resources |
| App Runner instance | Can revert to 1 vCPU / 2 GB once Option C is deployed | Option F upsize is a temporary bridge |

---

## Open Questions

1. **Is sync itself currently causing OOM, or only the concurrent sync + metric calculation?**
   Check App Runner CloudWatch memory metrics during a sync window with no concurrent
   API requests (e.g. trigger `POST /api/sync` at a time when the DORA page is not open).
   If sync alone stays under 1400 MB, Option C is sufficient and the instance can revert
   to 1 vCPU / 2 GB after Step 2. If sync alone exceeds 1800 MB, Option D (or Option F
   permanently) is needed.

2. **Lambda package structure**: should the Lambda handler live in `backend/src/lambda/`
   (importing TypeORM entities and metric services directly) or in a separate
   `packages/snapshot-worker/` directory? The former is simpler for the current monorepo
   structure; the latter is cleaner if Option D is anticipated. Recommendation: start with
   `backend/src/lambda/snapshot.handler.ts` and extract to a package if/when Option D
   is implemented.

3. **Snapshot scope for trend**: should the snapshot cover the most recent 8 quarters
   (hardcoded) or be configurable? A fixed 8-quarter scope bounds Lambda execution time
   and RDS query size predictably. Recommendation: 8 quarters fixed; revisit if the UI
   ever exposes a longer range selector.

4. **`BoardConfig` change invalidation**: when a user changes board config (done statuses,
   failure types), the snapshot is stale. Options: (a) trigger immediate Lambda recompute
   on config PUT, (b) mark snapshot stale and let the next sync refresh it, (c) store
   a config hash in the snapshot and compare on read. Recommendation: option (a) — call
   `lambda.invoke({ boardId })` in the board config PUT handler. This ensures the DORA
   page reflects config changes immediately without waiting 30 minutes.

5. **RDS connectivity from Lambda**: the Lambda must be in the same VPC private subnet as
   the App Runner backend and must have an inbound security group rule from the Lambda's
   security group on port 5432 of the RDS security group. Confirm the existing
   `fragile-rds-sg` security group allows inbound from a new `fragile-lambda-sg`, or
   whether the existing `fragile-apprunner-connector-sg` can be reused.

---

## Acceptance Criteria (for the recommended two-step implementation)

### Step 1 — Option F (instance upsize)
- [ ] `apprunner/main.tf` updated: `cpu = "2048"`, `memory = "4096"`.
- [ ] `backend/Dockerfile` updated: `--max-old-space-size=3600`.
- [ ] `terraform apply` succeeds; App Runner service shows new instance configuration.
- [ ] No OOM crashes observed in App Runner logs during a manual sync cycle.

### Step 2 — Option C (Lambda snapshot computation)
- [ ] `DoraSnapshot` entity and reversible TypeORM migration (up + down) committed.
- [ ] Lambda handler `snapshot.handler.ts` builds as a standalone Node.js bundle.
- [ ] Lambda is deployed via Terraform with correct VPC subnet, security group, timeout
      (60s), and memory (512 MB minimum).
- [ ] `SyncService.syncBoard()` invokes the Lambda asynchronously after changelog sync
      completes; failure of Lambda invocation is logged but does not fail the sync.
- [ ] `GET /api/metrics/dora/aggregate` and `GET /api/metrics/dora/trend` read from
      `dora_snapshots`; return HTTP 202 with `{ status: 'pending' }` when no snapshot
      exists for a board.
- [ ] `PUT /api/boards/:boardId/config` triggers Lambda recompute for that board.
- [ ] `GET /api/metrics/dora/snapshot/status` returns snapshot age and staleness per board.
- [ ] Unit tests cover the Lambda handler with mocked TypeORM repositories.
- [ ] Integration test: trigger sync → wait for Lambda completion → verify snapshot row
      exists in `dora_snapshots` with correct `boardId` and recent `computedAt`.
- [ ] App Runner instance can be reverted to 1 vCPU / 2 GB (or left at 2 vCPU / 4 GB
      per monitoring data) — this is a post-deploy decision, not a pre-deploy blocker.
- [ ] All existing Jest tests for metric services pass without modification.
- [ ] `dora_snapshots` migration implements both `up()` and `down()`.
