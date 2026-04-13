import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
import { dateParts, midnightInTz } from '../metrics/tz-utils.js';

export interface RoadmapSprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  totalIssues: number;
  coveredIssues: number;
  uncoveredIssues: number;
  roadmapCoverage: number;
  /**
   * On-time delivery rate: green ÷ (green + amber).
   * = issues delivered on or before targetDate ÷ all roadmap-linked issues.
   * 0 when there are no roadmap-linked issues.
   */
  roadmapOnTimeRate: number;
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
    @Inject(forwardRef(() => SyncService))
    private readonly syncService: SyncService,
    private readonly configService: ConfigService,
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

    // Resolve doneStatusNames and cancelledStatusNames from board config
    const doneStatusNames: string[] =
      boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const cancelledStatusNames: string[] =
      boardConfig?.cancelledStatusNames ?? ['Cancelled', "Won't Do"];

    if (sprints.length === 0) {
      return [];
    }

    // Load ALL board issues — we cannot rely on the sprintId column because
    // Jira only stores the *current* sprint on an issue.  Issues from recently-
    // closed sprints will have had their sprintId updated to the active sprint
    // by the last sync, making a WHERE sprintId IN (...) query miss them entirely.
    const allBoardIssues = (await this.issueRepo.find({ where: { boardId } })).filter(
      (i) => isWorkItem(i.issueType),
    );

    if (allBoardIssues.length === 0) {
      return this.emptyAccuracyForSprints(sprints);
    }

    const allBoardKeys = allBoardIssues.map((i) => i.key);
    const issueByKey = new Map<string, JiraIssue>(allBoardIssues.map((i) => [i.key, i]));

    // Bulk-load all Sprint-field changelogs for all board issues in one query
    const allSprintChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allBoardKeys })
      .andWhere('cl.field = :field', { field: 'Sprint' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Build per-sprint issue sets by replaying Sprint-field changelogs,
    // using the same algorithm as sprint-detail.service.ts.
    const sprintSet = new Set(sprints.map((s) => s.id));
    const sprintByName = new Map<string, JiraSprint>(sprints.map((s) => [s.name, s]));
    const issuesBySprint = new Map<string, Set<string>>();
    for (const s of sprints) {
      issuesBySprint.set(s.id, new Set<string>());
    }

    // Group changelogs by issue key for efficient per-issue replay
    const changelogsByIssue = new Map<string, typeof allSprintChangelogs>();
    for (const cl of allSprintChangelogs) {
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // For each board issue, figure out which target sprints it belongs to
    for (const issue of allBoardIssues) {
      const logs = changelogsByIssue.get(issue.key) ?? [];

      // Collect names of all target sprints this issue ever appeared in
      // via changelogs — also handle issues with no changelogs (assigned at creation)
      const sprintNamesToCheck = new Set<string>();

      // Issues currently assigned to a target sprint but with no sprint changelog
      // were created directly into that sprint
      if (
        issue.sprintId !== null &&
        sprintSet.has(issue.sprintId) &&
        logs.length === 0
      ) {
        const sprint = sprints.find((s) => s.id === issue.sprintId);
        if (sprint) {
          issuesBySprint.get(sprint.id)!.add(issue.key);
        }
        continue;
      }

      // Collect sprint names referenced in changelogs that correspond to our target sprints
      for (const cl of logs) {
        for (const sprint of sprints) {
          if (
            sprintValueContainsName(cl.fromValue, sprint.name) ||
            sprintValueContainsName(cl.toValue, sprint.name)
          ) {
            sprintNamesToCheck.add(sprint.name);
          }
        }
      }

      // Fallback: if the issue's current sprintId points to a target sprint but
      // no changelog mentions that sprint by name (e.g. Jira carried the issue
      // forward when the sprint was started without emitting a Sprint-field
      // changelog entry), include it directly.  This mirrors the pattern in
      // sprint-detail.service.ts lines 294-298.
      if (issue.sprintId !== null && sprintSet.has(issue.sprintId)) {
        const targetSprint = sprints.find((s) => s.id === issue.sprintId);
        if (targetSprint && !sprintNamesToCheck.has(targetSprint.name)) {
          issuesBySprint.get(targetSprint.id)!.add(issue.key);
          // Still replay changelogs for other target sprints this issue may
          // have appeared in — do NOT continue; fall through.
        }
      }

      // For each referenced target sprint, replay the changelog to determine
      // whether the issue was a member at any point during that sprint window
      for (const sprintName of sprintNamesToCheck) {
        const sprint = sprintByName.get(sprintName);
        if (!sprint) continue;

        const sprintStart = sprint.startDate;
        const sprintEnd = sprint.endDate ?? new Date();

        if (!sprintStart) {
          // No start date: include if any changelog mentions this sprint
          issuesBySprint.get(sprint.id)!.add(issue.key);
          continue;
        }

        const effectiveStart = new Date(sprintStart.getTime() + ROADMAP_GRACE_PERIOD_MS);

        // Determine state at sprint start
        let inSprintAtStart = wasInSprintByName(logs, sprintName, sprintStart);
        let inSprintAtEnd = inSprintAtStart;

        for (const cl of logs) {
          if (cl.changedAt <= sprintStart) continue;
          if (cl.changedAt > sprintEnd) break;

          if (sprintValueContainsName(cl.toValue, sprintName)) {
            inSprintAtEnd = true;
          }
          if (
            sprintValueContainsName(cl.fromValue, sprintName) &&
            !sprintValueContainsName(cl.toValue, sprintName)
          ) {
            inSprintAtEnd = false;
          }
        }

        // Also handle issues created directly into the sprint after grace period
        const createdMidSprint =
          logs.length > 0 &&
          issue.createdAt > effectiveStart &&
          issue.createdAt <= sprintEnd &&
          !inSprintAtStart;

        if (inSprintAtStart || inSprintAtEnd || createdMidSprint) {
          issuesBySprint.get(sprint.id)!.add(issue.key);
        }
      }
    }

    // Materialise issue lists per sprint
    const issueListBySprint = new Map<string, JiraIssue[]>();
    for (const [sid, keySet] of issuesBySprint) {
      issueListBySprint.set(
        sid,
        [...keySet].map((k) => issueByKey.get(k)!).filter(Boolean),
      );
    }

    // Load all roadmap ideas once — filter per-sprint in memory
    const allIdeasForSprints = await this.loadAllIdeas();

    const results: RoadmapSprintAccuracy[] = [];
    for (const sprint of sprints) {
      const sprintIssues = issueListBySprint.get(sprint.id) ?? [];
      const inProgressStatusNames: string[] =
        boardConfig?.inProgressStatusNames ?? ['In Progress'];
      const accuracy = await this.calculateSprintAccuracy(
        sprint,
        sprintIssues,
        doneStatusNames,
        cancelledStatusNames,
        allIdeasForSprints,
        inProgressStatusNames,
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
        // null means in-flight (no done-transition yet) → always qualifies.
        // Non-null means completed at that timestamp; eligibility uses that date.
        const issueActivityEnd = completionDates.get(i.key) ?? null;
        return this.isIssueEligibleForRoadmapItem(issueActivityStart, issueActivityEnd, item);
      });
      const eligibleCoveredKeys = new Set(eligibleCoveredIssues.map((i) => i.key));

      const totalIssues = issues.length;
      const coveredCount = eligibleCoveredIssues.length;
      // Issues linked to any active idea but not covered (amber equivalent for Kanban)
      const linkedNotCoveredCount = issues.filter(
        (i) => i.epicKey !== null && activeIdeas.has(i.epicKey) && !eligibleCoveredKeys.has(i.key),
      ).length;
      const totalLinkedKanban = coveredCount + linkedNotCoveredCount;

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
        roadmapOnTimeRate:
          totalLinkedKanban > 0
            ? Math.round((coveredCount / totalLinkedKanban) * 10000) / 100
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
      //
      // Polaris interval fields store dates as date-only values (midnight UTC).
      // A sprint starting at e.g. 03:30 UTC on the same calendar day as an idea's
      // targetDate would incorrectly miss the overlap check because midnight < 03:30.
      // Extending targetDate to 23:59:59.999 UTC ensures a date-only targetDate
      // covers the full calendar day it represents.
      const ideaTargetEndOfDay = new Date(idea.targetDate.getTime());
      ideaTargetEndOfDay.setUTCHours(23, 59, 59, 999);
      if (ideaTargetEndOfDay < windowStart || idea.startDate > windowEnd) continue;

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
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const { year, month } = dateParts(date, tz);
    const q = Math.floor(month / 3) + 1;
    return `${year}-Q${q}`;
  }

  private dateToWeekKey(date: Date): string {
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const { year, month, day } = dateParts(date, tz);
    // Build a local-date proxy in the given timezone to compute ISO week
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
        // null means in-flight (no done-transition yet) → always qualifies.
        // Non-null means completed at that timestamp; eligibility uses that date.
        const issueActivityEnd = completionDatesWeekly.get(i.key) ?? null;
        return this.isIssueEligibleForRoadmapItem(issueActivityStart, issueActivityEnd, item);
      });
      const eligibleCoveredKeys = new Set(eligibleCoveredIssues.map((i) => i.key));

      const totalIssues = issues.length;
      const coveredCount = eligibleCoveredIssues.length;
      // Issues linked to any active idea but not covered (amber equivalent for Kanban weekly)
      const linkedNotCoveredCountWeekly = issues.filter(
        (i) => i.epicKey !== null && activeIdeas.has(i.epicKey) && !eligibleCoveredKeys.has(i.key),
      ).length;
      const totalLinkedWeekly = coveredCount + linkedNotCoveredCountWeekly;

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
        roadmapOnTimeRate:
          totalLinkedWeekly > 0
            ? Math.round((coveredCount / totalLinkedWeekly) * 10000) / 100
            : 0,
      });
    }

    return results;
  }

  private async calculateSprintAccuracy(
    sprint: JiraSprint,
    sprintIssues: JiraIssue[],
    doneStatusNames: string[],
    cancelledStatusNames: string[],
    allIdeas: JpdIdea[],
    inProgressStatusNames: string[], // accepted for API clarity; not used in core predicate
  ): Promise<RoadmapSprintAccuracy> {
    // Exclude Epics, Sub-tasks, and cancelled issues from all coverage metrics.
    // Cancelled issues are removed from both numerator and denominator so they
    // do not inflate the amber count or drag down the coverage percentage.
    const filteredIssues = sprintIssues.filter(
      (i) => isWorkItem(i.issueType) && !cancelledStatusNames.includes(i.status),
    );

    if (filteredIssues.length === 0) {
      return this.emptyAccuracy(sprint);
    }

    // Build epicKey → targetDate map scoped to the sprint window.
    // filterIdeasForWindow excludes ideas without both dates (decision 2)
    // and applies the date-window overlap filter. Conflict resolution: keep
    // the idea with the later targetDate.
    const sprintStart = sprint.startDate ?? new Date();
    const sprintEnd = sprint.endDate ?? new Date();
    const epicIdeaMap = this.filterIdeasForWindow(allIdeas, sprintStart, sprintEnd);

    // Query ALL done-status transitions for sprint issues — no date restriction
    // and no needsChangelogCheck split.  This ensures issues that were already
    // in Done status at sync time still get a reliable resolvedAt timestamp.
    const allFilteredKeys = filteredIssues.map((i) => i.key);
    const changelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allFilteredKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // completionDates: issueKey → first done-transition timestamp (all-time)
    const completionDates = new Map<string, Date>();
    for (const cl of changelogs) {
      if (cl.toValue !== null && doneStatusNames.includes(cl.toValue)) {
        if (!completionDates.has(cl.issueKey)) {
          completionDates.set(cl.issueKey, cl.changedAt);
        }
      }
    }

    // Per-issue delivery classification:
    //   in-scope (green)  = linked to an idea AND:
    //                         (a) resolvedAt <= idea.targetDate (end-of-day), OR
    //                         (b) in-flight in active sprint with targetDate not yet lapsed
    //   linked   (amber)  = linked to an idea AND neither (a) nor (b)
    //   none              = no roadmap link
    const coveredIssues: JiraIssue[] = [];
    const linkedNotCoveredIssues: JiraIssue[] = [];

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0); // start of today UTC

    for (const issue of filteredIssues) {
      if (issue.epicKey === null) continue;
      const idea = epicIdeaMap.get(issue.epicKey);
      if (!idea) continue;

      const targetEndOfDay = this.endOfDayUTC(idea.targetDate);
      const resolvedAt = completionDates.get(issue.key) ?? null;

      // Condition A: delivered on time
      const deliveredOnTime = resolvedAt !== null && resolvedAt <= targetEndOfDay;

      // Condition B: in-flight and on track
      const isInFlight =
        sprint.state === 'active' &&
        idea.targetDate >= today &&
        !doneStatusNames.includes(issue.status) &&
        !cancelledStatusNames.includes(issue.status);

      if (deliveredOnTime || isInFlight) {
        coveredIssues.push(issue);
      } else {
        linkedNotCoveredIssues.push(issue);
      }
    }

    // Compute metrics
    const totalIssues = filteredIssues.length;
    const coveredCount = coveredIssues.length;
    const uncoveredIssues = totalIssues - coveredCount;
    const roadmapCoverage =
      totalIssues > 0
        ? Math.round((coveredCount / totalIssues) * 10000) / 100
        : 0;

    // roadmapOnTimeRate = green ÷ (green + amber)
    const totalLinkedIssues = coveredCount + linkedNotCoveredIssues.length;
    const roadmapOnTimeRate =
      totalLinkedIssues > 0
        ? Math.round((coveredCount / totalLinkedIssues) * 10000) / 100
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
      roadmapOnTimeRate,
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
      roadmapOnTimeRate: 0,
    };
  }

  /**
   * Extend a date to 23:59:59.999 UTC (end of calendar day).
   * Polaris stores targetDate as a date-only value (midnight UTC); this
   * ensures a completion timestamp at any point during the target day
   * is considered on-time.
   */
  private endOfDayUTC(date: Date): Date {
    const d = new Date(date.getTime());
    d.setUTCHours(23, 59, 59, 999);
    return d;
  }

  private quarterToDates(quarter: string): { startDate: Date; endDate: Date } {
    const match = quarter.match(/^(\d{4})-Q([1-4])$/);
    if (!match) {
      throw new Error(`Invalid quarter format: ${quarter}. Expected YYYY-QN`);
    }
    const tz = this.configService.get<string>('TIMEZONE', 'UTC');
    const year = parseInt(match[1], 10);
    const q = parseInt(match[2], 10);
    const startMonth = (q - 1) * 3; // 0-indexed
    const startDate = midnightInTz(year, startMonth, 1, tz);
    // Last day of the quarter: month startMonth+3 day 0 = last day of month startMonth+2
    const endDate = midnightInTz(year, startMonth + 3, 0, tz);
    endDate.setUTCHours(23, 59, 59, 999);
    return { startDate, endDate };
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

  private emptyAccuracyForSprints(sprints: JiraSprint[]): RoadmapSprintAccuracy[] {
    return sprints.map((s) => this.emptyAccuracy(s));
  }
}

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Grace period matching PlanningService — absorbs Jira's bulk-add delay */
const ROADMAP_GRACE_PERIOD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `sprintName` appears as an exact token in a comma-separated
 * Sprint field value (prevents "Sprint 1" matching "Sprint 10").
 */
function sprintValueContainsName(
  value: string | null,
  sprintName: string,
): boolean {
  if (!value) return false;
  return value.split(',').some((s) => s.trim() === sprintName);
}

/**
 * Replay Sprint-field changelogs to determine whether an issue was in
 * `sprintName` at or just after `date` (using a 5-minute grace period).
 * Returns true for issues with no changelogs (assigned at creation).
 */
function wasInSprintByName(
  sprintChangelogs: { changedAt: Date; fromValue: string | null; toValue: string | null }[],
  sprintName: string,
  date: Date,
): boolean {
  const effectiveDate = new Date(date.getTime() + ROADMAP_GRACE_PERIOD_MS);
  let inSprint = false;

  for (const cl of sprintChangelogs) {
    if (cl.changedAt > effectiveDate) break;
    if (sprintValueContainsName(cl.toValue, sprintName)) {
      inSprint = true;
    }
    if (
      sprintValueContainsName(cl.fromValue, sprintName) &&
      !sprintValueContainsName(cl.toValue, sprintName)
    ) {
      inSprint = false;
    }
  }

  if (sprintChangelogs.length === 0) return true;
  return inSprint;
}
