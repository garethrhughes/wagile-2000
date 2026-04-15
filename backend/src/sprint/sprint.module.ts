import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
  JiraIssueLink,
  JiraSprint,
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { SprintController } from './sprint.controller.js';
import { SprintDetailService } from './sprint-detail.service.js';
import { MetricsModule } from '../metrics/metrics.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraSprint,
      JiraIssue,
      JiraChangelog,
      BoardConfig,
      JpdIdea,
      RoadmapConfig,
      JiraIssueLink,
    ]),
    MetricsModule,
  ],
  controllers: [SprintController],
  providers: [SprintDetailService],
  exports: [SprintDetailService],
})
export class SprintModule {}
