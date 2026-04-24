import { Controller, Get, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';
import { DoraSnapshotReadService, BoardSnapshotStatus } from './dora-snapshot-read.service.js';
import { MetricsQueryDto } from './dto/metrics-query.dto.js';
import { DoraAggregateQueryDto } from './dto/dora-aggregate-query.dto.js';
import { DoraTrendQueryDto } from './dto/dora-trend-query.dto.js';
import type { OrgDoraResult, TrendResponse } from './dto/org-dora-response.dto.js';
import { ORG_SNAPSHOT_KEY } from '../lambda/in-process-snapshot.service.js';
import { BoardConfig } from '../database/entities/index.js';

@ApiTags('metrics')
@Controller('api/metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly doraSnapshotReadService: DoraSnapshotReadService,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  // ---------------------------------------------------------------------------
  // New aggregate + trend endpoints — declared BEFORE any parameterised routes
  // to prevent NestJS treating "aggregate" / "trend" as route params.
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get org-level aggregated DORA metrics for a single period (snapshot-backed)',
  })
  @Get('dora/aggregate')
  async getDoraAggregate(
    @Query() query: DoraAggregateQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrgDoraResult | { status: string; message: string }> {
    // When a single boardId is provided use the per-board snapshot;
    // otherwise (no boardId, or multiple) use the org-level snapshot.
    const snapshotKey =
      query.boardId && !query.boardId.includes(',')
        ? query.boardId
        : ORG_SNAPSHOT_KEY;

    const snapshot = await this.doraSnapshotReadService.getSnapshot(
      snapshotKey,
      'aggregate',
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

  @ApiOperation({
    summary: 'Get org-level DORA metrics trend across multiple periods (snapshot-backed)',
  })
  @Get('dora/trend')
  async getDoraTrend(
    @Query() query: DoraTrendQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TrendResponse | { status: string; message: string }> {
    const isSingleBoard = query.boardId && !query.boardId.includes(',');
    const snapshotKey = isSingleBoard ? query.boardId! : ORG_SNAPSHOT_KEY;
    // Per-board trend is stored raw (for org merging); display-ready shape is in
    // 'trend-display'. Org snapshot writes OrgDoraResult shape directly to 'trend'.
    const snapshotType = isSingleBoard ? ('trend-display' as const) : ('trend' as const);

    const snapshot = await this.doraSnapshotReadService.getSnapshot(
      snapshotKey,
      snapshotType,
    );

    if (!snapshot) {
      res.status(202);
      return { status: 'pending', message: 'Snapshot not yet computed. Trigger a sync.' };
    }

    if (snapshot.stale) {
      res.setHeader('X-Snapshot-Stale', 'true');
    }
    res.setHeader('X-Snapshot-Age', String(snapshot.ageSeconds));

    const payload = snapshot.payload as TrendResponse;
    if (query.limit !== undefined && Array.isArray(payload)) {
      return payload.slice(0, query.limit) as TrendResponse;
    }
    return payload;
  }

  @ApiOperation({
    summary: 'Get snapshot computation status for all boards',
  })
  @Get('dora/snapshot/status')
  async getSnapshotStatus(): Promise<BoardSnapshotStatus[]> {
    const configs = await this.boardConfigRepo.find({ select: ['boardId'] });
    const boardIds = configs.map((c) => c.boardId);
    return this.doraSnapshotReadService.getSnapshotStatus(boardIds);
  }

  // ---------------------------------------------------------------------------
  // Existing endpoints — unchanged
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get combined DORA metrics for all or a specific board',
  })
  @Get('dora')
  async getDora(@Query() query: MetricsQueryDto) {
    return this.metricsService.getDora(query);
  }

  @ApiOperation({ summary: 'Get deployment frequency metric' })
  @Get('deployment-frequency')
  async getDeploymentFrequency(@Query() query: MetricsQueryDto) {
    return this.metricsService.getDeploymentFrequency(query);
  }

  @ApiOperation({ summary: 'Get lead time metric' })
  @Get('lead-time')
  async getLeadTime(@Query() query: MetricsQueryDto) {
    return this.metricsService.getLeadTime(query);
  }

  @ApiOperation({ summary: 'Get change failure rate metric' })
  @Get('cfr')
  async getCfr(@Query() query: MetricsQueryDto) {
    return this.metricsService.getCfr(query);
  }

  @ApiOperation({ summary: 'Get mean time to recovery metric' })
  @Get('mttr')
  async getMttr(@Query() query: MetricsQueryDto) {
    return this.metricsService.getMttr(query);
  }
}
