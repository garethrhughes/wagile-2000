import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { QuarterDetailService, type QuarterDetailResponse } from './quarter-detail.service.js';

@ApiTags('quarters')
@Controller('api/quarters')
export class QuarterController {
  constructor(private readonly quarterDetailService: QuarterDetailService) {}

  @ApiOperation({ summary: 'Get annotated ticket-level breakdown for a quarter' })
  @ApiParam({ name: 'boardId', description: 'The board identifier' })
  @ApiParam({ name: 'quarter', description: 'Quarter in format YYYY-QN e.g. 2025-Q2' })
  @Get(':boardId/:quarter/detail')
  async getDetail(
    @Param('boardId') boardId: string,
    @Param('quarter') quarter: string,
  ): Promise<QuarterDetailResponse> {
    return this.quarterDetailService.getDetail(boardId, quarter);
  }
}
