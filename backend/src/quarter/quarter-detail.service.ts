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
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';

// ---------------------------------------------------------------------------
// Response interfaces (exported for use by the controller and frontend types)
// ---------------------------------------------------------------------------

export interface QuarterDetailIssue {
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

  /** The quarter this issue was assigned to, e.g. "2025-Q2" */
  assignedQuarter: string;

  /** True if the issue transitioned to a done status within the quarter window */
  completedInQuarter: boolean;

  /** True if the issue's board-entry date is strictly after quarter start */
  addedMidQuarter: boolean;

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

export interface QuarterDetailSummary {
  totalIssues: number;
  completedIssues: number;
  addedMidQuarter: number;
  linkedToRoadmap: number;
  totalPoints: number;
  completedPoints: number;
}

export interface QuarterDetailBoardConfig {
  boardType: string;
  doneStatusNames: string[];
}

export interface QuarterDetailResponse {
  boardId: string;
  quarter: string;
  quarterStart: string;
  quarterEnd: string;
  summary: QuarterDetailSummary;
  issues: QuarterDetailIssue[];
  boardConfig: QuarterDetailBoardConfig;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class QuarterDetailService {
  private readonly logger = new Logger(QuarterDetailService.name);
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
    quarter: string,
  ): Promise<QuarterDetailResponse> {
    // -----------------------------------------------------------------------
    // Step 1 — Parse quarter to date range
    // -----------------------------------------------------------------------
    const { quarterStart, quarterEnd } = this.parseQuarter(quarter);

    // -----------------------------------------------------------------------
    // Step 2 — Load board config
    // -----------------------------------------------------------------------
    const boardConfig = await this.boardConfigRepo.findOne({ where: { boardId } });
    const doneStatuses: string[] = boardConfig?.doneStatusNames ?? ['Done', 'Closed', 'Released'];
    const incidentIssueTypes: string[] = boardConfig?.incidentIssueTypes ?? ['Bug', 'Incident'];
    const incidentLabels: string[] = boardConfig?.incidentLabels ?? [];
    const failureIssueTypes: string[] = boardConfig?.failureIssueTypes ?? ['Bug', 'Incident'];
    const failureLabels: string[] = boardConfig?.failureLabels ?? ['regression', 'incident', 'hotfix'];
    const boardType: string = boardConfig?.boardType ?? 'scrum';
    const backlogStatusIds: string[] = boardConfig?.backlogStatusIds ?? [];

    // -----------------------------------------------------------------------
    // Step 3 — Load all issues for board
    // -----------------------------------------------------------------------
    const issues = (await this.issueRepo.find({ where: { boardId } }))
      .filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) {
      return this.buildEmptyResponse(boardId, quarter, quarterStart, quarterEnd, boardType, doneStatuses);
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
    // -----------------------------------------------------------------------
    const boardEntryDateByKey = new Map<string, Date>();

    for (const issue of issues) {
      const issueChangelogs = changelogsByIssue.get(issue.key) ?? [];

      let entryDate: Date;

      if (boardType === 'kanban') {
        // Kanban: earliest status changelog where fromValue = 'To Do'
        const toDoTransition = issueChangelogs.find(
          (cl) => cl.field === 'status' && cl.fromValue === 'To Do',
        );
        entryDate = toDoTransition ? toDoTransition.changedAt : issue.createdAt;
      } else {
        // Scrum: earliest Sprint changelog
        const sprintTransition = issueChangelogs.find(
          (cl) => cl.field === 'Sprint',
        );
        entryDate = sprintTransition ? sprintTransition.changedAt : issue.createdAt;
      }

      boardEntryDateByKey.set(issue.key, entryDate);
    }

    // For Kanban boards, exclude pure-backlog issues (never pulled onto the board).
    // Primary: statusId is in backlogStatusIds. Fallback: no status changelog at all.
    const filteredIssues = boardType === 'kanban'
      ? issues.filter((issue) => {
          if (backlogStatusIds.length > 0 && issue.statusId !== null) {
            return !backlogStatusIds.includes(issue.statusId);
          }
          return issueKeysWithStatusChangelog.has(issue.key);
        })
      : issues;

    // Apply dataStartDate lower bound filter for Kanban boards (before the quarter window filter)
    const dataStartDate = boardConfig?.dataStartDate ?? null;
    const startBound = boardType === 'kanban' && dataStartDate ? new Date(dataStartDate) : null;
    const startBoundedIssues = startBound
      ? filteredIssues.filter((issue) => {
          const entryDate = boardEntryDateByKey.get(issue.key);
          return entryDate !== undefined && entryDate >= startBound;
        })
      : filteredIssues;

    // -----------------------------------------------------------------------
    // Step 6 — Filter issues to those whose boardEntryDate falls within the quarter
    // -----------------------------------------------------------------------
    const quarterIssues = startBoundedIssues.filter((issue) => {
      const entryDate = boardEntryDateByKey.get(issue.key);
      if (!entryDate) return false;
      return entryDate >= quarterStart && entryDate <= quarterEnd;
    });

    if (quarterIssues.length === 0) {
      return this.buildEmptyResponse(boardId, quarter, quarterStart, quarterEnd, boardType, doneStatuses);
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

    // -----------------------------------------------------------------------
    // Step 8 — Build per-issue result
    // -----------------------------------------------------------------------
    const results: QuarterDetailIssue[] = [];

    for (const issue of quarterIssues) {
      const issueChangelogs = changelogsByIssue.get(issue.key) ?? [];
      const boardEntryDate = boardEntryDateByKey.get(issue.key) ?? issue.createdAt;

      // completedInQuarter: has a status transition to a done status within the quarter
      const completedInQuarter = issueChangelogs.some(
        (cl) =>
          cl.field === 'status' &&
          cl.toValue !== null &&
          doneStatuses.includes(cl.toValue) &&
          cl.changedAt >= quarterStart &&
          cl.changedAt <= quarterEnd,
      );

      // addedMidQuarter: boardEntryDate is strictly after quarterStart
      const addedMidQuarter = boardEntryDate > quarterStart;

      // linkedToRoadmap
      const linkedToRoadmap =
        issue.epicKey != null && coveredEpicKeys.has(issue.epicKey);

      // isIncident: must match type/label AND be Critical priority
      const matchesIncidentTypeOrLabel =
        incidentIssueTypes.includes(issue.issueType) ||
        (incidentLabels.length > 0 && issue.labels.some((l) => incidentLabels.includes(l)));
      const isIncident = matchesIncidentTypeOrLabel && issue.priority === 'Critical';

      // isFailure
      const isFailure =
        failureIssueTypes.includes(issue.issueType) ||
        (failureLabels.length > 0 && issue.labels.some((l) => failureLabels.includes(l)));

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
        assignedQuarter: quarter,
        completedInQuarter,
        addedMidQuarter,
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
      if (a.completedInQuarter !== b.completedInQuarter) {
        return a.completedInQuarter ? 1 : -1;
      }
      return a.key.localeCompare(b.key);
    });

    // -----------------------------------------------------------------------
    // Step 9 — Build summary
    // -----------------------------------------------------------------------
    const summary: QuarterDetailSummary = {
      totalIssues: quarterIssues.length,
      completedIssues: results.filter((r) => r.completedInQuarter).length,
      addedMidQuarter: results.filter((r) => r.addedMidQuarter).length,
      linkedToRoadmap: results.filter((r) => r.linkedToRoadmap).length,
      totalPoints: results.reduce((s, r) => s + (r.points ?? 0), 0),
      completedPoints: results
        .filter((r) => r.completedInQuarter)
        .reduce((s, r) => s + (r.points ?? 0), 0),
    };

    // -----------------------------------------------------------------------
    // Step 10 — Return response
    // -----------------------------------------------------------------------
    return {
      boardId,
      quarter,
      quarterStart: quarterStart.toISOString(),
      quarterEnd: quarterEnd.toISOString(),
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

  private parseQuarter(quarter: string): { quarterStart: Date; quarterEnd: Date } {
    const match = quarter.match(/^(\d{4})-Q([1-4])$/);
    if (!match) {
      throw new BadRequestException(
        `Invalid quarter format: "${quarter}". Expected YYYY-QN e.g. 2025-Q2`,
      );
    }

    const year = parseInt(match[1], 10);
    const q = parseInt(match[2], 10);
    const startMonth = (q - 1) * 3;

    const quarterStart = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
    const quarterEnd = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));

    return { quarterStart, quarterEnd };
  }

  private buildEmptyResponse(
    boardId: string,
    quarter: string,
    quarterStart: Date,
    quarterEnd: Date,
    boardType: string,
    doneStatusNames: string[],
  ): QuarterDetailResponse {
    return {
      boardId,
      quarter,
      quarterStart: quarterStart.toISOString(),
      quarterEnd: quarterEnd.toISOString(),
      summary: {
        totalIssues: 0,
        completedIssues: 0,
        addedMidQuarter: 0,
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
