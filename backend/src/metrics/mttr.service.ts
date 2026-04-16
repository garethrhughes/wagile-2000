import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';
import { classifyMTTR, type DoraBand } from './dora-bands.js';
import { percentile, round2 } from './statistics.js';
import { isWorkItem } from './issue-type-filters.js';
import type { TrendDataSlice } from './trend-data-loader.service.js';

// Default in-progress status names shared between the DB path and the in-memory path.
const DEFAULT_IN_PROGRESS_NAMES: string[] = [
  'In Progress', 'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
  'PEER CODE REVIEW', 'Ready for Review', 'In Test', 'IN TEST', 'QA',
  'QA testing', 'QA Validation', 'IN TESTING', 'Under Test', 'ready to test',
  'Ready for Testing', 'READY FOR TESTING', 'Ready for Release',
  'Ready for release', 'READY FOR RELEASE', 'Awaiting Release', 'READY',
];

export interface MttrResult {
  boardId: string;
  medianHours: number;
  band: DoraBand;
  incidentCount: number;
  /** Incidents opened in the period with no recovery transition yet. */
  openIncidentCount: number;
  /** Incidents with recovery timestamp before detection timestamp (data anomalies). */
  anomalyCount: number;
}

/** Internal return type of getMttrObservations — includes counters alongside sample. */
interface MttrObservations {
  recoveryHours: number[];
  openIncidentCount: number;
  anomalyCount: number;
}

@Injectable()
export class MttrService {
  private readonly logger = new Logger(MttrService.name);

  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  /**
   * Returns the raw sorted recovery-hours observations for a board/period,
   * plus counts of open incidents and data anomalies.
   * Used by MetricsService.getDoraAggregate() for pooled-median computation.
   */
  async getMttrObservations(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<MttrObservations> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const incidentIssueTypes = config?.incidentIssueTypes ?? ['Bug', 'Incident'];
    const recoveryStatuses = config?.recoveryStatusNames ?? ['Done', 'Resolved'];
    const incidentLabels = config?.incidentLabels ?? [];
    const incidentPriorities = config?.incidentPriorities ?? ['Critical'];
    const inProgressNames: string[] = config?.inProgressStatusNames ?? DEFAULT_IN_PROGRESS_NAMES;

    // Get incident issues for this board
    const allIssues = (await this.issueRepo.find({
      where: { boardId },
    })).filter((i) => isWorkItem(i.issueType));

    const incidentIssues = allIssues.filter((issue) => {
      const isIncidentType = incidentIssueTypes.includes(issue.issueType);
      const hasIncidentLabel =
        incidentLabels.length > 0
          ? issue.labels.some((l) => incidentLabels.includes(l))
          : false;
      return isIncidentType || hasIncidentLabel;
    });

    // AND-gate: filter by priority if incidentPriorities is non-empty
    const priorityFilteredIssues =
      incidentPriorities.length > 0
        ? incidentIssues.filter(
            (issue) =>
              issue.priority !== null &&
              incidentPriorities.includes(issue.priority),
          )
        : incidentIssues;

    if (priorityFilteredIssues.length === 0) return { recoveryHours: [], openIncidentCount: 0, anomalyCount: 0 };

    const incidentKeys = priorityFilteredIssues.map((i) => i.key);

    // Get all status changelogs for incident issues.
    // No lower-bound on changedAt: MTTR needs pre-period in-progress transitions
    // to determine the correct start time for incidents that were already in-flight
    // when the measurement window opens.  Period-scoping is applied via the
    // recoveryChangelogs filter below.
    const allIncidentChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: incidentKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group all changelogs by issue
    const changelogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of allIncidentChangelogs) {
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // Get recovery transitions in bulk (within the period)
    const recoveryChangelogs = allIncidentChangelogs.filter(
      (cl) =>
        recoveryStatuses.includes(cl.toValue ?? '') &&
        cl.changedAt >= startDate &&
        cl.changedAt <= endDate,
    );

    // Group by issue and take first recovery transition
    const firstRecoveryByIssue = new Map<string, Date>();
    for (const cl of recoveryChangelogs) {
      if (!firstRecoveryByIssue.has(cl.issueKey)) {
        firstRecoveryByIssue.set(cl.issueKey, cl.changedAt);
      }
    }

    // Calculate MTTR for each incident.
    // Start time = first "In Progress" transition (when work began), falling
    // back to issue creation if no such transition exists.
    //
    // Note (proposal 0029): MTTR is measured in wall-clock hours, not working
    // hours, because incident recovery time is an elapsed-time metric — teams
    // respond to incidents around the clock, not just during business hours.
    // WorkingTimeService is therefore intentionally NOT used here.
    const recoveryHours: number[] = [];
    let openIncidentCount = 0;
    let anomalyCount = 0;

    for (const issue of priorityFilteredIssues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
      );
      const startTime = inProgressTransition
        ? inProgressTransition.changedAt
        : issue.createdAt;

      const recoveryDate = firstRecoveryByIssue.get(issue.key);
      if (!recoveryDate) {
        // Incident has no recovery transition — it is still open.
        openIncidentCount++;
        continue;
      }

      const hours =
        (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
      if (hours < 0) {
        // Data anomaly: recovery timestamp precedes detection timestamp.
        // Log a warning so operators can investigate the underlying Jira data.
        this.logger.warn(
          `MTTR anomaly: issue ${issue.key} has recovery before detection ` +
          `(${recoveryDate.toISOString()} < ${startTime.toISOString()}).` +
          ` Excluding from MTTR sample.`,
        );
        anomalyCount++;
        continue;
      }

      recoveryHours.push(hours);
    }

    recoveryHours.sort((a, b) => a - b);
    return { recoveryHours, openIncidentCount, anomalyCount };
  }

  /**
   * In-memory variant for the trend path.
   * Accepts pre-loaded data from TrendDataLoader and slices it to [startDate, endDate].
   * No DB calls — pure computation.
   */
  getMttrObservationsFromData(
    slice: TrendDataSlice,
    startDate: Date,
    endDate: Date,
  ): MttrObservations {
    const incidentIssueTypes = slice.boardConfig?.incidentIssueTypes ?? ['Bug', 'Incident'];
    const recoveryStatuses   = slice.boardConfig?.recoveryStatusNames ?? ['Done', 'Resolved'];
    const incidentLabels     = slice.boardConfig?.incidentLabels     ?? [];
    const incidentPriorities = slice.boardConfig?.incidentPriorities ?? ['Critical'];
    const inProgressNames    = slice.boardConfig?.inProgressStatusNames ?? DEFAULT_IN_PROGRESS_NAMES;

    const incidentIssues = slice.issues.filter((issue) => {
      const isIncidentType = incidentIssueTypes.includes(issue.issueType);
      const hasIncidentLabel =
        incidentLabels.length > 0
          ? issue.labels.some((l) => incidentLabels.includes(l))
          : false;
      return isIncidentType || hasIncidentLabel;
    });

    const priorityFilteredIssues =
      incidentPriorities.length > 0
        ? incidentIssues.filter(
            (issue) =>
              issue.priority !== null && incidentPriorities.includes(issue.priority),
          )
        : incidentIssues;

    if (priorityFilteredIssues.length === 0) {
      return { recoveryHours: [], openIncidentCount: 0, anomalyCount: 0 };
    }

    const incidentKeySet = new Set(priorityFilteredIssues.map((i) => i.key));

    // Group changelogs by issue key (scoped to incident issues)
    const changelogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of slice.changelogs) {
      if (!incidentKeySet.has(cl.issueKey)) continue;
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // First recovery transition in period, per issue
    const firstRecoveryByIssue = new Map<string, Date>();
    for (const cl of slice.changelogs) {
      if (!incidentKeySet.has(cl.issueKey)) continue;
      if (
        recoveryStatuses.includes(cl.toValue ?? '') &&
        cl.changedAt >= startDate &&
        cl.changedAt <= endDate &&
        !firstRecoveryByIssue.has(cl.issueKey)
      ) {
        firstRecoveryByIssue.set(cl.issueKey, cl.changedAt);
      }
    }

    const recoveryHours: number[] = [];
    let openIncidentCount = 0;
    let anomalyCount = 0;

    for (const issue of priorityFilteredIssues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue !== null && inProgressNames.includes(cl.toValue),
      );
      const startTime = inProgressTransition
        ? inProgressTransition.changedAt
        : issue.createdAt;

      const recoveryDate = firstRecoveryByIssue.get(issue.key);
      if (!recoveryDate) {
        openIncidentCount++;
        continue;
      }

      const hours = (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
      if (hours < 0) {
        this.logger.warn(
          `MTTR anomaly (from data): issue ${issue.key} recovery before detection — excluding.`,
        );
        anomalyCount++;
        continue;
      }

      recoveryHours.push(hours);
    }

    recoveryHours.sort((a, b) => a - b);
    return { recoveryHours, openIncidentCount, anomalyCount };
  }

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<MttrResult> {
    const { recoveryHours, openIncidentCount, anomalyCount } =
      await this.getMttrObservations(boardId, startDate, endDate);

    if (recoveryHours.length === 0) {
      return {
        boardId,
        medianHours: 0,
        band: classifyMTTR(0),
        incidentCount: 0,
        openIncidentCount,
        anomalyCount,
      };
    }

    // Array is already sorted by getMttrObservations
    const median = percentile(recoveryHours, 50);

    return {
      boardId,
      medianHours: round2(median),
      band: classifyMTTR(median),
      incidentCount: recoveryHours.length,
      openIncidentCount,
      anomalyCount,
    };
  }
}
