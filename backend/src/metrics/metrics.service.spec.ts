import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MetricsService } from './metrics.service.js';
import { DeploymentFrequencyService } from './deployment-frequency.service.js';
import { LeadTimeService } from './lead-time.service.js';
import { CfrService } from './cfr.service.js';
import { MttrService } from './mttr.service.js';
import { CycleTimeService } from './cycle-time.service.js';
import { DoraCacheService } from './dora-cache.service.js';
import { TrendDataLoader, type TrendDataSlice } from './trend-data-loader.service.js';
import { JiraSprint, BoardConfig, WorkingTimeConfigEntity } from '../database/entities/index.js';

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

const MOCK_DF_RESULT = {
  boardId: 'ACC',
  totalDeployments: 4,
  deploymentsPerDay: 0.04,
  band: 'fair',
  periodDays: 90,
};

const MOCK_SLICE: TrendDataSlice = {
  boardId: 'ACC',
  boardConfig: null,
  wtEntity: Object.assign(new WorkingTimeConfigEntity(), {
    id: 1, excludeWeekends: false, workDays: [1,2,3,4,5], hoursPerDay: 8, holidays: [],
  }),
  issues: [],
  changelogs: [],
  versions: [],
  issueLinks: [],
};

function buildDeploymentFrequencyService(): jest.Mocked<DeploymentFrequencyService> {
  return {
    calculate: jest.fn().mockResolvedValue(MOCK_DF_RESULT),
    calculateFromData: jest.fn().mockReturnValue(MOCK_DF_RESULT),
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
    getLeadTimeObservationsFromData: jest.fn().mockReturnValue({
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
    calculateFromData: jest.fn().mockReturnValue({
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
    getMttrObservationsFromData: jest.fn().mockReturnValue({ recoveryHours: [2], openIncidentCount: 0, anomalyCount: 0 }),
  } as unknown as jest.Mocked<MttrService>;
}

function buildTrendDataLoader(): jest.Mocked<TrendDataLoader> {
  return {
    load: jest.fn().mockResolvedValue(MOCK_SLICE),
  } as unknown as jest.Mocked<TrendDataLoader>;
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
  let doraCache: DoraCacheService;
  let trendDataLoader: jest.Mocked<TrendDataLoader>;

  beforeEach(() => {
    dfService = buildDeploymentFrequencyService();
    ltService = buildLeadTimeService();
    cfrService = buildCfrService();
    mttrService = buildMttrService();
    cycleTimeService = buildCycleTimeService();
    sprintRepo = mockRepo<JiraSprint>();
    boardConfigRepo = mockRepo<BoardConfig>();
    doraCache = new DoraCacheService();
    trendDataLoader = buildTrendDataLoader();

    service = new MetricsService(
      dfService,
      ltService,
      cfrService,
      mttrService,
      cycleTimeService,
      sprintRepo,
      boardConfigRepo,
      mockConfigService(),
      doraCache,
      trendDataLoader,
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
      const result = await service.getDoraAggregate({ boardId: 'ACC' });

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

      const result = await service.getDoraAggregate({});

      // 2 boards × 4 deployments = 8 total
      expect(result.orgDeploymentFrequency.totalDeployments).toBe(8);
      // pooled lead time observations: [3,5,7,9]
      expect(result.orgLeadTime.sampleSize).toBe(4);
      expect(result.boardBreakdowns).toHaveLength(2);
    });

    it('returns org-level result when only boardId is provided (no period)', async () => {
      const result = await service.getDoraAggregate({ boardId: 'ACC' });
      expect(result.orgDeploymentFrequency).toBeDefined();
    });

    it('includes boardType in board breakdowns (default scrum)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(null); // no config → default scrum
      const result = await service.getDoraAggregate({ boardId: 'ACC' });
      expect(result.boardBreakdowns[0].boardType).toBe('scrum');
    });

    it('marks boardType as kanban when boardConfig says kanban', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
      } as unknown as BoardConfig);

      const result = await service.getDoraAggregate({ boardId: 'PLAT' });
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

      const result = await service.getDoraAggregate({ boardId: 'ACC' });
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

      const result = await service.getDoraAggregate({ boardId: 'ACC' });
      expect(result.anyBoardUsingDefaultConfig).toBe(true);
      expect(result.boardsUsingDefaultConfig).toContain('ACC');
    });

    it('returns a period in the result', async () => {
      const result = await service.getDoraAggregate({
        boardId: 'ACC',
      });
      expect(result.period.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.period.label).toMatch(/^\d{4}-Q\d$/);
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
      const starts = points.map((p) => new Date(p.period.start).getTime());
      expect(starts[0]).toBeLessThan(starts[starts.length - 1]);
    });

    it('returns trend points for a single board (quarter mode only)', async () => {
      const points = await service.getDoraTrend({ boardId: 'ACC', limit: 2 });
      expect(points).toHaveLength(2);
      expect(points[0].period.label).toMatch(/^\d{4}-Q\d$/); // quarter label format
    });

    it('loads data only for the single requested board when boardId is specified', async () => {
      boardConfigRepo.find.mockResolvedValue([
        { boardId: 'ACC' } as BoardConfig,
        { boardId: 'BPT' } as BoardConfig,
      ]);

      await service.getDoraTrend({ boardId: 'ACC', limit: 1 });

      const loadCalls = trendDataLoader.load.mock.calls;
      expect(loadCalls.every(([bid]) => bid === 'ACC')).toBe(true);
    });

    it('returns quarter-mode trend when no mode specified (no boardId required)', async () => {
      boardConfigRepo.find.mockResolvedValue([{ boardId: 'ACC' } as BoardConfig]);
      const points = await service.getDoraTrend({ limit: 2 });
      expect(points).toHaveLength(2);
    });

    it('returns quarter-mode trend for a Kanban board', async () => {
      boardConfigRepo.findOne.mockResolvedValue({
        boardId: 'PLAT',
        boardType: 'kanban',
      } as unknown as BoardConfig);

      // Kanban boards are fine in quarter mode
      const points = await service.getDoraTrend({ boardId: 'PLAT', limit: 2 });
      expect(points).toHaveLength(2);
    });

    it('returns quarter-mode trend even when loader returns minimal data', async () => {
      trendDataLoader.load.mockResolvedValue({ ...MOCK_SLICE, boardId: 'ACC' });
      const points = await service.getDoraTrend({ boardId: 'ACC', limit: 2 });
      expect(points).toHaveLength(2);
    });

    it('trend points contain OrgDoraResult fields', async () => {
      const points = await service.getDoraTrend({ boardId: 'ACC', limit: 1 });
      const p = points[0];
      expect(p).toHaveProperty('period.label');
      expect(p).toHaveProperty('period.start');
      expect(p).toHaveProperty('period.end');
      expect(p).toHaveProperty('orgDeploymentFrequency.deploymentsPerDay');
      expect(p).toHaveProperty('orgLeadTime.medianDays');
      expect(p).toHaveProperty('orgChangeFailureRate.changeFailureRate');
      expect(p).toHaveProperty('orgMttr.medianHours');
      expect(p).toHaveProperty('boardBreakdowns');
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

  // -------------------------------------------------------------------------
  // getDoraAggregate — caching behaviour
  // -------------------------------------------------------------------------

  describe('getDoraAggregate (caching)', () => {
    it('returns the same result on second call without hitting DB services again', async () => {
      // First call — services invoked
      const result1 = await service.getDoraAggregate({ boardId: 'ACC' });
      const firstCallCount = dfService.calculate.mock.calls.length;

      // Second call — should be served from cache
      const result2 = await service.getDoraAggregate({ boardId: 'ACC' });

      expect(dfService.calculate.mock.calls.length).toBe(firstCallCount); // no new DB calls
      expect(result2.orgDeploymentFrequency.totalDeployments).toBe(
        result1.orgDeploymentFrequency.totalDeployments,
      );
    });

    it('calls DB services again after cache is manually cleared', async () => {
      await service.getDoraAggregate({ boardId: 'ACC' });
      const countAfterFirst = dfService.calculate.mock.calls.length;

      doraCache.clear();

      await service.getDoraAggregate({ boardId: 'ACC' });
      expect(dfService.calculate.mock.calls.length).toBeGreaterThan(countAfterFirst);
    });

    it('does not share cache entries between different boardId values (second call)', async () => {
      await service.getDoraAggregate({ boardId: 'ACC' });
      const countAfterFirst = dfService.calculate.mock.calls.length;

      await service.getDoraAggregate({ boardId: 'BPT' });
      expect(dfService.calculate.mock.calls.length).toBeGreaterThan(countAfterFirst);
    });

    it('does not share cache entries between different boardId values', async () => {
      await service.getDoraAggregate({ boardId: 'ACC' });
      const countAfterFirst = dfService.calculate.mock.calls.length;

      await service.getDoraAggregate({ boardId: 'PLAT' });
      expect(dfService.calculate.mock.calls.length).toBeGreaterThan(countAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // getDoraTrend — caching behaviour
  // -------------------------------------------------------------------------

  describe('getDoraTrend (caching)', () => {
    it('returns the same result on second call without calling TrendDataLoader again', async () => {
      const result1 = await service.getDoraTrend({ boardId: 'ACC', limit: 2 });
      const loadsAfterFirst = trendDataLoader.load.mock.calls.length;

      const result2 = await service.getDoraTrend({ boardId: 'ACC', limit: 2 });

      // No additional data loads for the second trend fetch (cache hit)
      expect(trendDataLoader.load.mock.calls.length).toBe(loadsAfterFirst);
      expect(result2).toHaveLength(result1.length);
    });

    it('re-fetches after cache is cleared', async () => {
      await service.getDoraTrend({ boardId: 'ACC', limit: 2 });
      const loadsAfterFirst = trendDataLoader.load.mock.calls.length;

      doraCache.clear();

      await service.getDoraTrend({ boardId: 'ACC', limit: 2 });
      expect(trendDataLoader.load.mock.calls.length).toBeGreaterThan(loadsAfterFirst);
    });

    it('calls TrendDataLoader.load once per board regardless of period count', async () => {
      await service.getDoraTrend({ boardId: 'ACC', limit: 4 });
      // 1 board → 1 load, not 4 loads (one per quarter)
      expect(trendDataLoader.load).toHaveBeenCalledTimes(1);
    });

    it('calls TrendDataLoader.load once per board for multi-board trend', async () => {
      boardConfigRepo.find.mockResolvedValue([
        { boardId: 'ACC' } as BoardConfig,
        { boardId: 'PLAT' } as BoardConfig,
      ]);
      trendDataLoader.load
        .mockResolvedValueOnce({ ...MOCK_SLICE, boardId: 'ACC' })
        .mockResolvedValueOnce({ ...MOCK_SLICE, boardId: 'PLAT' });

      await service.getDoraTrend({ limit: 3 });

      // 2 boards → 2 loads, not 2 × 3 = 6
      expect(trendDataLoader.load).toHaveBeenCalledTimes(2);
    });
  });
});
