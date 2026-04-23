import { LeadTimeService } from './lead-time.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  WorkingTimeConfigEntity,
} from '../database/entities/index.js';
import { WorkingTimeService } from './working-time.service.js';
import type { TrendDataSlice } from './trend-data-loader.service.js';

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('LeadTimeService', () => {
  let service: LeadTimeService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let versionRepo: jest.Mocked<Repository<JiraVersion>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let workingTimeService: jest.Mocked<WorkingTimeService>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    versionRepo = mockRepo<JiraVersion>();
    boardConfigRepo = mockRepo<BoardConfig>();

    workingTimeService = {
      getConfig: jest.fn().mockResolvedValue({
        id: 1, excludeWeekends: false, workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
      }),
      toConfig: jest.fn().mockReturnValue({
        timezone: 'UTC', workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
      }),
      workingDaysBetween: jest.fn(),
      workingHoursBetween: jest.fn(),
    } as unknown as jest.Mocked<WorkingTimeService>;

    service = new LeadTimeService(
      issueRepo,
      changelogRepo,
      versionRepo,
      boardConfigRepo,
      workingTimeService,
    );
  });

  it('should return zero for empty board', async () => {
    const result = await service.calculate(
      'ACC',
      new Date('2025-01-01'),
      new Date('2025-03-31'),
    );

    expect(result.boardId).toBe('ACC');
    expect(result.medianDays).toBe(0);
    expect(result.sampleSize).toBe(0);
  });

  it('should calculate median lead time from changelogs', async () => {
    const created = new Date('2025-01-01');
    const inProgress = new Date('2025-01-01T00:01:00Z'); // started almost immediately
    const done = new Date('2025-01-04'); // 3 days later
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', createdAt: created, fixVersion: null, labels: [] },
    ] as unknown as JiraIssue[]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: done },
      ]),
      getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const result = await service.calculate('ACC', start, end);

    // lead time = inProgress → done ≈ 3 days
    expect(result.medianDays).toBeCloseTo(3, 1);
    expect(result.sampleSize).toBe(1);
    expect(result.band).toBe('high');
  });

  it('should use cycle time for Kanban boards', async () => {
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      inProgressStatusNames: ['In Progress'],
      dataStartDate: null,
    } as unknown as BoardConfig);

    const created = new Date('2025-01-01');
    const inProgress = new Date('2025-01-05'); // started 4 days after creation
    const done = new Date('2025-01-06'); // 1 day in progress
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    issueRepo.find.mockResolvedValue([
      { key: 'PLAT-1', boardId: 'PLAT', issueType: 'Story', createdAt: created, fixVersion: null, labels: [] },
    ] as unknown as JiraIssue[]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'PLAT-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'PLAT-1', field: 'status', toValue: 'Done', changedAt: done },
      ]),
      getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'PLAT-1' }]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const result = await service.calculate('PLAT', start, end);

    // Cycle time should be from In Progress → Done = 1 day
    expect(result.medianDays).toBe(1);
    expect(result.band).toBe('high');
  });

  it('should calculate p95 lead time', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-06-30');
    // Create 20 issues with varying lead times
    const issues = Array.from({ length: 20 }, (_, i) => ({
      key: `ACC-${i + 1}`,
      boardId: 'ACC',
      issueType: 'Story',
      createdAt: new Date('2025-01-01'),
      fixVersion: null,
      labels: [],
    }));

    issueRepo.find.mockResolvedValue(issues as unknown as JiraIssue[]);

    // Each issue gets an In Progress then Done transition; lead time = (i+1) days
    const changelogs = issues.flatMap((issue, i) => [
      {
        issueKey: issue.key,
        field: 'status',
        toValue: 'In Progress',
        changedAt: new Date('2025-01-01T01:00:00Z'),
      },
      {
        issueKey: issue.key,
        field: 'status',
        toValue: 'Done',
        changedAt: new Date(new Date('2025-01-01').getTime() + (i + 1) * 24 * 60 * 60 * 1000),
      },
    ]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(changelogs),
      getRawMany: jest.fn().mockResolvedValue(issues.map(i => ({ issueKey: i.key }))),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const result = await service.calculate('ACC', start, end);

    expect(result.sampleSize).toBe(20);
    expect(result.p95Days).toBeGreaterThan(result.medianDays);
  });

  // ---------------------------------------------------------------------------
  // excludeWeekends = true: delegates to WorkingTimeService
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Fix 0034: in-flight issues (In Progress before startDate) must be included
  // ---------------------------------------------------------------------------

  it('includes issues whose In Progress transition precedes startDate (proposal 0034)', async () => {
    const start = new Date('2025-02-01');
    const end   = new Date('2025-03-31');

    // Issue started In Progress before the measurement window opens
    const inProgress = new Date('2025-01-10T09:00:00Z'); // before start
    const done       = new Date('2025-02-15T09:00:00Z'); // within window

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', createdAt: inProgress, fixVersion: null, labels: [] },
    ] as unknown as JiraIssue[]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: done },
      ]),
      getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const { observations, anomalyCount } = await service.getLeadTimeObservations('ACC', start, end);

    // Issue must appear in the sample (not discarded as anomaly)
    expect(observations).toHaveLength(1);
    expect(anomalyCount).toBe(0);
    // Lead time = In Progress → Done ≈ 36 days
    expect(observations[0]).toBeGreaterThan(30);
  });

  it('does not pass a changedAt lower-bound to the changelog query builder', async () => {
    const start = new Date('2025-01-01');
    const end   = new Date('2025-03-31');

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', createdAt: new Date('2024-06-01'), fixVersion: null, labels: [] },
    ] as unknown as JiraIssue[]);

    // The service makes two createQueryBuilder calls:
    //   1st: doneRows — uses .select().getRawMany() with a BETWEEN clause (expected)
    //   2nd: changelogs — uses .getMany() and must NOT have a changedAt clause
    // Use separate QB instances so we can assert on the second call independently.
    const changelogAndWhere = jest.fn().mockReturnThis();
    const doneRowsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
    };
    const changelogQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: changelogAndWhere,
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    let callCount = 0;
    changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? doneRowsQb : changelogQb;
    });
    versionRepo.find.mockResolvedValue([]);

    await service.getLeadTimeObservations('ACC', start, end);

    const changedAtCall = changelogAndWhere.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('changedAt'),
    );
    expect(changedAtCall).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Change 2: getLeadTimeObservationsFromData — in-memory variant
  // ---------------------------------------------------------------------------

  describe('getLeadTimeObservationsFromData', () => {
    function makeWtEntity(excludeWeekends = false): WorkingTimeConfigEntity {
      return Object.assign(new WorkingTimeConfigEntity(), {
        id: 1,
        excludeWeekends,
        workDays: [1, 2, 3, 4, 5],
        hoursPerDay: 8,
        holidays: [] as string[],
      });
    }

    function makeSlice(overrides: Partial<TrendDataSlice> = {}): TrendDataSlice {
      return {
        boardId: 'ACC',
        boardConfig: null,
        wtEntity: makeWtEntity(),
        issues: [],
        changelogs: [],
        versions: [],
        issueLinks: [],
        ...overrides,
      };
    }

    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    it('returns empty observations for an empty slice', () => {
      const result = service.getLeadTimeObservationsFromData(makeSlice(), start, end);
      expect(result.observations).toHaveLength(0);
      expect(result.anomalyCount).toBe(0);
    });

    it('calculates lead time from In Progress to Done within the period', () => {
      const inProgress = new Date('2025-01-01T00:01:00Z');
      const done = new Date('2025-01-04T00:00:00Z');

      const slice = makeSlice({
        issues: [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', fixVersion: null, labels: [] } as JiraIssue,
        ],
        changelogs: [
          { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress } as JiraChangelog,
          { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: done }        as JiraChangelog,
        ],
        versions: [],
      });

      const result = service.getLeadTimeObservationsFromData(slice, start, end);
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]).toBeCloseTo(3, 1);
    });

    it('excludes done transitions outside the period', () => {
      const inProgress = new Date('2024-12-01T00:00:00Z');
      const done = new Date('2024-12-20T00:00:00Z'); // before start

      const slice = makeSlice({
        issues: [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', fixVersion: null, labels: [] } as JiraIssue,
        ],
        changelogs: [
          { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress } as JiraChangelog,
          { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: done }        as JiraChangelog,
        ],
        versions: [],
      });

      const result = service.getLeadTimeObservationsFromData(slice, start, end);
      expect(result.observations).toHaveLength(0);
    });

    it('counts anomaly when no In Progress transition exists', () => {
      const slice = makeSlice({
        issues: [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', fixVersion: null, labels: [] } as JiraIssue,
        ],
        changelogs: [
          { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: new Date('2025-02-01') } as JiraChangelog,
        ],
        versions: [],
      });

      const result = service.getLeadTimeObservationsFromData(slice, start, end);
      expect(result.anomalyCount).toBe(1);
      expect(result.observations).toHaveLength(0);
    });

    it('uses workingDaysBetween when wtEntity.excludeWeekends is true', () => {
      workingTimeService.workingDaysBetween.mockReturnValue(2);

      const inProgress = new Date('2025-01-10T09:00:00Z');
      const done      = new Date('2025-01-13T09:00:00Z');

      const slice = makeSlice({
        wtEntity: makeWtEntity(true),
        issues: [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', fixVersion: null, labels: [] } as JiraIssue,
        ],
        changelogs: [
          { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress } as JiraChangelog,
          { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: done }        as JiraChangelog,
        ],
        versions: [],
      });

      const result = service.getLeadTimeObservationsFromData(slice, start, end);
      expect(workingTimeService.workingDaysBetween).toHaveBeenCalledWith(
        inProgress, done, expect.anything(),
      );
      expect(result.observations[0]).toBe(2);
    });
  });

  it('uses workingDaysBetween when excludeWeekends is true', async () => {
    workingTimeService.getConfig.mockResolvedValue({
      id: 1, excludeWeekends: true, workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [],
    });
    workingTimeService.workingDaysBetween.mockReturnValue(1.5);

    const inProgress = new Date('2025-01-10T09:00:00Z'); // Friday
    const done = new Date('2025-01-13T09:00:00Z');       // Monday
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', createdAt: inProgress, fixVersion: null, labels: [] },
    ] as unknown as JiraIssue[]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: done },
      ]),
      getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const result = await service.calculate('ACC', start, end);

    // workingDaysBetween was called with the correct start/end dates
    expect(workingTimeService.workingDaysBetween).toHaveBeenCalledWith(
      inProgress,
      done,
      expect.anything(),
    );
    // The returned value from workingDaysBetween is used as medianDays
    expect(result.medianDays).toBe(1.5);
  });
});
