import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SprintDetailService } from './sprint-detail.service.js';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  BoardConfig,
  JpdIdea,
  RoadmapConfig,
  JiraIssueLink,
} from '../database/entities/index.js';
import { WorkingTimeService } from '../metrics/working-time.service.js';

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

function mockConfigService(jiraBaseUrl = ''): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockReturnValue(jiraBaseUrl),
  } as unknown as jest.Mocked<ConfigService>;
}

function makeQb(changelogs: object[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(changelogs),
  };
}

const SPRINT: JiraSprint = {
  id: 'sprint-1',
  boardId: 'ACC',
  name: 'Sprint 1',
  state: 'active',
  startDate: new Date('2026-01-05T00:00:00Z'),
  endDate: new Date('2026-01-19T00:00:00Z'),
  goal: '',
} as JiraSprint;

function mockWorkingTimeService(): jest.Mocked<WorkingTimeService> {
  return {
    getConfig: jest.fn().mockResolvedValue({
      id: 1, excludeWeekends: false, workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
    }),
    toConfig: jest.fn().mockReturnValue({
      timezone: 'UTC', workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
    }),
    workingDaysBetween: jest.fn(),
    workingHoursBetween: jest.fn(),
  } as unknown as jest.Mocked<WorkingTimeService>;
}

describe('SprintDetailService', () => {
  let service: SprintDetailService;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let jpdIdeaRepo: jest.Mocked<Repository<JpdIdea>>;
  let roadmapConfigRepo: jest.Mocked<Repository<RoadmapConfig>>;
  let issueLinkRepo: jest.Mocked<Repository<JiraIssueLink>>;
  let workingTimeService: jest.Mocked<WorkingTimeService>;

  beforeEach(() => {
    sprintRepo = mockRepo<JiraSprint>();
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();
    jpdIdeaRepo = mockRepo<JpdIdea>();
    roadmapConfigRepo = mockRepo<RoadmapConfig>();
    issueLinkRepo = mockRepo<JiraIssueLink>();
    workingTimeService = mockWorkingTimeService();

    service = new SprintDetailService(
      sprintRepo,
      issueRepo,
      changelogRepo,
      boardConfigRepo,
      jpdIdeaRepo,
      roadmapConfigRepo,
      issueLinkRepo,
      mockConfigService(),
      workingTimeService,
    );
  });

  // ---------------------------------------------------------------------------
  // Not found / Kanban guard
  // ---------------------------------------------------------------------------

  it('throws NotFoundException when sprint does not exist', async () => {
    sprintRepo.findOne.mockResolvedValue(null);

    await expect(service.getDetail('ACC', 'missing-sprint')).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException for Kanban boards', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    await expect(service.getDetail('ACC', 'sprint-1')).rejects.toThrow(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // Empty board (no issues)
  // ---------------------------------------------------------------------------

  it('returns empty response when board has no issues', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue(null);
    issueRepo.find.mockResolvedValue([]);
    roadmapConfigRepo.find.mockResolvedValue([]);
    // changelogRepo not called

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.sprintId).toBe('sprint-1');
    expect(result.issues).toHaveLength(0);
    expect(result.summary.committedCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Basic happy path
  // ---------------------------------------------------------------------------

  it('returns sprint detail with committed and completed issue', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'A feature',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      // First call: Sprint changelogs (assigned before sprint start)
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'), // before sprint start
          },
        ]);
      }
      // Second call: status changelogs for final sprint issues
      return makeQb([
        {
          issueKey: 'ACC-1',
          field: 'status',
          toValue: 'In Progress',
          changedAt: new Date('2026-01-05T10:00:00Z'),
        },
        {
          issueKey: 'ACC-1',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2026-01-10T10:00:00Z'),
        },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.sprintId).toBe('sprint-1');
    expect(result.sprintName).toBe('Sprint 1');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].key).toBe('ACC-1');
    expect(result.issues[0].completedInSprint).toBe(true);
    expect(result.summary.completedInSprintCount).toBe(1);
    expect(result.summary.committedCount).toBe(1);
    expect(result.summary.addedMidSprintCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Cancelled status handling including "Won't Do"
  // ---------------------------------------------------------------------------

  it('sets roadmapStatus to "none" for cancelled issues', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Cancelled issue',
        status: 'Cancelled',
        sprintId: 'sprint-1',
        epicKey: 'ACC-0', // has epic link but is cancelled
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('none');
  });

  it('sets roadmapStatus to "none" for "Won\'t Do" issues', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: "Won't do issue",
        status: "Won't Do",
        sprintId: 'sprint-1',
        epicKey: 'ACC-0',
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('none');
  });

  // ---------------------------------------------------------------------------
  // Default cancelledStatusNames fallback
  // ---------------------------------------------------------------------------

  it('uses default cancelled status ["Cancelled", "Won\'t Do"] when board config not found', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue(null); // no config
    roadmapConfigRepo.find.mockResolvedValue([]);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Issue with default cancelled check',
        status: "Won't Do",
        sprintId: 'sprint-1',
        epicKey: 'ACC-0',
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    // "Won't Do" should match the default cancelledStatusNames, so roadmapStatus = 'none'
    expect(result.issues[0].roadmapStatus).toBe('none');
  });

  // ---------------------------------------------------------------------------
  // isIncident / isFailure flags
  // ---------------------------------------------------------------------------

  it('marks bug as isIncident and isFailure based on board config', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: ['Bug'],
      failureLabels: [],
      incidentIssueTypes: ['Bug'],
      incidentLabels: [],
      incidentPriorities: [], // empty = all priorities qualify
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Bug',
        summary: 'A bug',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].isIncident).toBe(true);
    expect(result.issues[0].isFailure).toBe(true);
    expect(result.summary.incidentCount).toBe(1);
    expect(result.summary.failureCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // leadTimeDays computation
  // ---------------------------------------------------------------------------

  it('computes leadTimeDays from In Progress to Done', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    const inProgressAt = new Date('2026-01-06T00:00:00Z');
    const doneAt = new Date('2026-01-08T00:00:00Z'); // 2 days

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Lead time test',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgressAt },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: doneAt },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].leadTimeDays).toBe(2);
    expect(result.issues[0].resolvedAt).toBe(doneAt.toISOString());
    expect(result.summary.medianLeadTimeDays).toBe(2);
  });

  it('sets leadTimeDays to null for issues without done transition', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'In progress',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: new Date('2026-01-06T00:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].leadTimeDays).toBeNull();
    expect(result.issues[0].resolvedAt).toBeNull();
    expect(result.summary.medianLeadTimeDays).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Epics excluded
  // ---------------------------------------------------------------------------

  it('excludes Epic issue types from sprint detail', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue(null);
    roadmapConfigRepo.find.mockResolvedValue([]);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-E1',
        boardId: 'ACC',
        issueType: 'Epic',
        summary: 'An epic',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Mid-sprint addition (addedMidSprint = true)
  // ---------------------------------------------------------------------------

  it('marks issue as addedMidSprint when sprint changelog appears after grace period', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-2',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Added mid sprint',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        // Created well after sprint start
        createdAt: new Date('2026-01-08T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        // Sprint changelog: issue added to sprint AFTER start (mid-sprint)
        return makeQb([
          {
            issueKey: 'ACC-2',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-08T01:00:00Z'), // well after start
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].addedMidSprint).toBe(true);
    expect(result.summary.addedMidSprintCount).toBe(1);
    expect(result.summary.committedCount).toBe(0);
  });

  it('marks issue as addedMidSprint when created after grace period with no changelog', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-3',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Created mid sprint',
        status: 'In Progress',
        // sprintId matches sprint — direct assignment
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        // Created after sprint start + grace period
        createdAt: new Date('2026-01-08T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        // No sprint changelogs for this issue — it was created directly
        return makeQb([]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].addedMidSprint).toBe(true);
    expect(result.summary.addedMidSprintCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Removed from sprint (removedKeys)
  // ---------------------------------------------------------------------------

  it('tracks removedCount for issues removed during sprint', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    // Two issues: ACC-4 (removed) and ACC-5 (stays in sprint)
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-4',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Removed mid sprint',
        status: 'To Do',
        sprintId: null,
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
      {
        key: 'ACC-5',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Still in sprint',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          // ACC-4: was in sprint at start, then removed
          {
            issueKey: 'ACC-4',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'), // before start = committed
          },
          {
            issueKey: 'ACC-4',
            field: 'Sprint',
            toValue: null,
            fromValue: 'Sprint 1',
            changedAt: new Date('2026-01-10T00:00:00Z'), // removed during sprint
          },
          // ACC-5: committed, stays in sprint
          {
            issueKey: 'ACC-5',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      // Status changelogs for ACC-5 only
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    // Only ACC-5 remains in sprint
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].key).toBe('ACC-5');
    expect(result.summary.removedCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // roadmapStatus: 'in-scope' vs 'linked'
  // ---------------------------------------------------------------------------

  it('sets roadmapStatus to "in-scope" when issue completed on time vs roadmap target', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-1';
    const targetDate = new Date('2026-01-31T00:00:00Z');

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-5',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'On-time delivery',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-1',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate,
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-5',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      // Status changelogs: completed well before target date
      return makeQb([
        {
          issueKey: 'ACC-5',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2026-01-10T12:00:00Z'), // before Jan 31 target
        },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('in-scope');
    expect(result.summary.roadmapLinkedCount).toBe(1);
  });

  it('sets roadmapStatus to "linked" when issue not completed (no done transition)', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-2';
    const targetDate = new Date('2026-01-31T00:00:00Z');

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-6',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Not completed',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-2',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate,
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-6',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      // No done transition
      return makeQb([
        { issueKey: 'ACC-6', field: 'status', toValue: 'In Progress', changedAt: new Date('2026-01-05T10:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('linked');
  });

  it('sets roadmapStatus to "linked" when completed after target date', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-3';
    // Target date is Jan 8, but issue completed Jan 15 — late
    const targetDate = new Date('2026-01-08T00:00:00Z');

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-7',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Completed late',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-3',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate,
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-7',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        {
          issueKey: 'ACC-7',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2026-01-15T12:00:00Z'), // after Jan 8 target
        },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('linked');
  });

  // ---------------------------------------------------------------------------
  // Condition B — in-flight coverage (proposal 0020)
  // ---------------------------------------------------------------------------

  it('sets roadmapStatus to "in-scope" for In Progress issue in active sprint with future targetDate', async () => {
    const activeSprint: JiraSprint = { ...SPRINT, state: 'active' };
    sprintRepo.findOne.mockResolvedValue(activeSprint);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-B1';

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-B1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'In Progress story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-B1',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate: new Date('2099-12-31T00:00:00Z'), // well in the future
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-B1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      // No done transition
      return makeQb([
        { issueKey: 'ACC-B1', field: 'status', toValue: 'In Progress', changedAt: new Date('2026-01-05T10:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('in-scope');
  });

  it('sets roadmapStatus to "in-scope" for To Do issue in active sprint with future targetDate', async () => {
    const activeSprint: JiraSprint = { ...SPRINT, state: 'active' };
    sprintRepo.findOne.mockResolvedValue(activeSprint);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-B2';

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-B2',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'To Do story',
        status: 'To Do',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-B2',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate: new Date('2099-12-31T00:00:00Z'),
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-B2',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]); // no status changelogs
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('in-scope');
  });

  it('sets roadmapStatus to "linked" for In Progress issue in active sprint with past targetDate', async () => {
    const activeSprint: JiraSprint = { ...SPRINT, state: 'active' };
    sprintRepo.findOne.mockResolvedValue(activeSprint);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-B3';

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-B3',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'In Progress, lapsed deadline',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-B3',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate: new Date('2020-01-01T00:00:00Z'), // well in the past
        startDate: new Date('2019-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-B3',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-B3', field: 'status', toValue: 'In Progress', changedAt: new Date('2026-01-05T10:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('linked');
  });

  it('sets roadmapStatus to "none" for Cancelled issue in active sprint with future targetDate (unchanged)', async () => {
    const activeSprint: JiraSprint = { ...SPRINT, state: 'active' };
    sprintRepo.findOne.mockResolvedValue(activeSprint);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
    } as unknown as BoardConfig);

    const epicKey = 'EPIC-B4';

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-B4',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Cancelled with future deadline',
        status: 'Cancelled',
        sprintId: 'sprint-1',
        epicKey,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);

    roadmapConfigRepo.find.mockResolvedValue([{ jpdKey: 'JPD' } as unknown as RoadmapConfig]);
    jpdIdeaRepo.find.mockResolvedValue([
      {
        key: 'JPD-B4',
        jpdKey: 'JPD',
        deliveryIssueKeys: [epicKey],
        targetDate: new Date('2099-12-31T00:00:00Z'),
        startDate: new Date('2026-01-01T00:00:00Z'),
      } as unknown as JpdIdea,
    ]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-B4',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].roadmapStatus).toBe('none');
  });

  // ---------------------------------------------------------------------------
  // Sort order: incomplete before completed
  // ---------------------------------------------------------------------------

  it('sorts incomplete issues before completed issues, then alphabetically', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-10',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Completed issue',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
      {
        key: 'ACC-2',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Incomplete issue',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-10',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
          {
            issueKey: 'ACC-2',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      // Status changelogs: ACC-10 is done, ACC-2 is in progress
      return makeQb([
        {
          issueKey: 'ACC-10',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2026-01-10T12:00:00Z'),
        },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues).toHaveLength(2);
    // Incomplete first
    expect(result.issues[0].key).toBe('ACC-2');
    expect(result.issues[0].completedInSprint).toBe(false);
    // Completed second
    expect(result.issues[1].key).toBe('ACC-10');
    expect(result.issues[1].completedInSprint).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Sprint with no startDate — all issues treated as committed
  // ---------------------------------------------------------------------------

  it('treats all issues as committed when sprint has no startDate', async () => {
    const sprintNoStart: JiraSprint = {
      id: 'sprint-ns',
      boardId: 'ACC',
      name: 'Sprint NS',
      state: 'active',
      startDate: null,
      endDate: new Date('2026-01-19T00:00:00Z'),
      goal: '',
    } as JiraSprint;

    sprintRepo.findOne.mockResolvedValue(sprintNoStart);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-8',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Sprint without start',
        status: 'In Progress',
        sprintId: 'sprint-ns',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-8',
            field: 'Sprint',
            toValue: 'Sprint NS',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([]);
    });

    const result = await service.getDetail('ACC', 'sprint-ns');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].addedMidSprint).toBe(false);
    expect(result.summary.committedCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // isFailure via labels
  // ---------------------------------------------------------------------------

  it('marks issue as isFailure based on failure label', async () => {
    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: ['hotfix'],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-9',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Hotfix story',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: ['hotfix'],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-9',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-9', field: 'status', toValue: 'Done', changedAt: new Date('2026-01-10T00:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].isFailure).toBe(true);
    expect(result.summary.failureCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // jiraUrl
  // ---------------------------------------------------------------------------

  it('includes jiraUrl when JIRA_BASE_URL is configured', async () => {
    service = new SprintDetailService(
      sprintRepo,
      issueRepo,
      changelogRepo,
      boardConfigRepo,
      jpdIdeaRepo,
      roadmapConfigRepo,
      issueLinkRepo,
      mockConfigService('https://myco.atlassian.net'),
      workingTimeService,
    );

    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'URL test',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-04T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: new Date('2026-01-10T00:00:00Z') },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    expect(result.issues[0].jiraUrl).toBe('https://myco.atlassian.net/browse/ACC-1');
  });

  // ---------------------------------------------------------------------------
  // excludeWeekends = true: delegates to WorkingTimeService for leadTimeDays
  // ---------------------------------------------------------------------------

  it('uses workingDaysBetween for per-issue leadTimeDays when excludeWeekends is true', async () => {
    workingTimeService.getConfig.mockResolvedValue({
      id: 1, excludeWeekends: true, workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
    });
    workingTimeService.workingDaysBetween.mockReturnValue(1);

    sprintRepo.findOne.mockResolvedValue(SPRINT);
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: [],
      incidentIssueTypes: [],
      incidentLabels: [],
      cancelledStatusNames: ['Cancelled'],
    } as unknown as BoardConfig);

    const inProgressAt = new Date('2026-01-09T00:00:00Z'); // Friday
    const doneAt = new Date('2026-01-12T00:00:00Z');       // Monday

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        summary: 'Weekend span',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        labels: [],
        points: null,
        createdAt: new Date('2026-01-05T00:00:00Z'),
      } as unknown as JiraIssue,
    ]);
    roadmapConfigRepo.find.mockResolvedValue([]);

    let qbCallCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      qbCallCount++;
      if (qbCallCount === 1) {
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'Sprint',
            toValue: 'Sprint 1',
            fromValue: null,
            changedAt: new Date('2026-01-07T00:00:00Z'),
          },
        ]);
      }
      return makeQb([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgressAt },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: doneAt },
      ]);
    });

    const result = await service.getDetail('ACC', 'sprint-1');

    // workingDaysBetween was called with the correct start/end dates
    expect(workingTimeService.workingDaysBetween).toHaveBeenCalledWith(
      inProgressAt,
      doneAt,
      expect.anything(),
    );
    // The returned value from workingDaysBetween is reflected in leadTimeDays
    expect(result.issues[0].leadTimeDays).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // B-4: Missing BoardConfig fallback defaults
  // ---------------------------------------------------------------------------

  describe('B-4: missing BoardConfig fallback defaults', () => {
    it('classifies Bug issues as failures when boardConfig is null', async () => {
      sprintRepo.findOne.mockResolvedValue(SPRINT);
      boardConfigRepo.findOne.mockResolvedValue(null); // No BoardConfig row

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Bug',
          summary: 'A bug',
          status: 'Done',
          sprintId: 'sprint-1',
          epicKey: null,
          labels: [],
          points: null,
          priority: null,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        } as unknown as JiraIssue,
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          return makeQb([
            {
              issueKey: 'ACC-1',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2026-01-04T00:00:00Z'),
            },
          ]);
        }
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'status',
            toValue: 'Done',
            changedAt: new Date('2026-01-10T10:00:00Z'),
          },
        ]);
      });

      const result = await service.getDetail('ACC', 'sprint-1');

      // With B-4 fix: Bug should be classified as a failure even without BoardConfig
      expect(result.issues[0].isFailure).toBe(true);
      expect(result.summary.failureCount).toBe(1);
    });

    it('classifies Incident issues as failures when boardConfig is null', async () => {
      sprintRepo.findOne.mockResolvedValue(SPRINT);
      boardConfigRepo.findOne.mockResolvedValue(null);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-2',
          boardId: 'ACC',
          issueType: 'Incident',
          summary: 'An incident',
          status: 'In Progress',
          sprintId: 'sprint-1',
          epicKey: null,
          labels: [],
          points: null,
          priority: null,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        } as unknown as JiraIssue,
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          return makeQb([
            {
              issueKey: 'ACC-2',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2026-01-04T00:00:00Z'),
            },
          ]);
        }
        return makeQb([]);
      });

      const result = await service.getDetail('ACC', 'sprint-1');

      // Incident should be classified as failure by default
      expect(result.issues[0].isFailure).toBe(true);
    });

    it('classifies Story issues as non-failures when boardConfig is null', async () => {
      sprintRepo.findOne.mockResolvedValue(SPRINT);
      boardConfigRepo.findOne.mockResolvedValue(null);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-3',
          boardId: 'ACC',
          issueType: 'Story',
          summary: 'A story',
          status: 'Done',
          sprintId: 'sprint-1',
          epicKey: null,
          labels: [],
          points: null,
          priority: null,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        } as unknown as JiraIssue,
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          return makeQb([
            {
              issueKey: 'ACC-3',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2026-01-04T00:00:00Z'),
            },
          ]);
        }
        return makeQb([
          {
            issueKey: 'ACC-3',
            field: 'status',
            toValue: 'Done',
            changedAt: new Date('2026-01-10T10:00:00Z'),
          },
        ]);
      });

      const result = await service.getDetail('ACC', 'sprint-1');

      // Story should NOT be classified as failure
      expect(result.issues[0].isFailure).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // B-2: incidentPriorities AND-gate in sprint view
  // ---------------------------------------------------------------------------

  describe('B-2: incidentPriorities AND-gate', () => {
    function makeB2Setup(priority: string | null, incidentPriorities: string[]) {
      sprintRepo.findOne.mockResolvedValue(SPRINT);
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        doneStatusNames: ['Done'],
        failureIssueTypes: ['Bug', 'Incident'],
        failureLabels: [],
        incidentIssueTypes: ['Bug', 'Incident'],
        incidentLabels: [],
        incidentPriorities,
        cancelledStatusNames: [],
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Bug',
          summary: 'A bug',
          status: 'Done',
          sprintId: 'sprint-1',
          epicKey: null,
          labels: [],
          points: null,
          priority,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        } as unknown as JiraIssue,
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          return makeQb([
            {
              issueKey: 'ACC-1',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2026-01-04T00:00:00Z'),
            },
          ]);
        }
        return makeQb([
          {
            issueKey: 'ACC-1',
            field: 'status',
            toValue: 'Done',
            changedAt: new Date('2026-01-10T10:00:00Z'),
          },
        ]);
      });
    }

    it('Bug at Medium priority is NOT classified as incident when incidentPriorities = [Critical, Highest]', async () => {
      makeB2Setup('Medium', ['Critical', 'Highest']);

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isIncident).toBe(false);
    });

    it('Bug at Critical priority IS classified as incident when incidentPriorities = [Critical, Highest]', async () => {
      makeB2Setup('Critical', ['Critical', 'Highest']);

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isIncident).toBe(true);
    });

    it('any-priority Bug IS classified as incident when incidentPriorities = [] (empty means all qualify)', async () => {
      makeB2Setup('Low', []);

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isIncident).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // failureLinkTypes AND-gate (Proposal 0032)
  // ---------------------------------------------------------------------------

  describe('failureLinkTypes AND-gate', () => {
    /**
     * Helper: sets up a sprint with a single Bug issue (ACC-1) and two
     * changelog query builder calls (Sprint, then status).
     * The issueLinkRepo createQueryBuilder is a separate mock.
     */
    function setupLinkGateTest(
      failureLinkTypes: string[],
      linkRows: object[],
    ) {
      sprintRepo.findOne.mockResolvedValue(SPRINT);
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        doneStatusNames: ['Done'],
        failureIssueTypes: ['Bug'],
        failureLabels: [],
        failureLinkTypes,
        incidentIssueTypes: [],
        incidentLabels: [],
        incidentPriorities: [],
        cancelledStatusNames: ['Cancelled'],
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Bug',
          summary: 'A bug',
          status: 'In Progress',
          sprintId: 'sprint-1',
          epicKey: null,
          labels: [],
          points: null,
          priority: null,
          createdAt: new Date('2026-01-03T00:00:00Z'),
        } as unknown as JiraIssue,
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          return makeQb([
            {
              issueKey: 'ACC-1',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2026-01-04T00:00:00Z'),
            },
          ]);
        }
        return makeQb([]);
      });

      // issueLinkRepo mock: returns the given linkRows
      issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(linkRows),
      });
    }

    it('does NOT mark as isFailure when failureLinkTypes is set and issue has no matching link', async () => {
      setupLinkGateTest(['caused by'], []); // no causal links found

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isFailure).toBe(false);
    });

    it('marks as isFailure when failureLinkTypes is set and issue has a matching causal link', async () => {
      setupLinkGateTest(['caused by'], [{ key: 'ACC-1' }]); // link found

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isFailure).toBe(true);
    });

    it('marks as isFailure when failureLinkTypes is empty (default — no AND-gate applied)', async () => {
      // failureLinkTypes = [] means gate is skipped entirely
      setupLinkGateTest([], []);

      const result = await service.getDetail('ACC', 'sprint-1');

      // Gate skipped: Bug matches failureIssueTypes → isFailure = true
      expect(result.issues[0].isFailure).toBe(true);
      // issueLinkRepo should NOT have been called
      expect(issueLinkRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('link type matching is case-insensitive', async () => {
      // Config uses title-case; link row uses lower-case — must still match
      setupLinkGateTest(['Caused By'], [{ key: 'ACC-1' }]);

      const result = await service.getDetail('ACC', 'sprint-1');

      expect(result.issues[0].isFailure).toBe(true);
    });
  });
});
