/**
 * InProcessSnapshotService
 *
 * In-process fallback for DORA snapshot computation, used when
 * USE_LAMBDA=false (local development). Delegates to MetricsService which
 * produces the correct OrgDoraResult / TrendResponse wire shapes.
 *
 * After each board sync, computes three snapshots:
 *   1. Per-board  — keyed to the board's own ID (e.g. 'ACC')
 *      a. aggregate — OrgDoraResult for the current quarter
 *      b. trend     — raw TrendResponse (oldest→newest) kept for symmetry with
 *                     the Lambda path; used as the per-board raw trend store
 *      c. trend-display — OrgDoraResult[] per quarter (oldest→newest), the
 *                         display-ready shape the frontend trend endpoint reads
 *   2. Org-level  — keyed to ORG_SNAPSHOT_KEY ('__org__'), covering all boards
 *      a. aggregate — OrgDoraResult for the current quarter across all boards
 *      b. trend     — OrgDoraResult[] per quarter (oldest→newest) for multi-board
 *                     trend view
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

/** Number of quarters to include in trend snapshots. */
const TREND_QUARTERS = 8;

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
      this.metricsService.getDoraTrend({ boardId, limit: TREND_QUARTERS }),
    ]);

    // trend-display: getDoraTrend already returns OrgDoraResult[] (oldest→newest),
    // which is exactly the display-ready shape the frontend trend endpoint reads
    // for per-board views. Reuse it directly to avoid redundant DB queries.
    const trendDisplay = boardTrend;

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
        {
          boardId,
          snapshotType: 'trend-display' as const,
          payload: trendDisplay,
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
    const quarters = listRecentQuarters(TREND_QUARTERS);

    const configs = await this.boardConfigRepo.find({ select: ['boardId'] });
    const allBoardIdStr = configs.map((c) => c.boardId).join(',');

    // Org aggregate: current quarter, all boards
    const orgAggregate = await this.metricsService.getDoraAggregate({
      boardId: allBoardIdStr,
      quarter: currentQuarter,
    });

    // Org trend: OrgDoraResult per quarter across all boards (oldest→newest).
    // This matches the shape the frontend expects from the multi-board trend endpoint.
    const orgTrendItems = await Promise.all(
      quarters.map((q) =>
        this.metricsService.getDoraAggregate({ boardId: allBoardIdStr, quarter: q.label }),
      ),
    );
    const orgTrend = orgTrendItems.reverse(); // oldest → newest

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
