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

    // Primary: count issues with fixVersion that has a releaseDate in range
    const releasedVersions = await this.versionRepo.find({
      where: {
        projectKey: boardId,
        released: true,
        releaseDate: Between(startDate, endDate),
      },
    });

    const versionNames = releasedVersions.map((v) => v.name);
    let versionDeployments = 0;

    if (versionNames.length > 0) {
      const issues = (await this.issueRepo.find({
        where: {
          boardId,
          fixVersion: In(versionNames),
        },
      })).filter((i) => isWorkItem(i.issueType));
      versionDeployments = issues.length;
    }

    // Fallback: count issues that transitioned to a done status in the period
    const transitionDeployments = await this.countDoneTransitions(
      boardId,
      doneStatuses,
      startDate,
      endDate,
    );

    // Use the larger of the two counts (avoids double counting by taking max)
    const totalDeployments = Math.max(versionDeployments, transitionDeployments);

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

  private async countDoneTransitions(
    boardId: string,
    doneStatuses: string[],
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    // Get all issues for this board
    const issues = (await this.issueRepo.find({
      where: { boardId },
      select: ['key', 'issueType'],
    })).filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) return 0;

    const issueKeys = issues.map((i) => i.key);

    // Find changelogs for status transitions to done statuses in the period
    const changelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
      .andWhere('cl.changedAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
      .getCount();

    return changelogs;
  }
}
