import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';
import { DoraSnapshotReadService, BoardSnapshotStatus } from './dora-snapshot-read.service.js';
import { MetricsQueryDto } from './dto/metrics-query.dto.js';
import { DoraAggregateQueryDto } from './dto/dora-aggregate-query.dto.js';
import { DoraTrendQueryDto } from './dto/dora-trend-query.dto.js';
import type { OrgDoraResult, TrendResponse } from './dto/org-dora-response.dto.js';

/** All configured board IDs — used by the snapshot status endpoint. */
const ALL_BOARD_IDS = ['ACC', 'BPT', 'SPS', 'OCS', 'DATA', 'PLAT'];

@ApiTags('metrics')
@Controller('api/metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly doraSnapshotReadService: DoraSnapshotReadService,
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
    const snapshot = await this.doraSnapshotReadService.getSnapshot(
      query.boardId ?? '',
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
    const snapshot = await this.doraSnapshotReadService.getSnapshot(
      query.boardId ?? '',
      'trend',
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

  @ApiOperation({
    summary: 'Get snapshot computation status for all boards',
  })
  @Get('dora/snapshot/status')
  async getSnapshotStatus(): Promise<BoardSnapshotStatus[]> {
    return this.doraSnapshotReadService.getSnapshotStatus(ALL_BOARD_IDS);
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
