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
import { WeekController } from './week.controller.js';
import { WeekDetailService } from './week-detail.service.js';

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
  controllers: [WeekController],
  providers: [WeekDetailService],
})
export class WeekModule {}
