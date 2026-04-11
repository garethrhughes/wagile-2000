import { Injectable } from '@nestjs/common';
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

export interface LeadTimeResult {
  boardId: string;
  medianDays: number;
  p95Days: number;
  band: DoraBand;
  sampleSize: number;
}

@Injectable()
export class LeadTimeService {
  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  /**
   * Returns the raw sorted lead-time-days observations for a board/period.
   * Used by MetricsService.getDoraAggregate() for pooled-median computation.
   */
  async getLeadTimeObservations(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<number[]> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const doneStatuses = config?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];
    const isKanban = config?.boardType === 'kanban';

    // Get all issues for this board
    const issues = (await this.issueRepo.find({
      where: { boardId },
    })).filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) return [];

    const issueKeys = issues.map((i) => i.key);

    // Fetch all status changelogs in bulk for these issues
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

    for (const issue of issues) {
      const issueLogs = changelogsByIssue.get(issue.key) ?? [];

      // Determine start time.
      // For both Scrum and Kanban: prefer the first "In Progress" transition,
      // which reflects when a team member actually began the work (aligns with
      // LinearB's Jira-based Coding Time methodology and is more accurate than
      // issue creation, which can precede active work by days or weeks).
      // Kanban: skip issues with no In Progress transition (no meaningful start).
      // Scrum: fall back to issue creation if no transition exists.
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue === 'In Progress',
      );
      let startTime: Date;
      if (inProgressTransition) {
        startTime = inProgressTransition.changedAt;
      } else if (isKanban) {
        continue;
      } else {
        startTime = issue.createdAt;
      }

      // Determine end time: first done/released transition in the period
      const doneTransition = issueLogs.find(
        (cl) =>
          doneStatuses.includes(cl.toValue ?? '') &&
          cl.changedAt >= startDate &&
          cl.changedAt <= endDate,
      );

      let endTime: Date | null = null;

      if (doneTransition) {
        endTime = doneTransition.changedAt;
      } else if (issue.fixVersion) {
        // Fallback: use version release date
        const releaseDate = versionDateMap.get(issue.fixVersion);
        if (
          releaseDate &&
          releaseDate >= startDate &&
          releaseDate <= endDate
        ) {
          endTime = releaseDate;
        }
      }

      if (!endTime) continue;

      const days =
        (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
      if (days >= 0) {
        leadTimeDays.push(days);
      }
    }

    leadTimeDays.sort((a, b) => a - b);
    return leadTimeDays;
  }

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<LeadTimeResult> {
    const leadTimeDays = await this.getLeadTimeObservations(
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
    };
  }
}
