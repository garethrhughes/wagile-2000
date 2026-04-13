import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoadmapService } from './roadmap.service.js';
import { RoadmapController } from './roadmap.controller.js';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JpdIdea,
  RoadmapConfig,
  BoardConfig,
} from '../database/entities/index.js';
import { SyncModule } from '../sync/sync.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraSprint,
      JiraIssue,
      JiraChangelog,
      JpdIdea,
      RoadmapConfig,
      BoardConfig,
    ]),
    forwardRef(() => SyncModule),
  ],
  controllers: [RoadmapController],
  providers: [RoadmapService],
  exports: [RoadmapService],
})
export class RoadmapModule {}
