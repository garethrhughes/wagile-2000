import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import {
  JiraIssue,
  JiraVersion,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';
import {
  classifyDeploymentFrequency,
  type DoraBand,
} from './dora-bands.js';
import { isWorkItem } from './issue-type-filters.js';

export interface DeploymentFrequencyResult {
  boardId: string;
  totalDeployments: number;
  deploymentsPerDay: number;
  band: DoraBand;
  periodDays: number;
}

@Injectable()
export class DeploymentFrequencyService {
  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<DeploymentFrequencyResult> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const doneStatuses = config?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];

    // Primary path: issues with a fixVersion whose releaseDate falls in range.
    const releasedVersions = await this.versionRepo.find({
      where: {
        projectKey: boardId,
        released: true,
        releaseDate: Between(startDate, endDate),
      },
    });

    const versionNames = releasedVersions.map((v) => v.name);
    let versionIssueKeys = new Set<string>();

    if (versionNames.length > 0) {
      const issues = (await this.issueRepo.find({
        where: {
          boardId,
          fixVersion: In(versionNames),
        },
      })).filter((i) => isWorkItem(i.issueType));
      versionIssueKeys = new Set(issues.map((i) => i.key));
    }

    // Fallback path: issues with NO fixVersion that transitioned to a done status
    // in the period.  We only count issues not already counted by the version path,
    // so there is no double-counting.
    const allBoardIssues = (await this.issueRepo.find({
      where: { boardId },
      select: ['key', 'issueType', 'fixVersion'],
    })).filter((i) => isWorkItem(i.issueType));

    const noVersionKeys = allBoardIssues
      .filter((i) => !i.fixVersion && !versionIssueKeys.has(i.key))
      .map((i) => i.key);

    let transitionKeys = new Set<string>();
    if (noVersionKeys.length > 0) {
      const rows = await this.changelogRepo
        .createQueryBuilder('cl')
        .select('DISTINCT cl.issueKey', 'issueKey')
        .where('cl.issueKey IN (:...keys)', { keys: noVersionKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
        .andWhere('cl.changedAt BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .getRawMany<{ issueKey: string }>();
      transitionKeys = new Set(rows.map((r) => r.issueKey));
    }

    const totalDeployments = versionIssueKeys.size + transitionKeys.size;

    const periodMs = endDate.getTime() - startDate.getTime();
    const periodDays = Math.max(periodMs / (1000 * 60 * 60 * 24), 1);
    const deploymentsPerDay = totalDeployments / periodDays;

    return {
      boardId,
      totalDeployments,
      deploymentsPerDay,
      band: classifyDeploymentFrequency(deploymentsPerDay),
      periodDays: Math.round(periodDays),
    };
  }
}
