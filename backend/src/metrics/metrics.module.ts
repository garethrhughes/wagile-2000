import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import { DeploymentFrequencyService } from './deployment-frequency.service.js';
import { LeadTimeService } from './lead-time.service.js';
import { CfrService } from './cfr.service.js';
import { MttrService } from './mttr.service.js';
import { CycleTimeService } from './cycle-time.service.js';
import { CycleTimeController } from './cycle-time.controller.js';
import { WorkingTimeService } from './working-time.service.js';
import { DoraCacheService } from './dora-cache.service.js';
import { TrendDataLoader } from './trend-data-loader.service.js';
import { DoraSnapshotReadService } from './dora-snapshot-read.service.js';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  JiraSprint,
  BoardConfig,
  JiraIssueLink,
  WorkingTimeConfigEntity,
  DoraSnapshot,
} from '../database/entities/index.js';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      JiraIssue,
      JiraChangelog,
      JiraVersion,
      JiraSprint,
      BoardConfig,
      JiraIssueLink,
      WorkingTimeConfigEntity,
      DoraSnapshot,
    ]),
  ],
  controllers: [MetricsController, CycleTimeController],
  providers: [
    MetricsService,
    DeploymentFrequencyService,
    LeadTimeService,
    CfrService,
    MttrService,
    CycleTimeService,
    WorkingTimeService,
    DoraCacheService,
    TrendDataLoader,
    DoraSnapshotReadService,
  ],
  exports: [
    MetricsService,
    WorkingTimeService,
    TrendDataLoader,
    DeploymentFrequencyService,
    LeadTimeService,
    CfrService,
    MttrService,
  ],
})
export class MetricsModule {}
