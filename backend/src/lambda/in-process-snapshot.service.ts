/**
 * InProcessSnapshotService
 *
 * In-process fallback for DORA snapshot computation, used when
 * USE_LAMBDA=false (local development). Delegates to MetricsService which
 * already produces the correct OrgDoraResult / TrendResponse wire shapes, so
 * the stored payload is identical to what the Lambda handler would produce and
 * what the frontend expects.
 *
 * In production, the Lambda handler performs this computation in a separate
 * AWS Lambda function after each sync, keeping the App Runner heap free of
 * the combined sync + computation working set.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service.js';
import { DoraSnapshot } from '../database/entities/index.js';
import { listRecentQuarters } from '../metrics/period-utils.js';

@Injectable()
export class InProcessSnapshotService {
  private readonly logger = new Logger(InProcessSnapshotService.name);

  constructor(
    private readonly metricsService: MetricsService,
    @InjectRepository(DoraSnapshot)
    private readonly snapshotRepo: Repository<DoraSnapshot>,
  ) {}

  async computeAndPersist(boardId: string, quartersBack = 8): Promise<void> {
    const quarters = listRecentQuarters(quartersBack);
    const latestQuarter = quarters[0];

    // Use the same service methods the controller uses — guarantees the stored
    // payload is always the correct OrgDoraResult / TrendResponse wire shape.
    const [aggregatePayload, trendPayload] = await Promise.all([
      this.metricsService.getDoraAggregate({ boardId, quarter: latestQuarter.label }),
      this.metricsService.getDoraTrend({ boardId, mode: 'quarters', limit: quartersBack }),
    ]);

    await this.snapshotRepo.upsert(
      [
        {
          boardId,
          snapshotType: 'aggregate' as const,
          payload: aggregatePayload,
          triggeredBy: boardId,
          stale: false,
        },
        {
          boardId,
          snapshotType: 'trend' as const,
          payload: trendPayload,
          triggeredBy: boardId,
          stale: false,
        },
      ],
      ['boardId', 'snapshotType'],
    );

    this.logger.log(`Snapshot computed and persisted for board: ${boardId}`);
  }
}
