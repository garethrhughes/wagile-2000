import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';
import { classifyMTTR, type DoraBand } from './dora-bands.js';

export interface MttrResult {
  boardId: string;
  medianHours: number;
  band: DoraBand;
  incidentCount: number;
}

@Injectable()
export class MttrService {
  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<MttrResult> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const incidentIssueTypes = config?.incidentIssueTypes ?? [
      'Bug',
      'Incident',
    ];
    const recoveryStatuses = config?.recoveryStatusNames ?? [
      'Done',
      'Resolved',
    ];
    const incidentLabels = config?.incidentLabels ?? [];
    const incidentPriorities = config?.incidentPriorities ?? ['Critical'];

    // Get incident issues for this board
    const allIssues = await this.issueRepo.find({
      where: { boardId },
    });

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

    if (priorityFilteredIssues.length === 0) {
      return {
        boardId,
        medianHours: 0,
        band: classifyMTTR(0),
        incidentCount: 0,
      };
    }

    const incidentKeys = priorityFilteredIssues.map((i) => i.key);

    // Get all status changelogs for incident issues (in period for recovery,
    // but we also need pre-period In Progress transitions for start time)
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
    // back to issue creation if no such transition exists. This avoids
    // undercounting when tickets are created hours after the incident starts
    // being actively worked — measuring ticket lifecycle rather than wall-clock
    // discovery time.
    const issueMap = new Map(priorityFilteredIssues.map((i) => [i.key, i]));
    const recoveryHours: number[] = [];

    for (const [issueKey, recoveryDate] of firstRecoveryByIssue) {
      const issue = issueMap.get(issueKey);
      if (!issue) continue;

      const issueLogs = changelogsByIssue.get(issueKey) ?? [];
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue === 'In Progress',
      );
      const startTime = inProgressTransition
        ? inProgressTransition.changedAt
        : issue.createdAt;

      const hours =
        (recoveryDate.getTime() - startTime.getTime()) / (1000 * 60 * 60);
      if (hours >= 0) {
        recoveryHours.push(hours);
      }
    }

    if (recoveryHours.length === 0) {
      return {
        boardId,
        medianHours: 0,
        band: classifyMTTR(0),
        incidentCount: 0,
      };
    }

    recoveryHours.sort((a, b) => a - b);
    const median = percentile(recoveryHours, 50);

    return {
      boardId,
      medianHours: Math.round(median * 100) / 100,
      band: classifyMTTR(median),
      incidentCount: recoveryHours.length,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
}
