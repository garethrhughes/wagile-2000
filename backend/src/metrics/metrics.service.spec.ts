import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MetricsService } from './metrics.service.js';
import { DeploymentFrequencyService } from './deployment-frequency.service.js';
import { LeadTimeService } from './lead-time.service.js';
import { CfrService } from './cfr.service.js';
import { MttrService } from './mttr.service.js';
import { CycleTimeService } from './cycle-time.service.js';
import { JiraSprint, BoardConfig } from '../database/entities/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
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

function buildDeploymentFrequencyService(): jest.Mocked<DeploymentFrequencyService> {
  return {
    calculate: jest.fn().mockResolvedValue({
      boardId: 'ACC',
      totalDeployments: 4,
      deploymentsPerDay: 0.04,
      band: 'fair',
      periodDays: 90,
    }),
  } as unknown as jest.Mocked<DeploymentFrequencyService>;
}

function buildLeadTimeService(): jest.Mocked<LeadTimeService> {
  return {
    calculate: jest.fn().mockResolvedValue({
      boardId: 'ACC',
      medianDays: 5,
      p95Days: 10,
      band: 'excellent',
      sampleSize: 3,
      anomalyCount: 0,
    }),
    getLeadTimeObservations: jest.fn().mockResolvedValue({
      observations: [3, 5, 8],
      anomalyCount: 0,
    }),
  } as unknown as jest.Mocked<LeadTimeService>;
}

function buildCfrService(): jest.Mocked<CfrService> {
  return {
    calculate: jest.fn().mockResolvedValue({
      boardId: 'ACC',
      totalDeployments: 4,
      failureCount: 1,
      changeFailureRate: 25,
      band: 'fair',
      usingDefaultConfig: false,
    }),
  } as unknown as jest.Mocked<CfrService>;
}

function buildMttrService(): jest.Mocked<MttrService> {
  return {
    calculate: jest.fn().mockResolvedValue({
      boardId: 'ACC',
      medianHours: 2,
      band: 'excellent',
      incidentCount: 1,
      openIncidentCount: 0,
      anomalyCount: 0,
    }),
    getMttrObservations: jest.fn().mockResolvedValue({ recoveryHours: [2], openIncidentCount: 0, anomalyCount: 0 }),
  } as unknown as jest.Mocked<MttrService>;
}

function buildCycleTimeService(): jest.Mocked<CycleTimeService> {
  return {
    calculate: jest.fn().mockResolvedValue({
      boardId: 'ACC',
      count: 3,
      anomalyCount: 0,
      p50Days: 3,
      p85Days: 5,
      band: 'good',
      observations: [],
    }),
    getCycleTimeObservations: jest.fn().mockResolvedValue({
      observations: [{ cycleTimeDays: 3 }, { cycleTimeDays: 5 }],
    }),
  } as unknown as jest.Mocked<CycleTimeService>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsService', () => {
  let service: MetricsService;
  let dfService: jest.Mocked<DeploymentFrequencyService>;
  let ltService: jest.Mocked<LeadTimeService>;
  let cfrService: jest.Mocked<CfrService>;
  let mttrService: jest.Mocked<MttrService>;
  let cycleTimeService: jest.Mocked<CycleTimeService>;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    dfService = buildDeploymentFrequencyService();
    ltService = buildLeadTimeService();
    cfrService = buildCfrService();
    mttrService = buildMttrService();
    cycleTimeService = buildCycleTimeService();
    sprintRepo = mockRepo<JiraSprint>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new MetricsService(
      dfService,
      ltService,
      cfrService,
      mttrService,
      cycleTimeService,
      sprintRepo,
      boardConfigRepo,
      mockConfigService(),
    );
  });

  // -------------------------------------------------------------------------
  // getDora
  // -------------------------------------------------------------------------

  describe('getDora', () => {
    it('returns DORA results for a single board with quarter period', async () => {
      const results = await service.getDora({ boardId: 'ACC', quarter: '2026-Q1' });

      expect(results).toHaveLength(1);
      expect(results[0].boardId).toBe('ACC');
      expect(results[0].deploymentFrequency).toBeDefined();
      expect(results[0].leadTime).toBeDefined();
      expect(results[0].changeFailureRate).toBeDefined();
      expect(results[0].mttr).toBeDefined();
    });

    it('resolves period from sprint dates when sprintId is provided', async () => {
      const sprintStart = new Date('2026-01-01T00:00:00Z');
      const sprintEnd = new Date('2026-01-14T23:59:59Z');
      sprintRepo.findOne.mockResolvedValue({
        id: 'sprint-1',
        boardId: 'ACC',
        name: 'Sprint 1',
        state: 'closed',
        startDate: sprintStart,
        endDate: sprintEnd,
      } as unknown as JiraSprint);

      const results = await service.getDora({ boardId: 'ACC', sprintId: 'sprint-1' });

      expect(results).toHaveLength(1);
      expect(sprintRepo.findOne).toHaveBeenCalledWith({ where: { id: 'sprint-1' } });
    });

    it('falls back to last 90 days when no quarter/period/sprint is given', async () => {
      const results = await service.getDora({ boardId: 'ACC' });
      expect(results).toHaveLength(1);
      expect(dfService.calculate).toHaveBeenCalled();
    });

    it('resolves all board IDs when no boardId is given', async () => {
      boardConfigRepo.find.mockResolvedValue([
        { boardId: 'ACC' } as BoardConfig,
        { boardId: 'PLAT' } as BoardConfig,
      ]);

      const results = await service.getDora({ quarter: '2026-Q1' });

      expect(results).toHaveLength(2);
      expect(dfService.calculate).toHaveBeenCalledTimes(2);
    });

    it('includes period start/end in ISO format', async () => {
      const results = await service.getDora({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results[0].period.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(results[0].period.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // -------------------------------------------------------------------------
  // getDeploymentFrequency
  // -------------------------------------------------------------------------

  describe('getDeploymentFrequency', () => {
    it('returns deployment frequency for each board', async () => {
      const results = await service.getDeploymentFrequency({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results).toHaveLength(1);
      expect(results[0].totalDeployments).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // getLeadTime
  // -------------------------------------------------------------------------

  describe('getLeadTime', () => {
    it('returns lead time for each board', async () => {
      const results = await service.getLeadTime({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results).toHaveLength(1);
      expect(results[0].medianDays).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // getCfr
  // -------------------------------------------------------------------------

  describe('getCfr', () => {
    it('returns CFR for each board', async () => {
      const results = await service.getCfr({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results).toHaveLength(1);
      expect(results[0].changeFailureRate).toBe(25);
    });
  });

  // -------------------------------------------------------------------------
  // getMttr
  // -------------------------------------------------------------------------

  describe('getMttr', () => {
    it('returns MTTR for each board', async () => {
      const results = await service.getMttr({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results).toHaveLength(1);
      expect(results[0].medianHours).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getDoraAggregate
  // -------------------------------------------------------------------------

  describe('getDoraAggregate', () => {
    it('returns org-level aggregated DORA metrics', async () => {
      const result = await service.getDoraAggregate({ boardId: 'ACC', quarter: '2026-Q1' });

      expect(result.orgDeploymentFrequency.totalDeployments).toBe(4);
      expect(result.orgLeadTime.sampleSize).toBe(3);
      expect(result.orgChangeFailureRate.failureCount).toBe(1);
      expect(result.orgMttr.incidentCount).toBe(1);
    });

    it('pools observations from multiple boards', async () => {
      boardConfigRepo.find.mockResolvedValue([
        { boardId: 'ACC' } as BoardConfig,
        { boardId: 'PLAT' } as BoardConfig,
      ]);
      ltService.getLeadTimeObservations
        .mockResolvedValueOnce({ observations: [3, 5], anomalyCount: 0 })
        .mockResolvedValueOnce({ observations: [7, 9], anomalyCount: 0 });
      mttrService.getMttrObservations
        .mockResolvedValueOnce({ recoveryHours: [2], openIncidentCount: 0, anomalyCount: 0 })
        .mockResolvedValueOnce({ recoveryHours: [4], openIncidentCount: 0, anomalyCount: 0 });

      const result = await service.getDoraAggregate({ quarter: '2026-Q1' });

      // 2 boards × 4 deployments = 8 total
      expect(result.orgDeploymentFrequency.totalDeployments).toBe(8);
      // pooled lead time observations: [3,5,7,9]
      expect(result.orgLeadTime.sampleSize).toBe(4);
      expect(result.boardBreakdowns).toHaveLength(2);
    });

    it('resolves period from sprint when sprintId provided', async () => {
      sprintRepo.findOne.mockResolvedValue({
        id: 'sprint-1',
        boardId: 'ACC',
        name: 'Sprint 1',
        state: 'closed',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-01-14T23:59:59Z'),
      } as unknown as JiraSprint);

      const result = await service.getDoraAggregate({ boardId: 'ACC', sprintId: 'sprint-1' });
      expect(sprintRepo.findOne).toHaveBeenCalled();
      expect(result.orgDeploymentFrequency).toBeDefined();
    });

    it('includes boardType in board breakdowns (default scrum)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null); // no config → default scrum
      const result = await service.getDoraAggregate({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(result.boardBreakdowns[0].boardType).toBe('scrum');
    });

    it('marks boardType as kanban when boardConfig says kanban', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
      } as unknown as BoardConfig);

      const result = await service.getDoraAggregate({ boardId: 'PLAT', quarter: '2026-Q1' });
      expect(result.boardBreakdowns[0].boardType).toBe('kanban');
    });

    it('orgCFR is 0 when no deployments', async () => {
      cfrService.calculate.mockResolvedValue({
        boardId: 'ACC',
        totalDeployments: 0,
        failureCount: 0,
        changeFailureRate: 0,
        band: 'elite' as const,
        usingDefaultConfig: false,
      });
      dfService.calculate.mockResolvedValue({
        boardId: 'ACC',
        totalDeployments: 0,
        deploymentsPerDay: 0,
        band: 'low' as const,
        periodDays: 90,
      });

      const result = await service.getDoraAggregate({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(result.orgChangeFailureRate.changeFailureRate).toBe(0);
    });

    it('reports anyBoardUsingDefaultConfig when a board has no config', async () => {
      cfrService.calculate.mockResolvedValue({
        boardId: 'ACC',
        totalDeployments: 4,
        failureCount: 1,
        changeFailureRate: 25,
        band: 'medium' as const,
        usingDefaultConfig: true,
      });

      const result = await service.getDoraAggregate({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(result.anyBoardUsingDefaultConfig).toBe(true);
      expect(result.boardsUsingDefaultConfig).toContain('ACC');
    });

    it('uses explicit period range when period format is YYYY-MM-DD:YYYY-MM-DD', async () => {
      const result = await service.getDoraAggregate({
        boardId: 'ACC',
        period: '2026-01-01:2026-03-31',
      });
      expect(result.period.start).toContain('2026-01-01');
    });
  });

  // -------------------------------------------------------------------------
  // getDoraTrend
  // -------------------------------------------------------------------------

  describe('getDoraTrend', () => {
    it('returns trend points in quarter mode (oldest → newest)', async () => {
      const points = await service.getDoraTrend({ boardId: 'ACC', limit: 3 });
      // Should have 3 points (one per quarter), oldest first
      expect(points).toHaveLength(3);
      // Oldest start should be earlier than newest
      const starts = points.map((p) => new Date(p.start).getTime());
      expect(starts[0]).toBeLessThan(starts[starts.length - 1]);
    });

    it('returns trend in sprint mode when mode=sprints', async () => {
      // sprintRepo.find returns DESC order (most recent first) as the real DB would
      sprintRepo.find.mockResolvedValue([
        {
          id: 's2',
          boardId: 'ACC',
          name: 'Sprint 2',
          state: 'closed',
          startDate: new Date('2026-01-15T00:00:00Z'),
          endDate: new Date('2026-01-28T00:00:00Z'),
        } as unknown as JiraSprint,
        {
          id: 's1',
          boardId: 'ACC',
          name: 'Sprint 1',
          state: 'closed',
          startDate: new Date('2026-01-01T00:00:00Z'),
          endDate: new Date('2026-01-14T00:00:00Z'),
        } as unknown as JiraSprint,
      ]);

      const points = await service.getDoraTrend({ boardId: 'ACC', mode: 'sprints', limit: 2 });
      expect(points).toHaveLength(2);
      expect(points[0].label).toBe('Sprint 1'); // oldest first after reverse
    });

    it('throws BadRequestException in sprint mode without boardId', async () => {
      await expect(
        service.getDoraTrend({ mode: 'sprints', limit: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException in sprint mode for a Kanban board', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
      } as unknown as BoardConfig);

      await expect(
        service.getDoraTrend({ boardId: 'PLAT', mode: 'sprints', limit: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns empty array when sprint mode has no closed sprints', async () => {
      sprintRepo.find.mockResolvedValue([]);
      const points = await service.getDoraTrend({ boardId: 'ACC', mode: 'sprints', limit: 4 });
      expect(points).toEqual([]);
    });

    it('trend points contain expected fields', async () => {
      const points = await service.getDoraTrend({ boardId: 'ACC', limit: 1 });
      const p = points[0];
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('start');
      expect(p).toHaveProperty('end');
      expect(p).toHaveProperty('deploymentsPerDay');
      expect(p).toHaveProperty('medianLeadTimeDays');
      expect(p).toHaveProperty('changeFailureRate');
      expect(p).toHaveProperty('mttrMedianHours');
      expect(p).toHaveProperty('orgBands');
    });
  });

  // -------------------------------------------------------------------------
  // getCycleTime
  // -------------------------------------------------------------------------

  describe('getCycleTime', () => {
    it('returns cycle time result for a board', async () => {
      const results = await service.getCycleTime({ boardId: 'ACC', quarter: '2026-Q1' });
      expect(results).toHaveLength(1);
      expect(results[0].p50Days).toBe(3);
    });

    it('resolves sprint dates when sprintId is provided', async () => {
      sprintRepo.findOne.mockResolvedValue({
        id: 's1',
        boardId: 'ACC',
        name: 'Sprint 1',
        state: 'closed',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-01-14T00:00:00Z'),
      } as unknown as JiraSprint);

      const results = await service.getCycleTime({ boardId: 'ACC', sprintId: 's1' });
      expect(results).toHaveLength(1);
      expect(sprintRepo.findOne).toHaveBeenCalledWith({ where: { id: 's1' } });
    });

    it('passes issueType filter to cycleTimeService', async () => {
      await service.getCycleTime({ boardId: 'ACC', quarter: '2026-Q1', issueType: 'Story' });
      expect(cycleTimeService.calculate).toHaveBeenCalledWith(
        'ACC',
        expect.any(Date),
        expect.any(Date),
        '2026-Q1',
        'Story',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getCycleTimeTrend
  // -------------------------------------------------------------------------

  describe('getCycleTimeTrend', () => {
    it('returns trend points in quarter mode (oldest → newest)', async () => {
      const points = await service.getCycleTimeTrend({ boardId: 'ACC', limit: 3 });
      expect(points).toHaveLength(3);
      const starts = points.map((p) => new Date(p.start).getTime());
      expect(starts[0]).toBeLessThan(starts[starts.length - 1]);
    });

    it('returns trend in sprint mode', async () => {
      sprintRepo.find.mockResolvedValue([
        {
          id: 's1',
          boardId: 'ACC',
          name: 'Sprint 1',
          state: 'closed',
          startDate: new Date('2026-01-01T00:00:00Z'),
          endDate: new Date('2026-01-14T00:00:00Z'),
        } as unknown as JiraSprint,
      ]);

      const points = await service.getCycleTimeTrend({ boardId: 'ACC', mode: 'sprints', limit: 1 });
      expect(points).toHaveLength(1);
      expect(points[0].label).toBe('Sprint 1');
    });

    it('throws BadRequestException in sprint mode without boardId', async () => {
      await expect(
        service.getCycleTimeTrend({ mode: 'sprints', limit: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException in sprint mode for a Kanban board', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
      } as unknown as BoardConfig);

      await expect(
        service.getCycleTimeTrend({ boardId: 'PLAT', mode: 'sprints', limit: 4 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns empty array when sprint mode has no closed sprints', async () => {
      sprintRepo.find.mockResolvedValue([]);
      const points = await service.getCycleTimeTrend({ boardId: 'ACC', mode: 'sprints', limit: 4 });
      expect(points).toEqual([]);
    });

    it('pools observations across boards in quarter mode', async () => {
      boardConfigRepo.find.mockResolvedValue([
        { boardId: 'ACC' } as BoardConfig,
        { boardId: 'PLAT' } as BoardConfig,
      ]);
      cycleTimeService.getCycleTimeObservations
        .mockResolvedValueOnce({ observations: [{ cycleTimeDays: 2 } as never, { cycleTimeDays: 4 } as never], anomalyCount: 0 })
        .mockResolvedValueOnce({ observations: [{ cycleTimeDays: 6 } as never, { cycleTimeDays: 8 } as never], anomalyCount: 0 });

      const points = await service.getCycleTimeTrend({ limit: 1 });
      // Both boards' observations pooled → sampleSize = 4 (for the 1 quarter)
      expect(points[0].sampleSize).toBe(4);
    });

    it('trend points contain expected fields', async () => {
      const points = await service.getCycleTimeTrend({ boardId: 'ACC', limit: 1 });
      const p = points[0];
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('medianCycleTimeDays');
      expect(p).toHaveProperty('p85CycleTimeDays');
      expect(p).toHaveProperty('sampleSize');
      expect(p).toHaveProperty('band');
    });
  });

  // -------------------------------------------------------------------------
  // resolvePeriod edge cases
  // -------------------------------------------------------------------------

  describe('resolvePeriod (via getDora)', () => {
    it('uses explicit period range YYYY-MM-DD:YYYY-MM-DD', async () => {
      const results = await service.getDora({ boardId: 'ACC', period: '2026-01-01:2026-03-31' });
      expect(results[0].period.start).toContain('2026-01-01');
      expect(results[0].period.end).toContain('2026-03-31');
    });

    it('falls back to last 90 days for invalid period string', async () => {
      const before = Date.now();
      const results = await service.getDora({ boardId: 'ACC', period: 'not-a-date' });
      const endMs = new Date(results[0].period.end).getTime();
      expect(endMs).toBeGreaterThanOrEqual(before - 1000);
    });
  });
});
