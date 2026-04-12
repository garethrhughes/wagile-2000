import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraSprint,
  BoardConfig,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';

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
}
