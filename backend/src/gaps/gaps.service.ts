import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraSprint,
  BoardConfig,
  JiraChangelog,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';
import { quarterToDates } from '../metrics/period-utils.js';

export interface GapIssue {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  boardId: string;
  sprintId: string | null;
  sprintName: string | null;
  points: number | null;
  epicKey: string | null;
  jiraUrl: string;
}

export interface GapsResponse {
  noEpic: GapIssue[];
  noEstimate: GapIssue[];
}

export interface UnplannedDoneIssue {
  key: string;
  summary: string;
  issueType: string;
  boardId: string;
  resolvedAt: string;
  resolvedStatus: string;
  points: number | null;
  epicKey: string | null;
  priority: string | null;
  assignee: string | null;
  labels: string[];
  jiraUrl: string;
}

export interface UnplannedDoneSummary {
  total: number;
  totalPoints: number;
  byIssueType: Record<string, number>;
}

export interface UnplannedDoneResponse {
  boardId: string;
  window: { start: string; end: string };
  issues: UnplannedDoneIssue[];
  summary: UnplannedDoneSummary;
}

@Injectable()
export class GapsService {
  private readonly jiraBaseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
  ) {
    this.jiraBaseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
  }

  async getGaps(): Promise<GapsResponse> {
    // Step 1: board configs — done/cancelled status names and Kanban board IDs
    const configs = await this.boardConfigRepo.find();
    const doneByBoard = new Map<string, string[]>();
    const cancelledByBoard = new Map<string, string[]>();
    const kanbanBoardIds = new Set<string>();

    for (const cfg of configs) {
      doneByBoard.set(cfg.boardId, cfg.doneStatusNames ?? ['Done', 'Closed', 'Released']);
      cancelledByBoard.set(cfg.boardId, cfg.cancelledStatusNames ?? ['Cancelled', "Won't Do"]);
      if (cfg.boardType === 'kanban') kanbanBoardIds.add(cfg.boardId);
    }

    // Step 2: active sprints — eager load; used for the active-sprint gate AND
    // sprint name resolution (only active-sprint issues survive, so the name map
    // only needs entries for active sprints)
    const activeSprints = await this.sprintRepo.find({ where: { state: 'active' } });
    const activeSprintIds = new Set<string>(activeSprints.map((s) => s.id));
    const sprintNameMap = new Map<string, string>(activeSprints.map((s) => [s.id, s.name]));

    // Step 3: all work-item issues
    // Intentional: loads all issues across all boards for cross-board hygiene reporting.
    // Bounded dataset (single-user tool, ≤ ~5,000 rows). See proposal 0013 §Performance.
    const allIssues = (await this.issueRepo.find()).filter((i) =>
      isWorkItem(i.issueType),
    );

    // Build the Jira base URL from config
    const jiraBase = this.jiraBaseUrl;

    const noEpic: GapIssue[] = [];
    const noEstimate: GapIssue[] = [];

    for (const issue of allIssues) {
      // Step 4a: exclude done / cancelled (existing logic — unchanged)
      const done = doneByBoard.get(issue.boardId) ?? ['Done', 'Closed', 'Released'];
      const cancelled = cancelledByBoard.get(issue.boardId) ?? ['Cancelled'];
      if (done.includes(issue.status) || cancelled.includes(issue.status)) continue;

      // Steps 4b–c: active sprint gate — exclude backlog issues (null sprintId)
      // and issues assigned to closed or future sprints
      if (issue.sprintId === null || !activeSprintIds.has(issue.sprintId)) continue;

      const gap: GapIssue = {
        key: issue.key,
        summary: issue.summary,
        issueType: issue.issueType,
        status: issue.status,
        boardId: issue.boardId,
        sprintId: issue.sprintId,
        sprintName: sprintNameMap.get(issue.sprintId) ?? null,
        points: issue.points,
        epicKey: issue.epicKey,
        jiraUrl: jiraBase ? `${jiraBase}/browse/${issue.key}` : '',
      };

      // Step 4e: no-epic check — all board types
      if (issue.epicKey === null || issue.epicKey === '') noEpic.push(gap);

      // Step 4f: no-estimate check — Scrum boards only (Kanban boards excluded)
      if (issue.points === null && !kanbanBoardIds.has(issue.boardId)) noEstimate.push(gap);
    }

    // Step 6: sort both arrays by boardId ASC, then key ASC (deterministic)
    const byBoardThenKey = (a: GapIssue, b: GapIssue): number =>
      a.boardId.localeCompare(b.boardId) || a.key.localeCompare(b.key);

    noEpic.sort(byBoardThenKey);
    noEstimate.sort(byBoardThenKey);

    return { noEpic, noEstimate };
  }

  async getUnplannedDone(
    boardId: string,
    sprintId?: string,
    quarter?: string,
  ): Promise<UnplannedDoneResponse> {
    // Step 1: Load BoardConfig — throw for Kanban boards
    const config = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (config?.boardType === 'kanban') {
      throw new BadRequestException(
        'Unplanned done report is not available for Kanban boards',
      );
    }
    const doneStatusNames: string[] = config?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];

    // Step 2: Determine date window
    let windowStart: Date;
    let windowEnd: Date;

    if (sprintId) {
      const sprint = await this.sprintRepo.findOne({
        where: { id: sprintId, boardId },
      });
      if (!sprint) {
        throw new BadRequestException(
          `Sprint ${sprintId} not found for board ${boardId}`,
        );
      }
      windowStart = sprint.startDate ?? new Date(0);
      windowEnd = sprint.endDate ?? new Date();
    } else if (quarter) {
      const { startDate, endDate } = quarterToDates(quarter);
      windowStart = startDate;
      windowEnd = endDate;
    } else {
      // Fallback: last 90 days
      windowEnd = new Date();
      windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - 90);
    }

    // Step 3: Load all work-item issues for this board
    const allIssues = (
      await this.issueRepo.find({ where: { boardId } })
    ).filter((i) => isWorkItem(i.issueType));

    if (allIssues.length === 0) {
      return this.buildResponse(boardId, windowStart, windowEnd, []);
    }

    const allKeys = allIssues.map((i) => i.key);

    // Step 4: Bulk-load status-field changelogs for all issues
    const statusChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Step 5: Bulk-load Sprint-field changelogs for all issues
    const sprintChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allKeys })
      .andWhere('cl.field = :field', { field: 'Sprint' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group changelogs by issue key for O(1) lookups
    const statusLogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of statusChangelogs) {
      const list = statusLogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      statusLogsByIssue.set(cl.issueKey, list);
    }

    const sprintLogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of sprintChangelogs) {
      const list = sprintLogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      sprintLogsByIssue.set(cl.issueKey, list);
    }

    const jiraBase = this.jiraBaseUrl;
    const unplannedIssues: UnplannedDoneIssue[] = [];

    // Step 6: Classify each issue
    for (const issue of allIssues) {
      // Step 6a: Find resolvedAt — first status changelog where toValue ∈ doneStatusNames
      //          AND changedAt is within [windowStart, windowEnd]
      const statusLogs = statusLogsByIssue.get(issue.key) ?? [];
      let resolvedAt: Date | null = null;
      let resolvedStatus: string | null = null;

      for (const cl of statusLogs) {
        if (
          cl.toValue !== null &&
          doneStatusNames.includes(cl.toValue) &&
          cl.changedAt >= windowStart &&
          cl.changedAt <= windowEnd
        ) {
          resolvedAt = cl.changedAt;
          resolvedStatus = cl.toValue;
          break; // first within-window done transition
        }
      }

      // Fallback: no status changelog, current status is done, createdAt in window
      if (resolvedAt === null) {
        if (
          doneStatusNames.includes(issue.status) &&
          issue.createdAt >= windowStart &&
          issue.createdAt <= windowEnd
        ) {
          resolvedAt = issue.createdAt;
          resolvedStatus = issue.status;
        } else {
          continue; // skip — no resolution within window
        }
      }

      // Step 6b: Replay Sprint-field changelogs up to resolvedAt
      const sprintLogs = sprintLogsByIssue.get(issue.key) ?? [];
      let inSprint = false;

      for (const cl of sprintLogs) {
        if (cl.changedAt > resolvedAt) break;

        // Presence-only check — we care whether the issue was in *any* sprint,
        // not a specific one. No need for the exact-name sprintValueContains()
        // helper used elsewhere (which guards against "Sprint 1" matching
        // "Sprint 10"). A non-empty toValue means the issue entered some sprint;
        // an empty toValue after a non-empty fromValue means it left all sprints.
        if (cl.toValue !== null && cl.toValue.trim() !== '') {
          inSprint = true;
        }
        if (
          (cl.fromValue !== null && cl.fromValue.trim() !== '') &&
          (cl.toValue === null || cl.toValue.trim() === '')
        ) {
          inSprint = false;
        }
      }

      // Step 6c: Fall back to snapshot sprintId for issues created directly
      // into a sprint via the Jira UI. Jira only records a Sprint changelog
      // when an issue *moves between* sprint states; an issue placed into a
      // sprint at creation has no Sprint changelog at all. If there are no
      // sprint changelogs and the snapshot sprintId is non-null the issue was
      // in a sprint at creation and should be treated as planned.
      // (Mirrors the wasInSprintAtDate fallback in sprint-detail.service.ts.)
      if (sprintLogs.length === 0 && issue.sprintId !== null) {
        inSprint = true;
      }

      // Step 6d: Skip if in sprint at resolution time (planned completion)
      if (inSprint) continue;

      // Step 6d: Classify as unplanned done
      // resolvedStatus is always non-null here: the continue guards above
      // ensure we only reach this point when resolvedStatus was assigned.
      unplannedIssues.push({
        key: issue.key,
        summary: issue.summary,
        issueType: issue.issueType,
        boardId: issue.boardId,
        resolvedAt: resolvedAt.toISOString(),
        resolvedStatus: resolvedStatus as string,
        points: issue.points,
        epicKey: issue.epicKey,
        priority: issue.priority,
        assignee: issue.assignee,
        labels: issue.labels,
        jiraUrl: jiraBase ? `${jiraBase}/browse/${issue.key}` : '',
      });
    }

    // Step 8: Sort by resolvedAt DESC, then key ASC for ties
    unplannedIssues.sort((a, b) => {
      const timeDiff = new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.key.localeCompare(b.key);
    });

    return this.buildResponse(boardId, windowStart, windowEnd, unplannedIssues);
  }

  private buildResponse(
    boardId: string,
    windowStart: Date,
    windowEnd: Date,
    issues: UnplannedDoneIssue[],
  ): UnplannedDoneResponse {
    const totalPoints = issues.reduce((acc, i) => acc + (i.points ?? 0), 0);
    const byIssueType: Record<string, number> = {};
    for (const issue of issues) {
      byIssueType[issue.issueType] = (byIssueType[issue.issueType] ?? 0) + 1;
    }

    return {
      boardId,
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      },
      issues,
      summary: {
        total: issues.length,
        totalPoints,
        byIssueType,
      },
    };
  }
}
