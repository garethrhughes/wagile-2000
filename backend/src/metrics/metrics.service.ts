import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DeploymentFrequencyService,
  type DeploymentFrequencyResult,
} from './deployment-frequency.service.js';
import { LeadTimeService, type LeadTimeResult } from './lead-time.service.js';
import { CfrService, type CfrResult } from './cfr.service.js';
import { MttrService, type MttrResult } from './mttr.service.js';
import {
  CycleTimeService,
  type CycleTimeResult,
  type CycleTimeTrendPoint,
} from './cycle-time.service.js';
import { classifyCycleTime } from './cycle-time-bands.js';
import { JiraSprint, BoardConfig } from '../database/entities/index.js';
import { MetricsQueryDto } from './dto/metrics-query.dto.js';
import { DoraAggregateQueryDto } from './dto/dora-aggregate-query.dto.js';
import { DoraTrendQueryDto } from './dto/dora-trend-query.dto.js';
import { CycleTimeQueryDto } from './dto/cycle-time-query.dto.js';
import { CycleTimeTrendQueryDto } from './dto/cycle-time-trend-query.dto.js';
import {
  type OrgDoraResult,
  type TrendResponse,
  type TrendPoint,
  type DoraMetricsBoardBreakdown,
} from './dto/org-dora-response.dto.js';
import {
  classifyDeploymentFrequency,
  classifyLeadTime,
  classifyChangeFailureRate,
  classifyMTTR,
} from './dora-bands.js';
import { percentile, round2 } from './statistics.js';
import { listRecentQuarters, quarterToDates } from './period-utils.js';
import { DoraCacheService } from './dora-cache.service.js';
import { TrendDataLoader, type TrendDataSlice } from './trend-data-loader.service.js';

export interface DoraMetricsResult {
  boardId: string;
  period: { start: string; end: string };
  deploymentFrequency: DeploymentFrequencyResult;
  leadTime: LeadTimeResult;
  changeFailureRate: CfrResult;
  mttr: MttrResult;
}

export type { CycleTimeResult, CycleTimeTrendPoint };

// ---------------------------------------------------------------------------
// Internal helper type for per-board results before org-level aggregation.
// ---------------------------------------------------------------------------
interface PerBoardDoraResult {
  boardId: string;
  df: DeploymentFrequencyResult;
  cfr: CfrResult;
  lt: LeadTimeResult;
  mttr: MttrResult;
  ltObs: number[];
  mttrObs: number[];
  boardConfig: BoardConfig | null;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly timezone: string;

  constructor(
    private readonly deploymentFrequencyService: DeploymentFrequencyService,
    private readonly leadTimeService: LeadTimeService,
    private readonly cfrService: CfrService,
    private readonly mttrService: MttrService,
    private readonly cycleTimeService: CycleTimeService,
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly configService: ConfigService,
    private readonly doraCache: DoraCacheService,
    private readonly trendDataLoader: TrendDataLoader,
  ) {
    this.timezone = this.configService.get<string>('TIMEZONE', 'UTC');
  }

  async getDora(query: MetricsQueryDto): Promise<DoraMetricsResult[]> {
    let { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    // If sprintId is provided, resolve dates from the sprint record
    if (query.sprintId) {
      const sprint = await this.sprintRepo.findOne({
        where: { id: query.sprintId },
      });
      if (sprint?.startDate && sprint?.endDate) {
        startDate = sprint.startDate;
        endDate = sprint.endDate;
      }
    }

    const results: DoraMetricsResult[] = [];

    for (const boardId of boardIds) {
      const [deploymentFrequency, leadTime, changeFailureRate, mttr] =
        await Promise.all([
          this.deploymentFrequencyService.calculate(
            boardId,
            startDate,
            endDate,
          ),
          this.leadTimeService.calculate(boardId, startDate, endDate),
          this.cfrService.calculate(boardId, startDate, endDate),
          this.mttrService.calculate(boardId, startDate, endDate),
        ]);

      results.push({
        boardId,
        period: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        deploymentFrequency,
        leadTime,
        changeFailureRate,
        mttr,
      });
    }

    return results;
  }

  async getDeploymentFrequency(
    query: MetricsQueryDto,
  ): Promise<DeploymentFrequencyResult[]> {
    const { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    return Promise.all(
      boardIds.map((id) =>
        this.deploymentFrequencyService.calculate(id, startDate, endDate),
      ),
    );
  }

  async getLeadTime(query: MetricsQueryDto): Promise<LeadTimeResult[]> {
    const { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    return Promise.all(
      boardIds.map((id) =>
        this.leadTimeService.calculate(id, startDate, endDate),
      ),
    );
  }

  async getCfr(query: MetricsQueryDto): Promise<CfrResult[]> {
    const { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    return Promise.all(
      boardIds.map((id) =>
        this.cfrService.calculate(id, startDate, endDate),
      ),
    );
  }

  async getMttr(query: MetricsQueryDto): Promise<MttrResult[]> {
    const { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    return Promise.all(
      boardIds.map((id) =>
        this.mttrService.calculate(id, startDate, endDate),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // getDoraAggregate (RC-1: does NOT call getDora(); calls per-board services
  // directly in parallel via Promise.all per RC-6)
  // ---------------------------------------------------------------------------

  async getDoraAggregate(query: DoraAggregateQueryDto): Promise<OrgDoraResult> {
    // ---------------------------------------------------------------------------
    // Cache look-up — avoid re-running expensive multi-table DB queries on every
    // HTTP request.  TTL is 60 s; this is fine because DORA metrics are computed
    // from historical Jira data that only changes during a background sync.
    // ---------------------------------------------------------------------------
    const cacheKey = DoraCacheService.buildKey(
      {
        boardId: query.boardId,
        quarter: query.quarter,
        sprintId: query.sprintId,
        period: query.period,
      },
      'aggregate',
    );
    const cached = this.doraCache.get<OrgDoraResult>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    // If sprintId is provided, resolve dates from the sprint record
    if (query.sprintId) {
      const sprint = await this.sprintRepo.findOne({
        where: { id: query.sprintId },
      });
      if (sprint?.startDate && sprint?.endDate) {
        startDate = sprint.startDate;
        endDate = sprint.endDate;
      }
    }

    // RC-6: parallelize all per-board calls using Promise.all over boardIds.
    // Each board runs its four service calls in an inner Promise.all.
    const boardResults = await Promise.all(
      boardIds.map(async (boardId) => {
        // Fetch observations (raw arrays) and totals (df, cfr) in parallel.
        // Lead time and MTTR summaries are derived from observations to avoid
        // duplicate DB queries (RC-1).
        const [df, cfr, ltResult, mttrObsResult, boardConfig] = await Promise.all([
          this.deploymentFrequencyService.calculate(boardId, startDate, endDate),
          this.cfrService.calculate(boardId, startDate, endDate),
          this.leadTimeService.getLeadTimeObservations(boardId, startDate, endDate),
          this.mttrService.getMttrObservations(boardId, startDate, endDate),
          this.boardConfigRepo.findOne({ where: { boardId } }),
        ]);

        const ltObs = ltResult.observations;
        const ltAnomalyCount = ltResult.anomalyCount;
        const mttrObs = mttrObsResult.recoveryHours;
        const mttrOpenCount = mttrObsResult.openIncidentCount;
        const mttrAnomalyCount = mttrObsResult.anomalyCount;

        const ltMedian = percentile(ltObs, 50);
        const ltP95 = percentile(ltObs, 95);
        const lt: LeadTimeResult = {
          boardId,
          medianDays: round2(ltMedian),
          p95Days: round2(ltP95),
          band: classifyLeadTime(ltMedian),
          sampleSize: ltObs.length,
          anomalyCount: ltAnomalyCount,
        };

        const mttrMedianVal = percentile(mttrObs, 50);
        const mttr: MttrResult = {
          boardId,
          medianHours: round2(mttrMedianVal),
          band: classifyMTTR(mttrMedianVal),
          incidentCount: mttrObs.length,
          openIncidentCount: mttrOpenCount,
          anomalyCount: mttrAnomalyCount,
        };

        return { boardId, df, cfr, lt, mttr, ltObs, mttrObs, boardConfig };
      }),
    );

    const result = this.buildOrgDoraResult(boardResults, startDate, endDate);

    // Store in cache before returning
    this.doraCache.set(cacheKey, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // getDoraTrend
  //
  // Change 2: loads all board data once for the full trend range via
  // TrendDataLoader, then fans out to per-period in-memory calculations.
  // Query budget: ~2–4 per board (regardless of period count) vs the previous
  // ~9 × boards × periods.
  // ---------------------------------------------------------------------------

  async getDoraTrend(query: DoraTrendQueryDto): Promise<TrendResponse> {
    // Cache look-up — serve repeated page loads instantly
    const trendCacheKey = DoraCacheService.buildKey(
      {
        boardId: query.boardId,
        mode: query.mode,
        limit: query.limit,
      },
      'trend',
    );
    const cachedTrend = this.doraCache.get<TrendResponse>(trendCacheKey);
    if (cachedTrend !== undefined) {
      return cachedTrend;
    }

    const limit = query.limit ?? 8;
    const mode = query.mode ?? 'quarters';
    const boardIds = await this.resolveBoardIds(query.boardId);

    if (mode === 'sprints') {
      // RC-8: throw BadRequestException if the board is Kanban.
      const boardIdStr = query.boardId;
      if (!boardIdStr) {
        throw new BadRequestException(
          'Sprint trend mode requires a single boardId.',
        );
      }
      const boardId = boardIdStr.split(',')[0].trim();
      const boardConfig = await this.boardConfigRepo.findOne({
        where: { boardId },
      });
      if (boardConfig?.boardType === 'kanban') {
        throw new BadRequestException(
          `Sprint trend mode requires a Scrum board. ${boardId} is a Kanban board.`,
        );
      }

      const sprints = (await this.sprintRepo.find({
        where: { boardId, state: 'closed' },
        order: { endDate: 'DESC' },
        take: limit,
      })).filter((s) => s.startDate !== null && s.endDate !== null);

      if (sprints.length === 0) return [];

      // Determine full date range spanning all sprints
      const rangeStart = sprints[sprints.length - 1].startDate as Date;
      const rangeEnd   = sprints[0].endDate as Date;

      // Sprint trend is always single-board: load data only for the board whose
      // sprints were fetched.  Using the full resolved boardIds list here would
      // mix multi-board data into an org aggregate while the sprint list itself
      // is scoped to a single board, producing incorrect trend results.
      const slices = await Promise.all(
        [boardId].map((bid) => this.trendDataLoader.load(bid, rangeStart, rangeEnd)),
      );

      const points = sprints.map((sprint): TrendPoint => {
        const periodStart = sprint.startDate as Date;
        const periodEnd   = sprint.endDate as Date;
        const agg = this.buildOrgDoraResultFromData(slices, periodStart, periodEnd);
        return {
          label: sprint.name,
          start: periodStart.toISOString(),
          end:   periodEnd.toISOString(),
          deploymentsPerDay:    agg.orgDeploymentFrequency.deploymentsPerDay,
          medianLeadTimeDays:   agg.orgLeadTime.medianDays,
          changeFailureRate:    agg.orgChangeFailureRate.changeFailureRate,
          mttrMedianHours:      agg.orgMttr.medianHours,
          orgBands: {
            deploymentFrequency: agg.orgDeploymentFrequency.band,
            leadTime:            agg.orgLeadTime.band,
            changeFailureRate:   agg.orgChangeFailureRate.band,
            mttr:                agg.orgMttr.band,
          },
        };
      });

      // Return oldest → newest; sprints are historical by definition
      const sprintTrend = points.reverse();
      this.doraCache.set(trendCacheKey, sprintTrend, DoraCacheService.HISTORICAL_TTL_MS);
      return sprintTrend;
    }

    // Quarter mode (default)
    const quarters = listRecentQuarters(limit, this.timezone); // newest first

    // Determine full date range spanning all quarters
    const rangeStart = quarters[quarters.length - 1].startDate;
    const rangeEnd   = quarters[0].endDate;

    // Load data once per board for the full span
    const slices = await Promise.all(
      boardIds.map((bid) => this.trendDataLoader.load(bid, rangeStart, rangeEnd)),
    );

    const points = quarters.map((q): TrendPoint => {
      const agg = this.buildOrgDoraResultFromData(slices, q.startDate, q.endDate);
      return {
        label: q.label,
        start: q.startDate.toISOString(),
        end:   q.endDate.toISOString(),
        deploymentsPerDay:    agg.orgDeploymentFrequency.deploymentsPerDay,
        medianLeadTimeDays:   agg.orgLeadTime.medianDays,
        changeFailureRate:    agg.orgChangeFailureRate.changeFailureRate,
        mttrMedianHours:      agg.orgMttr.medianHours,
        orgBands: {
          deploymentFrequency: agg.orgDeploymentFrequency.band,
          leadTime:            agg.orgLeadTime.band,
          changeFailureRate:   agg.orgChangeFailureRate.band,
          mttr:                agg.orgMttr.band,
        },
      };
    });

    // Return oldest → newest
    const quarterTrend = points.reverse();

    // Change 3: cache historical trends longer — data is immutable once the quarter closes
    const allHistorical = quarters.every((q) =>
      DoraCacheService.isHistoricalQuarter(q.label, this.timezone),
    );
    const ttl = allHistorical ? DoraCacheService.HISTORICAL_TTL_MS : undefined;
    this.doraCache.set(trendCacheKey, quarterTrend, ttl);
    return quarterTrend;
  }

  // ---------------------------------------------------------------------------
  // getCycleTime
  // ---------------------------------------------------------------------------

  async getCycleTime(query: CycleTimeQueryDto): Promise<CycleTimeResult[]> {
    let { startDate, endDate } = this.resolvePeriod(query);
    const boardIds = await this.resolveBoardIds(query.boardId);

    // Resolve period key for embedding in observations
    const periodKey = query.quarter ?? query.sprintId ?? 'custom';

    // If sprintId is provided, resolve dates from the sprint record
    if (query.sprintId) {
      const sprint = await this.sprintRepo.findOne({
        where: { id: query.sprintId },
      });
      if (sprint?.startDate && sprint?.endDate) {
        startDate = sprint.startDate;
        endDate = sprint.endDate;
      }
    }

    return Promise.all(
      boardIds.map((boardId) =>
        this.cycleTimeService.calculate(
          boardId,
          startDate,
          endDate,
          periodKey,
          query.issueType,
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // getCycleTimeTrend
  // ---------------------------------------------------------------------------

  async getCycleTimeTrend(
    query: CycleTimeTrendQueryDto,
  ): Promise<CycleTimeTrendPoint[]> {
    const limit = query.limit ?? 8;
    const mode = query.mode ?? 'quarters';
    const boardIds = await this.resolveBoardIds(query.boardId);

    if (mode === 'sprints') {
      // Issue 5: single boardId guard — same as getDoraTrend()
      if (!query.boardId) {
        throw new BadRequestException(
          'Sprint trend mode requires a single boardId.',
        );
      }
      const boardId = boardIds[0];
      const boardConfig = await this.boardConfigRepo.findOne({
        where: { boardId },
      });
      if (boardConfig?.boardType === 'kanban') {
        throw new BadRequestException(
          `Sprint trend mode requires a Scrum board. ${boardId} is a Kanban board.`,
        );
      }

      const sprints = await this.sprintRepo.find({
        where: { boardId, state: 'closed' },
        order: { endDate: 'DESC' },
        take: limit,
      });

      if (sprints.length === 0) return [];

      const points = await Promise.all(
        sprints.map(async (sprint): Promise<CycleTimeTrendPoint> => {
          const start = sprint.startDate ?? new Date();
          const end = sprint.endDate ?? new Date();
          const result = await this.cycleTimeService.calculate(
            boardId,
            start,
            end,
            sprint.name,
            query.issueType,
          );
          return {
            label: sprint.name,
            start: start.toISOString(),
            end: end.toISOString(),
            medianCycleTimeDays: result.p50Days,
            p85CycleTimeDays: result.p85Days,
            sampleSize: result.count,
            band: result.band,
          };
        }),
      );

      return points.reverse(); // oldest → newest
    }

    // Quarter mode (default)
    const quarters = listRecentQuarters(limit, this.timezone); // newest first
    const points = await Promise.all(
      quarters.map(async (q): Promise<CycleTimeTrendPoint> => {
        // Pool observations across all selected boards for a true cross-board median
        const results = await Promise.all(
          boardIds.map((boardId) =>
            this.cycleTimeService.getCycleTimeObservations(
              boardId,
              q.startDate,
              q.endDate,
              q.label,
              query.issueType,
            ),
          ),
        );
        const allObs = results.flatMap((r) => r.observations);
        const sorted = allObs.map((o) => o.cycleTimeDays).sort((a, b) => a - b);
        const p50 = percentile(sorted, 50);
        return {
          label: q.label,
          start: q.startDate.toISOString(),
          end: q.endDate.toISOString(),
          medianCycleTimeDays: round2(p50),
          p85CycleTimeDays: round2(percentile(sorted, 85)),
          sampleSize: sorted.length,
          band: classifyCycleTime(p50),
        };
      }),
    );

    return points.reverse(); // oldest → newest
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveBoardIds(boardId: string | undefined): Promise<string[]> {
    if (boardId) {
      return boardId.split(',').map((id) => id.trim());
    }
    const configs = await this.boardConfigRepo.find({ select: ['boardId'] });
    return configs.map((c) => c.boardId);
  }

  private resolvePeriod(query: {
    quarter?: string;
    sprintId?: string;
    period?: string;
  }): {
    startDate: Date;
    endDate: Date;
  } {
    // Quarter format: YYYY-QN
    if (query.quarter) {
      const { startDate, endDate } = quarterToDates(query.quarter, this.timezone);
      return { startDate, endDate };
    }

    // Explicit date range: YYYY-MM-DD:YYYY-MM-DD
    if (query.period && query.period.includes(':')) {
      const [start, end] = query.period.split(':');
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
        return { startDate, endDate };
      }
    }

    // Default: last 90 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90);
    return { startDate, endDate };
  }

  /**
   * Aggregates per-board results into a single OrgDoraResult.
   * Used by both getDoraAggregate (DB path) and buildOrgDoraResultFromData (trend path).
   */
  private buildOrgDoraResult(
    boardResults: PerBoardDoraResult[],
    startDate: Date,
    endDate: Date,
  ): OrgDoraResult {
    // --- Org-level deployment frequency: sum of totals
    const totalDeployments = boardResults.reduce(
      (sum, r) => sum + r.df.totalDeployments,
      0,
    );
    const periodMs = endDate.getTime() - startDate.getTime();
    const periodDays = Math.max(periodMs / (1000 * 60 * 60 * 24), 1);
    const deploymentsPerDay = totalDeployments / periodDays;
    const dfContributing = boardResults.filter((r) => r.df.totalDeployments > 0).length;

    // --- Org-level lead time: pooled median across all boards' observations
    const allLtObs = boardResults.flatMap((r) => r.ltObs);
    allLtObs.sort((a, b) => a - b);
    const ltMedian = percentile(allLtObs, 50);
    const ltP95 = percentile(allLtObs, 95);
    const ltContributing = boardResults.filter((r) => r.ltObs.length > 0).length;
    const ltAnomalyTotal = boardResults.reduce(
      (sum, r) => sum + r.lt.anomalyCount,
      0,
    );

    // --- Org-level CFR: ratio of sums
    const totalFailures = boardResults.reduce(
      (sum, r) => sum + r.cfr.failureCount,
      0,
    );
    const totalDeplForCfr = boardResults.reduce(
      (sum, r) => sum + r.cfr.totalDeployments,
      0,
    );
    const orgCfr =
      totalDeplForCfr > 0
        ? Math.round((totalFailures / totalDeplForCfr) * 10000) / 100
        : 0;
    const cfrContributing = boardResults.filter(
      (r) => r.cfr.totalDeployments > 0,
    ).length;
    const boardsUsingDefaultConfig = boardResults
      .filter((r) => r.cfr.usingDefaultConfig)
      .map((r) => r.boardId);
    const anyBoardUsingDefaultConfig = boardsUsingDefaultConfig.length > 0;

    // --- Org-level MTTR: pooled median across all boards' observations
    const allMttrObs = boardResults.flatMap((r) => r.mttrObs);
    allMttrObs.sort((a, b) => a - b);
    const mttrMedian = percentile(allMttrObs, 50);
    const mttrContributing = boardResults.filter((r) => r.mttrObs.length > 0).length;
    const totalIncidents = allMttrObs.length;

    // --- Per-board breakdowns (RC-4: include boardType)
    const boardBreakdowns: DoraMetricsBoardBreakdown[] = boardResults.map((r) => {
      const rawBoardType = r.boardConfig?.boardType ?? 'scrum';
      const boardType: 'scrum' | 'kanban' =
        rawBoardType === 'kanban' ? 'kanban' : 'scrum';
      return {
        boardId: r.boardId,
        period: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        deploymentFrequency: r.df,
        leadTime: r.lt,
        changeFailureRate: r.cfr,
        mttr: r.mttr,
        boardType,
      };
    });

    return {
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      orgDeploymentFrequency: {
        totalDeployments,
        deploymentsPerDay: round2(deploymentsPerDay),
        band: classifyDeploymentFrequency(deploymentsPerDay),
        periodDays: Math.round(periodDays),
        contributingBoards: dfContributing,
      },
      orgLeadTime: {
        medianDays: round2(ltMedian),
        p95Days: round2(ltP95),
        band: classifyLeadTime(ltMedian),
        sampleSize: allLtObs.length,
        contributingBoards: ltContributing,
        anomalyCount: ltAnomalyTotal,
      },
      orgChangeFailureRate: {
        totalDeployments: totalDeplForCfr,
        failureCount: totalFailures,
        changeFailureRate: orgCfr,
        band: classifyChangeFailureRate(orgCfr),
        contributingBoards: cfrContributing,
        anyBoardUsingDefaultConfig,
        boardsUsingDefaultConfig,
      },
      orgMttr: {
        medianHours: round2(mttrMedian),
        band: classifyMTTR(mttrMedian),
        incidentCount: totalIncidents,
        contributingBoards: mttrContributing,
      },
      boardBreakdowns,
      anyBoardUsingDefaultConfig,
      boardsUsingDefaultConfig,
    };
  }

  /**
   * Computes an OrgDoraResult for a single period using pre-loaded TrendDataSlices.
   * All calculations are in-memory — no DB calls.
   */
  private buildOrgDoraResultFromData(
    slices: TrendDataSlice[],
    startDate: Date,
    endDate: Date,
  ): OrgDoraResult {
    const boardResults: PerBoardDoraResult[] = slices.map((slice) => {
      const df  = this.deploymentFrequencyService.calculateFromData(slice, startDate, endDate);
      const cfr = this.cfrService.calculateFromData(slice, startDate, endDate);
      const ltResult   = this.leadTimeService.getLeadTimeObservationsFromData(slice, startDate, endDate);
      const mttrResult = this.mttrService.getMttrObservationsFromData(slice, startDate, endDate);

      const ltObs = ltResult.observations;
      const ltAnomalyCount = ltResult.anomalyCount;
      const mttrObs = mttrResult.recoveryHours;
      const mttrOpenCount = mttrResult.openIncidentCount;
      const mttrAnomalyCount = mttrResult.anomalyCount;

      const ltMedian = percentile(ltObs, 50);
      const ltP95    = percentile(ltObs, 95);
      const lt: LeadTimeResult = {
        boardId: slice.boardId,
        medianDays: round2(ltMedian),
        p95Days:    round2(ltP95),
        band: classifyLeadTime(ltMedian),
        sampleSize: ltObs.length,
        anomalyCount: ltAnomalyCount,
      };

      const mttrMedianVal = percentile(mttrObs, 50);
      const mttr: MttrResult = {
        boardId: slice.boardId,
        medianHours: round2(mttrMedianVal),
        band: classifyMTTR(mttrMedianVal),
        incidentCount: mttrObs.length,
        openIncidentCount: mttrOpenCount,
        anomalyCount: mttrAnomalyCount,
      };

      return {
        boardId: slice.boardId,
        df,
        cfr,
        lt,
        mttr,
        ltObs,
        mttrObs,
        boardConfig: slice.boardConfig,
      };
    });

    return this.buildOrgDoraResult(boardResults, startDate, endDate);
  }
}
