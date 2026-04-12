import { LeadTimeService } from './lead-time.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
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

describe('LeadTimeService', () => {
  let service: LeadTimeService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let versionRepo: jest.Mocked<Repository<JiraVersion>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    versionRepo = mockRepo<JiraVersion>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new LeadTimeService(
      issueRepo,
      changelogRepo,
      versionRepo,
      boardConfigRepo,
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
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: done },
      ]),
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
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'PLAT-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'PLAT-1', field: 'status', toValue: 'Done', changedAt: done },
      ]),
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
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(changelogs),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    const result = await service.calculate('ACC', start, end);

    expect(result.sampleSize).toBe(20);
    expect(result.p95Days).toBeGreaterThan(result.medianDays);
  });
});
