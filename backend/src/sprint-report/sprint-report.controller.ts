import { Controller, Get, Delete, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SprintReportService } from './sprint-report.service.js';

@ApiTags('sprint-report')
@Controller('api/sprint-report')
export class SprintReportController {
  constructor(private readonly sprintReportService: SprintReportService) {}

  @Get(':boardId/:sprintId')
  async getReport(
    @Param('boardId') boardId: string,
    @Param('sprintId') sprintId: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.sprintReportService.generateReport(boardId, sprintId, refresh === 'true');
  }

  @Get(':boardId')
  async listReports(@Param('boardId') boardId: string) {
    return this.sprintReportService.listReports(boardId);
  }

  @Delete(':boardId/:sprintId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteReport(
    @Param('boardId') boardId: string,
    @Param('sprintId') sprintId: string,
  ) {
    await this.sprintReportService.deleteReport(boardId, sprintId);
  }
}
