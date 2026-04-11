import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';
import { CycleTimeQueryDto } from './dto/cycle-time-query.dto.js';
import { CycleTimeTrendQueryDto } from './dto/cycle-time-trend-query.dto.js';
import type {
  CycleTimeResponse,
  CycleTimeTrendResponse,
} from './dto/cycle-time-response.dto.js';

@ApiTags('cycle-time')
@Controller('api/cycle-time')
export class CycleTimeController {
  constructor(private readonly metricsService: MetricsService) {}

  /**
   * GET /api/cycle-time/trend?boardId=ACC&mode=quarters&limit=8
   * Declared BEFORE the :boardId route to prevent NestJS matching "trend"
   * as a boardId path parameter.
   */
  @ApiOperation({ summary: 'Get cycle time trend across multiple periods' })
  @Get('trend')
  async getCycleTimeTrend(
    @Query() query: CycleTimeTrendQueryDto,
  ): Promise<CycleTimeTrendResponse> {
    return this.metricsService.getCycleTimeTrend(query);
  }

  /**
   * GET /api/cycle-time/:boardId?quarter=2026-Q1&issueType=Story
   */
  @ApiOperation({ summary: 'Get cycle time observations and percentiles for a board' })
  @Get(':boardId')
  async getCycleTime(
    @Param('boardId') boardId: string,
    @Query() query: CycleTimeQueryDto,
  ): Promise<CycleTimeResponse> {
    return this.metricsService.getCycleTime({ ...query, boardId });
  }
}
