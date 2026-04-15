import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';
import { JiraModule } from '../jira/jira.module.js';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  SyncLog,
  BoardConfig,
  RoadmapConfig,
  JpdIdea,
  JiraIssueLink,
  JiraFieldConfig,
} from '../database/entities/index.js';
import { SprintReportModule } from '../sprint-report/sprint-report.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraSprint,
      JiraIssue,
      JiraChangelog,
      JiraVersion,
      SyncLog,
      BoardConfig,
      RoadmapConfig,
      JpdIdea,
      JiraIssueLink,
      JiraFieldConfig,
    ]),
    JiraModule,
    forwardRef(() => SprintReportModule),
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
