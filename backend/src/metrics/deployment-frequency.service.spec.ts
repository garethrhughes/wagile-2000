import { DeploymentFrequencyService } from './deployment-frequency.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraVersion,
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
      getCount: jest.fn().mockResolvedValue(0),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('DeploymentFrequencyService', () => {
  let service: DeploymentFrequencyService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let versionRepo: jest.Mocked<Repository<JiraVersion>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    versionRepo = mockRepo<JiraVersion>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new DeploymentFrequencyService(
      issueRepo,
      versionRepo,
      changelogRepo,
      boardConfigRepo,
    );
  });

  it('should return zero deployments for empty board', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    const result = await service.calculate('ACC', start, end);

    expect(result.boardId).toBe('ACC');
    expect(result.totalDeployments).toBe(0);
    expect(result.band).toBe('low');
  });

  it('should count version-based deployments', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    versionRepo.find.mockResolvedValue([
      { id: 'v1', name: '1.0.0', releaseDate: new Date('2025-02-01'), projectKey: 'ACC', released: true },
      { id: 'v2', name: '1.1.0', releaseDate: new Date('2025-03-01'), projectKey: 'ACC', released: true },
    ] as JiraVersion[]);

    issueRepo.find.mockImplementation(async (opts) => {
      if (opts && typeof opts === 'object' && 'where' in opts) {
        const where = opts.where as Record<string, unknown>;
        if (where.fixVersion) {
          return [
            { key: 'ACC-1', boardId: 'ACC', fixVersion: '1.0.0' },
            { key: 'ACC-2', boardId: 'ACC', fixVersion: '1.0.0' },
            { key: 'ACC-3', boardId: 'ACC', fixVersion: '1.1.0' },
          ] as JiraIssue[];
        }
        if (where.boardId && !where.fixVersion) {
          return [] as JiraIssue[];
        }
      }
      return [] as JiraIssue[];
    });

    const result = await service.calculate('ACC', start, end);

    expect(result.totalDeployments).toBe(3);
    expect(result.deploymentsPerDay).toBeGreaterThan(0);
  });

  it('should classify band correctly for daily deploys', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-01-02');

    versionRepo.find.mockResolvedValue([
      { id: 'v1', name: '1.0', releaseDate: new Date('2025-01-01'), projectKey: 'ACC', released: true },
    ] as JiraVersion[]);

    issueRepo.find.mockImplementation(async (opts) => {
      if (opts && typeof opts === 'object' && 'where' in opts) {
        const where = opts.where as Record<string, unknown>;
        if (where.fixVersion) {
          return [
            { key: 'ACC-1' },
            { key: 'ACC-2' },
            { key: 'ACC-3' },
          ] as JiraIssue[];
        }
      }
      return [] as JiraIssue[];
    });

    const result = await service.calculate('ACC', start, end);

    expect(result.band).toBe('elite');
  });

  it('should use board config done statuses', async () => {
    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Deployed', 'Live'],
    } as BoardConfig);

    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');
    versionRepo.find.mockResolvedValue([]);

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(5),
      getRawMany: jest.fn().mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ issueKey: `ACC-${i + 1}` })),
      ),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', issueType: 'Story', fixVersion: null },
      { key: 'ACC-2', issueType: 'Story', fixVersion: null },
    ] as JiraIssue[]);

    const result = await service.calculate('ACC', start, end);

    expect(result.totalDeployments).toBe(5);
    expect(qb.andWhere).toHaveBeenCalledWith(
      'cl.toValue IN (:...statuses)',
      { statuses: ['Deployed', 'Live'] },
    );
  });
});
