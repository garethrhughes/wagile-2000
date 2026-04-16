import { MttrService } from './mttr.service.js';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  BoardConfig,
  WorkingTimeConfigEntity,
} from '../database/entities/index.js';
import type { TrendDataSlice } from './trend-data-loader.service.js';

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

  // ---------------------------------------------------------------------------
  // Fix 0034: in-flight incidents (In Progress before startDate) must use the
  // correct start time, not fall back to createdAt
  // ---------------------------------------------------------------------------

  it('uses the pre-period In Progress transition as startTime, not createdAt (proposal 0034)', async () => {
    const start = new Date('2025-02-01');
    const end   = new Date('2025-03-31');

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

    // Incident created well before the window; moved to In Progress before window opens
    const createdAt    = new Date('2025-01-01T00:00:00Z');
    const inProgress   = new Date('2025-01-20T00:00:00Z'); // before start
    const recoveryDate = new Date('2025-02-20T00:00:00Z'); // within window — 31 days after In Progress

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Incident', labels: [], priority: null, createdAt },
    ] as unknown as JiraIssue[]);

    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress },
        { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: recoveryDate },
      ]),
    });

    const result = await service.calculate('ACC', start, end);

    expect(result.incidentCount).toBe(1);
    // MTTR should be from inProgress → recoveryDate = 31 days = 744 hours
    // NOT from createdAt → recoveryDate = 50 days = 1200 hours
    expect(result.medianHours).toBeCloseTo(31 * 24, 0);
  });

  it('does not pass a changedAt lower-bound to the changelog query builder', async () => {
    const start = new Date('2025-01-01');
    const end   = new Date('2025-03-31');

    boardConfigRepo.findOne.mockResolvedValue({
      boardId: 'ACC',
      boardType: 'scrum',
      incidentIssueTypes: ['Bug'],
      recoveryStatusNames: ['Done'],
      incidentLabels: [],
      incidentPriorities: [],
      inProgressStatusNames: ['In Progress'],
    } as unknown as BoardConfig);

    issueRepo.find.mockResolvedValue([
      { key: 'ACC-1', boardId: 'ACC', issueType: 'Bug', labels: [], priority: null, createdAt: new Date('2024-06-01') },
    ] as unknown as JiraIssue[]);

    const andWhere = jest.fn().mockReturnThis();
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    changelogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    await service.getMttrObservations('ACC', start, end);

    const changedAtCall = andWhere.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('changedAt'),
    );
    expect(changedAtCall).toBeUndefined();
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

    // -------------------------------------------------------------------------
    // Change 2: getMttrObservationsFromData — in-memory variant
    // -------------------------------------------------------------------------

    describe('getMttrObservationsFromData', () => {
      function makeSlice(overrides: Partial<TrendDataSlice> = {}): TrendDataSlice {
        return {
          boardId: 'ACC',
          boardConfig: null,
          wtEntity: Object.assign(new WorkingTimeConfigEntity(), { id: 1, excludeWeekends: false, workDays: [1,2,3,4,5], hoursPerDay: 8, holidays: [] }),
          issues: [],
          changelogs: [],
          versions: [],
          issueLinks: [],
          ...overrides,
        };
      }

      const start = new Date('2025-01-01');
      const end   = new Date('2025-03-31');

      it('returns empty result for an empty slice', () => {
        const r = service.getMttrObservationsFromData(makeSlice(), start, end);
        expect(r.recoveryHours).toHaveLength(0);
        expect(r.openIncidentCount).toBe(0);
        expect(r.anomalyCount).toBe(0);
      });

      it('calculates recovery hours from In Progress to Done within the period', () => {
        const created     = new Date('2025-02-01T00:00:00Z');
        const inProgress  = new Date('2025-02-01T06:00:00Z');
        const done        = new Date('2025-02-01T18:00:00Z'); // 12 h after inProgress

        const slice = makeSlice({
          boardConfig: {
            boardId: 'ACC',
            incidentIssueTypes: ['Bug'],
            recoveryStatusNames: ['Done'],
            incidentLabels: [],
            incidentPriorities: [],
            inProgressStatusNames: ['In Progress'],
          } as never,
          issues: [
            { key: 'ACC-1', issueType: 'Bug', labels: [], priority: null, createdAt: created } as JiraIssue,
          ],
          changelogs: [
            { issueKey: 'ACC-1', field: 'status', toValue: 'In Progress', changedAt: inProgress } as JiraChangelog,
            { issueKey: 'ACC-1', field: 'status', toValue: 'Done',        changedAt: done }        as JiraChangelog,
          ],
        });

        const r = service.getMttrObservationsFromData(slice, start, end);
        expect(r.recoveryHours).toHaveLength(1);
        expect(r.recoveryHours[0]).toBe(12);
      });

      it('counts incident with no recovery transition as openIncidentCount', () => {
        const slice = makeSlice({
          boardConfig: { boardId: 'ACC', incidentIssueTypes: ['Incident'], recoveryStatusNames: ['Done'], incidentLabels: [], incidentPriorities: [], inProgressStatusNames: ['In Progress'] } as never,
          issues: [
            { key: 'ACC-1', issueType: 'Incident', labels: [], priority: null, createdAt: new Date('2025-02-01') } as JiraIssue,
          ],
          changelogs: [], // no recovery
        });

        const r = service.getMttrObservationsFromData(slice, start, end);
        expect(r.openIncidentCount).toBe(1);
        expect(r.recoveryHours).toHaveLength(0);
      });

      it('excludes recovery transitions outside the period', () => {
        const created = new Date('2024-11-01T00:00:00Z');
        const done    = new Date('2024-12-01T00:00:00Z'); // before start

        const slice = makeSlice({
          boardConfig: { boardId: 'ACC', incidentIssueTypes: ['Bug'], recoveryStatusNames: ['Done'], incidentLabels: [], incidentPriorities: [], inProgressStatusNames: ['In Progress'] } as never,
          issues: [
            { key: 'ACC-1', issueType: 'Bug', labels: [], priority: null, createdAt: created } as JiraIssue,
          ],
          changelogs: [
            { issueKey: 'ACC-1', field: 'status', toValue: 'Done', changedAt: done } as JiraChangelog,
          ],
        });

        const r = service.getMttrObservationsFromData(slice, start, end);
        expect(r.openIncidentCount).toBe(1);  // no in-period recovery → still open
        expect(r.recoveryHours).toHaveLength(0);
      });
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
