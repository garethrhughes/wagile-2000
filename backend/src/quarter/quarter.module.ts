import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
  JiraIssueLink,
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { QuarterController } from './quarter.controller.js';
import { QuarterDetailService } from './quarter-detail.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraIssue,
      JiraChangelog,
      BoardConfig,
      RoadmapConfig,
      JpdIdea,
      JiraIssueLink,
    ]),
  ],
  controllers: [QuarterController],
  providers: [QuarterDetailService],
})
export class QuarterModule {}
