import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { JiraClientService } from '../jira/jira-client.service.js';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  SyncLog,
  BoardConfig,
  RoadmapConfig,
  JpdIdea,
  JiraIssueLink,
  JiraFieldConfig,
} from '../database/entities/index.js';
import type {
  JiraChangelogEntry,
  JiraIssueValue,
  JiraIssueLink as JiraIssueLinkType,
} from '../jira/jira.types.js';
import { SprintReportService } from '../sprint-report/sprint-report.service.js';
import { LambdaInvokerService } from '../lambda/lambda-invoker.service.js';

/**
 * Resolved snapshot of JiraFieldConfig used throughout a single sync run.
 * Loading it once per sync avoids repeated DB reads in hot loops.
 */
interface FieldConfig {
  storyPointsFieldIds: string[];
  epicLinkFieldId: string | null;
  jpdDeliveryLinkInward: string[];
  jpdDeliveryLinkOutward: string[];
}

/** Fallback values that match the previously hardcoded behaviour. */
const DEFAULT_FIELD_CONFIG: FieldConfig = {
  storyPointsFieldIds: [
    'story_points',
    'customfield_10016',
    'customfield_10026',
    'customfield_10028',
    'customfield_11031',
  ],
  epicLinkFieldId: 'customfield_10014',
  jpdDeliveryLinkInward: ['is implemented by', 'is delivered by'],
  jpdDeliveryLinkOutward: ['implements', 'delivers'],
};

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  /**
   * Postgres session-level advisory lock key used to prevent concurrent
   * syncAll() runs across all App Runner instances (fleet-wide lock).
   */
  private static readonly SYNC_LOCK_KEY = 1_234_567_890;

  /**
   * QueryRunner holding the advisory lock while a sync is in progress.
   * null when no sync is running on this instance.
   */
  private syncLockRunner: QueryRunner | null = null;

  constructor(
    private readonly jiraClient: JiraClientService,
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
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
    @InjectRepository(JpdIdea)
    private readonly jpdIdeaRepo: Repository<JpdIdea>,
    @InjectRepository(JiraIssueLink)
    private readonly issueLinkRepo: Repository<JiraIssueLink>,
    @Inject(forwardRef(() => SprintReportService))
    private readonly sprintReportService: SprintReportService,
    @InjectRepository(JiraFieldConfig)
    private readonly jiraFieldConfigRepo: Repository<JiraFieldConfig>,
    private readonly lambdaInvoker: LambdaInvokerService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Attempt to acquire the Postgres advisory lock for sync.
   *
   * Uses a dedicated QueryRunner (= dedicated connection) because advisory
   * locks are session-scoped in Postgres: they must be acquired and released
   * on the exact same connection. Storing the QueryRunner in `syncLockRunner`
   * lets `releaseSyncLock` find the right connection.
   *
   * Returns true if the lock was acquired, false if it is already held (by
   * this instance or another App Runner instance in the fleet).
   */
  private async acquireSyncLock(): Promise<boolean> {
    if (this.syncLockRunner !== null) return false; // already locked on this instance
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const rows = await qr.query<{ pg_try_advisory_lock: boolean }[]>(
        'SELECT pg_try_advisory_lock($1)',
        [SyncService.SYNC_LOCK_KEY],
      );
      if (rows[0].pg_try_advisory_lock) {
        this.syncLockRunner = qr;
        return true;
      }
      await qr.release();
      return false;
    } catch (err) {
      await qr.release().catch(() => {});
      throw err;
    }
  }

  /**
   * Release the Postgres advisory lock acquired by `acquireSyncLock`.
   * Safe to call even if no lock is held.
   */
  private async releaseSyncLock(): Promise<void> {
    if (!this.syncLockRunner) return;
    const qr = this.syncLockRunner;
    this.syncLockRunner = null;
    try {
      await qr.query('SELECT pg_advisory_unlock($1)', [SyncService.SYNC_LOCK_KEY]);
    } finally {
      await qr.release().catch(() => {});
    }
  }

  @Cron('0 */30 * * * *')
  async handleCron(): Promise<void> {
    this.logger.log('Scheduled sync triggered');
    await this.syncAll();
  }

  get isSyncRunning(): boolean {
    return this.syncLockRunner !== null;
  }

  async syncAll(): Promise<{ boards: string[]; results: SyncLog[] }> {
    const locked = await this.acquireSyncLock();
    if (!locked) {
      this.logger.warn(
        'syncAll() could not acquire advisory lock — another instance may already be syncing.',
      );
      return { boards: [], results: [] };
    }

    const configs = await this.boardConfigRepo.find();
    const boardIds = configs.map((c) => c.boardId);
    const results: SyncLog[] = [];

    try {
      // Load field config once for the entire sync run.
      const fieldConfig = await this.loadFieldConfig();

      for (const boardId of boardIds) {
        const result = await this.syncBoard(boardId, fieldConfig);
        results.push(result);
      }

      // Invoke per-board Lambda snapshots sequentially and await each one
      // (RequestResponse). This guarantees that all per-board dora_snapshots rows
      // are written to the DB before the org-level invocation reads them.
      for (const boardId of boardIds) {
        await this.lambdaInvoker.invokeSnapshotWorker(boardId).catch((err: unknown) =>
          this.logger.warn(
            `Snapshot invocation failed for ${boardId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }

      // Invoke the org-level snapshot once all per-board rows are confirmed written.
      // The org handler reads per-board trend rows and merges them — no raw DB load.
      await this.lambdaInvoker.invokeOrgSnapshot().catch((err: unknown) =>
        this.logger.warn(
          `Org snapshot invocation failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

      try {
        await this.syncRoadmaps(fieldConfig);
      } catch (error) {
        this.logger.warn(
          `syncRoadmaps failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Auto-generate reports for any newly closed sprints (fire-and-forget,
      // but sequential across boards to avoid peak memory pressure from running
      // all boards' report generation concurrently on a fresh deployment).
      const generateAllReports = async () => {
        for (const boardId of boardIds) {
          await this.triggerSprintReportsForBoard(boardId).catch((err: unknown) =>
            this.logger.warn(
              `Sprint report trigger failed for ${boardId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      };
      generateAllReports().catch((err: unknown) =>
        this.logger.warn(
          `Sprint report generation failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } finally {
      await this.releaseSyncLock();
    }

    return { boards: boardIds, results };
  }

  /**
   * Load the singleton JiraFieldConfig row.  Falls back to hardcoded defaults
   * if the row is somehow absent (should not happen after migration).
   */
  private async loadFieldConfig(): Promise<FieldConfig> {
    const row = await this.jiraFieldConfigRepo.findOne({ where: { id: 1 } });
    if (!row) {
      this.logger.warn(
        'JiraFieldConfig row (id=1) missing — using hardcoded defaults. ' +
        'This should not happen on a migrated database.',
      );
      return { ...DEFAULT_FIELD_CONFIG };
    }
    return {
      storyPointsFieldIds: row.storyPointsFieldIds,
      epicLinkFieldId: row.epicLinkFieldId,
      jpdDeliveryLinkInward: row.jpdDeliveryLinkInward,
      jpdDeliveryLinkOutward: row.jpdDeliveryLinkOutward,
    };
  }

  async syncBoard(boardId: string, fieldConfig?: FieldConfig): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      boardId,
      issueCount: 0,
      status: 'success',
    });

    // Allow callers (e.g. the controller) to trigger a single-board sync
    // without providing a pre-loaded FieldConfig — load it on demand.
    const resolvedFieldConfig = fieldConfig ?? await this.loadFieldConfig();

    try {
      // Ensure board config exists and get its type
      const config = await this.ensureBoardConfig(boardId);

      // Resolve project key to numeric Jira board ID
      const numericBoardId = await this.resolveNumericBoardId(boardId);

      // Build the field list to request from Jira: story points fields + epic link field
      const extraFields = this.buildExtraFields(resolvedFieldConfig);

      let totalIssues = 0;
      const allIssueKeys: string[] = [];

      if (config.boardType === 'kanban') {
        // Kanban boards don't have sprints — fetch issues via JQL
        const issues = await this.syncKanbanIssuesWithConfig(boardId, extraFields, resolvedFieldConfig);
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
          const issues = await this.syncSprintIssues(
            boardId,
            numericBoardId,
            sprint.id,
            extraFields,
            resolvedFieldConfig,
          );
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

  /**
   * Build the list of extra Jira fields to request beyond the standard set.
   * Includes all configured story-points field IDs and the epic link field ID
   * (when non-null).
   */
  private buildExtraFields(fieldConfig: FieldConfig): string[] {
    const fields = [...fieldConfig.storyPointsFieldIds];
    if (fieldConfig.epicLinkFieldId !== null) {
      fields.push(fieldConfig.epicLinkFieldId);
    }
    return fields;
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

    // Safety net: should not occur in normal operation.
    // If reached, a board config was deleted while sync was running.
    this.logger.warn(
      `Board config for "${boardId}" not found during sync. ` +
      `Creating a fallback scrum config. Re-add the board via Settings.`,
    );
    const config = this.boardConfigRepo.create({
      boardId,
      boardType: 'scrum',
    });
    return this.boardConfigRepo.save(config);
  }

  private async syncKanbanIssuesWithConfig(
    boardId: string,
    extraFields: string[],
    fieldConfig: FieldConfig,
  ): Promise<JiraIssue[]> {
    const jql = `project = ${boardId} ORDER BY updated DESC`;
    const allIssues: JiraIssue[] = [];
    const allRawIssues: JiraIssueValue[] = [];
    let nextPageToken: string | undefined;

    do {
      const response = await this.jiraClient.searchIssues(jql, 0, 100, nextPageToken, extraFields);

      const issues = response.issues.map((i) =>
        this.mapJiraIssue(i, boardId, null, fieldConfig),
      );
      allIssues.push(...issues);
      allRawIssues.push(...response.issues);
      nextPageToken = response.nextPageToken;
      if (allIssues.length >= 1000) break;
    } while (nextPageToken);

    if (allIssues.length > 0) {
      await this.issueRepo.upsert(allIssues, ['key']);
      await this.persistIssueLinks(allRawIssues);
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
    extraFields: string[],
    fieldConfig: FieldConfig,
  ): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    const allRawIssues: JiraIssueValue[] = [];
    let startAt = 0;
    let total = 0;

    do {
      const response = await this.jiraClient.getSprintIssues(
        numericBoardId,
        sprintId,
        startAt,
        extraFields,
      );
      total = response.total;

      const issues = response.issues.map((i) =>
        this.mapJiraIssue(i, boardId, sprintId, fieldConfig),
      );
      allIssues.push(...issues);
      allRawIssues.push(...response.issues);
      startAt += response.maxResults;
    } while (startAt < total);

    if (allIssues.length > 0) {
      await this.issueRepo.upsert(allIssues, ['key']);
      await this.persistIssueLinks(allRawIssues);
    }

    return allIssues;
  }

  private mapJiraIssue(
    raw: JiraIssueValue,
    boardId: string,
    sprintId: string | null,
    fieldConfig: FieldConfig,
  ): JiraIssue {
    const issue = new JiraIssue();
    issue.key = raw.key;
    issue.summary = raw.fields.summary;
    issue.status = raw.fields.status.name;
    issue.statusId = raw.fields.status.id ?? null;
    issue.issueType = raw.fields.issuetype.name;
    issue.fixVersion =
      raw.fields.fixVersions?.length > 0
        ? raw.fields.fixVersions[0].name
        : null;
    issue.labels = raw.fields.labels ?? [];
    issue.priority = raw.fields.priority?.name ?? null;
    issue.assignee = raw.fields.assignee?.displayName ?? null;
    issue.boardId = boardId;
    issue.sprintId = sprintId;
    issue.createdAt = new Date(raw.fields.created);

    // Extract story points by iterating the configured field ID list.
    // The first field that returns a numeric value wins.
    for (const field of fieldConfig.storyPointsFieldIds) {
      const value = raw.fields[field];
      if (typeof value === 'number') {
        issue.points = value;
        break;
      }
    }
    if (issue.points === undefined) {
      issue.points = null;
    }

    // Extract epicKey: prefer modern parent link (only if parent is an Epic),
    // then fall back to the configured legacy epic link field (if non-null).
    const parent = raw.fields.parent;
    if (parent?.fields?.issuetype?.name === 'Epic') {
      issue.epicKey = parent.key;
    } else if (
      fieldConfig.epicLinkFieldId !== null &&
      typeof raw.fields[fieldConfig.epicLinkFieldId] === 'string'
    ) {
      issue.epicKey = raw.fields[fieldConfig.epicLinkFieldId] as string;
    } else {
      issue.epicKey = null;
    }

    return issue;
  }

  private async persistIssueLinks(rawIssues: JiraIssueValue[]): Promise<void> {
    for (const raw of rawIssues) {
      const links = raw.fields.issuelinks;
      if (!links || links.length === 0) continue;

      // Delete existing links for this issue key (scoped — no unbounded query)
      await this.issueLinkRepo.delete({ sourceIssueKey: raw.key });

      const newLinks: JiraIssueLink[] = [];

      for (const link of links as JiraIssueLinkType[]) {
        if (link.inwardIssue) {
          const entity = this.issueLinkRepo.create({
            sourceIssueKey: raw.key,
            targetIssueKey: link.inwardIssue.key,
            linkTypeName: link.type.name,
            isInward: true,
          });
          newLinks.push(entity);
        }
        if (link.outwardIssue) {
          const entity = this.issueLinkRepo.create({
            sourceIssueKey: raw.key,
            targetIssueKey: link.outwardIssue.key,
            linkTypeName: link.type.name,
            isInward: false,
          });
          newLinks.push(entity);
        }
      }

      if (newLinks.length > 0) {
        await this.issueLinkRepo.save(newLinks);
      }
    }
  }

  private async syncChangelogsBulk(issueKeys: string[]): Promise<void> {
    // Process in small batches so Promise.all does not spike beyond the
    // JiraClientService concurrency limit (MAX_CONCURRENT_REQUESTS = 5).
    // The client-level semaphore is the authoritative cap; keeping batchSize
    // equal to it avoids queuing unnecessary promises.
    const batchSize = 5;
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

  async syncRoadmaps(fieldConfig?: FieldConfig): Promise<void> {
    const resolvedFieldConfig = fieldConfig ?? await this.loadFieldConfig();
    const configs = await this.roadmapConfigRepo.find();
    for (const cfg of configs) {
      try {
        await this.syncJpdProject(cfg.jpdKey, resolvedFieldConfig);
      } catch (error) {
        this.logger.warn(
          `Failed to sync JPD project ${cfg.jpdKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async syncJpdProject(jpdKey: string, fieldConfig: FieldConfig): Promise<void> {
    // Load the roadmap config for this JPD project to get date field IDs
    const config = await this.roadmapConfigRepo.findOne({ where: { jpdKey } });
    const extraFields: string[] = [];
    if (config?.startDateFieldId) extraFields.push(config.startDateFieldId);
    if (config?.targetDateFieldId) extraFields.push(config.targetDateFieldId);

    let nextPageToken: string | undefined;
    const ideas: JpdIdea[] = [];

    do {
      const response = await this.jiraClient.getJpdIdeas(jpdKey, extraFields, nextPageToken);

      for (const issue of response.issues) {
        const deliveryIssueKeys: string[] = [];

        for (const link of issue.fields.issuelinks ?? []) {
          const inward = link.type.inward.toLowerCase();
          const outward = link.type.outward.toLowerCase();

          // Match delivery links using the configured inward/outward substrings.
          const isDeliveryLink =
            fieldConfig.jpdDeliveryLinkInward.some((s) => inward.includes(s.toLowerCase())) ||
            fieldConfig.jpdDeliveryLinkOutward.some((s) => outward.includes(s.toLowerCase()));

          if (isDeliveryLink) {
            if (link.inwardIssue?.fields?.issuetype?.name === 'Epic') {
              deliveryIssueKeys.push(link.inwardIssue.key);
            }
            if (link.outwardIssue?.fields?.issuetype?.name === 'Epic') {
              deliveryIssueKeys.push(link.outwardIssue.key);
            }
          }
        }

        const idea = new JpdIdea();
        idea.key = issue.key;
        idea.summary = issue.fields.summary;
        idea.status = issue.fields.status.name;
        idea.jpdKey = jpdKey;
        idea.deliveryIssueKeys = deliveryIssueKeys.length > 0 ? deliveryIssueKeys : null;

        // Extract date fields if configured.
        // Polaris interval fields are returned by the Jira API as a serialized
        // JSON string: e.g. '{"start":"2026-04-01","end":"2026-06-30"}'.
        // They may also arrive as a parsed object or a plain "YYYY-MM-DD" string.
        // For startDate we use the .start boundary; for targetDate we use .end.
        const parseIntervalField = (
          raw: unknown,
          boundary: 'start' | 'end',
        ): string | null => {
          if (raw === null || raw === undefined) return null
          // Already a parsed object with the expected shape
          if (typeof raw === 'object') {
            const obj = raw as Record<string, unknown>
            const val = obj[boundary]
            return typeof val === 'string' ? val : null
          }
          if (typeof raw === 'string') {
            // Try to parse as JSON first (Polaris interval serialized as string)
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>
              const val = parsed[boundary]
              if (typeof val === 'string') return val
            } catch {
              // Not JSON — fall through
            }
            // Plain date string (e.g. "2026-04-01") — use directly
            return raw || null
          }
          return null
        }

        const rawStart = config?.startDateFieldId
          ? parseIntervalField(issue.fields[config.startDateFieldId], 'start')
          : null
        const rawTarget = config?.targetDateFieldId
          ? parseIntervalField(issue.fields[config.targetDateFieldId], 'end')
          : null

        idea.startDate = rawStart ? new Date(rawStart) : null
        idea.targetDate = rawTarget ? new Date(rawTarget) : null

        ideas.push(idea);
      }

      nextPageToken = response.nextPageToken;
    } while (nextPageToken);

    if (ideas.length > 0) {
      await this.jpdIdeaRepo.upsert(ideas, ['key']);

      // Warn only when targetDateFieldId is configured but produced no dates —
      // avoids log spam before the operator has set up field IDs.
      if (
        config?.targetDateFieldId &&
        ideas.every((idea) => idea.targetDate === null)
      ) {
        this.logger.warn(
          `[${jpdKey}] targetDateFieldId "${config.targetDateFieldId}" is configured but ` +
          `all ${ideas.length} JPD ideas have null targetDate after sync. ` +
          `Check the field ID is correct for this tenant and trigger a resync.`,
        );
      }
    }

    this.logger.log(`Synced ${ideas.length} JPD ideas for project ${jpdKey}`);
  }

  private async triggerSprintReportsForBoard(boardId: string): Promise<void> {
    const closedSprints = await this.sprintRepo.find({ where: { boardId, state: 'closed' } });
    for (const sprint of closedSprints) {
      await this.sprintReportService.generateIfClosed(boardId, sprint.id);
    }
  }

  async getStatus(): Promise<
    { boardId: string; lastSync: Date | null; status: string }[]
  > {
    const configs = await this.boardConfigRepo.find();
    const boardIds = configs.map((c) => c.boardId);

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
