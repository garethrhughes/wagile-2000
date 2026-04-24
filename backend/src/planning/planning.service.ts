import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';
import { dateParts, midnightInTz } from '../metrics/tz-utils.js';

export interface SprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  commitment: number;
  added: number;
  removed: number;
  completed: number;
  scopeChangePercent: number;
  completionRate: number;
  /** Planning accuracy: committed issues delivered / committed issues.
   *  Uses story points when available, falls back to ticket count.
   *  null when there are zero committed issues. */
  planningAccuracy: number | null;
  /** Sum of story points for committed issues. null signals ticket-count fallback. */
  committedPoints: number | null;
  /** Sum of story points completed from the committed set. null signals ticket-count fallback. */
  completedPoints: number | null;
}

export interface QuarterInfo {
  quarter: string;
  startDate: string;
  endDate: string;
}

export interface KanbanQuarterSummary {
  quarter: string;
  state: string; // 'active' | 'closed'
  issuesPulledIn: number;
  completed: number;
  addedMidQuarter: number;
  pointsIn: number;
  pointsDone: number;
  deliveryRate: number; // 0-100
}

export interface KanbanWeekSummary {
  week: string;           // "2026-W15"
  state: string;          // 'active' | 'closed'
  weekStart: string;      // ISO date string
  issuesPulledIn: number;
  completed: number;
  addedMidWeek: number;   // board entry date is > 1 day after week start
  pointsIn: number;
  pointsDone: number;
  deliveryRate: number;   // 0-100
}

@Injectable()
export class PlanningService {
  private readonly logger = new Logger(PlanningService.name);

  constructor(
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly configService: ConfigService,
  ) {}

  async getAccuracy(
    boardId: string,
    sprintId?: string,
    quarter?: string,
  ): Promise<SprintAccuracy[]> {
    // Check for Kanban board
    const config = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    if (config?.boardType === 'kanban') {
      throw new BadRequestException(
        'Planning accuracy is not available for Kanban boards',
      );
    }

    // Get sprints to analyze
    let sprints: JiraSprint[];

    if (sprintId) {
      const sprint = await this.sprintRepo.findOne({
        where: { id: sprintId, boardId },
      });
      sprints = sprint ? [sprint] : [];
    } else if (quarter) {
      const { startDate, endDate } = this.quarterToDates(quarter);
      sprints = await this.sprintRepo
        .createQueryBuilder('s')
        .where('s.boardId = :boardId', { boardId })
        .andWhere('s.state = :state', { state: 'closed' })
        .andWhere('s.startDate >= :start', { start: startDate })
        .andWhere('s.endDate <= :end', { end: endDate })
        .orderBy('s.startDate', 'ASC')
        .getMany();
    } else {
      // Return all non-future sprints: active first, then closed descending
      const active = await this.sprintRepo.find({
        where: { boardId, state: 'active' },
        order: { startDate: 'DESC' },
      });
      const closed = await this.sprintRepo.find({
        where: { boardId, state: 'closed' },
        order: { startDate: 'DESC' },
      });
      sprints = [...active, ...closed];
    }

    const results: SprintAccuracy[] = [];

    for (const sprint of sprints) {
      const accuracy = await this.calculateSprintAccuracy(sprint);
      results.push(accuracy);
    }

    return results;
  }

  private async calculateSprintAccuracy(
    sprint: JiraSprint,
  ): Promise<SprintAccuracy> {
    if (!sprint.startDate) {
      return this.emptyAccuracy(sprint);
    }

    const sprintName = sprint.name;
    const sprintStart = sprint.startDate;

    // Get ALL board issues so we can reconstruct sprint membership from changelogs.
    // We can't rely on the sprintId column alone because upsert during sync
    // overwrites it with the last-synced sprint.
    const boardIssues = (await this.issueRepo.find({
      where: { boardId: sprint.boardId },
    })).filter((i) => isWorkItem(i.issueType));

    if (boardIssues.length === 0) {
      return this.emptyAccuracy(sprint);
    }

    const allKeys = boardIssues.map((i) => i.key);
    const issueStatusMap = new Map(
      boardIssues.map((i) => [i.key, i.status]),
    );
    const issueCreatedAtMap = new Map(
      boardIssues.map((i) => [i.key, i.createdAt]),
    );

    // Fetch Sprint-field changelogs for all board issues in bulk
    const sprintChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allKeys })
      .andWhere('cl.field = :field', { field: 'Sprint' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group changelogs by issue, keeping only those that reference this sprint
    const logsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of sprintChangelogs) {
      if (
        this.sprintValueContains(cl.fromValue, sprintName) ||
        this.sprintValueContains(cl.toValue, sprintName)
      ) {
        const list = logsByIssue.get(cl.issueKey) ?? [];
        list.push(cl);
        logsByIssue.set(cl.issueKey, list);
      }
    }

    // Also include issues currently assigned to this sprint with no changelog
    // (they were likely created directly in the sprint)
    const currentIssues = boardIssues.filter(
      (i) => i.sprintId === sprint.id,
    );
    for (const issue of currentIssues) {
      if (!logsByIssue.has(issue.key)) {
        logsByIssue.set(issue.key, []);
      }
    }

    if (logsByIssue.size === 0) {
      return this.emptyAccuracy(sprint);
    }

    // Classify each issue: committed, added, or removed
    // IMPORTANT: Only consider changes within the sprint window [start, end].
    // Changes after sprint end (carry-overs, sprint completion shuffles) are noise.
    const sprintEnd = sprint.endDate ?? new Date();
    const effectiveSprintStart = new Date(
      sprintStart.getTime() + PlanningService.SPRINT_GRACE_PERIOD_MS,
    );
    const committedKeys = new Set<string>();
    const addedKeys = new Set<string>();
    const removedKeys = new Set<string>();

    for (const [issueKey, logs] of logsByIssue) {
      // Issues with no sprint changelog were assigned to the sprint at creation.
      // But if createdAt is after the grace-period window, the issue was created
      // mid-sprint (e.g. filed directly into an active sprint) -- treat as added.
      const createdAt = issueCreatedAtMap.get(issueKey);
      const createdMidSprint =
        logs.length === 0 &&
        createdAt != null &&
        createdAt > effectiveSprintStart;

      const wasAtStart =
        !createdMidSprint &&
        this.wasInSprintAtDate(logs, sprintName, sprintStart);

      // Track membership only within the sprint window.
      // For mid-sprint creations, assume the issue stays in the sprint
      // (no remove changelog exists), so inSprintAtEnd starts true.
      let inSprintAtEnd = wasAtStart || createdMidSprint;
      let wasAddedDuringSprint = createdMidSprint;
      // Carry-overs from a previous sprint are treated as committed, not added.
      // See proposal 0038: when fromValue contains a different sprint name, the
      // issue was moved via Jira's "Complete Sprint" carry-over flow.
      let wasCarryOver = false;

      for (const cl of logs) {
        if (cl.changedAt <= sprintStart) continue;
        if (cl.changedAt > sprintEnd) break; // ignore post-sprint changes

        if (this.sprintValueContains(cl.toValue, sprintName)) {
          if (!inSprintAtEnd && !wasAtStart) {
            if (this.isCarryOverFromSprint(cl.fromValue, sprintName)) {
              wasCarryOver = true;
            } else {
              wasAddedDuringSprint = true;
            }
          }
          inSprintAtEnd = true;
        }
        if (
          this.sprintValueContains(cl.fromValue, sprintName) &&
          !this.sprintValueContains(cl.toValue, sprintName)
        ) {
          inSprintAtEnd = false;
        }
      }

      if (wasAtStart || wasCarryOver) {
        committedKeys.add(issueKey);
        if (!inSprintAtEnd) {
          removedKeys.add(issueKey);
        }
      } else if (wasAddedDuringSprint) {
        addedKeys.add(issueKey);
        if (!inSprintAtEnd) {
          removedKeys.add(issueKey);
        }
      }
    }

    // Determine completed issues
    const config = await this.boardConfigRepo.findOne({
      where: { boardId: sprint.boardId },
    });
    const doneStatuses = config?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];

    // Only look at issues that ended up in the sprint (committed + added - removed)
    const finalSprintKeys = new Set([...committedKeys, ...addedKeys]);
    for (const key of removedKeys) finalSprintKeys.delete(key);

    const completedKeys = new Set<string>();

    if (finalSprintKeys.size > 0) {
      const finalKeys = [...finalSprintKeys];
      const statusChangelogs = await this.changelogRepo
        .createQueryBuilder('cl')
        .where('cl.issueKey IN (:...keys)', { keys: finalKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        .orderBy('cl.changedAt', 'ASC')
        .getMany();

      const statusLogsByIssue = new Map<string, JiraChangelog[]>();
      for (const cl of statusChangelogs) {
        const list = statusLogsByIssue.get(cl.issueKey) ?? [];
        list.push(cl);
        statusLogsByIssue.set(cl.issueKey, list);
      }

      for (const key of finalKeys) {
        const status = issueStatusMap.get(key);
        if (status && doneStatuses.includes(status)) {
          completedKeys.add(key);
        } else {
          const logs = statusLogsByIssue.get(key) ?? [];
          const hasDoneTransition = logs.some(
            (cl) =>
              doneStatuses.includes(cl.toValue ?? '') &&
              sprint.endDate &&
              cl.changedAt <= sprint.endDate,
          );
          if (hasDoneTransition) {
            completedKeys.add(key);
          }
        }
      }
    }

    const commitment = committedKeys.size;
    const added = addedKeys.size;
    const removed = removedKeys.size;
    const completed = completedKeys.size;
    const scopeChangePercent =
      commitment > 0
        ? Math.round(((added + removed) / commitment) * 10000) / 100
        : 0;
    const completionRate =
      commitment + added - removed > 0
        ? Math.round(
            (completed / (commitment + added - removed)) * 10000,
          ) / 100
        : 0;

    // ---- Planning accuracy ------------------------------------------------
    // Build a points lookup from the already-loaded boardIssues array.
    const issuePointsMap = new Map<string, number | null>(
      boardIssues.map((i) => [i.key, i.points]),
    );

    let planningAccuracy: number | null = null;
    let committedPoints: number | null = null;
    let completedPoints: number | null = null;

    if (committedKeys.size > 0) {
      const committedArr = [...committedKeys];
      const allNull = committedArr.every(
        (k) => issuePointsMap.get(k) === null || issuePointsMap.get(k) === undefined,
      );

      if (!allNull) {
        // Points path
        const sumCommitted = committedArr.reduce(
          (acc, k) => acc + (issuePointsMap.get(k) ?? 0),
          0,
        );
        const sumCompleted = [...completedKeys]
          .filter((k) => committedKeys.has(k))
          .reduce((acc, k) => acc + (issuePointsMap.get(k) ?? 0), 0);

        committedPoints = sumCommitted;
        completedPoints = sumCompleted;
        planningAccuracy =
          sumCommitted > 0
            ? Math.round((sumCompleted / sumCommitted) * 10000) / 100
            : 0;
      } else {
        // Ticket-count fallback: committedPoints / completedPoints stay null
        const completedFromCommitted = [...completedKeys].filter((k) =>
          committedKeys.has(k),
        ).length;
        planningAccuracy =
          Math.round(
            (completedFromCommitted / committedKeys.size) * 10000,
          ) / 100;
      }
    }

    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      commitment,
      added,
      removed,
      completed,
      scopeChangePercent,
      completionRate,
      planningAccuracy,
      committedPoints,
      completedPoints,
    };
  }

  /**
   * Check if an issue was in the sprint at the given date by
   * replaying Sprint-field changelogs.
   *
   * A grace period is applied to absorb Jira's bulk-add delay: when a sprint
   * is started, Jira records the startDate at the moment of creation, but the
   * initial backlog issues are added ~20-60 seconds later.  Any issue whose
   * first Sprint changelog falls within that window should count as part of
   * the original commitment, not as a mid-sprint addition.
   */
  private static readonly SPRINT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

  private wasInSprintAtDate(
    sprintChangelogs: JiraChangelog[],
    sprintName: string,
    date: Date,
  ): boolean {
    // Extend the cutoff by the grace period so that issues added in the
    // initial bulk-load (typically seconds after sprint start) are treated
    // as committed rather than added.
    const effectiveDate = new Date(
      date.getTime() + PlanningService.SPRINT_GRACE_PERIOD_MS,
    );
    let inSprint = false;

    for (const cl of sprintChangelogs) {
      if (cl.changedAt > effectiveDate) break;

      if (this.sprintValueContains(cl.toValue, sprintName)) {
        inSprint = true;
      }
      if (
        this.sprintValueContains(cl.fromValue, sprintName) &&
        !this.sprintValueContains(cl.toValue, sprintName)
      ) {
        inSprint = false;
      }
    }

    // No changelog means the issue was assigned to the sprint at creation
    if (sprintChangelogs.length === 0) {
      return true;
    }

    return inSprint;
  }

  /**
   * Exact sprint-name match inside a comma-separated Sprint field value.
   * Prevents "Sprint 1" from matching "Sprint 10".
   */
  private sprintValueContains(
    value: string | null,
    sprintName: string,
  ): boolean {
    if (!value) return false;
    return value.split(',').some((s) => s.trim() === sprintName);
  }

  /**
   * Returns true when a Sprint-field changelog `fromValue` indicates that
   * the issue was carried over from a different sprint — i.e. it was moved
   * from another sprint into the current one rather than added from the backlog.
   *
   * When Jira's "Complete Sprint" carry-over runs, the changelog entry has:
   *   fromValue: "<previous sprint name>"
   *   toValue:   "<current sprint name>"
   *
   * A backlog addition has fromValue = null or "".
   * See proposal 0038.
   */
  private isCarryOverFromSprint(
    fromValue: string | null,
    currentSprintName: string,
  ): boolean {
    if (!fromValue) return false;
    return fromValue.split(',').some((s) => {
      const name = s.trim();
      return name !== '' && name !== currentSprintName;
    });
  }

  private emptyAccuracy(sprint: JiraSprint): SprintAccuracy {
    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      commitment: 0,
      added: 0,
      removed: 0,
      completed: 0,
      scopeChangePercent: 0,
      completionRate: 0,
      planningAccuracy: null,
      committedPoints: null,
      completedPoints: null,
    };
  }

  async getSprints(
    boardId: string,
  ): Promise<{ id: string; name: string; state: string }[]> {
    const sprints = await this.sprintRepo.find({
      where: { boardId },
      order: { startDate: 'DESC' },
    });

    return sprints.map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
    }));
  }

  async getQuarters(): Promise<QuarterInfo[]> {
    const sprints = await this.sprintRepo.find({
      where: { state: 'closed' },
      order: { startDate: 'ASC' },
    });

    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const quarters = new Map<string, QuarterInfo>();

    for (const sprint of sprints) {
      if (!sprint.startDate) continue;
      const { year, month } = dateParts(sprint.startDate, tz);
      const q = Math.floor(month / 3) + 1;
      const key = `${year}-Q${q}`;

      if (!quarters.has(key)) {
        const startMonth = (q - 1) * 3;
        const startDate = midnightInTz(year, startMonth, 1, tz);
        const endDate = new Date(midnightInTz(year, startMonth + 3, 1, tz).getTime() - 1);
        quarters.set(key, {
          quarter: key,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        });
      }
    }

    return [...quarters.values()].sort((a, b) =>
      b.quarter.localeCompare(a.quarter),
    );
  }

  async getKanbanQuarters(boardId: string): Promise<KanbanQuarterSummary[]> {
    // Verify this is actually a Kanban board
    const config = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (!config || config.boardType !== 'kanban') {
      throw new BadRequestException(
        `Board ${boardId} is not a Kanban board`,
      );
    }

    const doneStatuses: string[] = config.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const backlogStatusIds: string[] = config.backlogStatusIds ?? [];

    // C-3: configurable board-entry status list (fix for hardcoded 'To Do').
    // An issue enters the board when it first transitions *to* one of these statuses.
    const boardEntryStatuses: string[] = config.boardEntryStatuses ?? [
      'To Do', 'Backlog', 'Open', 'New', 'TODO', 'OPEN', 'Selected for Development',
    ];

    // Load all issues for this board, excluding Epics and Sub-tasks
    const allIssues = (
      await this.issueRepo.find({ where: { boardId } })
    ).filter((i) => isWorkItem(i.issueType));

    if (allIssues.length === 0) {
      return [];
    }

    const issueKeys = allIssues.map((i) => i.key);

    // Bulk-load the earliest board-entry changelog per issue.
    // An issue "enters" the board on the first transition *to* a boardEntryStatus.
    const boardEntryChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.toValue IN (:...statuses)', { statuses: boardEntryStatuses })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // issueKey -> earliest date it left "To Do"
    const boardEntryDate = new Map<string, Date>();
    for (const cl of boardEntryChangelogs) {
      if (!boardEntryDate.has(cl.issueKey)) {
        boardEntryDate.set(cl.issueKey, cl.changedAt);
      }
    }

    // Bulk-load the set of issue keys that have ANY status changelog
    // (used as fallback when backlogStatusIds is not configured)
    const issueKeysWithChangelog = new Set<string>(
      boardEntryChangelogs.map((cl) => cl.issueKey),
    );
    // Also catch issues that moved between non-"To Do" statuses
    if (backlogStatusIds.length === 0) {
      const anyStatusChangelogs = await this.changelogRepo
        .createQueryBuilder('cl')
        .select('DISTINCT cl."issueKey"', 'issueKey')
        .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        .getRawMany<{ issueKey: string }>();
      for (const row of anyStatusChangelogs) {
        issueKeysWithChangelog.add(row.issueKey);
      }
    }

    // Exclude pure-backlog issues: those that have never been pulled onto the board.
    // Primary: statusId is in backlogStatusIds (precise, requires post-sync data).
    // Fallback: issue has no status changelog at all (heuristic for pre-migration data).
    const onBoardIssues = allIssues.filter((issue) => {
      if (backlogStatusIds.length > 0) {
        // If statusId is known and matches a backlog status, exclude it.
        // If statusId is null (pre-migration), fall back to changelog heuristic.
        if (issue.statusId !== null) {
          return !backlogStatusIds.includes(issue.statusId);
        }
      }
      // Fallback: only include issues that have moved at least once
      return issueKeysWithChangelog.has(issue.key);
    });

    if (onBoardIssues.length === 0) {
      return [];
    }

    // Apply dataStartDate lower bound filter if configured
    const dataStartDate = config.dataStartDate ?? null;
    const startBound = dataStartDate ? new Date(dataStartDate) : null;
    const boundedIssues = startBound
      ? onBoardIssues.filter((issue) => {
          const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
          return entryDate >= startBound;
        })
      : onBoardIssues;

    if (boundedIssues.length === 0) {
      return [];
    }

    // Build map: issueKey → first done-transition timestamp (changelog-based)
    const allBoundedKeys = boundedIssues.map((i) => i.key);
    const doneChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allBoundedKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    const completionDateByIssue = new Map<string, Date>();
    for (const cl of doneChangelogs) {
      if (!completionDateByIssue.has(cl.issueKey)) {
        completionDateByIssue.set(cl.issueKey, cl.changedAt);
      }
    }

    // Bucket issues by the quarter of their board-entry date (fall back to createdAt)
    const quarterMap = new Map<string, typeof onBoardIssues>();
    for (const issue of boundedIssues) {
      const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
      const key = this.dateToQuarterKey(entryDate);
      const list = quarterMap.get(key) ?? [];
      list.push(issue);
      quarterMap.set(key, list);
    }

    const now = new Date();
    const currentQuarterKey = this.dateToQuarterKey(now);

    // For each quarter, derive per-issue "completed" and "addedMidQuarter" flags.
    // "addedMidQuarter" = board-entry date is after the 14-day grace period from quarter start.
    const results: KanbanQuarterSummary[] = [];

    const sortedKeys = Array.from(quarterMap.keys()).sort((a, b) =>
      b.localeCompare(a),
    );

    for (const qKey of sortedKeys) {
      const issues = quarterMap.get(qKey)!;
      const { startDate, endDate } = this.quarterToDates(qKey);
      const gracePeriodEnd = new Date(
        startDate.getTime() + 14 * 24 * 60 * 60 * 1000,
      );
      const state = qKey === currentQuarterKey ? 'active' : 'closed';

      let completed = 0;
      let addedMidQuarter = 0;
      let pointsIn = 0;
      let pointsDone = 0;

      for (const issue of issues) {
        const pts = issue.points ?? 0;
        pointsIn += pts;

        // Use changelog-based completion date — avoids stale current-status snapshot
        const completedAt = completionDateByIssue.get(issue.key);
        const isCompleted =
          completedAt !== undefined &&
          completedAt >= startDate &&
          completedAt <= endDate;
        if (isCompleted) {
          completed++;
          pointsDone += pts;
        }

        const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
        if (entryDate > gracePeriodEnd) {
          addedMidQuarter++;
        }
      }

      const issuesPulledIn = issues.length;
      const deliveryRate =
        issuesPulledIn > 0
          ? Math.round((completed / issuesPulledIn) * 10000) / 100
          : 0;

      results.push({
        quarter: qKey,
        state,
        issuesPulledIn,
        completed,
        addedMidQuarter,
        pointsIn,
        pointsDone,
        deliveryRate,
      });
    }

    return results;
  }

  async getKanbanWeeks(boardId: string): Promise<KanbanWeekSummary[]> {
    // Verify this is actually a Kanban board
    const config = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (!config || config.boardType !== 'kanban') {
      throw new BadRequestException(
        `Board ${boardId} is not a Kanban board`,
      );
    }

    const doneStatuses: string[] = config.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const backlogStatusIds: string[] = config.backlogStatusIds ?? [];

    // C-3: configurable board-entry status list (fix for hardcoded 'To Do').
    const boardEntryStatuses: string[] = config.boardEntryStatuses ?? [
      'To Do', 'Backlog', 'Open', 'New', 'TODO', 'OPEN', 'Selected for Development',
    ];

    // Load all issues for this board, excluding Epics and Sub-tasks
    const allIssues = (
      await this.issueRepo.find({ where: { boardId } })
    ).filter((i) => isWorkItem(i.issueType));

    if (allIssues.length === 0) {
      return [];
    }

    const issueKeys = allIssues.map((i) => i.key);

    // Bulk-load the earliest board-entry changelog per issue.
    const boardEntryChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.toValue IN (:...statuses)', { statuses: boardEntryStatuses })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // issueKey -> earliest date it left "To Do"
    const boardEntryDate = new Map<string, Date>();
    for (const cl of boardEntryChangelogs) {
      if (!boardEntryDate.has(cl.issueKey)) {
        boardEntryDate.set(cl.issueKey, cl.changedAt);
      }
    }

    // Bulk-load the set of issue keys that have ANY status changelog
    const issueKeysWithChangelog = new Set<string>(
      boardEntryChangelogs.map((cl) => cl.issueKey),
    );
    if (backlogStatusIds.length === 0) {
      const anyStatusChangelogs = await this.changelogRepo
        .createQueryBuilder('cl')
        .select('DISTINCT cl."issueKey"', 'issueKey')
        .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        .getRawMany<{ issueKey: string }>();
      for (const row of anyStatusChangelogs) {
        issueKeysWithChangelog.add(row.issueKey);
      }
    }

    // Exclude pure-backlog issues
    const onBoardIssues = allIssues.filter((issue) => {
      if (backlogStatusIds.length > 0) {
        if (issue.statusId !== null) {
          return !backlogStatusIds.includes(issue.statusId);
        }
      }
      return issueKeysWithChangelog.has(issue.key);
    });

    if (onBoardIssues.length === 0) {
      return [];
    }

    // Apply dataStartDate lower bound filter if configured
    const dataStartDateWeeks = config.dataStartDate ?? null;
    const startBoundWeeks = dataStartDateWeeks ? new Date(dataStartDateWeeks) : null;
    const boundedIssuesWeeks = startBoundWeeks
      ? onBoardIssues.filter((issue) => {
          const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
          return entryDate >= startBoundWeeks;
        })
      : onBoardIssues;

    if (boundedIssuesWeeks.length === 0) {
      return [];
    }

    // Build map: issueKey → first done-transition timestamp (changelog-based)
    const allBoundedWeekKeys = boundedIssuesWeeks.map((i) => i.key);
    const doneChangelogsWeeks = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allBoundedWeekKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.toValue IN (:...statuses)', { statuses: doneStatuses })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    const completionDateByIssueWeeks = new Map<string, Date>();
    for (const cl of doneChangelogsWeeks) {
      if (!completionDateByIssueWeeks.has(cl.issueKey)) {
        completionDateByIssueWeeks.set(cl.issueKey, cl.changedAt);
      }
    }

    // Bucket issues by the week of their board-entry date (fall back to createdAt)
    const weekMap = new Map<string, typeof onBoardIssues>();
    for (const issue of boundedIssuesWeeks) {
      const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
      const key = this.dateToWeekKey(entryDate);
      const list = weekMap.get(key) ?? [];
      list.push(issue);
      weekMap.set(key, list);
    }

    const now = new Date();
    const currentWeekKey = this.dateToWeekKey(now);

    const results: KanbanWeekSummary[] = [];

    const sortedKeys = Array.from(weekMap.keys()).sort((a, b) =>
      b.localeCompare(a),
    );

    for (const wKey of sortedKeys) {
      const issues = weekMap.get(wKey)!;
      const { weekStart, weekEnd } = this.weekKeyToDates(wKey);
      // 1-day grace period (instead of 14-day for quarters)
      const gracePeriodEnd = new Date(
        weekStart.getTime() + 1 * 24 * 60 * 60 * 1000,
      );
      const state = wKey === currentWeekKey ? 'active' : 'closed';

      let completed = 0;
      let addedMidWeek = 0;
      let pointsIn = 0;
      let pointsDone = 0;

      for (const issue of issues) {
        const pts = issue.points ?? 0;
        pointsIn += pts;

        // Use changelog-based completion date — avoids stale current-status snapshot
        const completedAt = completionDateByIssueWeeks.get(issue.key);
        const isCompleted =
          completedAt !== undefined &&
          completedAt >= weekStart &&
          completedAt <= weekEnd;
        if (isCompleted) {
          completed++;
          pointsDone += pts;
        }

        const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
        if (entryDate > gracePeriodEnd) {
          addedMidWeek++;
        }
      }

      const issuesPulledIn = issues.length;
      const deliveryRate =
        issuesPulledIn > 0
          ? Math.round((completed / issuesPulledIn) * 10000) / 100
          : 0;

      results.push({
        week: wKey,
        state,
        weekStart: weekStart.toISOString(),
        issuesPulledIn,
        completed,
        addedMidWeek,
        pointsIn,
        pointsDone,
        deliveryRate,
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Quarter helpers
  // ---------------------------------------------------------------------------

  private dateToQuarterKey(date: Date): string {
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const { year, month } = dateParts(date, tz);
    const q = Math.floor(month / 3) + 1;
    return `${year}-Q${q}`;
  }

  private quarterToDates(quarter: string): {
    startDate: Date;
    endDate: Date;
  } {
    const match = quarter.match(/^(\d{4})-Q([1-4])$/);
    if (!match) {
      throw new BadRequestException(
        `Invalid quarter format: ${quarter}. Expected YYYY-QN`,
      );
    }
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const year = parseInt(match[1], 10);
    const q = parseInt(match[2], 10);
    const startMonth = (q - 1) * 3; // 0-indexed
    const startDate = midnightInTz(year, startMonth, 1, tz);
    const endDate = midnightInTz(year, startMonth + 3, 0, tz);
    endDate.setUTCHours(23, 59, 59, 999);
    return { startDate, endDate };
  }

  // ---------------------------------------------------------------------------
  // ISO week helpers
  // ---------------------------------------------------------------------------

  private dateToWeekKey(date: Date): string {
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const { year, month, day } = dateParts(date, tz);
    // Build a UTC-based proxy for the local calendar date in `tz`
    const localDate = new Date(Date.UTC(year, month, day));
    // ISO 8601: find the Thursday of the same week to determine the ISO year.
    // Jan 4 is always in ISO week 1 of its year.
    const dow = localDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysToThursday = dow === 0 ? 4 : 4 - dow;
    const thursday = new Date(localDate);
    thursday.setUTCDate(localDate.getUTCDate() + daysToThursday);

    const isoYear = thursday.getUTCFullYear();

    // Monday of ISO week 1: Jan 4 of isoYear minus (its weekday - 1)
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay();
    const daysToMonday = jan4Day === 0 ? -6 : 1 - jan4Day;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() + daysToMonday);

    // Monday of this week (the week containing `date` in `tz`)
    const thisMonday = new Date(localDate);
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    thisMonday.setUTCDate(localDate.getUTCDate() + daysToMon);

    const diffMs = thisMonday.getTime() - week1Monday.getTime();
    const weekNumber = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

    return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
  }

  private weekKeyToDates(week: string): { weekStart: Date; weekEnd: Date } {
    const match = week.match(/^(\d{4})-W(\d{2})$/);
    if (!match) {
      throw new BadRequestException(
        `Invalid week format: ${week}. Expected YYYY-Www`,
      );
    }

    const year = parseInt(match[1], 10);
    const weekNum = parseInt(match[2], 10);

    // Jan 4 is always in ISO week 1
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay(); // 0=Sun, 1=Mon, ...
    // Monday of week 1
    const mondayOfWeek1 = new Date(jan4);
    const daysToMon = jan4Day === 0 ? -6 : 1 - jan4Day;
    mondayOfWeek1.setUTCDate(jan4.getUTCDate() + daysToMon);

    // Monday of the requested week
    const weekStart = new Date(mondayOfWeek1);
    weekStart.setUTCDate(mondayOfWeek1.getUTCDate() + (weekNum - 1) * 7);

    // Sunday 23:59:59.999 (6 days after Monday)
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart, weekEnd };
  }
}
