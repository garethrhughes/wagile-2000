/**
 * snapshot.handler.ts
 *
 * Lambda handler for post-sync DORA snapshot computation.
 *
 * This module intentionally does NOT bootstrap NestJS. It creates a TypeORM
 * DataSource directly and instantiates the metric services with `new`.
 * NestJS decorators (@Injectable, @InjectRepository, etc.) are no-ops at
 * runtime when used outside a NestJS IoC container — only reflect-metadata
 * is required for the TypeORM entity decorators to work.
 *
 * The DataSource is module-scoped and reused across warm Lambda invocations
 * to avoid repeated connection overhead.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
  WorkingTimeConfigEntity,
  DoraSnapshot,
  JiraFieldConfig,
  JiraSprint,
  SyncLog,
  RoadmapConfig,
  JpdIdea,
  SprintReport,
} from '../database/entities/index.js';
import { TrendDataLoader } from '../metrics/trend-data-loader.service.js';
import { DeploymentFrequencyService } from '../metrics/deployment-frequency.service.js';
import { LeadTimeService } from '../metrics/lead-time.service.js';
import { CfrService } from '../metrics/cfr.service.js';
import { MttrService } from '../metrics/mttr.service.js';
import { WorkingTimeService } from '../metrics/working-time.service.js';
import { listRecentQuarters } from '../metrics/period-utils.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotHandlerEvent {
  boardId: string;
  /** Number of past quarters to compute snapshots for. Defaults to 8. */
  quartersBack?: number;
}

// ── DataSource (module-level, reused across warm invocations) ────────────────

let dataSource: DataSource | null = null;

async function getDataSource(): Promise<DataSource> {
  if (dataSource && dataSource.isInitialized) return dataSource;

  dataSource = new DataSource({
    type: 'postgres',
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    username: process.env['DB_USERNAME'] ?? 'postgres',
    password: process.env['DB_PASSWORD'] ?? 'postgres',
    database: process.env['DB_DATABASE'] ?? 'ai_starter',
    ssl:
      process.env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
    entities: [
      JiraIssue,
      JiraChangelog,
      JiraVersion,
      BoardConfig,
      JiraIssueLink,
      WorkingTimeConfigEntity,
      DoraSnapshot,
      JiraFieldConfig,
      JiraSprint,
      SyncLog,
      RoadmapConfig,
      JpdIdea,
      SprintReport,
    ],
    // The Lambda never runs migrations.
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

  // Repositories
  const issueRepo       = ds.getRepository(JiraIssue);
  const changelogRepo   = ds.getRepository(JiraChangelog);
  const versionRepo     = ds.getRepository(JiraVersion);
  const boardConfigRepo = ds.getRepository(BoardConfig);
  const issueLinkRepo   = ds.getRepository(JiraIssueLink);
  const snapshotRepo    = ds.getRepository(DoraSnapshot);
  const wtConfigRepo    = ds.getRepository(WorkingTimeConfigEntity);

  // Services — manual instantiation, no NestJS IoC
  // WorkingTimeService requires a ConfigService to read the TIMEZONE env var.
  // In Lambda, we provide a minimal stub that reads from process.env directly.
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
    issueRepo,
    changelogRepo,
    versionRepo,
    boardConfigRepo,
    issueLinkRepo,
    workingTimeService,
  );
  const dfService   = new DeploymentFrequencyService(issueRepo, versionRepo, changelogRepo, boardConfigRepo);
  const ltService   = new LeadTimeService(issueRepo, changelogRepo, versionRepo, boardConfigRepo, workingTimeService);
  const cfrService  = new CfrService(issueRepo, changelogRepo, versionRepo, boardConfigRepo, issueLinkRepo);
  const mttrService = new MttrService(issueRepo, changelogRepo, boardConfigRepo);

  // Compute the trend window: last N quarters (newest first)
  const quarters = listRecentQuarters(quartersBack);
  // Oldest quarter's startDate → newest quarter's endDate
  const rangeStart = quarters[quarters.length - 1].startDate;
  const rangeEnd   = quarters[0].endDate;

  // Load all data in a single bulk pass (4 queries)
  const slice = await trendLoader.load(boardId, rangeStart, rangeEnd);

  // Compute all four metrics for all periods in memory
  const trendPayload = quarters.map((q) => ({
    period:    q.label,
    startDate: q.startDate,
    endDate:   q.endDate,
    df:   dfService.calculateFromData(slice, q.startDate, q.endDate),
    lt:   ltService.getLeadTimeObservationsFromData(slice, q.startDate, q.endDate),
    cfr:  cfrService.calculateFromData(slice, q.startDate, q.endDate),
    mttr: mttrService.getMttrObservationsFromData(slice, q.startDate, q.endDate),
  }));

  // Most recent quarter used as the "aggregate" snapshot
  const latestQuarter = quarters[0];
  const aggregatePayload = {
    period:    latestQuarter.label,
    startDate: latestQuarter.startDate,
    endDate:   latestQuarter.endDate,
    df:   dfService.calculateFromData(slice, latestQuarter.startDate, latestQuarter.endDate),
    lt:   ltService.getLeadTimeObservationsFromData(slice, latestQuarter.startDate, latestQuarter.endDate),
    cfr:  cfrService.calculateFromData(slice, latestQuarter.startDate, latestQuarter.endDate),
    mttr: mttrService.getMttrObservationsFromData(slice, latestQuarter.startDate, latestQuarter.endDate),
  };

  // Write snapshots (upsert on composite PK)
  await snapshotRepo.upsert(
    [
      {
        boardId,
        snapshotType: 'trend' as const,
        payload: trendPayload,
        triggeredBy: boardId,
        stale: false,
      },
      {
        boardId,
        snapshotType: 'aggregate' as const,
        payload: aggregatePayload,
        triggeredBy: boardId,
        stale: false,
      },
    ],
    ['boardId', 'snapshotType'],
  );

  console.log(`[snapshot-handler] Snapshot written for board: ${boardId}`);
  // DataSource remains open — reused on next warm invocation.
};
