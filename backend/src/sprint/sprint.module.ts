import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
  JiraSprint,
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { SprintController } from './sprint.controller.js';
import { SprintDetailService } from './sprint-detail.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraSprint,
      JiraIssue,
      JiraChangelog,
      BoardConfig,
      JpdIdea,
      RoadmapConfig,
    ]),
  ],
  controllers: [SprintController],
  providers: [SprintDetailService],
  exports: [SprintDetailService],
})
export class SprintModule {}
