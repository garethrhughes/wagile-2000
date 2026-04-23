/**
 * metrics.controller.spec.ts
 *
 * Unit tests for the snapshot-aware MetricsController endpoints.
 * Tests that:
 *   - getDoraAggregate returns 202 when no snapshot exists
 *   - getDoraAggregate returns payload with age header when snapshot is fresh
 *   - getDoraAggregate sets X-Snapshot-Stale header when snapshot is stale
 *   - getDoraTrend follows the same pattern
 *   - getSnapshotStatus delegates to DoraSnapshotReadService
 */
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { DoraSnapshotReadService } from './dora-snapshot-read.service.js';
import type { SnapshotResult, BoardSnapshotStatus } from './dora-snapshot-read.service.js';
import type { OrgDoraResult, TrendResponse } from './dto/org-dora-response.dto.js';
import type { DoraAggregateQueryDto } from './dto/dora-aggregate-query.dto.js';
import type { DoraTrendQueryDto } from './dto/dora-trend-query.dto.js';

function mockMetricsService(): jest.Mocked<MetricsService> {
  return {
    getDora: jest.fn(),
    getDoraAggregate: jest.fn(),
    getDoraTrend: jest.fn(),
    getDeploymentFrequency: jest.fn(),
    getLeadTime: jest.fn(),
    getCfr: jest.fn(),
    getMttr: jest.fn(),
  } as unknown as jest.Mocked<MetricsService>;
}

function mockSnapshotReadService(): jest.Mocked<DoraSnapshotReadService> {
  return {
    getSnapshot: jest.fn(),
    getSnapshotStatus: jest.fn(),
  } as unknown as jest.Mocked<DoraSnapshotReadService>;
}

function mockRes(): { status: jest.Mock; setHeader: jest.Mock } {
  return {
    status: jest.fn(),
    setHeader: jest.fn(),
  };
}

describe('MetricsController — snapshot-aware endpoints', () => {
  let controller: MetricsController;
  let snapshotSvc: jest.Mocked<DoraSnapshotReadService>;

  beforeEach(() => {
    snapshotSvc = mockSnapshotReadService();
    controller = new MetricsController(mockMetricsService(), snapshotSvc);
  });

  // ── getDoraAggregate ──────────────────────────────────────────────────────

  describe('getDoraAggregate', () => {
    const query = { boardId: 'ACC' } as DoraAggregateQueryDto;

    it('returns 202 pending when no snapshot exists', async () => {
      snapshotSvc.getSnapshot.mockResolvedValue(null);
      const res = mockRes();

      const result = await controller.getDoraAggregate(query, res as never);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(result).toEqual({
        status: 'pending',
        message: 'Snapshot not yet computed. Trigger a sync.',
      });
    });

    it('returns payload with X-Snapshot-Age header when snapshot is fresh', async () => {
      const snapshot: SnapshotResult = {
        payload: { deploymentFrequency: 1.5 } as unknown as OrgDoraResult,
        ageSeconds: 120,
        stale: false,
      };
      snapshotSvc.getSnapshot.mockResolvedValue(snapshot);
      const res = mockRes();

      const result = await controller.getDoraAggregate(query, res as never);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Snapshot-Age', '120');
      expect(res.setHeader).not.toHaveBeenCalledWith('X-Snapshot-Stale', 'true');
      expect(result).toEqual(snapshot.payload);
    });

    it('sets X-Snapshot-Stale header when snapshot is stale', async () => {
      const snapshot: SnapshotResult = {
        payload: { deploymentFrequency: 0 } as unknown as OrgDoraResult,
        ageSeconds: 7200,
        stale: true,
      };
      snapshotSvc.getSnapshot.mockResolvedValue(snapshot);
      const res = mockRes();

      await controller.getDoraAggregate(query, res as never);

      expect(res.setHeader).toHaveBeenCalledWith('X-Snapshot-Stale', 'true');
      expect(res.setHeader).toHaveBeenCalledWith('X-Snapshot-Age', '7200');
    });
  });

  // ── getDoraTrend ──────────────────────────────────────────────────────────

  describe('getDoraTrend', () => {
    const query = { boardId: 'ACC' } as DoraTrendQueryDto;

    it('returns 202 pending when no trend snapshot exists', async () => {
      snapshotSvc.getSnapshot.mockResolvedValue(null);
      const res = mockRes();

      const result = await controller.getDoraTrend(query, res as never);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(result).toEqual({
        status: 'pending',
        message: 'Snapshot not yet computed. Trigger a sync.',
      });
    });

    it('returns payload with X-Snapshot-Age header when trend snapshot is fresh', async () => {
      const snapshot: SnapshotResult = {
        payload: { periods: [] } as unknown as TrendResponse,
        ageSeconds: 300,
        stale: false,
      };
      snapshotSvc.getSnapshot.mockResolvedValue(snapshot);
      const res = mockRes();

      const result = await controller.getDoraTrend(query, res as never);

      expect(res.setHeader).toHaveBeenCalledWith('X-Snapshot-Age', '300');
      expect(result).toEqual(snapshot.payload);
    });

    it('sets X-Snapshot-Stale header when trend snapshot is stale', async () => {
      const snapshot: SnapshotResult = {
        payload: { periods: [] } as unknown as TrendResponse,
        ageSeconds: 9000,
        stale: true,
      };
      snapshotSvc.getSnapshot.mockResolvedValue(snapshot);
      const res = mockRes();

      await controller.getDoraTrend(query, res as never);

      expect(res.setHeader).toHaveBeenCalledWith('X-Snapshot-Stale', 'true');
    });
  });

  // ── getSnapshotStatus ──────────────────────────────────────────────────────

  describe('getSnapshotStatus', () => {
    it('returns snapshot status for all boards', async () => {
      const status: BoardSnapshotStatus[] = [
        {
          boardId: 'ACC',
          computedAt: new Date(),
          ageSeconds: 500,
          isStale: false,
          hasAggregate: true,
          hasTrend: true,
        },
      ];
      snapshotSvc.getSnapshotStatus.mockResolvedValue(status);

      const result = await controller.getSnapshotStatus();

      expect(snapshotSvc.getSnapshotStatus).toHaveBeenCalledWith([
        'ACC', 'BPT', 'SPS', 'OCS', 'DATA', 'PLAT',
      ]);
      expect(result).toBe(status);
    });
  });
});
