import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
} from '../database/entities/index.js';
import { classifyChangeFailureRate, type DoraBand } from './dora-bands.js';
import { isWorkItem } from './issue-type-filters.js';

export interface CfrResult {
  boardId: string;
  totalDeployments: number;
  failureCount: number;
  changeFailureRate: number;
  band: DoraBand;
  /** True when no BoardConfig row exists for this board and hardcoded defaults are in use. */
  usingDefaultConfig: boolean;
}

@Injectable()
export class CfrService {
  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(JiraIssueLink)
    private readonly issueLinkRepo: Repository<JiraIssueLink>,
  ) {}

  async calculate(
    boardId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<CfrResult> {
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    const usingDefaultConfig = config === null;
    const doneStatuses = config?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];
    const failureIssueTypes = config?.failureIssueTypes ?? [
      'Bug',
      'Incident',
    ];
    const failureLabels = config?.failureLabels ?? [
      'regression',
      'incident',
      'hotfix',
    ];
    const failureLinkTypes = config?.failureLinkTypes ?? [];

    // Count total deployments (issues that reached done in the period)
    const allIssues = (await this.issueRepo.find({
      where: { boardId },
    })).filter((i) => isWorkItem(i.issueType));

    if (allIssues.length === 0) {
      return {
        boardId,
        totalDeployments: 0,
        failureCount: 0,
        changeFailureRate: 0,
        band: classifyChangeFailureRate(0),
        usingDefaultConfig,
      };
    }

    // C-4: Primary path — count distinct release DAYS, consistent with
    // DeploymentFrequencyService.  Multiple versions on the same day = 1 deployment.
    const releasedVersions = await this.versionRepo.find({
      where: {
        projectKey: boardId,
        released: true,
        releaseDate: Between(startDate, endDate),
      },
    });

    const releaseDays = new Set(
      releasedVersions
        .filter((v) => v.releaseDate != null)
        .map((v) => v.releaseDate!.toISOString().split('T')[0]),
    );
    const versionDeployments = releaseDays.size;

    // Collect all deployed issue keys (for the failure-classification step).
    // We still need the issue keys to determine which issues were released;
    // the deployment COUNT uses release days, but the failure classification
    // must operate on the actual issues (type, labels, links).
    // Derive from the already-loaded allIssues to avoid a redundant DB query.
    const versionNames = new Set(releasedVersions.map((v) => v.name));
    const versionIssueKeys =
      versionNames.size > 0
        ? new Set(
            allIssues
              .filter((i) => i.fixVersion != null && versionNames.has(i.fixVersion))
              .map((i) => i.key),
          )
        : new Set<string>();

    // C-4: Fallback path — count distinct transition DAYS for issues with no fixVersion.
    const noVersionKeys = allIssues
      .filter((i) => !i.fixVersion && !versionIssueKeys.has(i.key))
      .map((i) => i.key);

    let transitionIssueKeys = new Set<string>();
    let fallbackDeployments = 0;
    if (noVersionKeys.length > 0) {
      const doneTransitions = await this.changelogRepo
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
      transitionIssueKeys = new Set(doneTransitions.map((t) => t.issueKey));

      // Count distinct days for the fallback path
      const fallbackDayRows = await this.changelogRepo
        .createQueryBuilder('cl')
        .select(`DATE(cl."changedAt") AS "transitionDay"`)
        .where('cl.issueKey IN (:...keys)', { keys: noVersionKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
        .andWhere('cl.changedAt BETWEEN :start AND :end', {
          start: startDate,
          end: endDate,
        })
        .groupBy('"transitionDay"')
        .getRawMany<{ transitionDay: string }>();
      fallbackDeployments = fallbackDayRows.length;
    }

    // Combine both paths
    const deployedKeys = new Set([...versionIssueKeys, ...transitionIssueKeys]);
    const totalDeployments = versionDeployments + fallbackDeployments;

    // Count failure issues among deployed (type/label OR-gate)
    const issueMap = new Map(allIssues.map((i) => [i.key, i]));
    const failureIssues: JiraIssue[] = [];

    for (const key of deployedKeys) {
      const issue = issueMap.get(key);
      if (!issue) continue;

      const isFailureType = failureIssueTypes.includes(issue.issueType);
      const hasFailureLabel = issue.labels.some((l) =>
        failureLabels.includes(l),
      );

      if (isFailureType || hasFailureLabel) {
        failureIssues.push(issue);
      }
    }

    // AND-gate: require a causal link if failureLinkTypes is non-empty
    let filteredFailures = failureIssues;
    if (failureLinkTypes.length > 0 && failureIssues.length > 0) {
      const failureKeys = failureIssues.map((i) => i.key);
      const causalLinks = await this.issueLinkRepo
        .createQueryBuilder('link')
        .where('link.sourceIssueKey IN (:...keys)', { keys: failureKeys })
        .andWhere('LOWER(link.linkTypeName) IN (:...types)', {
          types: failureLinkTypes.map((t) => t.toLowerCase()),
        })
        .getMany();
      const keysWithCausalLink = new Set(causalLinks.map((l) => l.sourceIssueKey));
      filteredFailures = failureIssues.filter((i) =>
        keysWithCausalLink.has(i.key),
      );
    }

    const failureCount = filteredFailures.length;

    const changeFailureRate =
      totalDeployments > 0
        ? Math.round((failureCount / totalDeployments) * 10000) / 100
        : 0;

    return {
      boardId,
      totalDeployments,
      failureCount,
      changeFailureRate,
      band: classifyChangeFailureRate(changeFailureRate),
      usingDefaultConfig,
    };
  }
}
