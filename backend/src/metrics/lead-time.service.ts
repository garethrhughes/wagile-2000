import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
} from '../database/entities/index.js';
import { classifyLeadTime, type DoraBand } from './dora-bands.js';
import { percentile, round2 } from './statistics.js';
import { isWorkItem } from './issue-type-filters.js';
import { WorkingTimeService } from './working-time.service.js';
import type { TrendDataSlice } from './trend-data-loader.service.js';

// Default in-progress status names shared between the DB path and the in-memory path.
const DEFAULT_IN_PROGRESS_NAMES: string[] = [
  'In Progress', 'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
  'PEER CODE REVIEW', 'Ready for Review', 'In Test', 'IN TEST', 'QA',
  'QA testing', 'QA Validation', 'IN TESTING', 'Under Test', 'ready to test',
  'Ready for Testing', 'READY FOR TESTING', 'Ready for Release',
  'Ready for release', 'READY FOR RELEASE', 'Awaiting Release', 'READY',
];

export interface LeadTimeResult {
  boardId: string;
  medianDays: number;
  p95Days: number;
  band: DoraBand;
  sampleSize: number;
  /** Issues excluded because no in-progress transition was found (no work-started evidence) */
  anomalyCount: number;
}

@Injectable()
export class LeadTimeService {
  private readonly logger = new Logger(LeadTimeService.name);

  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly workingTimeService: WorkingTimeService,
  ) {}

  /**
   * Returns the raw sorted lead-time-days observations for a board/period,
   * plus a count of anomalous issues that were excluded: issues that had a
   * done-transition within the window but lacked any prior in-progress
   * transition (no work-started evidence).
   * Used by MetricsService.getDoraAggregate() for pooled-median computation.
   */
  async getLeadTimeObservations(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ observations: number[]; anomalyCount: number }> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const doneStatuses = config?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const inProgressNames: string[] = config?.inProgressStatusNames ?? DEFAULT_IN_PROGRESS_NAMES;

    // Get all issues for this board
    const issues = (await this.issueRepo.find({
      where: { boardId },
    })).filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) return { observations: [], anomalyCount: 0 };

    const issueKeys = issues.map((i) => i.key);

    // Fetch all status changelogs in bulk for these issues.
    // No lower-bound on changedAt: Lead Time needs pre-period in-progress
    // transitions to determine when work started on issues that were already
    // in-flight when the measurement window opens.  Period-scoping is applied
    // per-issue below via the doneTransition filter.
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

    // Pre-fetch version release dates for fixVersion lead time
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

    const leadTimeDays: number[] = [];
    let anomalyCount = 0;

    // Load working-time config once for the whole batch.
    const wtEntity = await this.workingTimeService.getConfig();
    const wtConfig = this.workingTimeService.toConfig(wtEntity);

    for (const issue of issues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];

      // Resolve in-progress start first — needed to guard the fixVersion fallback.
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
      );

      // Determine end time — only issues completed in this period are relevant.
      // Use the LAST done transition in the period (issue may be re-opened).
      const doneTransition = issueLogs
        .filter(
          (cl) =>
            doneStatuses.includes(cl.toValue ?? '') &&
            cl.changedAt >= startDate &&
            cl.changedAt <= endDate,
        )
        .at(-1);

      let endTime: Date | null = null;

      if (doneTransition) {
        endTime = doneTransition.changedAt;
      } else if (issue.fixVersion) {
        // Fallback: use version release date, but only if it is not earlier than
        // the in-progress transition — a release date that precedes work starting
        // produces a nonsensical negative duration (e.g. OCS-774: version 3.238
        // released before the issue moved to In Progress).
        const releaseDate = versionDateMap.get(issue.fixVersion);
        if (
          releaseDate &&
          releaseDate >= startDate &&
          releaseDate <= endDate &&
          (inProgressTransition === undefined ||
            releaseDate >= inProgressTransition.changedAt)
        ) {
          endTime = releaseDate;
        }
      }

      if (!endTime) continue;

      // If no in-progress transition exists the issue was completed in-window
      // but has no work-started evidence — window-scoped anomaly.
      if (!inProgressTransition) {
        anomalyCount++;
        continue;
      }
      const startTime: Date = inProgressTransition.changedAt;

      const days = wtEntity.excludeWeekends
        ? this.workingTimeService.workingDaysBetween(startTime, endTime, wtConfig)
        : (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
      if (days < 0) {
        this.logger.warn(
          `Negative lead time for ${issue.key}: ${days.toFixed(2)} days — clamping to 0`,
        );
      }
      leadTimeDays.push(Math.max(0, days));
    }

    leadTimeDays.sort((a, b) => a - b);
    return { observations: leadTimeDays, anomalyCount };
  }

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<LeadTimeResult> {
    const { observations: leadTimeDays, anomalyCount } = await this.getLeadTimeObservations(
      boardId,
      startDate,
      endDate,
    );

    if (leadTimeDays.length === 0) {
      return {
        boardId,
        medianDays: 0,
        p95Days: 0,
        band: classifyLeadTime(0),
        sampleSize: 0,
        anomalyCount,
      };
    }

    // Array is already sorted by getLeadTimeObservations
    const median = percentile(leadTimeDays, 50);
    const p95 = percentile(leadTimeDays, 95);

    return {
      boardId,
      medianDays: round2(median),
      p95Days: round2(p95),
      band: classifyLeadTime(median),
      sampleSize: leadTimeDays.length,
      anomalyCount,
    };
  }

  /**
   * In-memory variant for the trend path.
   * Accepts pre-loaded data from TrendDataLoader and slices it to [startDate, endDate].
   * No DB calls — pure computation.
   */
  getLeadTimeObservationsFromData(
    slice: TrendDataSlice,
    startDate: Date,
    endDate: Date,
  ): { observations: number[]; anomalyCount: number } {
    const doneStatuses = slice.boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const inProgressNames = slice.boardConfig?.inProgressStatusNames ?? DEFAULT_IN_PROGRESS_NAMES;

    if (slice.issues.length === 0) return { observations: [], anomalyCount: 0 };

    // Group changelogs by issue key (already filtered to status field in the slice)
    const changelogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of slice.changelogs) {
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // Build version → releaseDate map (full slice range; period guard applied per-issue below)
    const versionDateMap = new Map(
      slice.versions
        .filter((v) => v.releaseDate !== null)
        .map((v) => [v.name, v.releaseDate as Date]),
    );

    const wtConfig = this.workingTimeService.toConfig(slice.wtEntity);

    const leadTimeDays: number[] = [];
    let anomalyCount = 0;

    for (const issue of slice.issues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];

      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
      );

      const doneTransition = issueLogs
        .filter(
          (cl) =>
            doneStatuses.includes(cl.toValue ?? '') &&
            cl.changedAt >= startDate &&
            cl.changedAt <= endDate,
        )
        .at(-1);

      let endTime: Date | null = null;

      if (doneTransition) {
        endTime = doneTransition.changedAt;
      } else if (issue.fixVersion) {
        const releaseDate = versionDateMap.get(issue.fixVersion);
        if (
          releaseDate &&
          releaseDate >= startDate &&
          releaseDate <= endDate &&
          (inProgressTransition === undefined ||
            releaseDate >= inProgressTransition.changedAt)
        ) {
          endTime = releaseDate;
        }
      }

      if (!endTime) continue;

      if (!inProgressTransition) {
        anomalyCount++;
        continue;
      }

      const startTime: Date = inProgressTransition.changedAt;
      const days = slice.wtEntity.excludeWeekends
        ? this.workingTimeService.workingDaysBetween(startTime, endTime, wtConfig)
        : (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);

      leadTimeDays.push(Math.max(0, days));
    }

    leadTimeDays.sort((a, b) => a - b);
    return { observations: leadTimeDays, anomalyCount };
  }
}
