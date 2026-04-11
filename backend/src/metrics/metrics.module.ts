import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import { DeploymentFrequencyService } from './deployment-frequency.service.js';
import { LeadTimeService } from './lead-time.service.js';
import { CfrService } from './cfr.service.js';
import { MttrService } from './mttr.service.js';
import { CycleTimeService } from './cycle-time.service.js';
import { CycleTimeController } from './cycle-time.controller.js';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  JiraSprint,
  BoardConfig,
  JiraIssueLink,
} from '../database/entities/index.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JiraIssue,
      JiraChangelog,
      JiraVersion,
      JiraSprint,
      BoardConfig,
      JiraIssueLink,
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
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
