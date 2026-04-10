import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
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
    ]),
  ],
  controllers: [QuarterController],
  providers: [QuarterDetailService],
})
export class QuarterModule {}
