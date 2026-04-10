import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../auth/api-key-auth.guard.js';
import { SprintDetailService, type SprintDetailResponse } from './sprint-detail.service.js';

@ApiTags('sprints')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
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
