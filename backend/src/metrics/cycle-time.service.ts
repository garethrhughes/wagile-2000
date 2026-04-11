import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
} from '../database/entities/index.js';
import { classifyCycleTime, type CycleTimeBand } from './cycle-time-bands.js';
import { percentile, round2 } from './statistics.js';
import { isWorkItem } from './issue-type-filters.js';

// ---------------------------------------------------------------------------
// Authoritative type definitions (single source of truth)
// Imported by the DTO file; NOT re-declared there.
// ---------------------------------------------------------------------------

export interface CycleTimeObservation {
  issueKey: string;
  issueType: string;
  summary: string;
  cycleTimeDays: number;
  completedAt: string;   // ISO — done transition
  startedAt: string;     // ISO — in-progress transition
  periodKey: string;     // e.g. "2026-Q1" or sprint name
  jiraUrl: string;       // deep-link into Jira
}

export interface CycleTimeResult {
  boardId: string;
  p50Days: number;
  p75Days: number;
  p85Days: number;
  p95Days: number;
  count: number;
  anomalyCount: number;
  observations: CycleTimeObservation[];
  band: CycleTimeBand;
}

export interface CycleTimeTrendPoint {
  label: string;
  start: string;
  end: string;
  medianCycleTimeDays: number;
  p85CycleTimeDays: number;
  sampleSize: number;
  band: CycleTimeBand;
}

// ---------------------------------------------------------------------------
// CycleTimeService
// ---------------------------------------------------------------------------

@Injectable()
export class CycleTimeService {
  private readonly logger = new Logger(CycleTimeService.name);
  private readonly jiraBaseUrl: string;

  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
    if (!baseUrl) {
      this.logger.warn(
        'JIRA_BASE_URL is not configured — jiraUrl fields will be empty strings',
      );
    }
    this.jiraBaseUrl = baseUrl;
  }

  /**
   * Returns per-issue cycle-time observations for a board/period.
   * Called by calculate() and by getCycleTimeTrend() for pooled-median.
   *
   * periodKey is embedded on every observation for display purposes.
   */
  async getCycleTimeObservations(
    boardId: string,
    startDate: Date,
    endDate: Date,
    periodKey: string,
    issueTypeFilter?: string,
  ): Promise<{ observations: CycleTimeObservation[]; anomalyCount: number }> {
    // 1. Load board config
    const config = await this.boardConfigRepo.findOne({ where: { boardId } });
    const inProgressNames = config?.inProgressStatusNames ?? [
      // Standard Jira active-work statuses
      'In Progress',
      // Review / peer-review variants (case-sensitive match against real data)
      'In Review',
      'Peer-Review',
      'Peer Review',
      'PEER REVIEW',
      'PEER CODE REVIEW',
      'Ready for Review',
      // Test / QA variants
      'In Test',
      'IN TEST',
      'QA',
      'QA testing',
      'QA Validation',
      'IN TESTING',
      'Under Test',
      'ready to test',
      'Ready for Testing',
      'READY FOR TESTING',
      // Pre-release staging variants
      'Ready for Release',
      'Ready for release',
      'READY FOR RELEASE',
      'Awaiting Release',
      'READY',
    ];
    const doneStatuses = config?.doneStatusNames ?? ['Done', 'Closed', 'Released'];

    // 2. Load all issues for this board (filtered by type if provided).
    // Epics and Sub-tasks are always excluded as non-deliverable issue types.
    // If issueTypeFilter is itself an excluded type, return empty immediately.
    if (issueTypeFilter && !isWorkItem(issueTypeFilter)) {
      return { observations: [], anomalyCount: 0 };
    }
    const issueWhere: { boardId: string; issueType?: string } = { boardId };
    if (issueTypeFilter) {
      issueWhere.issueType = issueTypeFilter;
    }
    const issues = (await this.issueRepo.find({ where: issueWhere }))
      .filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) {
      return { observations: [], anomalyCount: 0 };
    }

    const issueKeys = issues.map((i) => i.key);

    // 3. Fetch all status changelogs in bulk (ASC order → last match = most recent)
    const changelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group changelogs by issue key
    const changelogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of changelogs) {
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // Pre-fetch version release dates for fixVersion fallback
    const versionNames = [
      ...new Set(
        issues.map((i) => i.fixVersion).filter((v): v is string => v !== null),
      ),
    ];
    const versions =
      versionNames.length > 0
        ? await this.versionRepo.find({
            where: { name: In(versionNames), projectKey: boardId },
          })
        : [];
    const versionDateMap = new Map(
      versions
        .filter((v) => v.releaseDate !== null)
        .map((v) => [v.name, v.releaseDate as Date]),
    );

    const observations: CycleTimeObservation[] = [];
    let anomalyCount = 0;

    for (const issue of issues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];

      // Step (a): cycleStart = FIRST changelog where toValue ∈ inProgressStatusNames
      const inProgressTransition = issueLogs.find(
        (cl) => inProgressNames.includes(cl.toValue ?? ''),
      );

      if (!inProgressTransition) {
        // Issue 1 + proposal §1.3: no in-progress transition — mark as anomaly,
        // include in anomalyCount but exclude from percentile calculation.
        // We still continue rather than creating an observation with dummy times.
        anomalyCount++;
        continue;
      }

      const cycleStart = inProgressTransition.changedAt;

      // Step (b): cycleEnd = LAST done transition in period
      // An issue may be re-opened and re-resolved; we want the most recent
      // resolution within the period, not the first.
      const doneTransition = issueLogs
        .filter(
          (cl) =>
            doneStatuses.includes(cl.toValue ?? '') &&
            cl.changedAt >= startDate &&
            cl.changedAt <= endDate,
        )
        .at(-1);

      let cycleEnd: Date | null = null;

      if (doneTransition) {
        cycleEnd = doneTransition.changedAt;
      } else if (issue.fixVersion) {
        // Fallback: fixVersion releaseDate in period
        const releaseDate = versionDateMap.get(issue.fixVersion);
        if (
          releaseDate &&
          releaseDate >= startDate &&
          releaseDate <= endDate
        ) {
          cycleEnd = releaseDate;
        }
      }

      if (!cycleEnd) {
        // Issue not completed in this period — skip entirely
        continue;
      }

      // Step (c): compute cycle time, clamp negative values (data anomaly)
      const rawDays =
        (cycleEnd.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);

      if (rawDays < 0) {
        this.logger.warn(
          `Negative cycle time for ${issue.key}: ${rawDays.toFixed(2)} days — clamping to 0`,
        );
      }

      const cycleTimeDays = Math.max(0, rawDays);

      observations.push({
        issueKey: issue.key,
        issueType: issue.issueType ?? 'Unknown',
        summary: issue.summary ?? '',
        cycleTimeDays: round2(cycleTimeDays),
        completedAt: cycleEnd.toISOString(),
        startedAt: cycleStart.toISOString(),
        periodKey,
        jiraUrl: this.jiraBaseUrl
          ? `${this.jiraBaseUrl}/browse/${issue.key}`
          : '',
      });
    }

    // Sort by cycleTimeDays ASC (required for percentile calculation)
    observations.sort((a, b) => a.cycleTimeDays - b.cycleTimeDays);

    return { observations, anomalyCount };
  }

  /**
   * Main public method — aggregates observations into CycleTimeResult.
   * Explicit zero-observations fallback (mirrors LeadTimeService pattern).
   */
  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
    periodKey: string,
    issueTypeFilter?: string,
  ): Promise<CycleTimeResult> {
    const { observations, anomalyCount } = await this.getCycleTimeObservations(
      boardId,
      startDate,
      endDate,
      periodKey,
      issueTypeFilter,
    );

    // Explicit zero-observations guard (same as LeadTimeService)
    if (observations.length === 0) {
      return {
        boardId,
        p50Days: 0,
        p75Days: 0,
        p85Days: 0,
        p95Days: 0,
        count: 0,
        anomalyCount,
        observations: [],
        band: classifyCycleTime(0),
      };
    }

    const cycleTimes = observations.map((o) => o.cycleTimeDays);
    // Array is already sorted ASC by getCycleTimeObservations
    const p50 = percentile(cycleTimes, 50);
    const p75 = percentile(cycleTimes, 75);
    const p85 = percentile(cycleTimes, 85);
    const p95 = percentile(cycleTimes, 95);

    return {
      boardId,
      p50Days: round2(p50),
      p75Days: round2(p75),
      p85Days: round2(p85),
      p95Days: round2(p95),
      count: observations.length,
      anomalyCount,
      observations,
      band: classifyCycleTime(p50),
    };
  }
}
