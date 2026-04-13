import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { SprintReport, JiraSprint, SyncLog } from '../database/entities/index.js';
import { SprintDetailService } from '../sprint/sprint-detail.service.js';
import { PlanningService } from '../planning/planning.service.js';
import { RoadmapService } from '../roadmap/roadmap.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ScoringService, ScoringInput, SprintDimensionScores } from './scoring.service.js';
import { RecommendationService, SprintRecommendation, RecommendationContext } from './recommendation.service.js';
import {
  classifyDeploymentFrequency,
  classifyLeadTime,
  classifyChangeFailureRate,
  classifyMTTR,
  DoraBand,
} from '../metrics/dora-bands.js';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface SprintReportTrendPoint {
  sprintId: string;
  sprintName: string;
  compositeScore: number;
  scores: SprintDimensionScores;
}

export interface SprintReportResponse {
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  compositeScore: number;
  compositeBand: string;
  scores: SprintDimensionScores;
  recommendations: SprintRecommendation[];
  trend: SprintReportTrendPoint[];
  generatedAt: string;
  dataAsOf: string;
}

export interface SprintReportSummary {
  boardId: string;
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  compositeScore: number;
  compositeBand: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SprintReportService {
  private readonly logger = new Logger(SprintReportService.name);

  constructor(
    @InjectRepository(SprintReport)
    private readonly reportRepo: Repository<SprintReport>,
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly sprintDetailService: SprintDetailService,
    private readonly planningService: PlanningService,
    private readonly roadmapService: RoadmapService,
    private readonly metricsService: MetricsService,
    private readonly scoringService: ScoringService,
    private readonly recommendationService: RecommendationService,
  ) {}

  async generateReport(
    boardId: string,
    sprintId: string,
    forceRefresh = false,
  ): Promise<SprintReportResponse> {
    // Step 1: Load the sprint
    const sprint = await this.sprintRepo.findOne({ where: { id: sprintId, boardId } });
    if (!sprint) {
      throw new NotFoundException(`Sprint "${sprintId}" not found on board "${boardId}"`);
    }

    // Step 2: Only closed sprints
    if (sprint.state !== 'closed') {
      throw new BadRequestException('Sprint reports can only be generated for closed sprints');
    }

    // Step 3: Return cached report if not forcing refresh
    if (!forceRefresh) {
      const existing = await this.reportRepo.findOne({ where: { boardId, sprintId } });
      if (existing) {
        return existing.payload as SprintReportResponse;
      }
    }

    // Step 4: Load data in parallel
    const [detail, planningResults, roadmapResults, doraResults, priorReports] =
      await Promise.all([
        this.sprintDetailService.getDetail(boardId, sprintId),
        this.planningService.getAccuracy(boardId, sprintId).catch((err: unknown) => {
          this.logger.warn(
            `PlanningService.getAccuracy failed for ${boardId}/${sprintId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }),
        this.roadmapService.getAccuracy(boardId, sprintId).catch((err: unknown) => {
          this.logger.warn(
            `RoadmapService.getAccuracy failed for ${boardId}/${sprintId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }),
        this.metricsService.getDora({ boardId, sprintId }).catch((err: unknown) => {
          this.logger.warn(
            `MetricsService.getDora failed for ${boardId}/${sprintId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }),
        this.reportRepo
          .createQueryBuilder('r')
          .where('r.boardId = :boardId', { boardId })
          .andWhere('r.sprintId != :sprintId', { sprintId })
          .orderBy('r.startDate', 'DESC')
          .take(5)
          .getMany(),
      ]);

    const planning = planningResults[0] ?? null;
    const roadmap = roadmapResults[0] ?? null;
    const dora = doraResults[0] ?? null;

    // Step 5: Assemble ScoringInput
    const summary = detail.summary;

    const committedCount = planning?.commitment ?? summary.committedCount;
    const addedMidSprintCount = planning?.added ?? summary.addedMidSprintCount;
    const removedCount = planning?.removed ?? summary.removedCount;
    const completedInSprintCount = planning?.completed ?? summary.completedInSprintCount;

    const totalIssues = roadmap?.totalIssues ?? 0;
    const roadmapCoverage = roadmap?.roadmapCoverage ?? 0;

    const medianLeadTimeDays = dora?.leadTime?.medianDays ?? summary.medianLeadTimeDays ?? null;
    const deploymentsPerDay = dora?.deploymentFrequency?.deploymentsPerDay ?? 0;
    const changeFailureRate = dora?.changeFailureRate?.changeFailureRate ?? 0;
    const medianMttrHours = dora?.mttr?.medianHours ?? 0;

    const leadTimeBand: DoraBand = dora?.leadTime?.band ?? classifyLeadTime(medianLeadTimeDays ?? 9999);
    const dfBand: DoraBand = dora?.deploymentFrequency?.band ?? classifyDeploymentFrequency(deploymentsPerDay);
    const cfrBand: DoraBand = dora?.changeFailureRate?.band ?? classifyChangeFailureRate(changeFailureRate);
    const mttrBand: DoraBand = dora?.mttr?.band ?? classifyMTTR(medianMttrHours);

    const scoringInput: ScoringInput = {
      committedCount,
      addedMidSprintCount,
      removedCount,
      completedInSprintCount,
      roadmapCoverage,
      totalIssues,
      medianLeadTimeDays,
      deploymentsPerDay,
      changeFailureRate,
      medianMttrHours,
      leadTimeBand,
      dfBand,
      cfrBand,
      mttrBand,
    };

    // Step 6: Score
    const { scores, compositeScore, compositeBand } = this.scoringService.score(scoringInput);

    // Step 7: Recommendations
    const inScopeCount = committedCount + addedMidSprintCount - removedCount;
    const deliveryRate = inScopeCount > 0 ? completedInSprintCount / inScopeCount : 0;

    const recCtx: RecommendationContext = {
      deliveryRate,
      inScopeCount,
      committedCount,
      addedMidSprintCount,
      removedCount,
      roadmapCoverage,
      medianLeadTimeDays,
      deploymentsPerDay,
      changeFailureRate,
      medianMttrHours,
      incidentCount: summary.incidentCount,
      scores,
    };

    const recommendations = this.recommendationService.recommend(recCtx);

    // Step 8: dataAsOf from latest SyncLog
    const latestSync = await this.syncLogRepo.findOne({
      where: { boardId },
      order: { syncedAt: 'DESC' },
    });
    const dataAsOf = latestSync?.syncedAt?.toISOString() ?? new Date().toISOString();

    // Build trend from prior reports (oldest first — priorReports is DESC, so reverse)
    const trendPoints: SprintReportTrendPoint[] = [...priorReports].reverse().map((r) => {
      const payload = r.payload as SprintReportResponse;
      return {
        sprintId: r.sprintId,
        sprintName: r.sprintName,
        compositeScore: r.compositeScore,
        scores: payload.scores,
      };
    });

    // Step 9: Build response
    const response: SprintReportResponse = {
      boardId,
      sprintId,
      sprintName: sprint.name,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      endDate: sprint.endDate ? sprint.endDate.toISOString() : null,
      compositeScore,
      compositeBand,
      scores,
      recommendations,
      trend: trendPoints,
      generatedAt: new Date().toISOString(),
      dataAsOf,
    };

    // Step 10: Upsert to DB
    await this.reportRepo.save({
      boardId,
      sprintId,
      sprintName: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      compositeScore,
      compositeBand,
      payload: response as unknown as object,
      generatedAt: new Date(),
    });

    return response;
  }

  async generateIfClosed(boardId: string, sprintId: string): Promise<void> {
    try {
      const sprint = await this.sprintRepo.findOne({ where: { id: sprintId, boardId } });
      if (!sprint || sprint.state !== 'closed') return;

      const existing = await this.reportRepo.findOne({ where: { boardId, sprintId } });
      if (existing) return;

      await this.generateReport(boardId, sprintId);
    } catch (err) {
      this.logger.warn(
        `generateIfClosed failed for ${boardId}/${sprintId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async listReports(boardId: string): Promise<SprintReportSummary[]> {
    const reports = await this.reportRepo.find({
      where: { boardId },
      order: { startDate: 'DESC' },
    });

    return reports.map((r) => ({
      boardId: r.boardId,
      sprintId: r.sprintId,
      sprintName: r.sprintName,
      startDate: r.startDate ? r.startDate.toISOString() : null,
      endDate: r.endDate ? r.endDate.toISOString() : null,
      compositeScore: r.compositeScore,
      compositeBand: r.compositeBand,
      generatedAt: r.generatedAt.toISOString(),
    }));
  }

  async deleteReport(boardId: string, sprintId: string): Promise<void> {
    await this.reportRepo.delete({ boardId, sprintId });
  }
}
