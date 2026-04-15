import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
  JiraIssueLink,
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';

// ---------------------------------------------------------------------------
// Response interfaces (exported for use by the controller and frontend types)
// ---------------------------------------------------------------------------

export interface WeekDetailIssue {
  /** Jira issue key, e.g. "ACC-123" */
  key: string;

  /** Issue summary / title */
  summary: string;

  /** Jira issue type, e.g. "Story", "Bug", "Task" */
  issueType: string;

  /** Issue priority, or null if not set */
  priority: string | null;

  /** Current status at time of last sync */
  status: string;

  /** Story points, or null if not set */
  points: number | null;

  /** Epic key, or null if not set */
  epicKey: string | null;

  /** The week this issue was assigned to, e.g. "2026-W15" */
  assignedWeek: string;

  /** True if the issue transitioned to a done status within the week window */
  completedInWeek: boolean;

  /** True if the issue's board-entry date is > 1 day after week start */
  addedMidWeek: boolean;

  /** True if the issue's epicKey is a member of the coveredEpicKeys set */
  linkedToRoadmap: boolean;

  /** True if the issue matches incidentIssueTypes OR incidentLabels */
  isIncident: boolean;

  /** True if the issue matches failureIssueTypes OR failureLabels */
  isFailure: boolean;

  /** Labels attached to the issue */
  labels: string[];

  /** ISO 8601 timestamp of when the issue entered the board */
  boardEntryDate: string;

  /** Deep link to the issue in Jira Cloud, or empty string if not configured */
  jiraUrl: string;
}

export interface WeekDetailSummary {
  totalIssues: number;
  completedIssues: number;
  addedMidWeek: number;
  linkedToRoadmap: number;
  totalPoints: number;
  completedPoints: number;
}

export interface WeekDetailBoardConfig {
  boardType: string;
  doneStatusNames: string[];
}

export interface WeekDetailResponse {
  boardId: string;
  week: string;
  weekStart: string;
  weekEnd: string;
  summary: WeekDetailSummary;
  issues: WeekDetailIssue[];
  boardConfig: WeekDetailBoardConfig;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class WeekDetailService {
  private readonly logger = new Logger(WeekDetailService.name);
  private readonly jiraBaseUrl: string;

  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
    @InjectRepository(JpdIdea)
    private readonly jpdIdeaRepo: Repository<JpdIdea>,
    @InjectRepository(JiraIssueLink)
    private readonly issueLinkRepo: Repository<JiraIssueLink>,
    private readonly configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
    if (!baseUrl) {
      this.logger.warn(
        'JIRA_BASE_URL is not configured — jiraUrl fields will be empty strings',
      );
    }
    this.jiraBaseUrl = baseUrl;
  }

  async getDetail(
    boardId: string,
    week: string,
  ): Promise<WeekDetailResponse> {
    // -----------------------------------------------------------------------
    // Step 1 — Parse week to date range
    // -----------------------------------------------------------------------
    const { weekStart, weekEnd } = this.parseWeek(week);

    // -----------------------------------------------------------------------
    // Step 2 — Load board config
    // -----------------------------------------------------------------------
    const boardConfig = await this.boardConfigRepo.findOne({ where: { boardId } });
    const boardType: string = boardConfig?.boardType ?? 'scrum';

    // Week detail is only available for Kanban boards
    if (boardType !== 'kanban') {
      throw new BadRequestException(
        'Week detail is only available for Kanban boards',
      );
    }

    const doneStatuses: string[] = boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const incidentIssueTypes: string[] = boardConfig?.incidentIssueTypes ?? ['Bug', 'Incident'];
    const incidentLabels: string[] = boardConfig?.incidentLabels ?? [];
    const incidentPriorities: string[] = boardConfig?.incidentPriorities ?? ['Critical'];
    const failureIssueTypes: string[] = boardConfig?.failureIssueTypes ?? ['Bug', 'Incident'];
    const failureLabels: string[] = boardConfig?.failureLabels ?? ['regression', 'incident', 'hotfix'];
    const failureLinkTypes: string[] = boardConfig?.failureLinkTypes ?? [];
    const backlogStatusIds: string[] = boardConfig?.backlogStatusIds ?? [];

    // -----------------------------------------------------------------------
    // Step 3 — Load all issues for board
    // -----------------------------------------------------------------------
    const issues = (await this.issueRepo.find({ where: { boardId } }))
      .filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) {
      return this.buildEmptyResponse(boardId, week, weekStart, weekEnd, boardType, doneStatuses);
    }

    const allKeys = issues.map((i) => i.key);

    // -----------------------------------------------------------------------
    // Step 4 — Load all changelogs for those issues
    // -----------------------------------------------------------------------
    const allChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allKeys })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group changelogs by issueKey
    const changelogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of allChangelogs) {
      const list = changelogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      changelogsByIssue.set(cl.issueKey, list);
    }

    // Build set of issue keys that have any status changelog (backlog fallback)
    const issueKeysWithStatusChangelog = new Set<string>();
    for (const cl of allChangelogs) {
      if (cl.field === 'status') issueKeysWithStatusChangelog.add(cl.issueKey);
    }

    // -----------------------------------------------------------------------
    // Step 5 — Compute board-entry date per issue and exclude backlog items
    //          (Kanban only: earliest status changelog where fromValue = 'To Do')
    // -----------------------------------------------------------------------
    const boardEntryDateByKey = new Map<string, Date>();

    for (const issue of issues) {
      const issueChangelogs = changelogsByIssue.get(issue.key) ?? [];

      const toDoTransition = issueChangelogs.find(
        (cl) => cl.field === 'status' && cl.fromValue === 'To Do',
      );
      const entryDate = toDoTransition ? toDoTransition.changedAt : issue.createdAt;

      boardEntryDateByKey.set(issue.key, entryDate);
    }

    // Exclude pure-backlog issues (never pulled onto the board).
    // Primary: statusId is in backlogStatusIds. Fallback: no status changelog at all.
    const filteredIssues = issues.filter((issue) => {
      if (backlogStatusIds.length > 0 && issue.statusId !== null) {
        return !backlogStatusIds.includes(issue.statusId);
      }
      return issueKeysWithStatusChangelog.has(issue.key);
    });

    // Apply dataStartDate lower bound filter (before the week window filter)
    const dataStartDate = boardConfig?.dataStartDate ?? null;
    const startBound = dataStartDate ? new Date(dataStartDate) : null;
    const startBoundedIssues = startBound
      ? filteredIssues.filter((issue) => {
          const entryDate = boardEntryDateByKey.get(issue.key);
          return entryDate !== undefined && entryDate >= startBound;
        })
      : filteredIssues;

    // -----------------------------------------------------------------------
    // Step 6 — Filter issues to those whose boardEntryDate falls within the week
    // -----------------------------------------------------------------------
    const weekIssues = startBoundedIssues.filter((issue) => {
      const entryDate = boardEntryDateByKey.get(issue.key);
      if (!entryDate) return false;
      return entryDate >= weekStart && entryDate <= weekEnd;
    });

    if (weekIssues.length === 0) {
      return this.buildEmptyResponse(boardId, week, weekStart, weekEnd, boardType, doneStatuses);
    }

    // -----------------------------------------------------------------------
    // Step 6b — failureLinkTypes AND-gate: bulk causal-link query
    //
    // When failureLinkTypes is non-empty, only issues with a matching causal
    // link (e.g. 'caused by') are classified as failures.  When
    // failureLinkTypes is empty (the default), all type/label matches qualify.
    // See Proposal 0032.
    // -----------------------------------------------------------------------
    const weekIssueKeys = weekIssues.map((i) => i.key);
    let keysWithCausalLink = new Set<string>();
    if (failureLinkTypes.length > 0) {
      const linkRows = await this.issueLinkRepo
        .createQueryBuilder('l')
        .select('l.sourceIssueKey', 'key')
        .where('l.sourceIssueKey IN (:...keys)', { keys: weekIssueKeys })
        .andWhere('LOWER(l.linkTypeName) IN (:...types)', {
          types: failureLinkTypes.map((t) => t.toLowerCase()),
        })
        .getRawMany<{ key: string }>();
      keysWithCausalLink = new Set(linkRows.map((r) => r.key));
    }

    // -----------------------------------------------------------------------
    // Step 7 — Load RoadmapConfig and build coveredEpicKeys
    // -----------------------------------------------------------------------
    const roadmapConfigs = await this.roadmapConfigRepo.find({ where: {} });
    const coveredEpicKeys = new Set<string>();

    if (roadmapConfigs.length > 0) {
      const jpdKeys = roadmapConfigs.map((r) => r.jpdKey);
      const ideas = await this.jpdIdeaRepo.find({ where: { jpdKey: In(jpdKeys) } });
      for (const idea of ideas) {
        for (const key of (idea.deliveryIssueKeys ?? [])) {
          if (key) {
            coveredEpicKeys.add(key);
          }
        }
      }
    }

    // 1-day grace period for addedMidWeek
    const gracePeriodEnd = new Date(weekStart.getTime() + 1 * 24 * 60 * 60 * 1000);

    // -----------------------------------------------------------------------
    // Step 8 — Build per-issue result
    // -----------------------------------------------------------------------
    const results: WeekDetailIssue[] = [];

    for (const issue of weekIssues) {
      const issueChangelogs = changelogsByIssue.get(issue.key) ?? [];
      const boardEntryDate = boardEntryDateByKey.get(issue.key) ?? issue.createdAt;

      // completedInWeek: has a status transition to a done status within the week window
      const completedInWeek = issueChangelogs.some(
        (cl) =>
          cl.field === 'status' &&
          cl.toValue !== null &&
          doneStatuses.includes(cl.toValue) &&
          cl.changedAt >= weekStart &&
          cl.changedAt <= weekEnd,
      );

      // addedMidWeek: boardEntryDate is > 1 day after week start
      const addedMidWeek = boardEntryDate > gracePeriodEnd;

      // linkedToRoadmap
      const linkedToRoadmap =
        issue.epicKey != null && coveredEpicKeys.has(issue.epicKey);

      // isIncident: must match type/label AND pass priority AND-gate
      // (consistent with MttrService; incidentPriorities = [] means all priorities qualify)
      const matchesIncidentTypeOrLabel =
        incidentIssueTypes.includes(issue.issueType) ||
        (incidentLabels.length > 0 && issue.labels.some((l) => incidentLabels.includes(l)));
      const isIncident =
        matchesIncidentTypeOrLabel &&
        (incidentPriorities.length === 0 ||
          incidentPriorities.includes(issue.priority ?? ''));

      // isFailure: must pass type/label gate AND (if failureLinkTypes configured)
      // the causal-link AND-gate.  See Proposal 0032.
      const passesTypeGate =
        failureIssueTypes.includes(issue.issueType) ||
        (failureLabels.length > 0 && issue.labels.some((l) => failureLabels.includes(l)));
      const passesLinkGate =
        failureLinkTypes.length === 0 || keysWithCausalLink.has(issue.key);
      const isFailure = passesTypeGate && passesLinkGate;

      // jiraUrl
      const jiraUrl = this.jiraBaseUrl
        ? `${this.jiraBaseUrl}/browse/${issue.key}`
        : '';

      results.push({
        key: issue.key,
        summary: issue.summary,
        issueType: issue.issueType,
        priority: issue.priority,
        status: issue.status,
        points: issue.points,
        epicKey: issue.epicKey,
        assignedWeek: week,
        completedInWeek,
        addedMidWeek,
        linkedToRoadmap,
        isIncident,
        isFailure,
        labels: issue.labels,
        boardEntryDate: boardEntryDate.toISOString(),
        jiraUrl,
      });
    }

    // Sort: incomplete issues first (alphabetical by key), then completed
    results.sort((a, b) => {
      if (a.completedInWeek !== b.completedInWeek) {
        return a.completedInWeek ? 1 : -1;
      }
      return a.key.localeCompare(b.key);
    });

    // -----------------------------------------------------------------------
    // Step 9 — Build summary
    // -----------------------------------------------------------------------
    const summary: WeekDetailSummary = {
      totalIssues: weekIssues.length,
      completedIssues: results.filter((r) => r.completedInWeek).length,
      addedMidWeek: results.filter((r) => r.addedMidWeek).length,
      linkedToRoadmap: results.filter((r) => r.linkedToRoadmap).length,
      totalPoints: results.reduce((s, r) => s + (r.points ?? 0), 0),
      completedPoints: results
        .filter((r) => r.completedInWeek)
        .reduce((s, r) => s + (r.points ?? 0), 0),
    };

    // -----------------------------------------------------------------------
    // Step 10 — Return response
    // -----------------------------------------------------------------------
    return {
      boardId,
      week,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      summary,
      issues: results,
      boardConfig: {
        boardType,
        doneStatusNames: doneStatuses,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private parseWeek(week: string): { weekStart: Date; weekEnd: Date } {
    const match = week.match(/^(\d{4})-W(\d{2})$/);
    if (!match) {
      throw new BadRequestException(
        `Invalid week format: "${week}". Expected YYYY-Www e.g. 2026-W15`,
      );
    }

    const year = parseInt(match[1], 10);
    const weekNum = parseInt(match[2], 10);

    // Jan 4 is always in ISO week 1
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay(); // 0=Sun, 1=Mon, ...
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

  private buildEmptyResponse(
    boardId: string,
    week: string,
    weekStart: Date,
    weekEnd: Date,
    boardType: string,
    doneStatusNames: string[],
  ): WeekDetailResponse {
    return {
      boardId,
      week,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      summary: {
        totalIssues: 0,
        completedIssues: 0,
        addedMidWeek: 0,
        linkedToRoadmap: 0,
        totalPoints: 0,
        completedPoints: 0,
      },
      issues: [],
      boardConfig: {
        boardType,
        doneStatusNames,
      },
    };
  }
}
