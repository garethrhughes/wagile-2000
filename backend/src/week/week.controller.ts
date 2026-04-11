import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { WeekDetailService, type WeekDetailResponse } from './week-detail.service.js';

@ApiTags('weeks')
@Controller('api/weeks')
export class WeekController {
  constructor(private readonly weekDetailService: WeekDetailService) {}

  @ApiOperation({ summary: 'Get annotated ticket-level breakdown for a week (Kanban boards only)' })
  @ApiParam({ name: 'boardId', description: 'The board identifier' })
  @ApiParam({ name: 'week', description: 'ISO week in format YYYY-Www e.g. 2026-W15' })
  @Get(':boardId/:week/detail')
  async getDetail(
    @Param('boardId') boardId: string,
    @Param('week') week: string,
  ): Promise<WeekDetailResponse> {
    return this.weekDetailService.getDetail(boardId, week);
  }
}
