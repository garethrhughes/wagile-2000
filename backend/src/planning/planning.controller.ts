import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PlanningService } from './planning.service.js';
import { PlanningQueryDto } from './dto/planning-query.dto.js';

@ApiTags('planning')
@Controller('api/planning')
export class PlanningController {
  constructor(private readonly planningService: PlanningService) {}

  @ApiOperation({
    summary:
      'Get sprint planning accuracy. Returns 400 for Kanban boards.',
  })
  @Get('accuracy')
  async getAccuracy(@Query() query: PlanningQueryDto) {
    const boardId = query.boardId ?? 'ACC';
    return this.planningService.getAccuracy(
      boardId,
      query.sprintId,
      query.quarter,
    );
  }

  @ApiOperation({ summary: 'Get available sprints for a board' })
  @Get('sprints')
  async getSprints(@Query('boardId') boardId: string) {
    return this.planningService.getSprints(boardId ?? 'ACC');
  }

  @ApiOperation({ summary: 'Get available quarters derived from sprint data' })
  @Get('quarters')
  async getQuarters() {
    return this.planningService.getQuarters();
  }

  @ApiOperation({
    summary: 'Get quarterly flow metrics for a Kanban board. Returns 400 for Scrum boards.',
  })
  @Get('kanban-quarters/:boardId')
  async getKanbanQuarters(@Param('boardId') boardId: string) {
    return this.planningService.getKanbanQuarters(boardId);
  }

  @ApiOperation({
    summary: 'Get weekly flow metrics for a Kanban board. Returns 400 for Scrum boards.',
  })
  @Get('kanban-weeks/:boardId')
  async getKanbanWeeks(@Param('boardId') boardId: string) {
    return this.planningService.getKanbanWeeks(boardId);
  }
}
