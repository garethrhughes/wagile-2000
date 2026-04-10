import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';

export interface SprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  commitment: number;
  added: number;
  removed: number;
  completed: number;
  scopeChangePercent: number;
  completionRate: number;
}

export interface QuarterInfo {
  quarter: string;
  startDate: string;
  endDate: string;
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
      sprints = await this.sprintRepo.find({
        where: { boardId, state: 'closed' },
        order: { startDate: 'DESC' },
        take: 10,
      });
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
    const boardIssues = await this.issueRepo.find({
      where: { boardId: sprint.boardId },
    });

    if (boardIssues.length === 0) {
      return this.emptyAccuracy(sprint);
    }

    const allKeys = boardIssues.map((i) => i.key);
    const issueStatusMap = new Map(
      boardIssues.map((i) => [i.key, i.status]),
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
    const committedKeys = new Set<string>();
    const addedKeys = new Set<string>();
    const removedKeys = new Set<string>();

    for (const [issueKey, logs] of logsByIssue) {
      const wasAtStart = this.wasInSprintAtDate(
        logs,
        sprintName,
        sprintStart,
      );

      // Track final sprint membership after sprint start
      let inSprint = wasAtStart;
      for (const cl of logs) {
        if (cl.changedAt <= sprintStart) continue;
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

      if (wasAtStart) {
        committedKeys.add(issueKey);
        if (!inSprint) {
          removedKeys.add(issueKey);
        }
      } else {
        // Was it ever added to this sprint after the start?
        const addedAfterStart = logs.some(
          (cl) =>
            cl.changedAt > sprintStart &&
            this.sprintValueContains(cl.toValue, sprintName),
        );
        if (addedAfterStart) {
          addedKeys.add(issueKey);
          if (!inSprint) {
            removedKeys.add(issueKey);
          }
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

    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      commitment,
      added,
      removed,
      completed,
      scopeChangePercent,
      completionRate,
    };
  }

  /**
   * Check if an issue was in the sprint at the given date by
   * replaying Sprint-field changelogs.
   */
  private wasInSprintAtDate(
    sprintChangelogs: JiraChangelog[],
    sprintName: string,
    date: Date,
  ): boolean {
    let inSprint = false;

    for (const cl of sprintChangelogs) {
      if (cl.changedAt > date) break;

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

  private emptyAccuracy(sprint: JiraSprint): SprintAccuracy {
    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      commitment: 0,
      added: 0,
      removed: 0,
      completed: 0,
      scopeChangePercent: 0,
      completionRate: 0,
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

    const quarters = new Map<string, QuarterInfo>();

    for (const sprint of sprints) {
      if (!sprint.startDate) continue;
      const d = sprint.startDate;
      const q = Math.floor(d.getMonth() / 3) + 1;
      const year = d.getFullYear();
      const key = `${year}-Q${q}`;

      if (!quarters.has(key)) {
        const startMonth = (q - 1) * 3;
        const startDate = new Date(year, startMonth, 1);
        const endDate = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
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

    const year = parseInt(match[1], 10);
    const q = parseInt(match[2], 10);
    const startMonth = (q - 1) * 3;

    return {
      startDate: new Date(year, startMonth, 1),
      endDate: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
    };
  }
}
