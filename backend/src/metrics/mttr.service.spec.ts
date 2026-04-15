import { MttrService } from './mttr.service.js';
import { Repository } from 'typeorm';
import {
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

describe('MttrService', () => {
  let service: MttrService;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    issueRepo = mockRepo<JiraIssue>();
    changelogRepo = mockRepo<JiraChangelog>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new MttrService(issueRepo, changelogRepo, boardConfigRepo);
  });

  it('should return zero for board with no incidents', async () => {
    const result = await service.calculate(
      'ACC',
      new Date('2025-01-01'),
      new Date('2025-03-31'),
    );

    expect(result.boardId).toBe('ACC');
    expect(result.medianHours).toBe(0);
    expect(result.incidentCount).toBe(0);
    expect(result.band).toBe('elite');
  });

  it('should calculate median recovery time for incidents', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      incidentIssueTypes: ['Bug', 'Incident'],
      recoveryStatusNames: ['Done', 'Resolved'],
      incidentLabels: [],
      incidentPriorities: [],
      inProgressStatusNames: ['In Progress'],
      dataStartDate: null,
    } as unknown as BoardConfig);

    // Two incidents: Bug created at different times
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Bug',
        labels: [],
        priority: null,
        createdAt: new Date('2025-01-10T00:00:00Z'),
      },
      {
        key: 'ACC-2',
        boardId: 'ACC',
        issueType: 'Incident',
        labels: [],
        priority: null,
        createdAt: new Date('2025-02-01T00:00:00Z'),
      },
      {
        key: 'ACC-3',
        boardId: 'ACC',
        issueType: 'Story',
        labels: [],
        priority: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ] as unknown as JiraIssue[]);

    // ACC-1 recovered in 12 hours, ACC-2 recovered in 48 hours
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          issueKey: 'ACC-1',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2025-01-10T12:00:00Z'), // 12 hours
        },
        {
          issueKey: 'ACC-2',
          field: 'status',
          toValue: 'Resolved',
          changedAt: new Date('2025-02-03T00:00:00Z'), // 48 hours
        },
      ]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const result = await service.calculate('ACC', start, end);

    expect(result.incidentCount).toBe(2);
    // Median of [12, 48] = 30
    expect(result.medianHours).toBe(30);
    expect(result.band).toBe('medium'); // 30 hours = > 24h (high) but < 168h (medium)
  });

  it('should use incident labels for identification', async () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-03-31');

    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      incidentIssueTypes: [],
      recoveryStatusNames: ['Done'],
      incidentLabels: ['production-incident'],
      incidentPriorities: [],
      inProgressStatusNames: ['In Progress'],
      dataStartDate: null,
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        labels: ['production-incident'],
        priority: null,
        createdAt: new Date('2025-01-10T00:00:00Z'),
      },
      {
        key: 'ACC-2',
        boardId: 'ACC',
        issueType: 'Story',
        labels: [],
        priority: null,
        createdAt: new Date('2025-01-15T00:00:00Z'),
      },
    ] as unknown as JiraIssue[]);

    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          issueKey: 'ACC-1',
          field: 'status',
          toValue: 'Done',
          changedAt: new Date('2025-01-10T00:30:00Z'), // 0.5 hours
        },
      ]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const result = await service.calculate('ACC', start, end);

    expect(result.incidentCount).toBe(1);
    expect(result.medianHours).toBe(0.5);
    expect(result.band).toBe('elite');
  });

  // -------------------------------------------------------------------------
  // Fix C-2: openIncidentCount and anomalyCount
  // -------------------------------------------------------------------------
  describe('C-2: openIncidentCount and anomalyCount', () => {
    it('counts incident with no recovery transition as openIncidentCount', async () => {
      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        incidentIssueTypes: ['Incident'],
        recoveryStatusNames: ['Done'],
        incidentLabels: [],
        incidentPriorities: [],
        inProgressStatusNames: ['In Progress'],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Incident',
          labels: [],
          priority: null,
          createdAt: new Date('2025-02-01T00:00:00Z'),
        },
      ] as unknown as JiraIssue[]);

      // No recovery transition for ACC-1
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const result = await service.calculate('ACC', start, end);

      expect(result.openIncidentCount).toBe(1);
      expect(result.incidentCount).toBe(0); // excluded from MTTR sample
      expect(result.medianHours).toBe(0);
    });

    it('logs warning and increments anomalyCount for negative recovery time', async () => {
      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        incidentIssueTypes: ['Incident'],
        recoveryStatusNames: ['Done'],
        incidentLabels: [],
        incidentPriorities: [],
        inProgressStatusNames: ['In Progress'],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Incident',
          labels: [],
          priority: null,
          createdAt: new Date('2025-02-10T00:00:00Z'),
        },
      ] as unknown as JiraIssue[]);

      // In Progress AFTER the Done transition (anomaly: recovery before detection)
      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            issueKey: 'ACC-1',
            field: 'status',
            toValue: 'In Progress',
            changedAt: new Date('2025-02-10T12:00:00Z'), // start time
          },
          {
            issueKey: 'ACC-1',
            field: 'status',
            toValue: 'Done',
            changedAt: new Date('2025-02-10T06:00:00Z'), // BEFORE In Progress → negative
          },
        ]),
      });

      const result = await service.calculate('ACC', start, end);

      expect(result.anomalyCount).toBe(1);
      expect(result.incidentCount).toBe(0); // excluded from sample
    });

    it('returns openIncidentCount = 0 and anomalyCount = 0 for normal incidents', async () => {
      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');

      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'ACC',
        boardType: 'scrum',
        incidentIssueTypes: ['Incident'],
        recoveryStatusNames: ['Done'],
        incidentLabels: [],
        incidentPriorities: [],
        inProgressStatusNames: ['In Progress'],
        dataStartDate: null,
      } as unknown as BoardConfig);

      issueRepo.find.mockResolvedValue([
        {
          key: 'ACC-1',
          boardId: 'ACC',
          issueType: 'Incident',
          labels: [],
          priority: null,
          createdAt: new Date('2025-02-01T00:00:00Z'),
        },
      ] as unknown as JiraIssue[]);

      changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            issueKey: 'ACC-1',
            field: 'status',
            toValue: 'Done',
            changedAt: new Date('2025-02-01T06:00:00Z'), // 6 hours after createdAt
          },
        ]),
      });

      const result = await service.calculate('ACC', start, end);

      expect(result.openIncidentCount).toBe(0);
      expect(result.anomalyCount).toBe(0);
      expect(result.incidentCount).toBe(1);
    });
  });
});
