import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { QuarterDetailService } from './quarter-detail.service.js';
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
    key: 'ACC-1',
    boardId: 'ACC',
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
    issueKey: 'ACC-1',
    field: 'status',
    fromValue: 'To Do',
    toValue: 'In Progress',
    changedAt: new Date('2026-01-05T09:00:00Z'),
    ...overrides,
  } as unknown as JiraChangelog;
}

describe('QuarterDetailService', () => {
  let service: QuarterDetailService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let roadmapConfigRepo: jest.Mocked<Repository<RoadmapConfig>>;
  let jpdIdeaRepo: jest.Mocked<Repository<JpdIdea>>;
  let issueLinkRepo: jest.Mocked<Repository<JiraIssueLink>>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();
    roadmapConfigRepo = mockRepo<RoadmapConfig>();
    jpdIdeaRepo = mockRepo<JpdIdea>();
    issueLinkRepo = mockRepo<JiraIssueLink>();

    service = new QuarterDetailService(
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
    it('throws BadRequestException for invalid quarter format', async () => {
      await expect(service.getDetail('ACC', 'not-a-quarter')).rejects.toThrow(BadRequestException);
    });

    it('throws for quarter with invalid Q number', async () => {
      await expect(service.getDetail('ACC', '2026-Q5')).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // Empty board
  // -------------------------------------------------------------------------

  describe('getDetail — empty board', () => {
    it('returns empty response when board has no issues', async () => {
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');

      expect(result.boardId).toBe('ACC');
      expect(result.quarter).toBe('2026-Q1');
      expect(result.summary.totalIssues).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(result.quarterStart).toBe('2026-01-01T00:00:00.000Z');
      expect(result.quarterEnd).toBe('2026-03-31T23:59:59.999Z');
    });

    it('excludes Epic issue type', async () => {
      issueRepo.find.mockResolvedValue([makeIssue({ issueType: 'Epic' })]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.summary.totalIssues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — scrum board
  // -------------------------------------------------------------------------

  describe('getDetail — scrum board happy path', () => {
    it('returns issues with correct completedInQuarter flag', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        fromValue: null,
        toValue: 'Sprint 1',
        changedAt: new Date('2026-01-05T09:00:00Z'), // Q1 entry
      });
      const doneChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'status',
        fromValue: 'In Progress',
        toValue: 'Done',
        changedAt: new Date('2026-01-15T09:00:00Z'), // completed in Q1
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog, doneChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');

      expect(result.summary.totalIssues).toBe(1);
      expect(result.issues[0].completedInQuarter).toBe(true);
    });

    it('marks addedMidQuarter as false for issue entering at Q1 start', async () => {
      // Entry on Jan 5 — very start of Q1 (not mid-quarter since Q1 starts Jan 1)
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        fromValue: null,
        toValue: 'Sprint 1',
        changedAt: new Date('2026-01-01T00:00:00Z'), // exactly at quarter start
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].addedMidQuarter).toBe(false);
    });

    it('marks addedMidQuarter as true for issue entering mid-quarter', async () => {
      // Entry on Feb 15 — clearly mid Q1
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        fromValue: null,
        toValue: 'Sprint 2',
        changedAt: new Date('2026-02-15T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].addedMidQuarter).toBe(true);
    });

    it('sets linkedToRoadmap when epicKey is in covered set', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', epicKey: 'EPIC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([
        { id: 1, jpdKey: 'JPD-1', description: null, startDateFieldId: null, targetDateFieldId: null, createdAt: new Date() } as RoadmapConfig,
      ]);
      jpdIdeaRepo.find.mockResolvedValue([
        { key: 'IDEA-1', jpdKey: 'JPD-1', deliveryIssueKeys: ['EPIC-1'], startDate: new Date('2026-01-01T00:00:00Z'), targetDate: new Date('2026-03-31T00:00:00Z') } as unknown as JpdIdea,
      ]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].linkedToRoadmap).toBe(true);
    });

    it('marks isIncident true for Critical Bug', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', issueType: 'Bug', priority: 'Critical', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isIncident).toBe(true);
    });

    it('marks isIncident false for non-Critical Bug', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', issueType: 'Bug', priority: 'High', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isIncident).toBe(false);
    });

    it('marks isFailure true for Bug type issue', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', issueType: 'Bug', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isFailure).toBe(true);
    });

    it('constructs jiraUrl when JIRA_BASE_URL is configured', async () => {
      const serviceWithUrl = new QuarterDetailService(
        issueRepo,
        changelogRepo,
        boardConfigRepo,
        roadmapConfigRepo,
        jpdIdeaRepo,
        issueLinkRepo,
        mockConfigService('https://myorg.atlassian.net'),
      );

      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await serviceWithUrl.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].jiraUrl).toBe('https://myorg.atlassian.net/browse/ACC-1');
    });

    it('returns empty jiraUrl when JIRA_BASE_URL is not configured', async () => {
      const sprintChangelog = makeChangelog({
        issueKey: 'ACC-1',
        field: 'Sprint',
        changedAt: new Date('2026-01-05T00:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintChangelog]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].jiraUrl).toBe('');
    });

    it('sorts incomplete issues before completed', async () => {
      const sprintCl1 = makeChangelog({ issueKey: 'ACC-1', field: 'Sprint', changedAt: new Date('2026-01-05T00:00:00Z') });
      const sprintCl2 = makeChangelog({ issueKey: 'ACC-2', field: 'Sprint', changedAt: new Date('2026-01-05T00:00:00Z') });
      const doneCl2 = makeChangelog({ issueKey: 'ACC-2', field: 'status', fromValue: 'In Progress', toValue: 'Done', changedAt: new Date('2026-01-10T00:00:00Z') });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeIssue({ key: 'ACC-2', createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintCl1, sprintCl2, doneCl2]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      // ACC-1 is incomplete → should come first
      expect(result.issues[0].key).toBe('ACC-1');
      expect(result.issues[1].key).toBe('ACC-2');
    });

    it('returns correct summary counts', async () => {
      const sprintCl = makeChangelog({ issueKey: 'ACC-1', field: 'Sprint', changedAt: new Date('2026-01-05T00:00:00Z') });
      const doneCl = makeChangelog({ issueKey: 'ACC-1', field: 'status', fromValue: 'In Progress', toValue: 'Done', changedAt: new Date('2026-01-10T00:00:00Z') });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', points: 3, createdAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([sprintCl, doneCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.summary.totalIssues).toBe(1);
      expect(result.summary.completedIssues).toBe(1);
      expect(result.summary.totalPoints).toBe(3);
      expect(result.summary.completedPoints).toBe(3);
    });

    it('returns boardConfig in response', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        doneStatusNames: ['Done', 'Released'],
      } as unknown as BoardConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.boardConfig.boardType).toBe('scrum');
      expect(result.boardConfig.doneStatusNames).toContain('Done');
    });
  });

  // -------------------------------------------------------------------------
  // Kanban board
  // -------------------------------------------------------------------------

  describe('getDetail — kanban board', () => {
    beforeEach(() => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        incidentIssueTypes: [],
        incidentLabels: [],
        failureIssueTypes: [],
        failureLabels: [],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);
    });

    it('uses "To Do" exit changelog as board-entry date for kanban issues', async () => {
      const toDoExitCl = makeChangelog({
        issueKey: 'PLAT-1',
        field: 'status',
        fromValue: 'To Do',
        toValue: 'In Progress',
        changedAt: new Date('2026-01-10T09:00:00Z'),
      });

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', createdAt: new Date('2025-12-01T00:00:00Z') }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([toDoExitCl]),
      });
      roadmapConfigRepo.find.mockResolvedValue([]);

      const result = await service.getDetail('PLAT', '2026-Q1');
      // Issue enters board Jan 10 → falls in Q1
      expect(result.summary.totalIssues).toBe(1);
      expect(result.issues[0].boardEntryDate).toContain('2026-01-10');
    });

    it('returns empty response when all issues are backlog (no status changelogs)', async () => {
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', createdAt: new Date('2026-01-05T00:00:00Z') }),
      ]);
      // No changelogs → issue never left "To Do" → treated as backlog
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.getDetail('PLAT', '2026-Q1');
      expect(result.summary.totalIssues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // B-3: incidentPriorities from BoardConfig
  // -------------------------------------------------------------------------

  describe('B-3: incidentPriorities from BoardConfig', () => {
    function setupB3(incidentPriorities: string[], issuePriority: string | null) {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
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
          key: 'ACC-1',
          issueType: 'Bug',
          priority: issuePriority,
          createdAt: new Date('2026-01-10T09:00:00Z'),
        }),
      ]);

      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          makeChangelog({
            issueKey: 'ACC-1',
            field: 'Sprint',
            fromValue: null,
            toValue: 'Sprint 1',
            changedAt: new Date('2026-01-10T09:00:00Z'),
          }),
          makeChangelog({
            issueKey: 'ACC-1',
            field: 'status',
            fromValue: 'To Do',
            toValue: 'Done',
            changedAt: new Date('2026-01-15T10:00:00Z'),
          }),
        ]),
      });

      roadmapConfigRepo.find.mockResolvedValue([]);
      jpdIdeaRepo.find.mockResolvedValue([]);
    }

    it('Bug at Highest priority IS incident when incidentPriorities = [Highest]', async () => {
      setupB3(['Highest'], 'Highest');
      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isIncident).toBe(true);
    });

    it('Bug at Medium priority is NOT incident when incidentPriorities = [Highest]', async () => {
      setupB3(['Highest'], 'Medium');
      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isIncident).toBe(false);
    });

    it('Bug at any priority IS incident when incidentPriorities = [] (empty = all)', async () => {
      setupB3([], 'Low');
      const result = await service.getDetail('ACC', '2026-Q1');
      expect(result.issues[0].isIncident).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // failureLinkTypes AND-gate (Proposal 0032)
  // -------------------------------------------------------------------------

  describe('failureLinkTypes AND-gate', () => {
    /**
     * Sets up a scrum board with one Bug issue (ACC-1) that entered Q1 via a
     * Sprint changelog on Jan 10.  The issueLinkRepo mock returns linkRows.
     */
    function setupLinkGateTest(
      failureLinkTypes: string[],
      linkRows: object[],
    ) {
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
        backlogStatusIds: [],
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', issueType: 'Bug', createdAt: new Date('2026-01-10T09:00:00Z') }),
      ]);

      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          makeChangelog({
            issueKey: 'ACC-1',
            field: 'Sprint',
            fromValue: null,
            toValue: 'Sprint 1',
            changedAt: new Date('2026-01-10T09:00:00Z'),
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

      const result = await service.getDetail('ACC', '2026-Q1');

      expect(result.issues[0].isFailure).toBe(false);
    });

    it('marks as isFailure when failureLinkTypes is set and matching link present', async () => {
      setupLinkGateTest(['caused by'], [{ key: 'ACC-1' }]);

      const result = await service.getDetail('ACC', '2026-Q1');

      expect(result.issues[0].isFailure).toBe(true);
    });
  });
});
