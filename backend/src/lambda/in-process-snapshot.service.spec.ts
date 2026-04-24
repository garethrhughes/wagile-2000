/**
 * in-process-snapshot.service.spec.ts
 *
 * Unit tests for InProcessSnapshotService.
 * MetricsService is mocked — the service now delegates to it entirely.
 */

import { Repository } from 'typeorm';
import { InProcessSnapshotService, ORG_SNAPSHOT_KEY } from './in-process-snapshot.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { BoardConfig, DoraSnapshot } from '../database/entities/index.js';
import type { OrgDoraResult } from '../metrics/dto/org-dora-response.dto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSnapshotRepo(): jest.Mocked<Repository<DoraSnapshot>> {
  return {
    upsert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Repository<DoraSnapshot>>;
}

function mockBoardConfigRepo(boardIds = ['ACC']): jest.Mocked<Repository<BoardConfig>> {
  return {
    find: jest.fn().mockResolvedValue(boardIds.map((boardId) => ({ boardId }))),
  } as unknown as jest.Mocked<Repository<BoardConfig>>;
}

function mockOrgDoraResult(): OrgDoraResult {
  return {
    period: { label: '2026-Q1', start: '2026-01-01T00:00:00.000Z', end: '2026-03-31T23:59:59.999Z' },
    orgDeploymentFrequency: { totalDeployments: 5, deploymentsPerDay: 0.05, band: 'low', periodDays: 90, contributingBoards: 1 },
    orgLeadTime: { medianDays: 3, p95Days: 10, band: 'high', sampleSize: 10, contributingBoards: 1, anomalyCount: 0 },
    orgChangeFailureRate: { totalDeployments: 5, failureCount: 0, changeFailureRate: 0, band: 'elite', contributingBoards: 1, anyBoardUsingDefaultConfig: false, boardsUsingDefaultConfig: [] },
    orgMttr: { medianHours: 2, band: 'elite', incidentCount: 0, contributingBoards: 0 },
    boardBreakdowns: [],
    anyBoardUsingDefaultConfig: false,
    boardsUsingDefaultConfig: [],
  };
}

function makeMockMetricsService(): jest.Mocked<Pick<MetricsService, 'getDoraAggregate' | 'getDoraTrend'>> {
  return {
    getDoraAggregate: jest.fn().mockResolvedValue(mockOrgDoraResult()),
    getDoraTrend: jest.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InProcessSnapshotService', () => {
  let service: InProcessSnapshotService;
  let snapshotRepo: jest.Mocked<Repository<DoraSnapshot>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let metricsService: jest.Mocked<Pick<MetricsService, 'getDoraAggregate' | 'getDoraTrend'>>;

  beforeEach(() => {
    snapshotRepo    = mockSnapshotRepo();
    boardConfigRepo = mockBoardConfigRepo(['ACC', 'BPT']);
    metricsService  = makeMockMetricsService();

    service = new InProcessSnapshotService(
      metricsService as unknown as MetricsService,
      snapshotRepo,
      boardConfigRepo,
    );
  });

  it('calls getDoraAggregate for the requested board', async () => {
    await service.computeAndPersist('ACC');
    expect(metricsService.getDoraAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'ACC' }),
    );
  });

  it('calls getDoraTrend for the requested board', async () => {
    await service.computeAndPersist('ACC');
    expect(metricsService.getDoraTrend).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'ACC' }),
    );
  });

  it('upserts five snapshot rows: per-board aggregate + trend + trend-display, org aggregate + trend', async () => {
    await service.computeAndPersist('ACC');
    // computeAndPersist calls computeBoard then computeOrg — two separate upserts
    expect(snapshotRepo.upsert).toHaveBeenCalledTimes(2);

    const allRows = (snapshotRepo.upsert.mock.calls as [Array<{ boardId: string; snapshotType: string }>, string[]][])
      .flatMap(([rows]) => rows);

    expect(allRows).toHaveLength(5);
    const perBoard = allRows.filter((r) => r.boardId === 'ACC');
    const org      = allRows.filter((r) => r.boardId === ORG_SNAPSHOT_KEY);
    expect(perBoard.map((r) => r.snapshotType).sort()).toEqual(['aggregate', 'trend', 'trend-display']);
    expect(org.map((r) => r.snapshotType).sort()).toEqual(['aggregate', 'trend']);
  });

  it('stores the OrgDoraResult payload for the aggregate snapshot', async () => {
    const aggregate = mockOrgDoraResult();
    metricsService.getDoraAggregate.mockResolvedValue(aggregate);

    await service.computeAndPersist('ACC');

    const allRows = (snapshotRepo.upsert.mock.calls as [Array<{ snapshotType: string; payload: unknown }>, string[]][])
      .flatMap(([rows]) => rows);
    const aggregateRow = allRows.find((r) => r.snapshotType === 'aggregate');
    expect(aggregateRow?.payload).toBe(aggregate);
  });

  it('rethrows errors so SyncService can log them', async () => {
    metricsService.getDoraAggregate.mockRejectedValue(new Error('query failed'));
    await expect(service.computeAndPersist('ACC')).rejects.toThrow('query failed');
  });
});
