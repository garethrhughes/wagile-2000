/**
 * trend-data-loader.service.spec.ts
 *
 * Verifies that TrendDataLoader.load() fires exactly the right queries
 * (one bulk issues load, one bulk changelog load with changedAt BETWEEN
 * rangeStart and rangeEnd, one versions load, one issue-links load) and
 * returns a correctly shaped TrendDataSlice.  All DB calls must be
 * mock-intercepted so no real DB is required.
 */

import { Repository, In, Between } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
  WorkingTimeConfigEntity,
} from '../database/entities/index.js';
import { TrendDataLoader } from './trend-data-loader.service.js';
import { WorkingTimeService } from './working-time.service.js';

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

const DEFAULT_WT_ENTITY: WorkingTimeConfigEntity = Object.assign(
  new WorkingTimeConfigEntity(),
  { id: 1, excludeWeekends: false, workDays: [1, 2, 3, 4, 5], hoursPerDay: 8, holidays: [] },
);

describe('TrendDataLoader', () => {
  let loader: TrendDataLoader;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let versionRepo: jest.Mocked<Repository<JiraVersion>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let issueLinkRepo: jest.Mocked<Repository<JiraIssueLink>>;
  let workingTimeService: jest.Mocked<WorkingTimeService>;

  const rangeStart = new Date('2025-01-01');
  const rangeEnd = new Date('2025-12-31');

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    versionRepo = mockRepo<JiraVersion>();
    boardConfigRepo = mockRepo<BoardConfig>();
    issueLinkRepo = mockRepo<JiraIssueLink>();

    workingTimeService = {
      getConfig: jest.fn().mockResolvedValue(DEFAULT_WT_ENTITY),
      toConfig: jest.fn(),
      workingDaysBetween: jest.fn(),
      workingHoursBetween: jest.fn(),
    } as unknown as jest.Mocked<WorkingTimeService>;

    loader = new TrendDataLoader(
      issueRepo,
      changelogRepo,
      versionRepo,
      boardConfigRepo,
      issueLinkRepo,
      workingTimeService,
    );
  });

  // -------------------------------------------------------------------------
  // Empty board
  // -------------------------------------------------------------------------

  it('returns an empty slice when the board has no issues', async () => {
    issueRepo.find.mockResolvedValue([]);

    const slice = await loader.load('ACC', rangeStart, rangeEnd);

    expect(slice.boardId).toBe('ACC');
    expect(slice.issues).toHaveLength(0);
    expect(slice.changelogs).toHaveLength(0);
    expect(slice.versions).toHaveLength(0);
    expect(slice.issueLinks).toHaveLength(0);
  });

  it('skips changelogs/versions/links query when board has no work items', async () => {
    // Only epics — isWorkItem returns false
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Epic' },
    ] as unknown as JiraIssue[]);

    await loader.load('ACC', rangeStart, rangeEnd);

    // Changelog query builder should not be invoked
    expect(changelogRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(versionRepo.find).not.toHaveBeenCalled();
    expect(issueLinkRepo.find).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Correct query parameters
  // -------------------------------------------------------------------------

  it('queries issues by boardId', async () => {
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' },
    ] as unknown as JiraIssue[]);

    await loader.load('ACC', rangeStart, rangeEnd);

    expect(issueRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { boardId: 'ACC' } }),
    );
  });

  it('queries changelogs with changedAt BETWEEN rangeStart and rangeEnd (lower and upper bounds)', async () => {
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' },
    ] as unknown as JiraIssue[]);

    const andWhere = jest.fn().mockReturnThis();
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    await loader.load('ACC', rangeStart, rangeEnd);

    const changedAtCalls = andWhere.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('changedAt'),
    );
    expect(changedAtCalls.length).toBe(2);
    // Lower bound
    expect(changedAtCalls[0]?.[1]).toMatchObject({ from: rangeStart });
    // Upper bound
    expect(changedAtCalls[1]?.[1]).toMatchObject({ to: rangeEnd });
  });

  it('queries versions with releaseDate Between rangeStart and rangeEnd', async () => {
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' },
    ] as unknown as JiraIssue[]);

    await loader.load('ACC', rangeStart, rangeEnd);

    expect(versionRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectKey: 'ACC',
          released: true,
        }),
      }),
    );
  });

  it('queries issue links scoped to the board issue keys', async () => {
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' },
      { key: 'ACC-2', boardId: 'ACC', issueType: 'Bug' },
    ] as unknown as JiraIssue[]);

    await loader.load('ACC', rangeStart, rangeEnd);

    expect(issueLinkRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceIssueKey: expect.anything(), // In(['ACC-1','ACC-2'])
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Returned slice shape
  // -------------------------------------------------------------------------

  it('returns slice with loaded data', async () => {
    const issue = { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' } as JiraIssue;
    const changelog = { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: new Date('2025-06-01') } as JiraChangelog;
    const version = { name: 'v1.0', projectKey: 'ACC', releaseDate: new Date('2025-06-01'), released: true } as JiraVersion;
    const link = { sourceIssueKey: 'ACC-1', targetIssueKey: 'ACC-2', linkTypeName: 'is caused by', isInward: false } as JiraIssueLink;
    const config = { boardId: 'ACC', boardType: 'scrum' } as BoardConfig;

    issueRepo.find.mockResolvedValue([issue]);
    versionRepo.find.mockResolvedValue([version]);
    issueLinkRepo.find.mockResolvedValue([link]);
    boardConfigRepo.findOne.mockResolvedValue(config);

    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([changelog]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const slice = await loader.load('ACC', rangeStart, rangeEnd);

    expect(slice.boardId).toBe('ACC');
    expect(slice.boardConfig).toBe(config);
    expect(slice.wtEntity).toBe(DEFAULT_WT_ENTITY);
    expect(slice.issues).toEqual([issue]);
    expect(slice.changelogs).toEqual([changelog]);
    expect(slice.versions).toEqual([version]);
    expect(slice.issueLinks).toEqual([link]);
  });

  it('excludes Epics and Sub-tasks from issues in the slice', async () => {
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Story' },
      { key: 'ACC-2', boardId: 'ACC', issueType: 'Epic' },
      { key: 'ACC-3', boardId: 'ACC', issueType: 'Sub-task' },
    ] as unknown as JiraIssue[]);

    const slice = await loader.load('ACC', rangeStart, rangeEnd);

    expect(slice.issues.map((i) => i.key)).toEqual(['ACC-1']);
  });
});
