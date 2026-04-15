import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { WeekDetailService } from './week-detail.service.js';
import {
  JiraIssue,
  JiraChangelog,
  BoardConfig,
  RoadmapConfig,
  JpdIdea,
  JiraIssueLink,
} from '../database/entities/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    get: jest.fn().mockImplementation((_key: string, defaultVal?: unknown) => {
      if (_key === 'JIRA_BASE_URL') return jiraBaseUrl;
      return defaultVal ?? '';
    }),
  } as unknown as jest.Mocked<ConfigService>;
}

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PLAT-1',
    boardId: 'PLAT',
    issueType: 'Story',
    summary: 'Test issue',
    status: 'In Progress',
    labels: [],
    epicKey: null,
    fixVersion: null,
    sprintId: null,
    createdAt: new Date('2026-01-05T09:00:00Z'),
    priority: null,
    points: null,
    statusId: null,
    ...overrides,
  } as unknown as JiraIssue;
}

function makeChangelog(overrides: Partial<JiraChangelog> = {}): JiraChangelog {
  return {
    id: 1,
    issueKey: 'PLAT-1',
    field: 'status',
    fromValue: 'To Do',
    toValue: 'In Progress',
    changedAt: new Date('2026-01-05T09:00:00Z'),
    ...overrides,
  } as unknown as JiraChangelog;
}

// 2026-W02 starts Monday 2026-01-05, ends Sunday 2026-01-11
const WEEK = '2026-W02';
const WEEK_START = new Date('2026-01-05T00:00:00.000Z');

describe('WeekDetailService', () => {
  let service: WeekDetailService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let roadmapConfigRepo: jest.Mocked<Repository<RoadmapConfig>>;
  let jpdIdeaRepo: jest.Mocked<Repository<JpdIdea>>;
  let issueLinkRepo: jest.Mocked<Repository<JiraIssueLink>>;

  function kanbanConfig(overrides: object = {}): BoardConfig {
    return {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      incidentIssueTypes: ['Bug', 'Incident'],
      incidentLabels: [],
      failureIssueTypes: ['Bug', 'Incident'],
      failureLabels: ['regression', 'incident', 'hotfix'],
      backlogStatusIds: [],
      dataStartDate: null,
      ...overrides,
    } as unknown as BoardConfig;
  }

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();
    roadmapConfigRepo = mockRepo<RoadmapConfig>();
    jpdIdeaRepo = mockRepo<JpdIdea>();
    issueLinkRepo = mockRepo<JiraIssueLink>();

    service = new WeekDetailService(
      issueRepo,
      changelogRepo,
      boardConfigRepo,
      roadmapConfigRepo,
      jpdIdeaRepo,
      issueLinkRepo,
      mockConfigService(),
    );
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('getDetail — validation', () => {
    it('throws BadRequestException for invalid week format', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      await expect(service.getDetail('PLAT', 'not-a-week')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for scrum board', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
      } as unknown as BoardConfig);
      await expect(service.getDetail('ACC', WEEK)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no board config (defaults to scrum)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null);
      await expect(service.getDetail('ACC', WEEK)).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // Empty board
  // -------------------------------------------------------------------------

  describe('getDetail — empty board', () => {
    it('returns empty response when board has no issues', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);

      expect(result.boardId).toBe('PLAT');
      expect(result.week).toBe(WEEK);
      expect(result.summary.totalIssues).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it('excludes Epic issue type', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      issueRepo.find.mockResolvedValue([makeIssue({ issueType: 'Epic' })]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.summary.totalIssues).toBe(0);
    });

    it('returns empty when no issues fall within the week', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      // Issue entered in a different week
      const toDoExitCl = makeChangelog({
        changedAt: new Date('2026-02-15T09:00:00Z'), // W07, not W02
      });
      issueRepo.find.mockResolvedValue([makeIssue()]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.summary.totalIssues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('getDetail — kanban happy path', () => {
    it('returns issue that entered the board in the given week', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        fromValue: 'To Do',
        toValue: 'In Progress',
        changedAt: new Date('2026-01-06T09:00:00Z'), // W02
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.summary.totalIssues).toBe(1);
      expect(result.issues[0].key).toBe('PLAT-1');
    });

    it('marks completedInWeek true for done transition within the week', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        fromValue: 'To Do',
        toValue: 'In Progress',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });
      const doneCl = makeChangelog({
        issueKey: 'PLAT-1',
        field: 'status',
        fromValue: 'In Progress',
        toValue: 'Done',
        changedAt: new Date('2026-01-08T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl, doneCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].completedInWeek).toBe(true);
    });

    it('marks addedMidWeek true for issue entering > 1 day after week start', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      // Jan 7 is > 1 day after Jan 5 (week start)
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        fromValue: 'To Do',
        toValue: 'In Progress',
        changedAt: new Date('2026-01-07T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].addedMidWeek).toBe(true);
    });

    it('marks addedMidWeek false for issue entering at week start', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        fromValue: 'To Do',
        toValue: 'In Progress',
        changedAt: WEEK_START, // exactly at week start
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].addedMidWeek).toBe(false);
    });

    it('marks isIncident true for Critical Bug', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', issueType: 'Bug', priority: 'Critical', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].isIncident).toBe(true);
    });

    it('marks isFailure true for issue with failure label', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', labels: ['regression'], createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].isFailure).toBe(true);
    });

    it('sets linkedToRoadmap when epicKey is in covered set', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', epicKey: 'EPIC-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([
        { id: 1, jpdKey: 'JPD-1', description: null, startDateFieldId: null, targetDateFieldId: null, createdAt: new Date() } as RoadmapConfig,
      ]);
      jpdIdeaRepo.find.mockResolvedValue([
        { key: 'IDEA-1', jpdKey: 'JPD-1', deliveryIssueKeys: ['EPIC-1'] } as unknown as JpdIdea,
      ]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].linkedToRoadmap).toBe(true);
    });

    it('builds jiraUrl when JIRA_BASE_URL is configured', async () => {
      const serviceWithUrl = new WeekDetailService(
        issueRepo,
        changelogRepo,
        boardConfigRepo,
        roadmapConfigRepo,
        jpdIdeaRepo,
        issueLinkRepo,
        mockConfigService('https://myorg.atlassian.net'),
      );
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await serviceWithUrl.getDetail('PLAT', WEEK);
      expect(result.issues[0].jiraUrl).toBe('https://myorg.atlassian.net/browse/PLAT-1');
    });

    it('returns correct summary counts', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });
      const doneCl = makeChangelog({
        issueKey: 'PLAT-1',
        field: 'status',
        fromValue: 'In Progress',
        toValue: 'Done',
        changedAt: new Date('2026-01-08T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', points: 5, createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl, doneCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.summary.totalIssues).toBe(1);
      expect(result.summary.completedIssues).toBe(1);
      expect(result.summary.totalPoints).toBe(5);
      expect(result.summary.completedPoints).toBe(5);
    });

    it('sorts incomplete issues before completed', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      const cl1 = makeChangelog({ issueKey: 'PLAT-1', changedAt: new Date('2026-01-06T09:00:00Z') });
      const cl2 = makeChangelog({ issueKey: 'PLAT-2', changedAt: new Date('2026-01-06T09:00:00Z') });
      const doneCl2 = makeChangelog({ issueKey: 'PLAT-2', field: 'status', fromValue: 'In Progress', toValue: 'Done', changedAt: new Date('2026-01-07T09:00:00Z') });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2025-12-01T00:00:00Z') }),
        makeIssue({ key: 'PLAT-2', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([cl1, cl2, doneCl2]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].key).toBe('PLAT-1'); // incomplete first
      expect(result.issues[1].key).toBe('PLAT-2');
    });

    it('returns boardConfig in response', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', WEEK);
      expect(result.boardConfig.boardType).toBe('kanban');
      expect(result.boardConfig.doneStatusNames).toContain('Done');
    });

    it('falls back to createdAt when issue has no "To Do" exit changelog', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig());
      // A non-"To Do" status transition (e.g. In Progress → Done)
      const otherCl = makeChangelog({
        issueKey: 'PLAT-1',
        fromValue: 'In Progress',
        toValue: 'Done',
        changedAt: new Date('2026-01-06T09:00:00Z'),
      });

      // createdAt is in W02 so issue should be included
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', createdAt: new Date('2026-01-05T09:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([otherCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      // createdAt (Jan 5) is in W02, but no "To Do" exit → falls back to createdAt
      const result = await service.getDetail('PLAT', WEEK);
      // Note: the fallback boardEntryDate = createdAt = Jan 5, which is in W02
      expect(result.summary.totalIssues).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // B-3: incidentPriorities from BoardConfig
  // -------------------------------------------------------------------------

  describe('B-3: incidentPriorities from BoardConfig', () => {
    function setupB3(incidentPriorities: string[], issuePriority: string | null) {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        incidentIssueTypes: ['Bug'],
        incidentLabels: [],
        incidentPriorities,
        failureIssueTypes: ['Bug'],
        failureLabels: [],
        backlogStatusIds: [],
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        makeIssue({
          key: 'PLAT-1',
          issueType: 'Bug',
          priority: issuePriority,
          createdAt: new Date('2026-01-05T09:00:00Z'),
        }),
      ]);

      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          makeChangelog({
            issueKey: 'PLAT-1',
            field: 'status',
            fromValue: 'To Do',
            toValue: 'In Progress',
            changedAt: new Date('2026-01-05T09:00:00Z'),
          }),
        ]),
      });

      roadmapConfigRepo.find.mockResolvedValue([]);
      jpdIdeaRepo.find.mockResolvedValue([]);
    }

    it('Bug at Highest priority IS incident when incidentPriorities = [Highest]', async () => {
      setupB3(['Highest'], 'Highest');
      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].isIncident).toBe(true);
    });

    it('Bug at Medium priority is NOT incident when incidentPriorities = [Highest]', async () => {
      setupB3(['Highest'], 'Medium');
      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].isIncident).toBe(false);
    });

    it('Bug at any priority IS incident when incidentPriorities = [] (empty = all)', async () => {
      setupB3([], 'Low');
      const result = await service.getDetail('PLAT', WEEK);
      expect(result.issues[0].isIncident).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // failureLinkTypes AND-gate (Proposal 0032)
  // -------------------------------------------------------------------------

  describe('failureLinkTypes AND-gate', () => {
    /**
     * Sets up a kanban board with one Bug issue (PLAT-1) that entered the
     * board in W02 via a "To Do" exit changelog.  The issueLinkRepo mock
     * returns the given linkRows.
     */
    function setupLinkGateTest(
      failureLinkTypes: string[],
      linkRows: object[],
    ) {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        failureIssueTypes: ['Bug'],
        failureLabels: [],
        failureLinkTypes,
        incidentIssueTypes: [],
        incidentLabels: [],
        incidentPriorities: [],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', issueType: 'Bug', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);

      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          makeChangelog({
            issueKey: 'PLAT-1',
            field: 'status',
            fromValue: 'To Do',
            toValue: 'In Progress',
            changedAt: new Date('2026-01-06T09:00:00Z'), // W02
          }),
        ]),
      });

      roadmapConfigRepo.find.mockResolvedValue([]);

      issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(linkRows),
      });
    }

    it('does NOT mark as isFailure when failureLinkTypes is set and no matching link', async () => {
      setupLinkGateTest(['caused by'], []); // no causal links

      const result = await service.getDetail('PLAT', WEEK);

      expect(result.issues[0].isFailure).toBe(false);
    });

    it('marks as isFailure when failureLinkTypes is set and matching link present', async () => {
      setupLinkGateTest(['caused by'], [{ key: 'PLAT-1' }]);

      const result = await service.getDetail('PLAT', WEEK);

      expect(result.issues[0].isFailure).toBe(true);
    });
  });
});
