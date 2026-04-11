import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SprintDetailService, type SprintDetailResponse } from './sprint-detail.service.js';

@ApiTags('sprints')
@Controller('api/sprints')
export class SprintController {
  constructor(private readonly sprintDetailService: SprintDetailService) {}

  @ApiOperation({ summary: 'Get annotated ticket-level breakdown for a sprint' })
  @Get(':boardId/:sprintId/detail')
  async getDetail(
    @Param('boardId') boardId: string,
    @Param('sprintId') sprintId: string,
  ): Promise<SprintDetailResponse> {
    return this.sprintDetailService.getDetail(boardId, sprintId);
  }
}
