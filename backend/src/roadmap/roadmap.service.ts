import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JpdIdea,
  RoadmapConfig,
  BoardConfig,
} from '../database/entities/index.js';
import { SyncService } from '../sync/sync.service.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';

export interface RoadmapSprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  totalIssues: number;
  coveredIssues: number;
  uncoveredIssues: number;
  roadmapCoverage: number;
  linkedCompletedIssues: number;
  roadmapDeliveryRate: number;
}

interface RoadmapItemWindow {
  ideaKey: string;
  startDate: Date;
  targetDate: Date;
}

@Injectable()
export class RoadmapService {
  private readonly logger = new Logger(RoadmapService.name);

  constructor(
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JpdIdea)
    private readonly jpdIdeaRepo: Repository<JpdIdea>,
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly syncService: SyncService,
  ) {}

  async getAccuracy(
    boardId: string,
    sprintId?: string,
    quarter?: string,
    week?: string,
    weekMode?: boolean,
  ): Promise<RoadmapSprintAccuracy[]> {
    const boardConfig = await this.boardConfigRepo.findOne({ where: { boardId } });
    const isKanban = boardConfig?.boardType === 'kanban';

    // Kanban boards have no sprints — sprintId filter is unsupported
    if (isKanban && sprintId) {
      throw new BadRequestException(
        'Sprint-level accuracy is not available for Kanban boards. Use quarter mode instead.',
      );
    }

    if (isKanban && week) {
      return this.getKanbanWeeklyAccuracy(boardId, boardConfig, week);
    }

    // weekMode=true on a Kanban board: return all weeks without filtering
    if (isKanban && weekMode) {
      return this.getKanbanWeeklyAccuracy(boardId, boardConfig, undefined);
    }

    if (isKanban) {
      return this.getKanbanAccuracy(boardId, boardConfig, quarter);
    }

    // Resolve sprints
    let sprints: JiraSprint[];

    if (sprintId) {
      const sprint = await this.sprintRepo.findOne({ where: { id: sprintId, boardId } });
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
      // Active first, then closed descending
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

    // Resolve doneStatusNames from board config
    const doneStatusNames: string[] =
      boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];

    if (sprints.length === 0) {
      return [];
    }

    // M3: bulk-load all issues for all sprints in one query
    const sprintIds = sprints.map((s) => s.id);
    const allIssues = await this.issueRepo.find({
      where: { sprintId: In(sprintIds), boardId },
    });
    const issuesBySprint = new Map<string, JiraIssue[]>();
    for (const issue of allIssues) {
      if (!issue.sprintId) continue;
      const list = issuesBySprint.get(issue.sprintId) ?? [];
      list.push(issue);
      issuesBySprint.set(issue.sprintId, list);
    }

    // Load all roadmap ideas once — filter per-sprint in memory
    const allIdeasForSprints = await this.loadAllIdeas();

    const results: RoadmapSprintAccuracy[] = [];
    for (const sprint of sprints) {
      const sprintIssues = issuesBySprint.get(sprint.id) ?? [];
      const accuracy = await this.calculateSprintAccuracy(
        sprint,
        sprintIssues,
        doneStatusNames,
        allIdeasForSprints,
      );
      results.push(accuracy);
    }

    return results;
  }

  /**
   * For Kanban boards: group issues by the quarter in which they were first
   * moved off "To Do" (i.e. pulled onto the board). Falls back to createdAt
   * for issues that have no such changelog entry.
   */
  private async getKanbanAccuracy(
    boardId: string,
    boardConfig: BoardConfig | null,
    quarter?: string,
  ): Promise<RoadmapSprintAccuracy[]> {
    const doneStatusNames: string[] =
      boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const backlogStatusIds: string[] = boardConfig?.backlogStatusIds ?? [];

    // Load all Kanban issues for this board, excluding Epics and Sub-tasks
    const allIssues = (await this.issueRepo.find({ where: { boardId } })).filter(
      (i) => isWorkItem(i.issueType),
    );

    if (allIssues.length === 0) {
      return [];
    }

    const issueKeys = allIssues.map((i) => i.key);

    // Bulk-load status changelogs for all these issues in one query
    const changelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.fromValue = :from', { from: 'To Do' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Build map: issueKey → earliest date it left "To Do"
    const boardEntryDate = new Map<string, Date>();
    for (const cl of changelogs) {
      if (!boardEntryDate.has(cl.issueKey)) {
        boardEntryDate.set(cl.issueKey, cl.changedAt);
      }
    }

    // Build set of issue keys that have any status changelog (fallback heuristic)
    const issueKeysWithChangelog = new Set<string>(changelogs.map((cl) => cl.issueKey));
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
    const dataStartDate = boardConfig?.dataStartDate ?? null;
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

    // Bulk-load all status changelogs for completion date / activity-start mapping
    const allBoundedKeys = boundedIssues.map((i) => i.key);
    const doneChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allBoundedKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Build map: issueKey → first done-transition changedAt
    const completionDates = new Map<string, Date>();
    // Build map: issueKey → first non-done transition changedAt (activity start).
    // NOTE: The Kanban path defines "activity start" as the first transition TO a
    // non-done status (i.e. the first time work was picked up or re-opened). The
    // sprint path (calculateSprintAccuracy) instead uses the first status transition
    // of *any* kind. The difference is low-risk — it only affects re-opened issues —
    // but is intentional: Kanban activity-start is board-pull semantics, sprint
    // activity-start is first-touch semantics. Both paths fall back to createdAt
    // when no changelog entry exists.
    const activityStartDates = new Map<string, Date>();
    for (const cl of doneChangelogs) {
      if (cl.toValue !== null && doneStatusNames.includes(cl.toValue)) {
        if (!completionDates.has(cl.issueKey)) {
          completionDates.set(cl.issueKey, cl.changedAt);
        }
      } else {
        // First transition to a non-done status = activity start
        if (!activityStartDates.has(cl.issueKey)) {
          activityStartDates.set(cl.issueKey, cl.changedAt);
        }
      }
    }

    // Group issues by the quarter of their board-entry date (fall back to createdAt)
    const quarterMap = new Map<string, JiraIssue[]>();
    for (const issue of boundedIssues) {
      const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
      const key = this.issueToQuarterKey(entryDate);
      const list = quarterMap.get(key) ?? [];
      list.push(issue);
      quarterMap.set(key, list);
    }

    // Filter to requested quarter if provided; otherwise all, newest first
    const filteredKeys = quarter
      ? Array.from(quarterMap.keys()).filter((k) => k === quarter)
      : Array.from(quarterMap.keys()).sort((a, b) => b.localeCompare(a));

    const now = new Date();
    const currentQuarterKey = this.issueToQuarterKey(now);

    // Load all ideas once — filter per-quarter in memory (avoids N×2 DB queries)
    const allIdeas = await this.loadAllIdeas();

    const results: RoadmapSprintAccuracy[] = [];
    for (const qKey of filteredKeys) {
      const issues = quarterMap.get(qKey)!;
      const { startDate, endDate } = this.quarterToDates(qKey);
      const state = qKey === currentQuarterKey ? 'active' : 'closed';

      const activeIdeas = this.filterIdeasForWindow(allIdeas, startDate, endDate);

      const eligibleCoveredIssues = issues.filter((i) => {
        if (i.epicKey === null || !activeIdeas.has(i.epicKey)) return false;
        const item = activeIdeas.get(i.epicKey)!;
        const issueActivityStart = activityStartDates.get(i.key) ?? i.createdAt;
        // Conservative: issues already in done status get null (treated as in-flight)
        const issueActivityEnd = doneStatusNames.includes(i.status)
          ? null
          : (completionDates.get(i.key) ?? null);
        return this.isIssueEligibleForRoadmapItem(issueActivityStart, issueActivityEnd, item);
      });
      const eligibleCoveredKeys = new Set(eligibleCoveredIssues.map((i) => i.key));

      const completedKeys = new Set<string>(
        issues
          .filter((i) => doneStatusNames.includes(i.status))
          .map((i) => i.key),
      );

      const totalIssues = issues.length;
      const coveredCount = eligibleCoveredIssues.length;
      const linkedCompletedIssues = [...completedKeys].filter((k) =>
        eligibleCoveredKeys.has(k),
      ).length;

      results.push({
        sprintId: qKey,
        sprintName: qKey,
        state,
        startDate: startDate.toISOString(),
        totalIssues,
        coveredIssues: coveredCount,
        uncoveredIssues: totalIssues - coveredCount,
        roadmapCoverage:
          totalIssues > 0
            ? Math.round((coveredCount / totalIssues) * 10000) / 100
            : 0,
        linkedCompletedIssues,
        roadmapDeliveryRate:
          coveredCount > 0
            ? Math.round((linkedCompletedIssues / coveredCount) * 10000) / 100
            : 0,
      });
    }

    return results;
  }

  /**
   * Load all JPD ideas from configured projects in a single pair of DB
   * queries. Returned ideas retain their raw date fields; use
   * filterIdeasForWindow() to apply a date-window filter in memory.
   */
  private async loadAllIdeas(): Promise<JpdIdea[]> {
    const configs = await this.roadmapConfigRepo.find();
    if (configs.length === 0) return [];
    const jpdKeys = configs.map((c) => c.jpdKey);
    return this.jpdIdeaRepo.find({ where: { jpdKey: In(jpdKeys) } });
  }

  /**
   * Filter a pre-loaded idea list to those whose delivery window overlaps
   * [windowStart, windowEnd], returning a Map keyed by epic key.
   * Ideas without both startDate and targetDate are excluded (decision 2).
   * Conflict resolution: if multiple ideas link the same epic key, keep
   * the one with the later targetDate.
   *
   * This is pure in-memory arithmetic — no DB access.
   */
  private filterIdeasForWindow(
    ideas: JpdIdea[],
    windowStart: Date,
    windowEnd: Date,
  ): Map<string, RoadmapItemWindow> {
    const result = new Map<string, RoadmapItemWindow>();

    for (const idea of ideas) {
      if (!idea.deliveryIssueKeys) continue;

      // Decision 2: ideas without BOTH dates are excluded entirely.
      if (idea.startDate === null || idea.targetDate === null) continue;

      // Date-window overlap filter:
      //   idea.targetDate >= windowStart  AND  idea.startDate <= windowEnd
      if (idea.targetDate < windowStart || idea.startDate > windowEnd) continue;

      for (const epicKey of idea.deliveryIssueKeys.filter(Boolean)) {
        const existing = result.get(epicKey);
        if (!existing) {
          result.set(epicKey, {
            ideaKey: idea.key,
            startDate: idea.startDate,
            targetDate: idea.targetDate,
          });
        } else {
          // Prefer the window with the later targetDate (most recent delivery commitment)
          if (idea.targetDate.getTime() > existing.targetDate.getTime()) {
            result.set(epicKey, {
              ideaKey: idea.key,
              startDate: idea.startDate,
              targetDate: idea.targetDate,
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * Returns true if the issue's activity window overlaps the roadmap item's
   * delivery window.
   *
   * Per architect note: gate on issueActivityStart <= targetDate only (not
   * issueActivityEnd). E6: an issue that started before the target but
   * finished after it still counts — late delivery is a rate miss, not an
   * exclusion.
   *
   * issueActivityEnd === null means the issue is in-flight; it always
   * qualifies the afterStart side of the check (conservative).
   */
  private isIssueEligibleForRoadmapItem(
    issueActivityStart: Date,
    issueActivityEnd: Date | null,
    item: RoadmapItemWindow,
  ): boolean {
    // Issue must have started at or before the roadmap item's target date
    const beforeTarget = issueActivityStart <= item.targetDate;

    // Issue must not have been completed before the roadmap item's start date
    const afterStart =
      issueActivityEnd === null || // in-flight: always qualifies
      issueActivityEnd >= item.startDate;

    return beforeTarget && afterStart;
  }

  private issueToQuarterKey(date: Date): string {
    const q = Math.floor(date.getMonth() / 3) + 1;
    return `${date.getFullYear()}-Q${q}`;
  }

  private dateToWeekKey(date: Date): string {
    // Find the Thursday of the week (ISO: weeks start Monday)
    const thursday = new Date(date);
    const day = date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysToThursday = day === 0 ? 4 : 4 - day;
    thursday.setDate(date.getDate() + daysToThursday);

    const isoYear = thursday.getFullYear();

    const startOfYear = new Date(isoYear, 0, 1);
    const diffMs = thursday.getTime() - startOfYear.getTime();
    const dayOfYear = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
    const weekNumber = Math.ceil(dayOfYear / 7);

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
    const jan4Day = jan4.getUTCDay();
    const daysToMon = jan4Day === 0 ? -6 : 1 - jan4Day;
    const mondayOfWeek1 = new Date(jan4);
    mondayOfWeek1.setUTCDate(jan4.getUTCDate() + daysToMon);

    const weekStart = new Date(mondayOfWeek1);
    weekStart.setUTCDate(mondayOfWeek1.getUTCDate() + (weekNum - 1) * 7);

    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart, weekEnd };
  }

  /**
   * For Kanban boards: group issues by the ISO week in which they were first
   * moved off "To Do" (i.e. pulled onto the board).
   */
  private async getKanbanWeeklyAccuracy(
    boardId: string,
    boardConfig: BoardConfig | null,
    week?: string,
  ): Promise<RoadmapSprintAccuracy[]> {
    const doneStatusNames: string[] =
      boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const backlogStatusIds: string[] = boardConfig?.backlogStatusIds ?? [];

    // Load all Kanban issues for this board, excluding Epics and Sub-tasks
    const allIssues = (await this.issueRepo.find({ where: { boardId } })).filter(
      (i) => isWorkItem(i.issueType),
    );

    if (allIssues.length === 0) {
      return [];
    }

    const issueKeys = allIssues.map((i) => i.key);

    // Bulk-load status changelogs for all these issues in one query
    const changelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .andWhere('cl.fromValue = :from', { from: 'To Do' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Build map: issueKey → earliest date it left "To Do"
    const boardEntryDate = new Map<string, Date>();
    for (const cl of changelogs) {
      if (!boardEntryDate.has(cl.issueKey)) {
        boardEntryDate.set(cl.issueKey, cl.changedAt);
      }
    }

    // Build set of issue keys that have any status changelog (fallback heuristic)
    const issueKeysWithChangelog = new Set<string>(changelogs.map((cl) => cl.issueKey));
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
    const dataStartDateWeekly = boardConfig?.dataStartDate ?? null;
    const startBoundWeekly = dataStartDateWeekly ? new Date(dataStartDateWeekly) : null;
    const boundedIssuesWeekly = startBoundWeekly
      ? onBoardIssues.filter((issue) => {
          const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
          return entryDate >= startBoundWeekly;
        })
      : onBoardIssues;

    if (boundedIssuesWeekly.length === 0) {
      return [];
    }

    // Bulk-load done-transition changelogs for completion date / activity-start mapping
    const allWeeklyKeys = boundedIssuesWeekly.map((i) => i.key);
    const doneChangelogsWeekly = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allWeeklyKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Build map: issueKey → first done-transition changedAt
    const completionDatesWeekly = new Map<string, Date>();
    // Build map: issueKey → first non-done transition changedAt (activity start).
    // NOTE: See getKanbanAccuracy for a note on the intentional difference between
    // this Kanban "board-pull semantics" definition and the sprint path's
    // "first-touch semantics" in calculateSprintAccuracy.
    const activityStartDatesWeekly = new Map<string, Date>();
    for (const cl of doneChangelogsWeekly) {
      if (cl.toValue !== null && doneStatusNames.includes(cl.toValue)) {
        if (!completionDatesWeekly.has(cl.issueKey)) {
          completionDatesWeekly.set(cl.issueKey, cl.changedAt);
        }
      } else {
        if (!activityStartDatesWeekly.has(cl.issueKey)) {
          activityStartDatesWeekly.set(cl.issueKey, cl.changedAt);
        }
      }
    }

    // Group issues by the week of their board-entry date (fall back to createdAt)
    const weekMap = new Map<string, JiraIssue[]>();
    for (const issue of boundedIssuesWeekly) {
      const entryDate = boardEntryDate.get(issue.key) ?? issue.createdAt;
      const key = this.dateToWeekKey(entryDate);
      const list = weekMap.get(key) ?? [];
      list.push(issue);
      weekMap.set(key, list);
    }

    // Filter to requested week if provided; otherwise all, newest first
    const filteredKeys = week
      ? Array.from(weekMap.keys()).filter((k) => k === week)
      : Array.from(weekMap.keys()).sort((a, b) => b.localeCompare(a));

    const now = new Date();
    const currentWeekKey = this.dateToWeekKey(now);

    // Load all ideas once — filter per-week in memory (avoids N×2 DB queries)
    const allIdeasWeekly = await this.loadAllIdeas();

    const results: RoadmapSprintAccuracy[] = [];
    for (const wKey of filteredKeys) {
      const issues = weekMap.get(wKey)!;
      const { weekStart, weekEnd } = this.weekKeyToDates(wKey);
      const state = wKey === currentWeekKey ? 'active' : 'closed';

      const activeIdeas = this.filterIdeasForWindow(allIdeasWeekly, weekStart, weekEnd);

      const eligibleCoveredIssues = issues.filter((i) => {
        if (i.epicKey === null || !activeIdeas.has(i.epicKey)) return false;
        const item = activeIdeas.get(i.epicKey)!;
        const issueActivityStart = activityStartDatesWeekly.get(i.key) ?? i.createdAt;
        // Conservative: issues already in done status get null (treated as in-flight)
        const issueActivityEnd = doneStatusNames.includes(i.status)
          ? null
          : (completionDatesWeekly.get(i.key) ?? null);
        return this.isIssueEligibleForRoadmapItem(issueActivityStart, issueActivityEnd, item);
      });
      const eligibleCoveredKeys = new Set(eligibleCoveredIssues.map((i) => i.key));

      const completedKeys = new Set<string>(
        issues
          .filter((i) => doneStatusNames.includes(i.status))
          .map((i) => i.key),
      );

      const totalIssues = issues.length;
      const coveredCount = eligibleCoveredIssues.length;
      const linkedCompletedIssues = [...completedKeys].filter((k) =>
        eligibleCoveredKeys.has(k),
      ).length;

      results.push({
        sprintId: wKey,
        sprintName: wKey,
        state,
        startDate: weekStart.toISOString(),
        totalIssues,
        coveredIssues: coveredCount,
        uncoveredIssues: totalIssues - coveredCount,
        roadmapCoverage:
          totalIssues > 0
            ? Math.round((coveredCount / totalIssues) * 10000) / 100
            : 0,
        linkedCompletedIssues,
        roadmapDeliveryRate:
          coveredCount > 0
            ? Math.round((linkedCompletedIssues / coveredCount) * 10000) / 100
            : 0,
      });
    }

    return results;
  }

  private async calculateSprintAccuracy(
    sprint: JiraSprint,
    sprintIssues: JiraIssue[],
    doneStatusNames: string[],
    allIdeas: JpdIdea[],
  ): Promise<RoadmapSprintAccuracy> {
    const filteredIssues = sprintIssues.filter(
      (i) => isWorkItem(i.issueType),
    );

    if (filteredIssues.length === 0) {
      return this.emptyAccuracy(sprint);
    }

    const sprintStart = sprint.startDate ?? new Date(0);
    const sprintEnd = sprint.endDate ?? new Date();

    // Filter pre-loaded ideas for this sprint window (no DB round-trip per sprint)
    const activeIdeas = this.filterIdeasForWindow(allIdeas, sprintStart, sprintEnd);

    // Build completed set — check current status first, then changelogs for remainder.
    // Also capture completion timestamps for issues found via changelog.
    const completedKeys = new Set<string>();
    const completionDates = new Map<string, Date>(); // issueKey → first done changedAt in sprint
    const needsChangelogCheck: string[] = [];

    for (const issue of filteredIssues) {
      if (doneStatusNames.includes(issue.status)) {
        // Already done; conservative: treat completionDate as null (in-flight for overlap)
        completedKeys.add(issue.key);
      } else {
        needsChangelogCheck.push(issue.key);
      }
    }

    // Only query changelogs for issues not already in done status
    if (needsChangelogCheck.length > 0) {
      const changelogs = await this.changelogRepo
        .createQueryBuilder('cl')
        .where('cl.issueKey IN (:...keys)', { keys: needsChangelogCheck })
        .andWhere('cl.field = :field', { field: 'status' })
        .andWhere('cl.changedAt >= :start', { start: sprintStart })
        .andWhere('cl.changedAt <= :end', { end: sprintEnd })
        .orderBy('cl.changedAt', 'ASC')
        .getMany();

      for (const cl of changelogs) {
        if (cl.toValue !== null && doneStatusNames.includes(cl.toValue)) {
          completedKeys.add(cl.issueKey);
          if (!completionDates.has(cl.issueKey)) {
            completionDates.set(cl.issueKey, cl.changedAt);
          }
        }
      }
    }

    // Query activity-start timestamps: first status transition for each issue
    const allFilteredKeys = filteredIssues.map((i) => i.key);
    const activityStartChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allFilteredKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    const activityStartDates = new Map<string, Date>();
    for (const cl of activityStartChangelogs) {
      if (!activityStartDates.has(cl.issueKey)) {
        // First status transition = activity start regardless of direction
        activityStartDates.set(cl.issueKey, cl.changedAt);
      }
    }

    // Classify covered issues with eligibility check
    const eligibleCoveredIssues = filteredIssues.filter((i) => {
      if (i.epicKey === null || !activeIdeas.has(i.epicKey)) return false;
      const item = activeIdeas.get(i.epicKey)!;
      const issueActivityStart = activityStartDates.get(i.key) ?? i.createdAt;
      // Conservative: issues already in done status get null (treated as in-flight)
      const issueActivityEnd = doneStatusNames.includes(i.status)
        ? null
        : (completionDates.get(i.key) ?? null);
      return this.isIssueEligibleForRoadmapItem(issueActivityStart, issueActivityEnd, item);
    });
    const eligibleCoveredKeys = new Set(eligibleCoveredIssues.map((i) => i.key));

    // Compute metrics
    const totalIssues = filteredIssues.length;
    const coveredCount = eligibleCoveredIssues.length;
    const uncoveredIssues = totalIssues - coveredCount;
    const roadmapCoverage =
      totalIssues > 0
        ? Math.round((coveredCount / totalIssues) * 10000) / 100
        : 0;

    const linkedCompletedIssues = [...completedKeys].filter((k) =>
      eligibleCoveredKeys.has(k),
    ).length;
    const roadmapDeliveryRate =
      coveredCount > 0
        ? Math.round((linkedCompletedIssues / coveredCount) * 10000) / 100
        : 0;

    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      totalIssues,
      coveredIssues: coveredCount,
      uncoveredIssues,
      roadmapCoverage,
      linkedCompletedIssues,
      roadmapDeliveryRate,
    };
  }

  private emptyAccuracy(sprint: JiraSprint): RoadmapSprintAccuracy {
    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      totalIssues: 0,
      coveredIssues: 0,
      uncoveredIssues: 0,
      roadmapCoverage: 0,
      linkedCompletedIssues: 0,
      roadmapDeliveryRate: 0,
    };
  }

  private quarterToDates(quarter: string): { startDate: Date; endDate: Date } {
    const match = quarter.match(/^(\d{4})-Q([1-4])$/);
    if (!match) {
      throw new Error(`Invalid quarter format: ${quarter}. Expected YYYY-QN`);
    }
    const year = parseInt(match[1], 10);
    const q = parseInt(match[2], 10);
    const startMonth = (q - 1) * 3;
    return {
      startDate: new Date(year, startMonth, 1),
      endDate: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
    };
  }

  async getConfigs(): Promise<RoadmapConfig[]> {
    return this.roadmapConfigRepo.find({ order: { createdAt: 'ASC' } });
  }

  async createConfig(jpdKey: string, description?: string): Promise<RoadmapConfig> {
    const existing = await this.roadmapConfigRepo.findOne({ where: { jpdKey } });
    if (existing) {
      throw new ConflictException(
        `A roadmap config for JPD key "${jpdKey}" already exists`,
      );
    }
    const config = this.roadmapConfigRepo.create({
      jpdKey,
      description: description ?? null,
    });
    return this.roadmapConfigRepo.save(config);
  }

  async updateConfig(
    id: number,
    startDateFieldId?: string | null,
    targetDateFieldId?: string | null,
  ): Promise<RoadmapConfig> {
    const existing = await this.roadmapConfigRepo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Roadmap config with id ${id} not found`);
    }
    if (startDateFieldId !== undefined) {
      existing.startDateFieldId = startDateFieldId;
    }
    if (targetDateFieldId !== undefined) {
      existing.targetDateFieldId = targetDateFieldId;
    }
    return this.roadmapConfigRepo.save(existing);
  }

  async deleteConfig(id: number): Promise<void> {
    const existing = await this.roadmapConfigRepo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Roadmap config with id ${id} not found`);
    }
    await this.roadmapConfigRepo.delete({ id });
  }

  async syncRoadmaps(): Promise<{ message: string }> {
    await this.syncService.syncRoadmaps();
    return { message: 'Roadmap sync completed' };
  }
}
