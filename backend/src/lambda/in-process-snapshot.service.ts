/**
 * InProcessSnapshotService
 *
 * In-process fallback for DORA snapshot computation, used when
 * USE_LAMBDA=false (local development). Delegates to MetricsService which
 * produces the correct OrgDoraResult / TrendResponse wire shapes.
 *
 * After each board sync, computes two snapshots:
 *   1. Per-board  — keyed to the board's own ID (e.g. 'ACC')
 *   2. Org-level  — keyed to ORG_SNAPSHOT_KEY ('__org__'), covering all boards
 *
 * The org snapshot powers the "All boards" view in the DORA page. Per-board
 * snapshots power the individual board drill-down view.
 *
 * In production, the Lambda handler performs this computation in a separate
 * AWS Lambda function after each sync, keeping the App Runner heap free of
 * the combined sync + computation working set.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service.js';
import { BoardConfig, DoraSnapshot } from '../database/entities/index.js';
import { listRecentQuarters } from '../metrics/period-utils.js';

/** Snapshot key for the org-level (all boards) aggregate and trend. */
export const ORG_SNAPSHOT_KEY = '__org__';

@Injectable()
export class InProcessSnapshotService {
  private readonly logger = new Logger(InProcessSnapshotService.name);

  constructor(
    private readonly metricsService: MetricsService,
    @InjectRepository(DoraSnapshot)
    private readonly snapshotRepo: Repository<DoraSnapshot>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  /** Compute and persist only the per-board snapshot rows for a single board. */
  async computeBoard(boardId: string): Promise<void> {
    const currentQuarter = listRecentQuarters(1)[0].label;

    const [boardAggregate, boardTrend] = await Promise.all([
      this.metricsService.getDoraAggregate({ boardId, quarter: currentQuarter }),
      this.metricsService.getDoraTrend({ boardId, limit: 8 }),
    ]);

    await this.snapshotRepo.upsert(
      [
        {
          boardId,
          snapshotType: 'aggregate' as const,
          payload: boardAggregate,
          triggeredBy: boardId,
          stale: false,
        },
        {
          boardId,
          snapshotType: 'trend' as const,
          payload: boardTrend,
          triggeredBy: boardId,
          stale: false,
        },
      ],
      ['boardId', 'snapshotType'],
    );

    this.logger.log(`Per-board snapshots persisted for board ${boardId}`);
  }

  /** Compute and persist only the org-level (__org__) snapshot rows. */
  async computeOrg(): Promise<void> {
    const currentQuarter = listRecentQuarters(1)[0].label;

    const configs = await this.boardConfigRepo.find({ select: ['boardId'] });
    const allBoardIdStr = configs.map((c) => c.boardId).join(',');

    const [orgAggregate, orgTrend] = await Promise.all([
      this.metricsService.getDoraAggregate({ boardId: allBoardIdStr, quarter: currentQuarter }),
      this.metricsService.getDoraTrend({ boardId: allBoardIdStr, limit: 8 }),
    ]);

    await this.snapshotRepo.upsert(
      [
        {
          boardId: ORG_SNAPSHOT_KEY,
          snapshotType: 'aggregate' as const,
          payload: orgAggregate,
          triggeredBy: ORG_SNAPSHOT_KEY,
          stale: false,
        },
        {
          boardId: ORG_SNAPSHOT_KEY,
          snapshotType: 'trend' as const,
          payload: orgTrend,
          triggeredBy: ORG_SNAPSHOT_KEY,
          stale: false,
        },
      ],
      ['boardId', 'snapshotType'],
    );

    this.logger.log(`Org-level snapshots persisted`);
  }

  /** @deprecated Use computeBoard() + computeOrg() separately. */
  async computeAndPersist(triggeredBy: string): Promise<void> {
    await this.computeBoard(triggeredBy);
    await this.computeOrg();
  }
}
