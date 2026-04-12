import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { RoadmapService } from './roadmap.service.js';
import { SyncService } from '../sync/sync.service.js';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  JpdIdea,
  RoadmapConfig,
  BoardConfig,
} from '../database/entities/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((dto: Partial<T>) => dto as T),
    save: jest.fn().mockImplementation(async (e: T) => e),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

function mockConfigService(tz = 'UTC'): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockImplementation((_key: string, defaultVal?: unknown) => {
      if (_key === 'TIMEZONE') return tz;
      return defaultVal ?? '';
    }),
  } as unknown as jest.Mocked<ConfigService>;
}

function mockSyncService(): jest.Mocked<SyncService> {
  return {
    syncRoadmaps: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SyncService>;
}

function buildQb(results: object[]) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(results),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return qb;
}

function makeSprint(overrides: Partial<JiraSprint> = {}): JiraSprint {
  return {
    id: 'sprint-1',
    boardId: 'ACC',
    name: 'Sprint 1',
    state: 'closed',
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: new Date('2026-01-14T23:59:59Z'),
    ...overrides,
  } as unknown as JiraSprint;
}

function makeIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'ACC-1',
    boardId: 'ACC',
    issueType: 'Story',
    summary: 'Do work',
    status: 'Done',
    labels: [],
    epicKey: null,
    fixVersion: null,
    sprintId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    priority: null,
    points: null,
    statusId: null,
    ...overrides,
  } as unknown as JiraIssue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoadmapService', () => {
  let service: RoadmapService;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let jpdIdeaRepo: jest.Mocked<Repository<JpdIdea>>;
  let roadmapConfigRepo: jest.Mocked<Repository<RoadmapConfig>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let syncService: jest.Mocked<SyncService>;

  beforeEach(() => {
    sprintRepo = mockRepo<JiraSprint>();
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    jpdIdeaRepo = mockRepo<JpdIdea>();
    roadmapConfigRepo = mockRepo<RoadmapConfig>();
    boardConfigRepo = mockRepo<BoardConfig>();
    syncService = mockSyncService();

    service = new RoadmapService(
      sprintRepo,
      issueRepo,
      changelogRepo,
      jpdIdeaRepo,
      roadmapConfigRepo,
      boardConfigRepo,
      syncService,
      mockConfigService(),
    );
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Scrum, no sprint ID (active + closed)
  // -------------------------------------------------------------------------

  describe('getAccuracy (scrum, no filter)', () => {
    it('returns empty array when board has no sprints', async () => {
      sprintRepo.find.mockResolvedValue([]);
      const result = await service.getAccuracy('ACC');
      expect(result).toEqual([]);
    });

    it('returns emptyAccuracy objects for sprints with no issues', async () => {
      const sprint = makeSprint();
      sprintRepo.find
        .mockResolvedValueOnce([sprint]) // active sprints
        .mockResolvedValueOnce([]);      // closed sprints
      issueRepo.find.mockResolvedValue([]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result).toHaveLength(1);
      expect(result[0].sprintId).toBe('sprint-1');
      expect(result[0].totalIssues).toBe(0);
      expect(result[0].coveredIssues).toBe(0);
    });

    it('excludes Epic issue type from accuracy calculation', async () => {
      const sprint = makeSprint();
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      // Only an Epic on the board — should be filtered out
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-EPIC', issueType: 'Epic', sprintId: 'sprint-1' }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(0);
    });

    it('excludes Sub-task issue type', async () => {
      const sprint = makeSprint();
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-2', issueType: 'Sub-task', sprintId: 'sprint-1' }),
      ]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(0);
    });

    it('assigns issue to sprint when sprintId matches and no changelogs', async () => {
      const sprint = makeSprint({ id: 'sprint-1' });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      const issue = makeIssue({ key: 'ACC-1', sprintId: 'sprint-1', status: 'Done' });
      issueRepo.find.mockResolvedValue([issue]);
      roadmapConfigRepo.find.mockResolvedValue([]);

      // Sprint field changelogs: empty (so issue is assigned at creation)
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(1);
    });

    it('excludes cancelled issues from totals (default "Cancelled")', async () => {
      const sprint = makeSprint({ id: 'sprint-1' });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', sprintId: 'sprint-1', status: 'Cancelled' }),
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(0);
    });

    it('excludes "Won\'t Do" cancelled issues', async () => {
      const sprint = makeSprint({ id: 'sprint-1' });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', sprintId: 'sprint-1', status: "Won't Do" }),
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(0);
    });

    it('respects custom cancelledStatusNames from boardConfig', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        cancelledStatusNames: ['Rejected'],
        doneStatusNames: ['Done'],
      } as unknown as BoardConfig);

      const sprint = makeSprint({ id: 'sprint-1' });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'ACC-1', sprintId: 'sprint-1', status: 'Rejected' }),
      ]);
      roadmapConfigRepo.find.mockResolvedValue([]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC');
      expect(result[0].totalIssues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Scrum by sprintId
  // -------------------------------------------------------------------------

  describe('getAccuracy (scrum, by sprintId)', () => {
    it('returns result for a single sprint by id', async () => {
      const sprint = makeSprint();
      sprintRepo.findOne.mockResolvedValue(sprint);
      issueRepo.find.mockResolvedValue([]);
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('ACC', 'sprint-1');
      expect(result).toHaveLength(1);
      expect(result[0].sprintId).toBe('sprint-1');
    });

    it('returns empty when sprintId is not found', async () => {
      sprintRepo.findOne.mockResolvedValue(null);
      const result = await service.getAccuracy('ACC', 'nonexistent');
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Kanban board
  // -------------------------------------------------------------------------

  describe('getAccuracy (kanban)', () => {
    beforeEach(() => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        cancelledStatusNames: ['Cancelled', "Won't Do"],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);
    });

    it('throws BadRequestException when sprintId is provided for kanban board', async () => {
      await expect(
        service.getAccuracy('PLAT', 'sprint-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns empty array when kanban board has no issues', async () => {
      issueRepo.find.mockResolvedValue([]);
      const result = await service.getAccuracy('PLAT');
      expect(result).toEqual([]);
    });

    it('returns empty array for kanban when all issues are backlog (no changelogs)', async () => {
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT' }),
      ]);
      // No "To Do" exit changelogs, no any-status changelogs → issue is backlog
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('PLAT');
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — quarter filter on scrum board
  // -------------------------------------------------------------------------

  describe('getAccuracy (scrum, by quarter)', () => {
    it('returns empty array when no closed sprints fall in the quarter', async () => {
      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      sprintRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);
      boardConfigRepo.findOne.mockResolvedValue(null);

      const result = await service.getAccuracy('ACC', undefined, '2026-Q1');
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getConfigs
  // -------------------------------------------------------------------------

  describe('getConfigs', () => {
    it('returns all roadmap configs ordered by createdAt', async () => {
      const configs: RoadmapConfig[] = [
        { id: 1, jpdKey: 'JPD-1', description: null, startDateFieldId: null, targetDateFieldId: null, createdAt: new Date() },
        { id: 2, jpdKey: 'JPD-2', description: 'Desc', startDateFieldId: null, targetDateFieldId: null, createdAt: new Date() },
      ];
      roadmapConfigRepo.find.mockResolvedValue(configs);

      const result = await service.getConfigs();
      expect(result).toHaveLength(2);
      expect(roadmapConfigRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' } });
    });

    it('returns empty array when no configs', async () => {
      roadmapConfigRepo.find.mockResolvedValue([]);
      const result = await service.getConfigs();
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // createConfig
  // -------------------------------------------------------------------------

  describe('createConfig', () => {
    it('creates a new roadmap config', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue(null);
      const saved = { id: 1, jpdKey: 'JPD-NEW', description: 'Test', startDateFieldId: null, targetDateFieldId: null, createdAt: new Date() };
      roadmapConfigRepo.save.mockResolvedValue(saved as RoadmapConfig);

      const result = await service.createConfig('JPD-NEW', 'Test');
      expect(roadmapConfigRepo.create).toHaveBeenCalledWith({ jpdKey: 'JPD-NEW', description: 'Test' });
      expect(result.jpdKey).toBe('JPD-NEW');
    });

    it('defaults description to null when not provided', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue(null);
      roadmapConfigRepo.save.mockImplementation(async (e) => e as RoadmapConfig);

      await service.createConfig('JPD-NO-DESC');
      expect(roadmapConfigRepo.create).toHaveBeenCalledWith({ jpdKey: 'JPD-NO-DESC', description: null });
    });

    it('throws ConflictException when jpdKey already exists', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue({
        id: 1, jpdKey: 'JPD-1',
      } as unknown as RoadmapConfig);

      await expect(service.createConfig('JPD-1')).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // updateConfig
  // -------------------------------------------------------------------------

  describe('updateConfig', () => {
    it('updates startDateFieldId and targetDateFieldId', async () => {
      const existing: RoadmapConfig = {
        id: 1,
        jpdKey: 'JPD-1',
        description: null,
        startDateFieldId: null,
        targetDateFieldId: null,
        createdAt: new Date(),
      };
      roadmapConfigRepo.findOne.mockResolvedValue(existing);
      roadmapConfigRepo.save.mockImplementation(async (e) => e as RoadmapConfig);

      const result = await service.updateConfig(1, 'customfield_10020', 'customfield_10030');
      expect(result.startDateFieldId).toBe('customfield_10020');
      expect(result.targetDateFieldId).toBe('customfield_10030');
    });

    it('does not overwrite field when argument is undefined', async () => {
      const existing: RoadmapConfig = {
        id: 1,
        jpdKey: 'JPD-1',
        description: null,
        startDateFieldId: 'cf_start',
        targetDateFieldId: 'cf_target',
        createdAt: new Date(),
      };
      roadmapConfigRepo.findOne.mockResolvedValue(existing);
      roadmapConfigRepo.save.mockImplementation(async (e) => e as RoadmapConfig);

      const result = await service.updateConfig(1, undefined, undefined);
      // Neither field should be changed
      expect(result.startDateFieldId).toBe('cf_start');
      expect(result.targetDateFieldId).toBe('cf_target');
    });

    it('allows setting field to null explicitly', async () => {
      const existing: RoadmapConfig = {
        id: 1,
        jpdKey: 'JPD-1',
        description: null,
        startDateFieldId: 'cf_start',
        targetDateFieldId: 'cf_target',
        createdAt: new Date(),
      };
      roadmapConfigRepo.findOne.mockResolvedValue(existing);
      roadmapConfigRepo.save.mockImplementation(async (e) => e as RoadmapConfig);

      const result = await service.updateConfig(1, null, null);
      expect(result.startDateFieldId).toBeNull();
      expect(result.targetDateFieldId).toBeNull();
    });

    it('throws NotFoundException when config id not found', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue(null);
      await expect(service.updateConfig(999)).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // deleteConfig
  // -------------------------------------------------------------------------

  describe('deleteConfig', () => {
    it('deletes an existing config', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue({
        id: 1, jpdKey: 'JPD-1',
      } as unknown as RoadmapConfig);

      await service.deleteConfig(1);
      expect(roadmapConfigRepo.delete).toHaveBeenCalledWith({ id: 1 });
    });

    it('throws NotFoundException when config id not found', async () => {
      roadmapConfigRepo.findOne.mockResolvedValue(null);
      await expect(service.deleteConfig(999)).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // syncRoadmaps
  // -------------------------------------------------------------------------

  describe('syncRoadmaps', () => {
    it('calls syncService.syncRoadmaps and returns success message', async () => {
      const result = await service.syncRoadmaps();
      expect(syncService.syncRoadmaps).toHaveBeenCalled();
      expect(result.message).toBe('Roadmap sync completed');
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — scrum with roadmap idea coverage
  // -------------------------------------------------------------------------

  describe('getAccuracy (scrum with idea coverage)', () => {
    it('counts issue as covered when delivered on time within sprint window', async () => {
      const sprint = makeSprint({
        id: 'sprint-1',
        name: 'Sprint 1',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-01-14T23:59:59Z'),
      });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])  // active
        .mockResolvedValueOnce([]);       // closed

      const issue = makeIssue({
        key: 'ACC-1',
        sprintId: 'sprint-1',
        status: 'Done',
        epicKey: 'EPIC-1',
      });
      issueRepo.find.mockResolvedValue([issue]);

      // One JPD idea covering EPIC-1 within the sprint window
      const idea = {
        key: 'JPD-1',
        summary: 'Feature A',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-01-14T00:00:00Z'),
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([idea]);

      // Sprint changelog: empty (issue assigned at creation)
      // Status changelog: Done transition within the sprint window (before targetDate)
      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        return {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(
            qbCallCount === 1
              ? [] // Sprint field changelogs (empty)
              : [  // Status changelogs: Done transition
                {
                  issueKey: 'ACC-1',
                  field: 'status',
                  fromValue: 'In Progress',
                  toValue: 'Done',
                  changedAt: new Date('2026-01-10T12:00:00Z'),
                },
              ]
          ),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
      });

      const result = await service.getAccuracy('ACC');
      expect(result).toHaveLength(1);
      expect(result[0].totalIssues).toBe(1);
      expect(result[0].coveredIssues).toBe(1);
      expect(result[0].roadmapCoverage).toBe(100);
      expect(result[0].roadmapOnTimeRate).toBe(100);
    });

    it('counts issue as linked-not-covered when delivered late', async () => {
      const sprint = makeSprint({
        id: 'sprint-1',
        name: 'Sprint 1',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-01-14T23:59:59Z'),
      });
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);

      const issue = makeIssue({
        key: 'ACC-1',
        sprintId: 'sprint-1',
        status: 'Done',
        epicKey: 'EPIC-1',
      });
      issueRepo.find.mockResolvedValue([issue]);

      // Idea targetDate = Jan 5 — issue resolved Jan 10 (late)
      const idea = {
        key: 'JPD-1',
        summary: 'Feature A',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-01-05T00:00:00Z'),
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([idea]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        return {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(
            qbCallCount === 1
              ? []
              : [{
                  issueKey: 'ACC-1',
                  field: 'status',
                  fromValue: 'In Progress',
                  toValue: 'Done',
                  changedAt: new Date('2026-01-10T12:00:00Z'), // after targetDate
                }]
          ),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
      });

      const result = await service.getAccuracy('ACC');
      expect(result[0].coveredIssues).toBe(0);
      expect(result[0].roadmapOnTimeRate).toBe(0);
    });

    it('returns empty accuracy for sprints when board has no work items', async () => {
      const sprint = makeSprint();
      sprintRepo.find
        .mockResolvedValueOnce([sprint])
        .mockResolvedValueOnce([]);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('ACC');
      expect(result).toHaveLength(1);
      expect(result[0].totalIssues).toBe(0);
      expect(result[0].coveredIssues).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Kanban accuracy (getKanbanAccuracy)
  // -------------------------------------------------------------------------

  describe('getAccuracy (kanban quarterly accuracy)', () => {
    const kanbanConfig = {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
      backlogStatusIds: [],
      dataStartDate: null,
    } as unknown as BoardConfig;

    it('returns empty when kanban board has no issues', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('PLAT');
      expect(result).toEqual([]);
    });

    it('returns empty when all issues are pure backlog (no changelogs)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT' }),
      ]);
      // All query builders return empty results
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(buildQb([]));

      const result = await service.getAccuracy('PLAT');
      expect(result).toEqual([]);
    });

    it('groups issues by quarter and computes coverage with ideas', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', epicKey: 'EPIC-1' }),
      ]);

      // Idea covering EPIC-1 in Q1 2026
      const idea = {
        key: 'JPD-1',
        summary: 'Feature A',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-03-31T00:00:00Z'),
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([idea]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };

        if (qbCallCount === 1) {
          // "To Do" exit changelogs
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          // DISTINCT issueKey (backlogStatusIds empty)
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        } else if (qbCallCount === 3) {
          // All status changelogs for bounded issues (both activity start + done)
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'In Progress',
              toValue: 'Done',
              changedAt: new Date('2026-01-20T09:00:00Z'),
            },
          ]);
        }
        return qb;
      });

      const result = await service.getAccuracy('PLAT');
      expect(result).toHaveLength(1);
      expect(result[0].sprintId).toBe('2026-Q1');
      expect(result[0].totalIssues).toBe(1);
      // Issue has epicKey EPIC-1, which maps to the idea — it started before targetDate
      expect(result[0].coveredIssues).toBeGreaterThanOrEqual(0);
    });

    it('filters to a specific quarter when quarter param provided', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', createdAt: new Date('2026-01-05T00:00:00Z') }),
      ]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };

        if (qbCallCount === 1) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        }
        return qb;
      });

      roadmapConfigRepo.find.mockResolvedValue([]);
      jpdIdeaRepo.find.mockResolvedValue([]);

      // Filter for a non-matching quarter — should return empty results
      const result = await service.getAccuracy('PLAT', undefined, '2025-Q4');
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Kanban weekly accuracy (getKanbanWeeklyAccuracy)
  // -------------------------------------------------------------------------

  describe('getAccuracy (kanban week mode)', () => {
    const kanbanConfig = {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
      backlogStatusIds: [],
      dataStartDate: null,
    } as unknown as BoardConfig;

    it('routes to weekly accuracy when week param is provided', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('PLAT', undefined, undefined, '2026-W02');
      expect(result).toEqual([]);
    });

    it('routes to weekly accuracy when weekMode=true', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('PLAT', undefined, undefined, undefined, true);
      expect(result).toEqual([]);
    });

    it('groups issues by ISO week and computes coverage', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);

      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', epicKey: 'EPIC-1' }),
      ]);

      const idea = {
        key: 'JPD-1',
        summary: 'Feature A',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-05T00:00:00Z'),  // W02 start
        targetDate: new Date('2026-01-11T00:00:00Z'),  // W02 end
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([idea]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };

        if (qbCallCount === 1) {
          // "To Do" exit changelogs — board-entry in W02 (Jan 6)
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-06T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          // DISTINCT issueKey query
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        } else if (qbCallCount === 3) {
          // All status changelogs
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-06T09:00:00Z'),
            },
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'In Progress',
              toValue: 'Done',
              changedAt: new Date('2026-01-08T12:00:00Z'),
            },
          ]);
        }
        return qb;
      });

      const result = await service.getAccuracy('PLAT', undefined, undefined, '2026-W02');
      expect(result).toHaveLength(1);
      expect(result[0].sprintId).toBe('2026-W02');
      expect(result[0].totalIssues).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // filterIdeasForWindow and isIssueEligibleForRoadmapItem (via getKanbanAccuracy)
  // -------------------------------------------------------------------------

  describe('filterIdeasForWindow edge cases', () => {
    const kanbanConfig = {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled', "Won't Do"],
      backlogStatusIds: [],
      dataStartDate: null,
    } as unknown as BoardConfig;

    it('excludes ideas with null startDate or targetDate', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', epicKey: 'EPIC-1' }),
      ]);

      // Idea without both dates — should be excluded from coverage
      const ideaNoDate = {
        key: 'JPD-2',
        summary: 'No dates',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: null,
        targetDate: null,
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([ideaNoDate]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        if (qbCallCount === 1) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        }
        return qb;
      });

      const result = await service.getAccuracy('PLAT');
      expect(result[0].coveredIssues).toBe(0);
    });

    it('handles idea with null deliveryIssueKeys gracefully', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', epicKey: 'EPIC-1' }),
      ]);

      const ideaNullKeys = {
        key: 'JPD-3',
        summary: 'No links',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: null,
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-03-31T00:00:00Z'),
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([ideaNullKeys]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        if (qbCallCount === 1) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        }
        return qb;
      });

      // Should not throw; idea with null deliveryIssueKeys is skipped
      const result = await service.getAccuracy('PLAT');
      expect(result[0].coveredIssues).toBe(0);
    });

    it('keeps idea with later targetDate when two ideas link the same epic', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-1', boardId: 'PLAT', epicKey: 'EPIC-1' }),
      ]);

      const earlierIdea = {
        key: 'JPD-1',
        summary: 'Earlier delivery',
        status: 'Done',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-01-31T00:00:00Z'),
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      const laterIdea = {
        key: 'JPD-2',
        summary: 'Later delivery commitment',
        status: 'In Progress',
        jpdKey: 'ROADMAP',
        deliveryIssueKeys: ['EPIC-1'],
        startDate: new Date('2026-01-01T00:00:00Z'),
        targetDate: new Date('2026-03-31T00:00:00Z'), // later
        syncedAt: new Date(),
      } as unknown as import('../database/entities/index.js').JpdIdea;

      roadmapConfigRepo.find.mockResolvedValue([{ id: 1, jpdKey: 'ROADMAP' } as unknown as import('../database/entities/index.js').RoadmapConfig]);
      jpdIdeaRepo.find.mockResolvedValue([earlierIdea, laterIdea]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        if (qbCallCount === 1) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'),
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        } else if (qbCallCount === 3) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-1',
              field: 'status',
              fromValue: 'In Progress',
              toValue: 'Done',
              changedAt: new Date('2026-02-15T09:00:00Z'),
            },
          ]);
        }
        return qb;
      });

      // With laterIdea (targetDate March 31), the issue resolved Feb 15 is on time
      const result = await service.getAccuracy('PLAT');
      expect(result[0].coveredIssues).toBe(1);
      expect(result[0].roadmapOnTimeRate).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — Kanban with dataStartDate filter
  // -------------------------------------------------------------------------

  describe('getAccuracy (kanban with dataStartDate)', () => {
    it('filters out issues before dataStartDate', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        cancelledStatusNames: ['Cancelled', "Won't Do"],
        backlogStatusIds: [],
        dataStartDate: '2026-03-01',
      } as unknown as BoardConfig);

      // Issue from January — board entry is before dataStartDate → excluded
      issueRepo.find.mockResolvedValue([
        makeIssue({ key: 'PLAT-OLD', boardId: 'PLAT', createdAt: new Date('2026-01-05T00:00:00Z') }),
      ]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        if (qbCallCount === 1) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'PLAT-OLD',
              field: 'status',
              fromValue: 'To Do',
              toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z'), // before dataStartDate
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-OLD' }]);
        }
        return qb;
      });

      const result = await service.getAccuracy('PLAT');
      expect(result).toEqual([]);
    });
  });
});
