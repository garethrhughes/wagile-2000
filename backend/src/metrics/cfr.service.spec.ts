import { CfrService } from './cfr.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
} from '../database/entities/index.js';

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
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
      inProgressStatusNames: ['In Progress'],
      dataStartDate: null,
    } as unknown as BoardConfig);

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
      ] as unknown as JiraIssue[];
    });

    // All 10 reached Done
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
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

  // -------------------------------------------------------------------------
  // Fix C-1: failureLinkTypes default should be [] (not ['caused by', ...])
  // -------------------------------------------------------------------------
  describe('C-1: failureLinkTypes default', () => {
    it('skips link AND-gate when failureLinkTypes is not configured (default [])', async () => {
      // No BoardConfig row → failureLinkTypes defaults to []
      boardConfigRepo.findOne.mockResolvedValue(null);

      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      // One Bug deployed (no fixVersion, transitioned to Done)
      issueRepo.find.mockImplementation(async (opts) => {
        if (opts && typeof opts === 'object' && 'where' in opts) {
          const where = opts.where as Record<string, unknown>;
          if (where.fixVersion) return [] as JiraIssue[];
        }
        return [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Bug', labels: [], fixVersion: null },
        ] as unknown as JiraIssue[];
      });

      versionRepo.find.mockResolvedValue([]);

      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
        getMany: jest.fn().mockResolvedValue([]),
      };
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      // No causal links — but gate should be SKIPPED when failureLinkTypes = []
      issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.calculate('ACC', start, end);

      // Bug should be counted as failure without requiring a causal link
      expect(result.failureCount).toBe(1);
      expect(result.changeFailureRate).toBe(100);
    });

    it('still applies link AND-gate when failureLinkTypes is explicitly configured', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        doneStatusNames: ['Done'],
        failureIssueTypes: ['Bug'],
        failureLabels: [],
        failureLinkTypes: ['caused by'],
        inProgressStatusNames: ['In Progress'],
        dataStartDate: null,
      } as unknown as BoardConfig);

      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      issueRepo.find.mockImplementation(async (opts) => {
        if (opts && typeof opts === 'object' && 'where' in opts) {
          const where = opts.where as Record<string, unknown>;
          if (where.fixVersion) return [] as JiraIssue[];
        }
        return [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Bug', labels: [], fixVersion: null },
        ] as unknown as JiraIssue[];
      });

      versionRepo.find.mockResolvedValue([]);

      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ issueKey: 'ACC-1' }]),
        getMany: jest.fn().mockResolvedValue([]),
      };
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      // No causal links — gate SHOULD be applied
      issueLinkRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.calculate('ACC', start, end);

      // Bug has no causal link → should NOT be counted
      expect(result.failureCount).toBe(0);
      expect(result.changeFailureRate).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Fix C-4: CFR denominator counts distinct release days, not issues
  // -------------------------------------------------------------------------
  describe('C-4: totalDeployments counts distinct release days', () => {
    it('returns totalDeployments=1 for one version regardless of issue count', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null); // default config, no link gate

      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      // One version released with 20 stories
      versionRepo.find.mockResolvedValue([
        {
          id: 'v1', name: '2.0.0',
          releaseDate: new Date('2025-02-15'),
          projectKey: 'ACC', released: true,
        },
      ] as JiraVersion[]);

      // Both calls to issueRepo.find return stories (one with fixVersion for version path)
      issueRepo.find.mockImplementation(async () => {
        return Array.from({ length: 20 }, (_, i) => ({
          key: `ACC-${i + 1}`,
          boardId: 'ACC',
          issueType: 'Story',
          labels: [],
          fixVersion: '2.0.0',
        })) as unknown as JiraIssue[];
      });

      const result = await service.calculate('ACC', start, end);

      // 1 version on 1 release day → totalDeployments = 1
      expect(result.totalDeployments).toBe(1);
      expect(result.failureCount).toBe(0);
      expect(result.changeFailureRate).toBe(0);
    });

    it('returns totalDeployments=2 for two versions on different release days', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null);

      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      versionRepo.find.mockResolvedValue([
        { id: 'v1', name: '1.0.0', releaseDate: new Date('2025-02-01'), projectKey: 'ACC', released: true },
        { id: 'v2', name: '1.1.0', releaseDate: new Date('2025-03-01'), projectKey: 'ACC', released: true },
      ] as JiraVersion[]);

      issueRepo.find.mockImplementation(async () => {
        return [
          { key: 'ACC-1', boardId: 'ACC', issueType: 'Story', labels: [], fixVersion: '1.0.0' },
          { key: 'ACC-2', boardId: 'ACC', issueType: 'Story', labels: [], fixVersion: '1.1.0' },
        ] as unknown as JiraIssue[];
      });

      const result = await service.calculate('ACC', start, end);

      expect(result.totalDeployments).toBe(2);
    });
  });
});

