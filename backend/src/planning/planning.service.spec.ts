import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanningService } from './planning.service.js';
import { Repository } from 'typeorm';
import {
  JiraSprint,
  JiraIssue,
  JiraChangelog,
  BoardConfig,
} from '../database/entities/index.js';

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

function mockConfigService(): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockImplementation((_key: string, defaultValue?: unknown) => defaultValue ?? 'UTC'),
  } as unknown as jest.Mocked<ConfigService>;
}

describe('PlanningService', () => {
  let service: PlanningService;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    sprintRepo = mockRepo<JiraSprint>();
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new PlanningService(
      sprintRepo,
      issueRepo,
      changelogRepo,
      boardConfigRepo,
      mockConfigService(),
    );
  });

  describe('getAccuracy', () => {
    it('should throw for Kanban boards', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        inProgressStatusNames: ['In Progress'],
        dataStartDate: null,
      } as unknown as BoardConfig);

      await expect(service.getAccuracy('PLAT')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getAccuracy('PLAT')).rejects.toThrow(
        'Planning accuracy is not available for Kanban boards',
      );
    });

    it('should return empty array when no sprints found', async () => {
      sprintRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('ACC');

      expect(result).toEqual([]);
    });

    it('should calculate sprint accuracy with committed issues', async () => {
      const sprint: JiraSprint = {
        id: 'sprint-1',
        name: 'Sprint 1',
        boardId: 'ACC',
        state: 'closed',
        startDate: new Date('2025-01-06'),
        endDate: new Date('2025-01-20'),
        goal: '',
      } as JiraSprint;

      // find is called twice: once for active sprints (empty), once for closed sprints
      sprintRepo.find
        .mockResolvedValueOnce([])         // active sprints
        .mockResolvedValueOnce([sprint]);  // closed sprints

      // All board issues (includes issues from this sprint)
      issueRepo.find.mockResolvedValue([
        { key: 'ACC-1', sprintId: 'sprint-1', status: 'Done', boardId: 'ACC', issueType: 'Story', points: null, createdAt: new Date('2025-01-01') },
        { key: 'ACC-2', sprintId: 'sprint-1', status: 'Done', boardId: 'ACC', issueType: 'Story', points: null, createdAt: new Date('2025-01-01') },
        { key: 'ACC-3', sprintId: 'sprint-1', status: 'In Progress', boardId: 'ACC', issueType: 'Story', points: null, createdAt: new Date('2025-01-01') },
      ] as unknown as JiraIssue[]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn(),
        };

        if (qbCallCount === 1) {
          // Sprint changelogs: all 3 added before sprint start
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'ACC-1',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2025-01-04'),
            },
            {
              issueKey: 'ACC-2',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2025-01-05'),
            },
            {
              issueKey: 'ACC-3',
              field: 'Sprint',
              toValue: 'Sprint 1',
              fromValue: null,
              changedAt: new Date('2025-01-05'),
            },
          ]);
        } else if (qbCallCount === 2) {
          // Status changelogs for final sprint issues
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'ACC-1',
              field: 'status',
              toValue: 'Done',
              changedAt: new Date('2025-01-15'),
            },
            {
              issueKey: 'ACC-2',
              field: 'status',
              toValue: 'Done',
              changedAt: new Date('2025-01-18'),
            },
          ]);
        } else {
          qb.getMany.mockResolvedValue([]);
        }
        return qb;
      });

      const result = await service.getAccuracy('ACC');

      expect(result).toHaveLength(1);
      expect(result[0].commitment).toBe(3);
      expect(result[0].added).toBe(0);
      expect(result[0].removed).toBe(0);
      // completed: ACC-1 (Done status), ACC-2 (Done status) = 2
      // ACC-3 is In Progress and has no done transition
      expect(result[0].completed).toBe(2);
      // completionRate = 2 / (3 + 0 - 0) * 100 = 66.67
      expect(result[0].completionRate).toBeCloseTo(66.67, 1);
    });

    it('should detect added issues (after sprint start)', async () => {
      const sprint: JiraSprint = {
        id: 'sprint-2',
        name: 'Sprint 2',
        boardId: 'ACC',
        state: 'closed',
        startDate: new Date('2025-02-01'),
        endDate: new Date('2025-02-14'),
        goal: '',
      } as JiraSprint;

      // find is called twice: once for active sprints (empty), once for closed sprints
      sprintRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([sprint]);

      issueRepo.find.mockResolvedValue([
        { key: 'ACC-10', sprintId: 'sprint-2', status: 'Done', boardId: 'ACC', issueType: 'Story', points: null, createdAt: new Date('2025-01-01') },
        { key: 'ACC-11', sprintId: 'sprint-2', status: 'Done', boardId: 'ACC', issueType: 'Story', points: null, createdAt: new Date('2025-01-01') },
      ] as unknown as JiraIssue[]);

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn(),
        };

        if (qbCallCount === 1) {
          // Sprint changelogs: ACC-10 before start, ACC-11 after start
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'ACC-10',
              field: 'Sprint',
              toValue: 'Sprint 2',
              fromValue: null,
              changedAt: new Date('2025-01-30'),
            },
            {
              issueKey: 'ACC-11',
              field: 'Sprint',
              toValue: 'Sprint 2',
              fromValue: null,
              changedAt: new Date('2025-02-05'), // After sprint start
            },
          ]);
        } else if (qbCallCount === 2) {
          qb.getMany.mockResolvedValue([
            {
              issueKey: 'ACC-10',
              field: 'status',
              toValue: 'Done',
              changedAt: new Date('2025-02-10'),
            },
            {
              issueKey: 'ACC-11',
              field: 'status',
              toValue: 'Done',
              changedAt: new Date('2025-02-12'),
            },
          ]);
        } else {
          qb.getMany.mockResolvedValue([]);
        }
        return qb;
      });

      const result = await service.getAccuracy('ACC');

      expect(result[0].commitment).toBe(1);
      expect(result[0].added).toBe(1);
      expect(result[0].scopeChangePercent).toBe(100); // (1+0)/1 * 100
    });
  });

  describe('getSprints', () => {
    it('should return sprints for a board', async () => {
      sprintRepo.find.mockResolvedValue([
        { id: 's1', name: 'Sprint 1', state: 'closed', boardId: 'ACC' },
        { id: 's2', name: 'Sprint 2', state: 'active', boardId: 'ACC' },
      ] as JiraSprint[]);

      const result = await service.getSprints('ACC');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 's1',
        name: 'Sprint 1',
        state: 'closed',
      });
    });
  });

  describe('getQuarters', () => {
    it('should extract unique quarters from sprint dates', async () => {
      sprintRepo.find.mockResolvedValue([
        {
          id: 's1',
          state: 'closed',
          startDate: new Date('2025-01-10'),
        },
        {
          id: 's2',
          state: 'closed',
          startDate: new Date('2025-01-24'),
        },
        {
          id: 's3',
          state: 'closed',
          startDate: new Date('2025-04-01'),
        },
      ] as JiraSprint[]);

      const result = await service.getQuarters();

      expect(result).toHaveLength(2);
      expect(result[0].quarter).toBe('2025-Q2');
      expect(result[1].quarter).toBe('2025-Q1');
    });

    it('should return empty array when no sprints', async () => {
      sprintRepo.find.mockResolvedValue([]);

      const result = await service.getQuarters();

      expect(result).toEqual([]);
    });

    it('should skip sprints with no startDate', async () => {
      sprintRepo.find.mockResolvedValue([
        { id: 's1', state: 'closed', startDate: null } as unknown as JiraSprint,
        { id: 's2', state: 'closed', startDate: new Date('2025-01-10') } as unknown as JiraSprint,
      ]);

      const result = await service.getQuarters();
      expect(result).toHaveLength(1);
      expect(result[0].quarter).toBe('2025-Q1');
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — sprintId path
  // -------------------------------------------------------------------------

  describe('getAccuracy with sprintId', () => {
    it('returns accuracy for a single sprint by id', async () => {
      const sprint: JiraSprint = {
        id: 'sprint-5',
        name: 'Sprint 5',
        boardId: 'ACC',
        state: 'closed',
        startDate: new Date('2026-01-06'),
        endDate: new Date('2026-01-20'),
        goal: '',
      } as JiraSprint;

      sprintRepo.findOne.mockResolvedValue(sprint);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getAccuracy('ACC', 'sprint-5');

      expect(sprintRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'sprint-5', boardId: 'ACC' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].sprintId).toBe('sprint-5');
    });

    it('returns empty array when sprintId not found', async () => {
      sprintRepo.findOne.mockResolvedValue(null);
      const result = await service.getAccuracy('ACC', 'nonexistent');
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAccuracy — quarter path
  // -------------------------------------------------------------------------

  describe('getAccuracy with quarter', () => {
    it('uses createQueryBuilder to fetch sprints in quarter date range', async () => {
      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      sprintRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getAccuracy('ACC', undefined, '2026-Q1');

      expect(sprintRepo.createQueryBuilder).toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getKanbanQuarters
  // -------------------------------------------------------------------------

  describe('getKanbanQuarters', () => {
    it('throws BadRequestException when board is not Kanban', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
      } as unknown as BoardConfig);

      await expect(service.getKanbanQuarters('ACC')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no board config exists', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null);
      await expect(service.getKanbanQuarters('PLAT')).rejects.toThrow(BadRequestException);
    });

    it('returns empty array when kanban board has no issues', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getKanbanQuarters('PLAT');
      expect(result).toEqual([]);
    });

    it('returns empty array when all issues are backlog (no status changelogs)', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);
      issueRepo.find.mockResolvedValue([
        { key: 'PLAT-1', boardId: 'PLAT', issueType: 'Story', summary: 'S', status: 'To Do',
          labels: [], epicKey: null, fixVersion: null, sprintId: null, createdAt: new Date('2026-01-05T00:00:00Z'),
          priority: null, points: null, statusId: null } as unknown as JiraIssue,
      ]);

      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        return qb;
      });

      const result = await service.getKanbanQuarters('PLAT');
      expect(result).toEqual([]);
    });

    it('groups issues into quarters by board-entry date', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        { key: 'PLAT-1', boardId: 'PLAT', issueType: 'Story', summary: 'S', status: 'Done',
          labels: [], epicKey: null, fixVersion: null, sprintId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
          priority: null, points: null, statusId: null } as unknown as JiraIssue,
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
          // Call 1: "To Do" exit changelogs (board-entry date)
          qb.getMany.mockResolvedValue([
            { issueKey: 'PLAT-1', field: 'status', fromValue: 'To Do', toValue: 'In Progress',
              changedAt: new Date('2026-01-10T09:00:00Z') },
          ]);
        } else if (qbCallCount === 2) {
          // Call 2: DISTINCT issueKey query (backlogStatusIds is empty, uses getRawMany)
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        } else if (qbCallCount === 3) {
          // Call 3: done-transition changelogs
          qb.getMany.mockResolvedValue([
            { issueKey: 'PLAT-1', field: 'status', fromValue: 'In Progress', toValue: 'Done',
              changedAt: new Date('2026-01-20T09:00:00Z') },
          ]);
        }
        return qb;
      });

      const result = await service.getKanbanQuarters('PLAT');
      expect(result).toHaveLength(1);
      expect(result[0].quarter).toBe('2026-Q1');
      expect(result[0].issuesPulledIn).toBe(1);
      expect(result[0].completed).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getKanbanWeeks
  // -------------------------------------------------------------------------

  describe('getKanbanWeeks', () => {
    it('throws BadRequestException when board is not Kanban', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
      } as unknown as BoardConfig);

      await expect(service.getKanbanWeeks('ACC')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no board config exists', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null);
      await expect(service.getKanbanWeeks('PLAT')).rejects.toThrow(BadRequestException);
    });

    it('returns empty array when kanban board has no issues', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getKanbanWeeks('PLAT');
      expect(result).toEqual([]);
    });

    it('groups issues into weeks by board-entry date', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        { key: 'PLAT-1', boardId: 'PLAT', issueType: 'Story', summary: 'S', status: 'Done',
          labels: [], epicKey: null, fixVersion: null, sprintId: null, createdAt: new Date('2026-01-01T00:00:00Z'),
          priority: null, points: null, statusId: null } as unknown as JiraIssue,
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
          // Call 1: "To Do" exit changelogs (board-entry date) — issue entered in W02 2026
          qb.getMany.mockResolvedValue([
            { issueKey: 'PLAT-1', field: 'status', fromValue: 'To Do', toValue: 'In Progress',
              changedAt: new Date('2026-01-06T09:00:00Z') },
          ]);
        } else if (qbCallCount === 2) {
          // Call 2: DISTINCT issueKey query (backlogStatusIds is empty, uses getRawMany)
          qb.getRawMany.mockResolvedValue([{ issueKey: 'PLAT-1' }]);
        } else if (qbCallCount === 3) {
          // Call 3: done-transition changelogs
          qb.getMany.mockResolvedValue([
            { issueKey: 'PLAT-1', field: 'status', fromValue: 'In Progress', toValue: 'Done',
              changedAt: new Date('2026-01-08T09:00:00Z') },
          ]);
        }
        return qb;
      });

      const result = await service.getKanbanWeeks('PLAT');
      expect(result).toHaveLength(1);
      expect(result[0].week).toBe('2026-W02');
      expect(result[0].issuesPulledIn).toBe(1);
      expect(result[0].completed).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // C-3: boardEntryStatuses — configurable board-entry status list
  // -------------------------------------------------------------------------

  describe('C-3: boardEntryStatuses', () => {
    it('queries board-entry using toValue IN boardEntryStatuses (not fromValue = To Do)', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
        boardEntryStatuses: ['Backlog', 'To Do', 'Open'],
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'PLAT-1', boardId: 'PLAT', issueType: 'Story', summary: 'S',
          status: 'Done', labels: [], epicKey: null, fixVersion: null,
          sprintId: null, createdAt: new Date('2025-12-01T00:00:00Z'),
          priority: null, points: null, statusId: null,
        } as unknown as JiraIssue,
      ]);

      const firstQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            issueKey: 'PLAT-1', field: 'status', fromValue: null,
            toValue: 'Backlog',
            changedAt: new Date('2026-01-05T09:00:00Z'),
          },
        ]),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) return firstQb;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'PLAT-1' }]),
        };
        return qb;
      });

      await service.getKanbanQuarters('PLAT');

      // After fix: first board-entry query uses toValue IN (...) not fromValue = 'To Do'
      const andWhereCalls = firstQb.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereCalls).not.toContain('cl.fromValue = :from');
      expect(andWhereCalls.some((c: string) => c.includes('toValue IN'))).toBe(true);
    });

    it('includes extended default statuses (Backlog, Open, New) when not configured', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
        doneStatusNames: ['Done'],
        backlogStatusIds: [],
        dataStartDate: null,
        // boardEntryStatuses: not set
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'PLAT-2', boardId: 'PLAT', issueType: 'Story', summary: 'T',
          status: 'Done', labels: [], epicKey: null, fixVersion: null,
          sprintId: null, createdAt: new Date('2025-11-01T00:00:00Z'),
          priority: null, points: null, statusId: null,
        } as unknown as JiraIssue,
      ]);

      const firstQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      let qbCallCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) return firstQb;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        return qb;
      });

      await service.getKanbanQuarters('PLAT');

      // The second andWhere call for the board-entry query should pass the default list
      // containing at minimum 'To Do', 'Backlog', 'Open', 'New'
      const andWhereCalls = firstQb.andWhere.mock.calls;
      const statusesCall = andWhereCalls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('toValue IN'),
      );
      expect(statusesCall).toBeDefined();
      const statusesArg = statusesCall![1] as { statuses: string[] };
      expect(statusesArg.statuses).toContain('To Do');
      expect(statusesArg.statuses).toContain('Backlog');
      expect(statusesArg.statuses).toContain('Open');
      expect(statusesArg.statuses).toContain('New');
    });
  });
});
