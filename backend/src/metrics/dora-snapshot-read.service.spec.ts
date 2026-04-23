/**
 * dora-snapshot-read.service.spec.ts
 *
 * Unit tests for DoraSnapshotReadService.
 */
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { DoraSnapshotReadService } from './dora-snapshot-read.service.js';
import { DoraSnapshot } from '../database/entities/index.js';

function mockRepo(): jest.Mocked<Repository<DoraSnapshot>> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as jest.Mocked<Repository<DoraSnapshot>>;
}

function makeConfig(staleMinutes?: number): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string, def?: unknown) => {
      if (key === 'SNAPSHOT_STALE_THRESHOLD_MINUTES') return staleMinutes;
      return def;
    }),
  } as unknown as ConfigService;
}

function makeSnapshot(ageMinutes: number): DoraSnapshot {
  const computedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
  return {
    boardId: 'ACC',
    snapshotType: 'aggregate',
    payload: { some: 'data' },
    computedAt,
    triggeredBy: 'ACC',
    stale: false,
  } as DoraSnapshot;
}

describe('DoraSnapshotReadService', () => {
  let service: DoraSnapshotReadService;
  let repo: jest.Mocked<Repository<DoraSnapshot>>;

  beforeEach(() => {
    repo = mockRepo();
    service = new DoraSnapshotReadService(repo, makeConfig());
  });

  it('returns null when no snapshot row exists', async () => {
    repo.findOne.mockResolvedValue(null);

    const result = await service.getSnapshot('ACC', 'aggregate');

    expect(result).toBeNull();
  });

  it('returns payload and ageSeconds when snapshot is fresh', async () => {
    repo.findOne.mockResolvedValue(makeSnapshot(5)); // 5 minutes old

    const result = await service.getSnapshot('ACC', 'aggregate');

    expect(result).not.toBeNull();
    expect(result!.payload).toEqual({ some: 'data' });
    expect(result!.ageSeconds).toBeGreaterThanOrEqual(5 * 60);
    expect(result!.stale).toBe(false);
  });

  it('marks snapshot as stale when age exceeds default threshold (60 min)', async () => {
    repo.findOne.mockResolvedValue(makeSnapshot(61)); // 61 minutes old

    const result = await service.getSnapshot('ACC', 'aggregate');

    expect(result!.stale).toBe(true);
  });

  it('respects SNAPSHOT_STALE_THRESHOLD_MINUTES config', async () => {
    const customService = new DoraSnapshotReadService(repo, makeConfig(30));
    repo.findOne.mockResolvedValue(makeSnapshot(31)); // 31 minutes old

    const result = await customService.getSnapshot('ACC', 'aggregate');

    expect(result!.stale).toBe(true);
  });

  it('returns all boards snapshot status', async () => {
    const now = new Date();
    repo.find.mockResolvedValue([
      {
        boardId: 'ACC',
        snapshotType: 'aggregate',
        payload: {},
        computedAt: now,
        triggeredBy: 'ACC',
        stale: false,
      } as DoraSnapshot,
      {
        boardId: 'ACC',
        snapshotType: 'trend',
        payload: {},
        computedAt: now,
        triggeredBy: 'ACC',
        stale: false,
      } as DoraSnapshot,
    ]);

    const status = await service.getSnapshotStatus(['ACC', 'PLAT']);

    expect(status).toHaveLength(2);
    const acc = status.find((s) => s.boardId === 'ACC');
    const plat = status.find((s) => s.boardId === 'PLAT');
    expect(acc?.hasAggregate).toBe(true);
    expect(acc?.hasTrend).toBe(true);
    expect(plat?.hasAggregate).toBe(false);
    expect(plat?.hasTrend).toBe(false);
  });
});
