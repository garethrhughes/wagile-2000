import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { JiraClientService } from '../jira/jira-client.service.js';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  SyncLog,
  BoardConfig,
} from '../database/entities/index.js';
import type {
  JiraChangelogEntry,
  JiraIssueValue,
} from '../jira/jira.types.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly jiraClient: JiraClientService,
    private readonly configService: ConfigService,
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
  ) {}

  @Cron('0 */30 * * * *')
  async handleCron(): Promise<void> {
    this.logger.log('Scheduled sync triggered');
    await this.syncAll();
  }

  async syncAll(): Promise<{ boards: string[]; results: SyncLog[] }> {
    const boardIdsStr = this.configService.get<string>(
      'JIRA_BOARD_IDS',
      'ACC,BPT,SPS,OCS,DATA,PLAT',
    );
    const boardIds = boardIdsStr.split(',').map((id) => id.trim());
    const results: SyncLog[] = [];

    for (const boardId of boardIds) {
      const result = await this.syncBoard(boardId);
      results.push(result);
    }

    return { boards: boardIds, results };
  }

  async syncBoard(boardId: string): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      boardId,
      issueCount: 0,
      status: 'success',
    });

    try {
      // Ensure board config exists and get its type
      const config = await this.ensureBoardConfig(boardId);

      // Resolve project key to numeric Jira board ID
      const numericBoardId = await this.resolveNumericBoardId(boardId);

      let totalIssues = 0;
      const allIssueKeys: string[] = [];

      if (config.boardType === 'kanban') {
        // Kanban boards don't have sprints — fetch issues via JQL
        const issues = await this.syncKanbanIssues(boardId);
        totalIssues = issues.length;
        allIssueKeys.push(...issues.map((i) => i.key));
        this.logger.log(
          `Synced ${totalIssues} Kanban issues for board ${boardId}`,
        );
      } else {
        // Scrum boards — sync via sprints
        const sprints = await this.syncSprints(boardId, numericBoardId);
        this.logger.log(
          `Synced ${sprints.length} sprints for board ${boardId}`,
        );

        for (const sprint of sprints) {
          const issues = await this.syncSprintIssues(boardId, numericBoardId, sprint.id);
          totalIssues += issues.length;
          allIssueKeys.push(...issues.map((i) => i.key));
        }
      }

      // Sync changelogs in bulk for all issues
      await this.syncChangelogsBulk(allIssueKeys);

      // Sync versions
      await this.syncVersions(boardId);

      syncLog.issueCount = totalIssues;
      this.logger.log(
        `Sync complete for board ${boardId}: ${totalIssues} issues`,
      );
    } catch (error) {
      syncLog.status = 'failed';
      syncLog.errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Sync failed for board ${boardId}: ${syncLog.errorMessage}`,
      );
    }

    return this.syncLogRepo.save(syncLog);
  }

  private async resolveNumericBoardId(projectKey: string): Promise<string> {
    // If the key is already numeric, use it directly
    if (/^\d+$/.test(projectKey)) return projectKey;

    const response = await this.jiraClient.getBoardsForProject(projectKey);
    if (response.values.length === 0) {
      throw new Error(
        `No Jira board found for project key "${projectKey}". ` +
        `Ensure the project exists and has a board.`,
      );
    }
    const board = response.values[0];
    this.logger.log(
      `Resolved project key "${projectKey}" to board ID ${board.id} ("${board.name}", type: ${board.type})`,
    );
    return String(board.id);
  }

  private async ensureBoardConfig(boardId: string): Promise<BoardConfig> {
    const existing = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    if (existing) return existing;

    const config = this.boardConfigRepo.create({
      boardId,
      boardType: boardId === 'PLAT' ? 'kanban' : 'scrum',
    });
    return this.boardConfigRepo.save(config);
  }

  private async syncKanbanIssues(boardId: string): Promise<JiraIssue[]> {
    // Fetch recent issues for the Kanban project via JQL
    const jql = `project = ${boardId} ORDER BY updated DESC`;
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    let total = 0;

    do {
      const response = await this.jiraClient.searchIssues(jql, startAt, 100);
      total = response.total;

      const issues = response.issues.map((i) =>
        this.mapJiraIssue(i, boardId, null),
      );
      allIssues.push(...issues);
      startAt += response.maxResults;
      // Cap at 1000 issues per Kanban board to avoid excessive API calls
      if (startAt >= 1000) break;
    } while (startAt < total);

    if (allIssues.length > 0) {
      await this.issueRepo.upsert(allIssues, ['key']);
    }

    return allIssues;
  }

  private async syncSprints(boardId: string, numericBoardId: string): Promise<JiraSprint[]> {
    const response = await this.jiraClient.getSprints(numericBoardId);
    const sprints: JiraSprint[] = response.values.map((s) => {
      const sprint = new JiraSprint();
      sprint.id = String(s.id);
      sprint.name = s.name;
      sprint.state = s.state;
      sprint.startDate = s.startDate ? new Date(s.startDate) : null;
      sprint.endDate = s.endDate ? new Date(s.endDate) : null;
      sprint.boardId = boardId;
      return sprint;
    });

    if (sprints.length > 0) {
      await this.sprintRepo.upsert(sprints, ['id']);
    }

    return sprints;
  }

  private async syncSprintIssues(
    boardId: string,
    numericBoardId: string,
    sprintId: string,
  ): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    let total = 0;

    do {
      const response = await this.jiraClient.getSprintIssues(
        numericBoardId,
        sprintId,
        startAt,
      );
      total = response.total;

      const issues = response.issues.map((i) =>
        this.mapJiraIssue(i, boardId, sprintId),
      );
      allIssues.push(...issues);
      startAt += response.maxResults;
    } while (startAt < total);

    if (allIssues.length > 0) {
      await this.issueRepo.upsert(allIssues, ['key']);
    }

    return allIssues;
  }

  private mapJiraIssue(
    raw: JiraIssueValue,
    boardId: string,
    sprintId: string | null,
  ): JiraIssue {
    const issue = new JiraIssue();
    issue.key = raw.key;
    issue.summary = raw.fields.summary;
    issue.status = raw.fields.status.name;
    issue.issueType = raw.fields.issuetype.name;
    issue.fixVersion =
      raw.fields.fixVersions?.length > 0
        ? raw.fields.fixVersions[0].name
        : null;
    issue.labels = raw.fields.labels ?? [];
    issue.boardId = boardId;
    issue.sprintId = sprintId;

    // Attempt to extract story points from common field names
    const storyPointFields = [
      'story_points',
      'customfield_10016',
      'customfield_10028',
    ];
    for (const field of storyPointFields) {
      const value = raw.fields[field];
      if (typeof value === 'number') {
        issue.points = value;
        break;
      }
    }
    if (issue.points === undefined) {
      issue.points = null;
    }

    return issue;
  }

  private async syncChangelogsBulk(issueKeys: string[]): Promise<void> {
    // Process in batches to avoid N+1 but also not overload API
    const batchSize = 20;
    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const promises = batch.map((key) => this.syncIssueChangelog(key));
      await Promise.all(promises);
    }
  }

  private async syncIssueChangelog(issueKey: string): Promise<void> {
    let startAt = 0;
    let total = 0;

    do {
      const response = await this.jiraClient.getIssueChangelog(
        issueKey,
        startAt,
      );
      total = response.total;

      const entries = this.mapChangelogEntries(issueKey, response.values);
      if (entries.length > 0) {
        // Delete existing changelogs for this issue to avoid duplicates
        if (startAt === 0) {
          await this.changelogRepo.delete({ issueKey });
        }
        await this.changelogRepo.save(entries);
      }

      startAt += response.maxResults;
    } while (startAt < total);
  }

  private mapChangelogEntries(
    issueKey: string,
    entries: JiraChangelogEntry[],
  ): JiraChangelog[] {
    const changelogs: JiraChangelog[] = [];

    for (const entry of entries) {
      for (const item of entry.items) {
        const changelog = new JiraChangelog();
        changelog.issueKey = issueKey;
        changelog.field = item.field;
        changelog.fromValue = item.fromString;
        changelog.toValue = item.toString;
        changelog.changedAt = new Date(entry.created);
        changelogs.push(changelog);
      }
    }

    return changelogs;
  }

  private async syncVersions(boardId: string): Promise<void> {
    try {
      const versions = await this.jiraClient.getProjectVersions(boardId);
      const entities = versions.map((v) => {
        const version = new JiraVersion();
        version.id = String(v.id);
        version.name = v.name;
        version.releaseDate = v.releaseDate
          ? new Date(v.releaseDate)
          : null;
        version.projectKey = boardId;
        version.released = v.released;
        return version;
      });

      if (entities.length > 0) {
        await this.versionRepo.upsert(entities, ['id']);
      }
    } catch (error) {
      this.logger.warn(
        `Could not sync versions for board ${boardId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getStatus(): Promise<
    { boardId: string; lastSync: Date | null; status: string }[]
  > {
    const boardIdsStr = this.configService.get<string>(
      'JIRA_BOARD_IDS',
      'ACC,BPT,SPS,OCS,DATA,PLAT',
    );
    const boardIds = boardIdsStr.split(',').map((id) => id.trim());

    const results: { boardId: string; lastSync: Date | null; status: string }[] =
      [];

    for (const boardId of boardIds) {
      const lastLog = await this.syncLogRepo.findOne({
        where: { boardId },
        order: { syncedAt: 'DESC' },
      });

      results.push({
        boardId,
        lastSync: lastLog?.syncedAt ?? null,
        status: lastLog?.status ?? 'never',
      });
    }

    return results;
  }
}
