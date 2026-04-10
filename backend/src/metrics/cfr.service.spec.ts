import { CfrService } from './cfr.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
} from '../database/entities/index.js';

function mockRepo<T>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('CfrService', () => {
  let service: CfrService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let versionRepo: jest.Mocked<Repository<JiraVersion>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let issueLinkRepo: jest.Mocked<Repository<JiraIssueLink>>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    versionRepo = mockRepo<JiraVersion>();
    boardConfigRepo = mockRepo<BoardConfig>();
    issueLinkRepo = mockRepo<JiraIssueLink>();

    service = new CfrService(
      issueRepo,
      changelogRepo,
      versionRepo,
      boardConfigRepo,
      issueLinkRepo,
    );
  });

  it('should return 0% for empty board', async () => {
    const result = await service.calculate(
      'ACC',
      new Date('2025-01-01'),
      new Date('2025-03-31'),
    );

    expect(result.boardId).toBe('ACC');
    expect(result.changeFailureRate).toBe(0);
    expect(result.band).toBe('elite');
  });

  it('should calculate CFR based on failure issue types', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: ['Bug'],
      failureLabels: [],
    } as BoardConfig);

    // 10 issues total: 2 Bugs, 8 Stories
    issueRepo.find.mockImplementation(async (opts) => {
      if (opts && typeof opts === 'object' && 'where' in opts) {
        const where = opts.where as Record<string, unknown>;
        if (where.fixVersion) return [] as JiraIssue[];
      }
      return [
        { key: 'ACC-1', boardId: 'ACC', issueType: 'Bug', labels: [] },
        { key: 'ACC-2', boardId: 'ACC', issueType: 'Bug', labels: [] },
        { key: 'ACC-3', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-4', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-5', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-6', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-7', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-8', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-9', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-10', boardId: 'ACC', issueType: 'Story', labels: [] },
      ] as JiraIssue[];
    });

    // All 10 reached Done
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ issueKey: `ACC-${i + 1}` })),
      ),
      getMany: jest.fn().mockResolvedValue([]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    // Both Bug issues have a causal link
    const linkQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { sourceIssueKey: 'ACC-1', targetIssueKey: 'ACC-99', linkTypeName: 'caused by', isInward: true },
        { sourceIssueKey: 'ACC-2', targetIssueKey: 'ACC-98', linkTypeName: 'caused by', isInward: true },
      ]),
    };
    issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue(linkQb);

    const result = await service.calculate('ACC', start, end);

    expect(result.totalDeployments).toBe(10);
    expect(result.failureCount).toBe(2);
    expect(result.changeFailureRate).toBe(20); // 2/10 * 100
    expect(result.band).toBe('low'); // >15%
  });

  it('should detect failures by labels', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      failureIssueTypes: [],
      failureLabels: ['regression'],
    } as BoardConfig);

    issueRepo.find.mockImplementation(async (opts) => {
      if (opts && typeof opts === 'object' && 'where' in opts) {
        const where = opts.where as Record<string, unknown>;
        if (where.fixVersion) return [] as JiraIssue[];
      }
      return [
        { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', labels: ['regression'] },
        { key: 'ACC-2', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-3', boardId: 'ACC', issueType: 'Story', labels: [] },
        { key: 'ACC-4', boardId: 'ACC', issueType: 'Story', labels: [] },
      ] as JiraIssue[];
    });

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(
        [{ issueKey: 'ACC-1' }, { issueKey: 'ACC-2' }, { issueKey: 'ACC-3' }, { issueKey: 'ACC-4' }],
      ),
      getMany: jest.fn().mockResolvedValue([]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    versionRepo.find.mockResolvedValue([]);

    // The regression-labelled issue has a causal link
    const linkQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { sourceIssueKey: 'ACC-1', targetIssueKey: 'ACC-99', linkTypeName: 'caused by', isInward: true },
      ]),
    };
    issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue(linkQb);

    const result = await service.calculate('ACC', start, end);

    expect(result.failureCount).toBe(1);
    expect(result.changeFailureRate).toBe(25); // 1/4 * 100
  });
});
