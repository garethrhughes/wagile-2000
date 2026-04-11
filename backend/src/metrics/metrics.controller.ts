import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';
import { MetricsQueryDto } from './dto/metrics-query.dto.js';
import { DoraAggregateQueryDto } from './dto/dora-aggregate-query.dto.js';
import { DoraTrendQueryDto } from './dto/dora-trend-query.dto.js';
import type { OrgDoraResult, TrendResponse } from './dto/org-dora-response.dto.js';

@ApiTags('metrics')
@Controller('api/metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  // ---------------------------------------------------------------------------
  // New aggregate + trend endpoints — declared BEFORE any parameterised routes
  // to prevent NestJS treating "aggregate" / "trend" as route params.
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get org-level aggregated DORA metrics for a single period',
  })
  @Get('dora/aggregate')
  async getDoraAggregate(
    @Query() query: DoraAggregateQueryDto,
  ): Promise<OrgDoraResult> {
    return this.metricsService.getDoraAggregate(query);
  }

  @ApiOperation({
    summary: 'Get org-level DORA metrics trend across multiple periods',
  })
  @Get('dora/trend')
  async getDoraTrend(
    @Query() query: DoraTrendQueryDto,
  ): Promise<TrendResponse> {
    return this.metricsService.getDoraTrend(query);
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
