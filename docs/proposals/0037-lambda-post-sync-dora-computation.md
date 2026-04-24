# 0037 — Lambda Post-Sync DORA Snapshot Computation

**Date:** 2026-04-23
**Status:** Accepted — implemented on branch `feat/lambda-snapshot-worker`
**Author:** Architect Agent
**Related ADRs:** ADR-0032, ADR-0033, ADR-0036, ADR-0037
**Approved option from:** [0036 — DORA Page Reliability Options Analysis](0036-dora-page-reliability-options.md) — Step 2, Option C

---

## Problem Statement

The DORA metrics page crashes the App Runner backend process with OOM kills (exit 137) when
metric computation runs in the same Node.js heap as a Jira sync. The two workloads — sync
(Jira API responses + bulk entity arrays) and computation (`TrendDataLoader` bulk reads across
8 quarters per board) — each independently approach the 1800 MB heap cap. When they overlap,
the combined peak exceeds it and the process dies.

This proposal specifies the implementation of **Option C** from proposal 0036: a small Lambda
function that is invoked asynchronously after each board's sync completes, reads from RDS, and
writes pre-computed DORA results to a `dora_snapshots` table. App Runner API endpoints then
read from the snapshot table rather than computing on request. The two large memory workloads
(sync and computation) are permanently separated into different processes.

This is **Step 2** of the two-step plan in 0036. Step 1 (instance upsize to 2 vCPU / 4 GB as
a stopgap) is tracked separately and is expected to already be deployed before this work begins.

---

## Scope of This Proposal

The following areas are designed in full here. All must be implemented together as a single
deployable unit — partial deployment (e.g. deploying the Lambda without updating the API read
path) leaves the system in a mixed state.

1. `dora_snapshots` database entity and TypeORM migration
2. Lambda function design, package structure, and handler
3. Invocation mechanism from `SyncService`
4. DORA API endpoint read-path changes
5. Board config change invalidation
6. Terraform infrastructure: new `lambda` module
7. IAM changes: App Runner task role, Lambda execution role
8. Network: Lambda VPC configuration and security groups
9. CI/CD build and deployment
10. Local development strategy
11. Rollout sequence and rollback plan

---

## Current Architecture (Relevant Excerpt)

```
SyncService.syncAll()
  └── for each boardId:
        syncBoard(boardId)                    ← Jira API calls, entity arrays, bulk upserts
        │                                       heap spike here (Jira responses + upsert buffers)
        └── [synchronous in same heap]
              triggerSprintReportsForBoard()   ← fire-and-forget within same process

GET /api/metrics/dora/trend
  └── MetricsService.getDoraTrend()
        └── TrendDataLoader.load(boardId, rangeStart, rangeEnd)
              ├── issueRepo.find({ where: { boardId } })       ← all board issues
              ├── changelogRepo.createQueryBuilder()            ← all status changelogs in range
              ├── versionRepo.find()                            ← all released versions in range
              └── issueLinkRepo.find()                          ← all issue links for board
              [then 4× calculateFromData() per period — 8 periods per trend]
```

The OOM crash occurs when a metric request arrives while `syncBoard()` is in-flight, causing
the two working sets to coexist in the same heap.

---

## Proposed Architecture

```
SyncService.syncBoard(boardId)          ← unchanged: Jira API, bulk upserts, sprint reports
  └── after syncLogRepo.save(syncLog):
        lambdaInvoker.invoke(boardId)   ← fire-and-forget, no await
        └── AWS Lambda: InvocationType=Event (async)

Lambda: fragile-dora-snapshot (Node.js 20, 512 MB, 120s timeout)
  handler({ boardId })
    ├── TypeORM DataSource.initialize()
    ├── TrendDataLoader.load(boardId, rangeStart, rangeEnd)   ← RDS only, no Jira API
    ├── [4× calculateFromData() × 8 quarters]
    └── DoraSnapshotRepository.upsert({ boardId, ... })

GET /api/metrics/dora/aggregate        ← reads dora_snapshots (fast, negligible memory)
GET /api/metrics/dora/trend            ← reads dora_snapshots (fast, negligible memory)

PUT /api/boards/:boardId/config
  └── boardConfigRepo.save(config)
        lambdaInvoker.invoke(boardId)   ← also triggers recompute on config change
```

**Memory separation guarantee:** By the time the Lambda reads RDS, `syncBoard()` has returned
and the App Runner process has GC'd the Jira API response buffers and bulk-upsert arrays for
that board. The sync working set and the computation working set never coexist in any single
process.

---

## Detailed Design

### 1. `dora_snapshots` Table

#### Purpose

One row per `(boardId, snapshotType)` pair. `snapshotType` is an enum string discriminating
the two shapes of data the DORA page needs:

- `'aggregate'` — the result of `getDoraAggregate()` for the board's most recent full quarter:
  all four metric results, band classifications, trend-across-periods array.
- `'trend'` — the result of `getDoraTrend()` across 8 quarters.

A single JSONB `payload` column stores the full serialised result. This avoids columnar schema
sprawl as the shape of metric results evolves (new fields can be added to the JSON without a
migration). The snapshot is opaque to Postgres — it is read and written as a unit.

> **Design trade-off:** A columnar schema (one column per metric per period) would allow
> Postgres to query individual metrics without deserialising the full JSON. At current scale
> (6 boards, < 200 KB per snapshot) the JSONB read cost is negligible and the schema
> flexibility outweighs the query optimisation. Revisit if board count exceeds ~50.

#### TypeORM Entity

```typescript
// backend/src/database/entities/dora-snapshot.entity.ts

import {
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type DoraSnapshotType = 'aggregate' | 'trend';

@Entity('dora_snapshots')
@Index(['boardId'])
export class DoraSnapshot {
  /**
   * Composite primary key: one row per board per snapshot type.
   * boardId: e.g. 'ACC', 'PLAT'
   */
  @PrimaryColumn()
  boardId!: string;

  @PrimaryColumn()
  snapshotType!: DoraSnapshotType;

  /**
   * The full serialised result from MetricsService.getDoraAggregate() or
   * MetricsService.getDoraTrend().  Stored as JSONB for efficient read and
   * optional future Postgres-side querying.
   */
  @Column({ type: 'jsonb' })
  payload!: object;

  /**
   * Wall-clock timestamp when this snapshot was last computed.
   * Used by the API to attach staleness metadata to the response.
   */
  @UpdateDateColumn({ type: 'timestamptz' })
  computedAt!: Date;

  /**
   * The boardId of the sync that triggered this computation.
   * Matches SyncLog.boardId for correlation in debugging.
   */
  @Column({ type: 'varchar' })
  triggeredBy!: string;

  /**
   * Whether this snapshot is considered stale.  Set to true by the API layer
   * when computedAt is older than 2× the sync interval (1 hour).
   * Computed at read time — not stored.  This column is reserved for future
   * use (e.g. explicit invalidation on board config change before recompute
   * has completed).
   */
  @Column({ default: false })
  stale!: boolean;
}
```

Export from `backend/src/database/entities/index.ts`:
```typescript
export { DoraSnapshot } from './dora-snapshot.entity.js';
export type { DoraSnapshotType } from './dora-snapshot.entity.js';
```

#### Migration

New file: `backend/src/migrations/XXXXXXXXXX-AddDoraSnapshotsTable.ts`

```typescript
import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddDoraSnapshotsTable1234567890123 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'dora_snapshots',
        columns: [
          { name: 'boardId',      type: 'varchar',      isPrimary: true },
          { name: 'snapshotType', type: 'varchar',      isPrimary: true },
          { name: 'payload',      type: 'jsonb',        isNullable: false },
          { name: 'computedAt',   type: 'timestamptz',  default: 'now()' },
          { name: 'triggeredBy',  type: 'varchar',      isNullable: false },
          { name: 'stale',        type: 'boolean',      default: false },
        ],
      }),
      true, // ifNotExists
    );

    await queryRunner.createIndex(
      'dora_snapshots',
      new TableIndex({
        name: 'IDX_dora_snapshots_boardId',
        columnNames: ['boardId'],
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('dora_snapshots', 'IDX_dora_snapshots_boardId');
    await queryRunner.dropTable('dora_snapshots', true);
  }
}
```

**Migration rules:**
- `up()` and `down()` are both implemented (project standard).
- `ifNotExists: true` makes `up()` safe to re-run.
- Migration is generated via TypeORM CLI (`npm run migration:generate`) then reviewed manually
  before commit. The entity definition above drives generation.

---

### 2. Lambda Function Design

#### Package Location

The Lambda handler lives at:

```
backend/src/lambda/snapshot.handler.ts
```

**Rationale for `backend/src/lambda/` rather than a separate `packages/snapshot-worker/`:**

The four metric services (`DeploymentFrequencyService`, `LeadTimeService`, `CfrService`,
`MttrService`), `TrendDataLoader`, `WorkingTimeService`, `dora-bands.ts`, `statistics.ts`,
and all TypeORM entities are already compiled TypeScript in `backend/`. The Lambda handler
needs all of them. Placing the handler inside `backend/src/lambda/` means:

- It is compiled by the same `tsc` invocation as the NestJS app (`backend/tsconfig.json`).
- It imports entities and services via relative paths — no package boundary, no duplication.
- A Lambda deployment package is a zip of `backend/dist/` — the same build output.
- If/when Option D (Step Functions) is adopted, the handler moves to a new package at that
  point. The cost of the eventual refactor is small compared to the premature extraction cost.

**Critical point:** The metric services use NestJS `@Injectable()` and `@InjectRepository()`
decorators. These are decorators only — they do not prevent the classes from being instantiated
directly with `new`. The Lambda handler will **not** bootstrap a NestJS `AppModule`; it will
create a TypeORM `DataSource` and instantiate the services manually with repository references.
This is safe because the services contain no NestJS lifecycle hooks (`onModuleInit` etc.) — they
are pure constructor-injection classes.

#### Handler: `backend/src/lambda/snapshot.handler.ts`

The handler performs four responsibilities on each invocation:

1. **Fetch DB password** from Secrets Manager (once per cold start, cached module-scope).
2. **Load a `TrendDataSlice`** for the triggering board covering the last 8 quarters.
3. **Compute per-board + org-level snapshots** — 4 rows upserted per invocation.
4. **Upsert to `dora_snapshots`** on composite PK `(boardId, snapshotType)`.

```typescript
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  JiraIssue, JiraChangelog, JiraVersion, BoardConfig, JiraIssueLink,
  WorkingTimeConfigEntity, DoraSnapshot, JiraFieldConfig, JiraSprint,
  SyncLog, RoadmapConfig, JpdIdea, SprintReport,
} from '../database/entities/index.js';
import { TrendDataLoader } from '../metrics/trend-data-loader.service.js';
import { DeploymentFrequencyService } from '../metrics/deployment-frequency.service.js';
import { LeadTimeService } from '../metrics/lead-time.service.js';
import { CfrService } from '../metrics/cfr.service.js';
import { MttrService } from '../metrics/mttr.service.js';
import { WorkingTimeService } from '../metrics/working-time.service.js';
import { listRecentQuarters } from '../metrics/period-utils.js';

export interface SnapshotHandlerEvent {
  boardId: string;
  quartersBack?: number;   // defaults to 8
}

/** Snapshot key for the org-level (all boards) aggregate and trend. */
export const ORG_SNAPSHOT_KEY = '__org__';

// ── Module-scope singletons (reused across warm invocations) ─────────────────

let dataSource: DataSource | null = null;
let cachedDbPassword: string | null = null;

async function getDbPassword(): Promise<string> {
  if (cachedDbPassword) return cachedDbPassword;
  const secretArn = process.env['DB_PASSWORD_SECRET_ARN'];
  if (!secretArn) throw new Error('DB_PASSWORD_SECRET_ARN is not set');
  const client = new SecretsManagerClient({ region: process.env['AWS_REGION'] ?? 'ap-southeast-2' });
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!SecretString) throw new Error('Secret has no string value');
  cachedDbPassword = SecretString;
  return cachedDbPassword;
}

async function getDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;
  const password = await getDbPassword();
  dataSource = new DataSource({
    type: 'postgres',
    host:     process.env['DB_HOST'] ?? 'localhost',
    port:     parseInt(process.env['DB_PORT'] ?? '5432', 10),
    username: process.env['DB_USERNAME'] ?? 'postgres',
    password,
    database: process.env['DB_DATABASE'] ?? 'ai_starter',
    ssl: process.env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
    entities: [
      JiraIssue, JiraChangelog, JiraVersion, BoardConfig, JiraIssueLink,
      WorkingTimeConfigEntity, DoraSnapshot, JiraFieldConfig, JiraSprint,
      SyncLog, RoadmapConfig, JpdIdea, SprintReport,
    ],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event: SnapshotHandlerEvent): Promise<void> => {
  const { boardId, quartersBack = 8 } = event;
  console.log(`[snapshot-handler] Starting DORA snapshot for board: ${boardId}`);

  const ds = await getDataSource();

  const issueRepo       = ds.getRepository(JiraIssue);
  const changelogRepo   = ds.getRepository(JiraChangelog);
  const versionRepo     = ds.getRepository(JiraVersion);
  const boardConfigRepo = ds.getRepository(BoardConfig);
  const issueLinkRepo   = ds.getRepository(JiraIssueLink);
  const snapshotRepo    = ds.getRepository(DoraSnapshot);
  const wtConfigRepo    = ds.getRepository(WorkingTimeConfigEntity);

  // WorkingTimeService requires a ConfigService for TIMEZONE. In Lambda,
  // provide a minimal stub reading from process.env directly.
  const configServiceStub = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const val = process.env[key];
      return val !== undefined ? (val as unknown as T) : defaultValue;
    },
  };
  const workingTimeService = new WorkingTimeService(
    wtConfigRepo,
    configServiceStub as unknown as import('@nestjs/config').ConfigService,
  );

  const trendLoader = new TrendDataLoader(
    issueRepo, changelogRepo, versionRepo, boardConfigRepo, issueLinkRepo, workingTimeService,
  );
  const dfService   = new DeploymentFrequencyService(issueRepo, versionRepo, changelogRepo, boardConfigRepo);
  const ltService   = new LeadTimeService(issueRepo, changelogRepo, versionRepo, boardConfigRepo, workingTimeService);
  const cfrService  = new CfrService(issueRepo, changelogRepo, versionRepo, boardConfigRepo, issueLinkRepo);
  const mttrService = new MttrService(issueRepo, changelogRepo, boardConfigRepo);

  // Compute the trend window: last N quarters (newest first)
  const quarters   = listRecentQuarters(quartersBack);
  const rangeStart = quarters[quarters.length - 1].startDate;
  const rangeEnd   = quarters[0].endDate;

  // ── Per-board snapshot ───────────────────────────────────────────────────
  const boardSlice = await trendLoader.load(boardId, rangeStart, rangeEnd);

  const latestQuarter    = quarters[0];
  const boardAggregate   = {
    period: latestQuarter.label, startDate: latestQuarter.startDate, endDate: latestQuarter.endDate,
    df:   dfService.calculateFromData(boardSlice, latestQuarter.startDate, latestQuarter.endDate),
    lt:   ltService.getLeadTimeObservationsFromData(boardSlice, latestQuarter.startDate, latestQuarter.endDate),
    cfr:  cfrService.calculateFromData(boardSlice, latestQuarter.startDate, latestQuarter.endDate),
    mttr: mttrService.getMttrObservationsFromData(boardSlice, latestQuarter.startDate, latestQuarter.endDate),
  };
  const boardTrend = quarters.map((q) => ({
    period: q.label, startDate: q.startDate, endDate: q.endDate,
    df:   dfService.calculateFromData(boardSlice, q.startDate, q.endDate),
    lt:   ltService.getLeadTimeObservationsFromData(boardSlice, q.startDate, q.endDate),
    cfr:  cfrService.calculateFromData(boardSlice, q.startDate, q.endDate),
    mttr: mttrService.getMttrObservationsFromData(boardSlice, q.startDate, q.endDate),
  }));

  // ── Org-level snapshot (all boards) ─────────────────────────────────────
  // Guard: if no board configs exist, skip org snapshot rather than passing
  // an empty boardId string which would crash the loader.
  const configs = await boardConfigRepo.find({ select: ['boardId'] });
  if (configs.length > 0) {
    const allBoardIds = configs.map((c) => c.boardId);
    // Reuse already-fetched boardSlice for the triggering board to avoid a
    // duplicate DB query; load remaining boards in one merged pass.
    const allBoardIdStr = allBoardIds.join(',');
    const orgSlice = await trendLoader.load(allBoardIdStr, rangeStart, rangeEnd);

    const orgAggregate = {
      period: latestQuarter.label, startDate: latestQuarter.startDate, endDate: latestQuarter.endDate,
      df:   dfService.calculateFromData(orgSlice, latestQuarter.startDate, latestQuarter.endDate),
      lt:   ltService.getLeadTimeObservationsFromData(orgSlice, latestQuarter.startDate, latestQuarter.endDate),
      cfr:  cfrService.calculateFromData(orgSlice, latestQuarter.startDate, latestQuarter.endDate),
      mttr: mttrService.getMttrObservationsFromData(orgSlice, latestQuarter.startDate, latestQuarter.endDate),
    };
    const orgTrend = quarters.map((q) => ({
      period: q.label, startDate: q.startDate, endDate: q.endDate,
      df:   dfService.calculateFromData(orgSlice, q.startDate, q.endDate),
      lt:   ltService.getLeadTimeObservationsFromData(orgSlice, q.startDate, q.endDate),
      cfr:  cfrService.calculateFromData(orgSlice, q.startDate, q.endDate),
      mttr: mttrService.getMttrObservationsFromData(orgSlice, q.startDate, q.endDate),
    }));

    await snapshotRepo.upsert([
      { boardId,            snapshotType: 'aggregate', payload: boardAggregate, triggeredBy: boardId, stale: false },
      { boardId,            snapshotType: 'trend',     payload: boardTrend,     triggeredBy: boardId, stale: false },
      { boardId: ORG_SNAPSHOT_KEY, snapshotType: 'aggregate', payload: orgAggregate, triggeredBy: boardId, stale: false },
      { boardId: ORG_SNAPSHOT_KEY, snapshotType: 'trend',     payload: orgTrend,     triggeredBy: boardId, stale: false },
    ], ['boardId', 'snapshotType']);
  } else {
    // No board configs yet — write only the triggering board's snapshots.
    await snapshotRepo.upsert([
      { boardId, snapshotType: 'aggregate', payload: boardAggregate, triggeredBy: boardId, stale: false },
      { boardId, snapshotType: 'trend',     payload: boardTrend,     triggeredBy: boardId, stale: false },
    ], ['boardId', 'snapshotType']);
  }

  console.log(`[snapshot-handler] Snapshot written for board: ${boardId}`);
  // DataSource remains open — reused on next warm invocation.
};
```

**Key implementation notes:**

- `DB_PASSWORD` is **not** stored as a plain Lambda environment variable. The handler fetches
  it from Secrets Manager using `DB_PASSWORD_SECRET_ARN` on the first cold start and caches it
  module-scope. The Lambda execution role must have `secretsmanager:GetSecretValue` on the
  secret ARN (granted via the Terraform `lambda_secrets` IAM policy).
- **4 rows upserted per invocation** (not 2): per-board `aggregate` + `trend`, plus
  org-level (`__org__`) `aggregate` + `trend`. The org-level snapshot powers the "All boards"
  view on the DORA page.
- **Empty board config guard**: if `boardConfigRepo.find()` returns no rows (e.g. first deploy
  before any board is configured), the org snapshot is skipped rather than crashing with an
  empty `boardId` string passed to `trendLoader.load()`.
- Quarter utility: `listRecentQuarters(n)` from `backend/src/metrics/period-utils.ts`
  (not the previously proposed `getLastNQuarters` — that function does not exist).
- `WorkingTimeService` requires a `ConfigService` for the `TIMEZONE` env var. In Lambda, a
  minimal stub reading directly from `process.env` is constructed inline.
- `@aws-sdk/client-secrets-manager` is added to `backend/package.json` as a production
  dependency.

#### Environment Variables Required by the Lambda

| Variable | Source | Notes |
|---|---|---|
| `DB_HOST` | Plain env var | RDS endpoint — same value as App Runner's `DB_HOST` |
| `DB_PORT` | Plain env var | `5432` |
| `DB_USERNAME` | Plain env var | `postgres` |
| `DB_PASSWORD` | Secrets Manager (via Lambda env secret) | Same secret ARN as App Runner |
| `DB_DATABASE` | Plain env var | `fragile` |
| `DB_SSL` | Plain env var | `'true'` in production (RDS enforces SSL) |

The Lambda does **not** need `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_USER_EMAIL`, or
`FRONTEND_URL`. It never calls the Jira API.

#### Timeout and Memory

| Setting | Value | Rationale |
|---|---|---|
| Memory | `512 MB` | `TrendDataLoader` for the largest board (PLAT, up to ~1000 issues) loads issues, changelogs, versions, and links — measured at < 150 MB in App Runner; 512 MB is 3× headroom. |
| Timeout | `120 seconds` | Conservative. Expected duration: 10–30 seconds per board at current scale. Allows headroom if PLAT grows significantly. |
| Reserved concurrency | Not set | Default (unreserved). At most 6 invocations per sync cycle. Fine at this scale. |

---

### 3. Invocation Mechanism

#### `LambdaInvokerService`

A new injectable service in `backend/src/lambda/lambda-invoker.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from '@aws-sdk/client-lambda';
import type { SnapshotHandlerEvent } from './snapshot.handler.js';

@Injectable()
export class LambdaInvokerService {
  private readonly logger = new Logger(LambdaInvokerService.name);
  private readonly client: LambdaClient | null;
  private readonly functionName: string | null;

  constructor(private readonly config: ConfigService) {
    // USE_LAMBDA is opt-in: only active when explicitly set to the string 'true'.
    // Unset or any other value defaults to in-process mode (safe for local dev).
    const useLambda = config.get<string>('USE_LAMBDA') === 'true';
    this.functionName = config.get<string>('DORA_SNAPSHOT_LAMBDA_NAME') ?? null;

    if (useLambda && this.functionName) {
      this.client = new LambdaClient({
        region: config.get<string>('AWS_REGION') ?? 'ap-southeast-2',
      });
    } else {
      this.client = null;
      if (useLambda && !this.functionName) {
        // USE_LAMBDA=true but no function name — skip Lambda and warn.
        // Falling back to in-process would reintroduce OOM risk in production,
        // so we skip and warn rather than silently fall back.
        this.logger.warn(
          'USE_LAMBDA=true but DORA_SNAPSHOT_LAMBDA_NAME is not set. ' +
          'DORA snapshot invocation is disabled for this boot.',
        );
      }
    }
  }

  async invokeSnapshotWorker(boardId: string): Promise<void> {
    if (!this.client || !this.functionName) {
      this.logger.debug(
        `Lambda invocation skipped for board ${boardId} (USE_LAMBDA=false or function not configured).`,
      );
      return;
    }

    const payload: SnapshotHandlerEvent = { boardId };

    try {
      await this.client.send(
        new InvokeCommand({
          FunctionName:   this.functionName,
          InvocationType: InvocationType.Event, // async fire-and-forget
          Payload:        Buffer.from(JSON.stringify(payload)),
        }),
      );
      this.logger.debug(`Invoked DORA snapshot Lambda for board: ${boardId}`);
    } catch (err) {
      // Invocation failure is non-fatal: sync has already succeeded.
      // The snapshot will be stale until the next sync; the API returns
      // the stale snapshot with a warning header.
      this.logger.warn(
        `Failed to invoke DORA snapshot Lambda for board ${boardId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
```

**Key design points:**

- `InvocationType.Event` — async, fire-and-forget. `client.send()` returns as soon as Lambda
  acknowledges the invocation (typically < 100 ms). The App Runner process does not wait for
  the Lambda to complete.
- Failure is caught and logged as a warning. Sync result is unaffected.
- `USE_LAMBDA === 'true'` (opt-in) — Lambda mode is only active when this env var is
  explicitly set to the string `'true'`. Unset or any other value → in-process mode.
  This prevents accidental Lambda invocations in local dev or CI where the function does
  not exist.
- `AWS_REGION` is read from config — consistent with all other AWS SDK usage.

#### Wiring `LambdaInvokerService` into `SyncService`

Add `LambdaInvokerService` to `SyncModule`:

```typescript
// backend/src/sync/sync.module.ts (additions)
import { LambdaInvokerService } from '../lambda/lambda-invoker.service.js';

@Module({
  providers: [SyncService, LambdaInvokerService],
  ...
})
export class SyncModule {}
```

Inject into `SyncService` constructor:

```typescript
constructor(
  // ... existing injections ...
  private readonly lambdaInvoker: LambdaInvokerService,
) {}
```

Call after `syncLogRepo.save(syncLog)` at the end of `syncBoard()`:

```typescript
// At the end of SyncService.syncBoard(), after saving the sync log:
const savedLog = await this.syncLogRepo.save(syncLog);

// Fire-and-forget Lambda invocation — sync result is already persisted.
// No await: Lambda runs asynchronously. Failure is logged, never thrown.
this.lambdaInvoker.invokeSnapshotWorker(boardId).catch(() => {
  // Already handled/logged inside invokeSnapshotWorker.
});

return savedLog;
```

The `.catch()` is belt-and-suspenders: `invokeSnapshotWorker` already handles all errors
internally. It ensures `syncBoard()` never rejects due to Lambda invocation.

#### Board Config Change Invalidation

When `PUT /api/boards/:boardId/config` updates a board's configuration (done statuses, failure
issue types, etc.), the existing snapshot for that board is immediately stale. Re-trigger:

```typescript
// backend/src/boards/boards.service.ts (additions)
constructor(
  // ... existing ...
  private readonly lambdaInvoker: LambdaInvokerService,
) {}

async updateConfig(boardId: string, dto: UpdateBoardConfigDto): Promise<BoardConfig> {
  const config = await this.boardConfigRepo.save({ boardId, ...dto });

  // Invalidate snapshot immediately — config change affects all metric results.
  this.lambdaInvoker.invokeSnapshotWorker(boardId).catch(() => {});

  return config;
}
```

`LambdaInvokerService` must be added to `BoardsModule`'s providers.

---

### 4. DORA API Endpoint Read-Path Changes

#### Decision: Snapshot-first with stale-data fallback (no live computation on miss)

The current `MetricsService.getDoraTrend()` and `getDoraAggregate()` call `TrendDataLoader`
on every request. These are the memory-expensive paths that cause OOM under concurrent sync.
After this proposal, these methods are redirected to read from `dora_snapshots`.

**Fallback strategy (open question for user — see §Open Questions):** The recommended approach
is **stale-data-with-header**, not live-computation fallback. A live-computation fallback is
the only option that would cause OOM under concurrent sync — the failure mode we are trying to
eliminate. The options:

| Strategy | Pros | Cons |
|---|---|---|
| **A. Stale snapshot + `X-Snapshot-Stale: true` header** (recommended) | Always fast. No OOM risk. Frontend can show "data from X minutes ago". | Users see old data if Lambda fails silently. |
| **B. HTTP 202 `{ status: 'pending' }` when no snapshot exists** | Explicit signal to frontend. | First sync after deploy returns 202 until Lambda runs once (~15s wait). |
| **C. Live-computation fallback** | No gap on first deploy. | Reintroduces OOM risk if Lambda fails and sync is concurrent. Defeats purpose. |

**Recommendation: Strategy A for stale snapshots, Strategy B for absent snapshots.** These are
different cases:

- **No snapshot at all** (`dora_snapshots` row does not exist for this board): return HTTP 202
  with `{ status: 'pending', message: 'Snapshot not yet computed. Trigger a sync.' }`.
- **Snapshot exists but is stale** (age > 2× sync interval = 60 minutes): return the snapshot
  payload with `X-Snapshot-Stale: true` and `X-Snapshot-Age: <seconds>` headers.
- **Snapshot fresh**: return payload with `X-Snapshot-Age: <seconds>` header (always present).

Staleness threshold: 60 minutes (2× the 30-minute sync interval). Configurable via
`SNAPSHOT_STALE_THRESHOLD_MINUTES` env var; default 60.

#### New `DoraSnapshotReadService`

```typescript
// backend/src/metrics/dora-snapshot-read.service.ts

@Injectable()
export class DoraSnapshotReadService {
  constructor(
    @InjectRepository(DoraSnapshot)
    private readonly snapshotRepo: Repository<DoraSnapshot>,
    private readonly config: ConfigService,
  ) {}

  async getSnapshot(
    boardId: string,
    snapshotType: DoraSnapshotType,
  ): Promise<{ payload: object; ageSeconds: number; stale: boolean } | null> {
    const row = await this.snapshotRepo.findOne({
      where: { boardId, snapshotType },
    });
    if (!row) return null;

    const ageSeconds = Math.floor(
      (Date.now() - row.computedAt.getTime()) / 1000,
    );
    const staleThresholdSeconds =
      (this.config.get<number>('SNAPSHOT_STALE_THRESHOLD_MINUTES') ?? 60) * 60;
    const stale = ageSeconds > staleThresholdSeconds;

    return { payload: row.payload, ageSeconds, stale };
  }
}
```

#### Updated Controller Methods

```typescript
// backend/src/metrics/metrics.controller.ts (updated aggregate + trend endpoints)

@Get('dora/aggregate')
async getDoraAggregate(
  @Query() query: DoraAggregateQueryDto,
  @Res({ passthrough: true }) res: Response,
): Promise<OrgDoraResult | { status: string; message: string }> {
  const snapshot = await this.doraSnapshotReadService.getSnapshot(
    query.boardId, 'aggregate',
  );

  if (!snapshot) {
    res.status(202);
    return { status: 'pending', message: 'Snapshot not yet computed. Trigger a sync.' };
  }

  if (snapshot.stale) {
    res.setHeader('X-Snapshot-Stale', 'true');
  }
  res.setHeader('X-Snapshot-Age', String(snapshot.ageSeconds));

  return snapshot.payload as OrgDoraResult;
}

@Get('dora/trend')
async getDoraTrend(
  @Query() query: DoraTrendQueryDto,
  @Res({ passthrough: true }) res: Response,
): Promise<TrendResponse | { status: string; message: string }> {
  const snapshot = await this.doraSnapshotReadService.getSnapshot(
    query.boardId, 'trend',
  );

  if (!snapshot) {
    res.status(202);
    return { status: 'pending', message: 'Snapshot not yet computed. Trigger a sync.' };
  }

  if (snapshot.stale) {
    res.setHeader('X-Snapshot-Stale', 'true');
  }
  res.setHeader('X-Snapshot-Age', String(snapshot.ageSeconds));

  return snapshot.payload as TrendResponse;
}
```

#### New Snapshot Status Endpoint

```
GET /api/metrics/dora/snapshot/status
```

Response:
```json
[
  {
    "boardId": "ACC",
    "snapshotAge": 1234,
    "isStale": false,
    "computedAt": "2026-04-23T12:00:00.000Z",
    "hasAggregate": true,
    "hasTrend": true
  },
  {
    "boardId": "PLAT",
    "snapshotAge": null,
    "isStale": null,
    "computedAt": null,
    "hasAggregate": false,
    "hasTrend": false
  }
]
```

This endpoint is unguarded (consistent with the project's no-auth model). The frontend uses
it to display "data last computed X minutes ago" and to distinguish "pending" from "error"
states. It also allows the user to trigger a sync from the UI when snapshots are absent.

#### Existing Endpoints Unchanged

`GET /api/metrics/dora`, `GET /api/metrics/deployment-frequency`,
`GET /api/metrics/lead-time`, `GET /api/metrics/cfr`, `GET /api/metrics/mttr` — these legacy
single-board endpoints still compute on demand. They are not used by the DORA page's primary
`aggregate` and `trend` calls. They may be deprecated in a future cleanup proposal.

---

### 5. Infrastructure: Terraform `lambda` Module

#### Module Location

New directory: `infra/terraform/modules/lambda/`

Files:
```
infra/terraform/modules/lambda/
  main.tf
  variables.tf
  outputs.tf
```

#### `infra/terraform/modules/lambda/main.tf`

The implemented Terraform module diverges from the original S3-based design in one important
way: **the zip is built by `make lambda-build` and deployed directly from disk** (no S3
bucket). This separates build concerns from infrastructure concerns — Terraform only deploys
a zip that already exists; it does not build it.

Key implementation details that differ from the original design:

**Build step moved to Makefile:** `null_resource` + `local-exec` was removed because
`filebase64sha256()` is evaluated at plan time, before any provisioner runs. On a clean
checkout the zip does not exist yet, so the hash bakes in as `""` and Terraform wants to
re-update the function on every subsequent plan (two-apply problem). The `make lambda-build`
target produces the zip at a deterministic path before `terraform apply` is invoked:
```
make lambda-build   # compile + package
make tf-apply       # deploy (zip already present, hash is real)
# or:
make deploy         # chains both
```

**Zip location:** The zip is written to `backend/snapshot-worker.zip` — intentionally
**outside** `backend/dist/` so that `nest build` (which sets `deleteOutDir: true`) cannot
delete it on the next compile.

**Zip layout:**
```bash
# From Makefile lambda-build target:
cd backend/dist && zip -r ../../backend/snapshot-worker.zip . --quiet
cd /tmp/lambda-node-modules && zip -r $CURDIR/backend/snapshot-worker.zip node_modules/ --quiet
```
This places compiled JS at the root of the zip (e.g. `lambda/snapshot.handler.js`) matching
the Lambda handler path `lambda/snapshot.handler.handler`.

**Production deps only:** `npm ci --omit=dev` is used for the Lambda runtime install,
keeping the zip well under Lambda's 250 MB unzipped limit.

**`source_code_hash` guard:** The `filebase64sha256()` call is still wrapped in a
`fileexists()` guard to degrade gracefully if someone runs `terraform plan` before
`make lambda-build`:
```hcl
source_code_hash = fileexists(local.lambda_zip_path) ? filebase64sha256(local.lambda_zip_path) : ""
```

**No S3 bucket:** The original proposal recommended an S3-based deployment. At current scale
the direct-zip approach is simpler and avoids managing an S3 bucket. If CI moves to GitHub
Actions with `terraform apply` running in a clean container, revisit S3 deployment (the
`s3_bucket` / `s3_key` attributes can replace `filename` without other changes).

```hcl
locals {
  repo_root       = "${path.module}/../../../.."
  lambda_zip_path = "${local.repo_root}/backend/snapshot-worker.zip"
}

resource "aws_lambda_function" "dora_snapshot" {
  function_name    = "fragile-dora-snapshot"
  role             = aws_iam_role.lambda_exec.arn
  package_type     = "Zip"
  filename         = local.lambda_zip_path
  source_code_hash = fileexists(local.lambda_zip_path) ? filebase64sha256(local.lambda_zip_path) : ""
  runtime          = "nodejs20.x"
  handler          = "lambda/snapshot.handler.handler"
  timeout          = 120
  memory_size      = 512
  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = {
      DB_HOST                = var.rds_endpoint
      DB_PORT                = "5432"
      DB_USERNAME            = "postgres"
      DB_DATABASE            = "fragile"
      DB_SSL                 = "true"
      DB_PASSWORD_SECRET_ARN = var.db_password_secret_arn
    }
  }
}
```

#### `infra/terraform/modules/lambda/variables.tf`

```hcl
variable "environment"            { type = string }
variable "vpc_id"                 { type = string }
variable "private_subnet_ids"     { type = list(string) }
variable "rds_endpoint"           { type = string }
variable "db_password_secret_arn" { type = string }
variable "lambda_s3_bucket"       { type = string }
variable "lambda_s3_key"          { type = string }
```

#### `infra/terraform/modules/lambda/outputs.tf`

```hcl
output "function_arn"         { value = aws_lambda_function.dora_snapshot.arn }
output "function_name"        { value = aws_lambda_function.dora_snapshot.function_name }
output "lambda_sg_id"         { value = aws_security_group.lambda.id }
```

#### RDS Security Group: Add Lambda Inbound Rule

The existing `fragile-rds-sg` currently only permits inbound PostgreSQL from the App Runner
connector SG. The Lambda's SG must be added as a second allowed source.

In `infra/terraform/modules/network/main.tf`, the `rds` security group ingress rule is
currently a single `security_groups` reference. This must be extended:

```hcl
# Updated: allow inbound from both App Runner connector AND Lambda SGs.
# network/main.tf cannot reference the lambda SG directly (circular module dependency).
# Solution: accept lambda_sg_id as a variable and add a second ingress rule.

variable "lambda_sg_id" {
  type    = string
  default = ""
  description = "Optional: Lambda security group ID allowed inbound PostgreSQL access."
}

resource "aws_security_group_rule" "rds_from_lambda" {
  count = var.lambda_sg_id != "" ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.lambda_sg_id
  security_group_id        = aws_security_group.rds.id
  description              = "PostgreSQL from DORA snapshot Lambda"
}
```

Alternatively, place the Lambda SG rule in the `lambda` module using the `rds_sg_id` as an
input variable — this avoids modifying the `network` module and keeps Lambda-specific rules
in the `lambda` module:

```hcl
# infra/terraform/modules/lambda/main.tf (addition)
resource "aws_security_group_rule" "rds_from_lambda" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.lambda.id
  security_group_id        = var.rds_sg_id
  description              = "PostgreSQL from DORA snapshot Lambda"
}
```

Add `rds_sg_id` to `lambda/variables.tf`. **This is the preferred approach** — the `lambda`
module owns its own RDS access rule, avoiding modification of the `network` module.

#### IAM: App Runner Task Role — `lambda:InvokeFunction`

Add to `infra/terraform/modules/iam/main.tf` in the `backend_task_permissions` policy document:

```hcl
# Lambda invocation — for DORA snapshot post-sync computation
statement {
  sid    = "InvokeDoraSnapshotLambda"
  effect = "Allow"
  actions = ["lambda:InvokeFunction"]
  resources = [var.dora_snapshot_lambda_arn]
}
```

Add `dora_snapshot_lambda_arn` to `iam/variables.tf`. Wire it in `environments/prod/main.tf`
via `module.lambda.function_arn`.

#### `environments/prod/main.tf` — New Module Block

```hcl
# ── Lambda — DORA snapshot computation ────────────────────────────────────
module "lambda" {
  source      = "../../modules/lambda"
  environment = var.environment

  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  rds_endpoint        = module.rds.db_endpoint
  rds_sg_id           = module.network.rds_security_group_id

  db_password_secret_arn = module.secrets.db_password_secret_arn

  lambda_s3_bucket = var.lambda_s3_bucket
  lambda_s3_key    = var.lambda_s3_key
}
```

Add `module.lambda.function_arn` to the `iam` module call:

```hcl
module "iam" {
  # ... existing ...
  dora_snapshot_lambda_arn = module.lambda.function_arn
}
```

Add `DORA_SNAPSHOT_LAMBDA_NAME` to the App Runner backend environment variables:

```hcl
# infra/terraform/modules/apprunner/main.tf — runtime_environment_variables
DORA_SNAPSHOT_LAMBDA_NAME = var.dora_snapshot_lambda_name
AWS_REGION                = var.aws_region
```

Add these variables to `apprunner/variables.tf` and pass them from `environments/prod/main.tf`.

**Network module outputs needed:**

`network` module must export `vpc_id` (it likely already exports `private_subnet_ids` and
`rds_security_group_id` — verify). Add to `network/outputs.tf` if missing:

```hcl
output "vpc_id" { value = aws_vpc.main.id }
```

---

### 6. CI/CD: Lambda Build and Deployment

#### Build

The Lambda is built and packaged by `make lambda-build` before `terraform apply`. The
`make deploy` target chains both steps. No separate CI step is required for the Lambda
package at current scale — `npm ci --omit=dev` + `npm run build` + `zip` are executed
locally on the machine running the deploy.

The zip is produced at `backend/snapshot-worker.zip` (outside `dist/` to survive
`nest build`'s `deleteOutDir`):
```
backend/snapshot-worker.zip
  lambda/snapshot.handler.js     ← compiled handler
  lambda/in-process-snapshot.service.js
  metrics/                       ← metric services
  database/entities/             ← TypeORM entities
  node_modules/                  ← production deps only (--omit=dev)
  ...
```

The Lambda handler path in the zip is `lambda/snapshot.handler.js`, matching the Terraform
`handler = "lambda/snapshot.handler.handler"` attribute.

#### Deployment

`make lambda-build && terraform apply` (or `make deploy`) builds and deploys. `source_code_hash`
ensures Lambda only updates when the zip content changes.

If CI moves to GitHub Actions with `terraform apply` running in a clean container, the
direct-zip approach continues to work (Node.js is available in the standard Actions runner).
If `terraform apply` is run from a machine without Node.js (e.g. a Terraform Cloud remote
run), switch to the S3-based approach: add a CI step to upload the zip to S3, and replace
`filename` + `source_code_hash` with `s3_bucket` + `s3_key` in `main.tf`.

#### Open Question OQ-4 — Resolved

The S3 bucket for Lambda artefacts is **not needed** in the current implementation. The
direct-zip deployment is simpler and sufficient for this project's CI/CD setup.

#### Cold Start Considerations

VPC-attached Lambdas have historically suffered 1–10 second cold starts due to ENI attachment.
Since mid-2023 (AWS Hyperplane integration), VPC Lambda cold starts are typically < 1 second
for Node.js 20.

This does not affect DORA page responsiveness — the Lambda runs asynchronously post-sync, and
the snapshot is pre-computed before any user requests it. A cold start adds 1 second to the
time between sync completion and snapshot availability; this is imperceptible given the 30-
minute sync interval.

---

### 7. Local Development Strategy

Lambda is not available locally. `docker-compose up` must still produce DORA snapshots so that
local development and testing work end-to-end.

#### `USE_LAMBDA` Opt-In — In-Process Fallback

`USE_LAMBDA` is opt-in: it must be set to the string `'true'` to enable Lambda invocations.
Unset (the default in `.env`) → in-process mode. This is deliberate:

- Local dev has no Lambda — the process would silently produce no snapshots if Lambda mode
  were the default.
- An unset env var in a misconfigured deployment defaults to the safe (in-process) path,
  not a broken Lambda call.

When `USE_LAMBDA` is not `'true'`, a companion service `InProcessSnapshotService` is invoked
instead:

```typescript
// backend/src/lambda/in-process-snapshot.service.ts

@Injectable()
export class InProcessSnapshotService {
  constructor(
    private readonly trendLoader: TrendDataLoader,
    private readonly dfService: DeploymentFrequencyService,
    private readonly ltService: LeadTimeService,
    private readonly cfrService: CfrService,
    private readonly mttrService: MttrService,
    @InjectRepository(DoraSnapshot)
    private readonly snapshotRepo: Repository<DoraSnapshot>,
  ) {}

  async computeAndPersist(boardId: string): Promise<void> {
    // Identical computation logic to the Lambda handler,
    // but running in-process using injected NestJS services.
    // ...
  }
}
```

`SyncService` conditionally calls `InProcessSnapshotService` instead of
`LambdaInvokerService.invokeSnapshotWorker()` when `USE_LAMBDA=false`:

```typescript
// backend/src/sync/sync.service.ts (modified call site)

if (this.config.get('USE_LAMBDA') !== 'true') {
  // Local dev / USE_LAMBDA not set: compute snapshot in-process.
  // In local dev, OOM is not a concern — the process has abundant RAM.
  this.inProcessSnapshotService.computeAndPersist(boardId).catch((err: unknown) => {
    this.logger.warn(`In-process snapshot failed for ${boardId}: ${String(err)}`);
  });
} else {
  this.lambdaInvoker.invokeSnapshotWorker(boardId).catch(() => {});
}
```

**Add to `.env.example`:**
```
# Set to 'true' to enable Lambda invocation for DORA snapshot computation (production only).
# Unset or any other value = in-process computation (safe for local dev).
USE_LAMBDA=
DORA_SNAPSHOT_LAMBDA_NAME=
AWS_REGION=ap-southeast-2
```

**The `InProcessSnapshotService` is also the recommended path for integration tests** — tests
set `USE_LAMBDA=false` and invoke a sync, then assert that a `dora_snapshots` row exists.

---

### 8. RDS Proxy: Deferred

Each Lambda invocation opens one TypeORM `DataSource` connection to RDS. With sequential
per-board sync invocations (6 boards, one after the other), peak simultaneous Lambda
invocations = 1. The `db.t4g.micro` instance supports ~85 connections; this workload uses ≤
1 Lambda connection + App Runner's pool (typically 2–5 active). No risk at current scale.

RDS Proxy would add value if:
- Lambda concurrency is increased (parallel per-board invocations), or
- Board count grows to 20+ with concurrent Lambda invocations exceeding ~30 connections.

**Decision: defer RDS Proxy.** Add to the open questions list for the user to confirm.

---

## Migration Plan (Deployment Sequence)

All steps are independently deployable and reversible. Each step can be rolled back without
affecting the previous step.

### Step 1 — Database (no downtime)

1. Generate TypeORM migration: `npm run migration:generate -- --name AddDoraSnapshotsTable`
2. Review generated SQL. Confirm `up()` and `down()` are correct.
3. Commit migration and entity.
4. Deploy backend with migration: `npm run migration:run` executes automatically on startup
   (confirm this is the project's startup behaviour — if not, run manually before deploy).
5. Verify `dora_snapshots` table exists. No data yet — table is empty. Existing endpoints
   unaffected (they do not read from this table yet).

### Step 2 — Lambda (no App Runner changes)

1. Build Lambda zip and upload to S3.
2. Add `infra/terraform/modules/lambda/` and apply Terraform to create the Lambda function,
   execution role, security group, and RDS ingress rule.
3. Add `lambda:InvokeFunction` to App Runner task role (IAM Terraform apply).
4. Add `DORA_SNAPSHOT_LAMBDA_NAME` and `AWS_REGION` to App Runner env (apprunner module apply).
5. Manually invoke the Lambda via AWS Console or CLI for one board:
   ```bash
   aws lambda invoke \
     --function-name fragile-dora-snapshot \
     --payload '{"boardId":"ACC"}' \
     --invocation-type RequestResponse \
     response.json
   ```
6. Verify `dora_snapshots` row written for `ACC`.
7. Smoke-test all 6 boards.

### Step 3 — API Read Path (additive change)

1. Deploy `DoraSnapshotReadService` and updated `MetricsController` aggregate/trend handlers.
2. Deploy `GET /api/metrics/dora/snapshot/status` endpoint.
3. Existing endpoints (`/dora`, `/deployment-frequency`, etc.) unchanged.
4. Verify `GET /api/metrics/dora/aggregate?boardId=ACC` returns the pre-computed snapshot.
5. Verify `GET /api/metrics/dora/snapshot/status` returns correct ages.

### Step 4 — Sync Service Wiring (the OOM fix lands here)

1. Deploy `LambdaInvokerService` wired into `SyncService.syncBoard()`.
2. Deploy board config PUT handler wiring.
3. Trigger a manual sync: `POST /api/sync`.
4. Verify Lambda invocations appear in CloudWatch Logs (`/aws/lambda/fragile-dora-snapshot`).
5. Verify `dora_snapshots` rows updated with fresh `computedAt`.
6. Monitor App Runner memory metrics during sync — confirm no OOM.

### Step 5 — Validation and Stopgap Reversal

1. Monitor App Runner CloudWatch metrics across 2–3 sync cycles.
2. Confirm `container_memory_utilization` stays below 80% during sync.
3. If memory is stable, downgrade App Runner from 2 vCPU / 4 GB (Option F stopgap) back to
   1 vCPU / 2 GB. This is optional — keep at 2 vCPU if sync itself uses significant memory.
4. Add CloudWatch alarm on `container_memory_utilization > 85%` (Quick Win QW-4 from 0036).
5. Add CloudWatch metric filter on `exit code 137` (Quick Win QW-5 from 0036).

---

## Risks and Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Lambda cold start delays first post-sync snapshot | Low (< 1s with Hyperplane) | Low (async; user doesn't wait) | Provisioned concurrency if cold starts become measurable |
| RDS connection limit exhaustion | Very Low at current scale | Medium | Monitor `DatabaseConnections` metric; add RDS Proxy if board count > 20 |
| Lambda timeout (large board) | Low | Medium | 120s timeout; PLAT (largest board) estimated < 30s. Alert on `Duration` P99 > 90s |
| Lambda fails silently; snapshot grows stale | Low-Medium | Medium | `X-Snapshot-Stale` header on API response; CloudWatch alarm on Lambda error rate > 0 |
| NestJS decorator imports fail in Lambda context (no IoC) | Low (decorators are no-ops) | High | Validate in dev build before deploying. Include `@nestjs/common` in zip if needed |
| `quarter-utils` / metric service imports missing from Lambda zip | Low | High | Integration test: invoke Lambda with `boardId=ACC` in CI and assert success |
| `DB_PASSWORD` secret resolution on cold start adds latency | Low | Low | One extra Secrets Manager call (~50 ms) per cold start; amortised over invocation lifetime |
| Snapshot absent on first deploy (before first sync post-deploy) | Certain (by design) | Low | API returns HTTP 202 `{ status: 'pending' }`. Frontend handles this. See frontend notes. |
| Lambda package size exceeds limit | Low | Medium | Full `node_modules/` zip estimated 30–50 MB unzipped (250 MB limit). Verify in CI. |

---

## Frontend Notes

These are not API contract changes but the frontend team should be aware:

1. `GET /api/metrics/dora/aggregate` and `/trend` may now return HTTP 202 with
   `{ status: 'pending' }` when no snapshot exists. The frontend must handle this case:
   show a "Sync in progress — data will appear shortly" message rather than an error state.

2. `X-Snapshot-Stale: true` header: optionally surface this in the UI as a banner:
   "Showing data from [X] minutes ago — snapshot is being refreshed."

3. `GET /api/metrics/dora/snapshot/status`: the DORA page can poll this endpoint (on mount,
   or after triggering a sync) to know when fresh snapshots are available and refresh the
   data display. Suggested poll interval: 5 seconds, max 10 polls.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | New table (`dora_snapshots`), 1 migration | ~50–200 KB JSONB per board; reversible up+down migration |
| API contract | Additive: new `snapshot/status` endpoint; existing shapes unchanged | `aggregate` and `trend` may now return HTTP 202; `X-Snapshot-Age` / `X-Snapshot-Stale` headers added |
| Frontend | Minor: handle HTTP 202 pending state; optionally surface staleness header | No page changes required; improvements are optional enhancements |
| Tests | New unit tests for `LambdaInvokerService`, `DoraSnapshotReadService`; new integration test for Lambda handler | Lambda handler tests use mocked TypeORM repositories — no NestJS infrastructure needed |
| Jira API | No new calls | Lambda reads RDS only |
| Cost | ~$0 incremental (Lambda free tier, S3 zip < $0.01/mo) | Instance upsize (Option F stopgap) adds ~$10–20/mo separately |
| Operational complexity | Low-medium | One new Lambda + Terraform module; standard CloudWatch logging |
| App Runner instance | Can revert to 1 vCPU / 2 GB after Step 5 validation | Depends on sync-only memory profile |
| Existing metric service tests | None — all `calculateFromData()` methods unchanged | Tests continue to pass without modification |

---

## Open Questions

These must be answered by the owner before implementation begins.

**OQ-1: Fallback strategy for stale snapshots**
This proposal recommends: HTTP 202 when absent, stale payload + `X-Snapshot-Stale` header
when old. Alternative: return HTTP 503 when stale (forces user to wait for sync). Which
user experience is preferred?

**OQ-2: Lambda package: include `@nestjs/common` and `@nestjs/typeorm` in the zip?**
The NestJS decorator imports on the metric service files may require `@nestjs/common` to be
present in the Lambda runtime. Including it is safe (small package, no side effects) but
adds ~2 MB to the zip. Alternative: strip decorators from the metric services via a Babel
transform or conditional compilation. Recommendation: include `@nestjs/common` and
`@nestjs/typeorm` in the zip for simplicity.

**OQ-3: RDS Proxy — add now or defer?**
Current analysis says defer (6 boards, sequential invocations, 1 Lambda connection). Confirm
this is acceptable. If any future plan involves parallel per-board Lambda invocations, RDS
Proxy should be added at the same time.

**OQ-4: S3 bucket for Lambda deployment artefacts**
A new S3 bucket is needed for Lambda zip uploads. Should this be:
(a) created manually (like the Terraform state bucket), or
(b) managed by a new Terraform resource (e.g. in the `lambda` module or a new `lambda-assets`
module)? Recommendation: (b) — add `aws_s3_bucket` to the `lambda` module and export the
bucket name as an output for use in CI.

**OQ-5: App Runner downsize after Option C is deployed**
After this is deployed and validated, should the App Runner instance be returned to 1 vCPU /
2 GB (reverting the Option F stopgap)? This saves ~$10–20/mo but requires confidence that
sync alone stays under 1800 MB. Confirm after Step 5 monitoring.

**OQ-6: `InProcessSnapshotService` code duplication**
The in-process fallback service (`InProcessSnapshotService`) duplicates the Lambda handler
logic in NestJS-injectable form. This is approximately 50–60 lines of shared computation code
that must be kept in sync. Acceptable for now given local-dev-only use. Confirm this is an
acceptable trade-off or whether a shared utility function should be extracted.

---

## Acceptance Criteria

- [ ] `DoraSnapshot` TypeORM entity committed with composite PK on `(boardId, snapshotType)`.
- [ ] Reversible migration (`up()` + `down()`) committed and tested locally.
- [ ] `dora_snapshots` table created successfully on `npm run migration:run`.
- [ ] Lambda handler at `backend/src/lambda/snapshot.handler.ts` compiles without errors.
- [ ] Lambda handler can be invoked locally (mocked DataSource) via a Jest unit test.
- [ ] Lambda invoked manually against staging RDS writes correct snapshot rows for all 6 boards.
- [ ] `LambdaInvokerService` is a no-op when `USE_LAMBDA=false` or `DORA_SNAPSHOT_LAMBDA_NAME`
      is unset.
- [ ] `SyncService.syncBoard()` invokes Lambda after `syncLogRepo.save()`; Lambda failure does
      not cause `syncBoard()` to reject.
- [ ] `PUT /api/boards/:boardId/config` triggers Lambda recompute for that board.
- [ ] `GET /api/metrics/dora/aggregate` returns HTTP 202 when no snapshot exists.
- [ ] `GET /api/metrics/dora/aggregate` returns snapshot payload with `X-Snapshot-Age` header
      when snapshot exists.
- [ ] `GET /api/metrics/dora/aggregate` sets `X-Snapshot-Stale: true` when age > 60 minutes.
- [ ] `GET /api/metrics/dora/snapshot/status` returns correct `computedAt`, `ageSeconds`,
      `isStale`, `hasAggregate`, `hasTrend` for all configured boards.
- [ ] Terraform `lambda` module applies cleanly: Lambda function, execution role, security
      group, and RDS ingress rule created.
- [ ] Lambda can connect to RDS in the VPC (verified via manual invocation).
- [ ] App Runner task role has `lambda:InvokeFunction` on the Lambda ARN.
- [ ] CI pipeline builds Lambda zip, uploads to S3, and deploys via `terraform apply`.
- [ ] App Runner memory does not exceed 80% during a full sync cycle post-deployment
      (verified in CloudWatch).
- [ ] All existing Jest metric service tests pass without modification.
- [ ] Integration test: trigger `syncBoard('ACC')` with `USE_LAMBDA=false` → assert
      `dora_snapshots` row exists for `('ACC', 'trend')` and `('ACC', 'aggregate')`.
- [ ] `docs/proposals/README.md` updated with this proposal.
- [ ] `docs/decisions/` ADR created when proposal is accepted.
