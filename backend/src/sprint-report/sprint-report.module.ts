import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SprintReport, JiraSprint, SyncLog } from '../database/entities/index.js';
import { SprintModule } from '../sprint/sprint.module.js';
import { PlanningModule } from '../planning/planning.module.js';
import { RoadmapModule } from '../roadmap/roadmap.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { SprintReportController } from './sprint-report.controller.js';
import { SprintReportService } from './sprint-report.service.js';
import { ScoringService } from './scoring.service.js';
import { RecommendationService } from './recommendation.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([SprintReport, JiraSprint, SyncLog]),
    SprintModule,
    PlanningModule,
    forwardRef(() => RoadmapModule),
    MetricsModule,
  ],
  controllers: [SprintReportController],
  providers: [SprintReportService, ScoringService, RecommendationService],
  exports: [SprintReportService],
})
export class SprintReportModule {}
