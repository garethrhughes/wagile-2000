/**
 * DoraSnapshotReadService
 *
 * Reads pre-computed DORA snapshots from the `dora_snapshots` table.
 * Attaches staleness metadata based on the snapshot's age.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { DoraSnapshot, DoraSnapshotType } from '../database/entities/index.js';

export interface SnapshotResult {
  payload: object;
  ageSeconds: number;
  stale: boolean;
}

export interface BoardSnapshotStatus {
  boardId: string;
  computedAt: Date | null;
  ageSeconds: number | null;
  isStale: boolean | null;
  hasAggregate: boolean;
  hasTrend: boolean;
}

@Injectable()
export class DoraSnapshotReadService {
  constructor(
    @InjectRepository(DoraSnapshot)
    private readonly snapshotRepo: Repository<DoraSnapshot>,
    private readonly config: ConfigService,
  ) {}

  async getSnapshot(
    boardId: string,
    snapshotType: DoraSnapshotType,
  ): Promise<SnapshotResult | null> {
    const row = await this.snapshotRepo.findOne({
      where: { boardId, snapshotType },
    });
    if (!row) return null;

    const ageSeconds = Math.floor(
      (Date.now() - row.computedAt.getTime()) / 1000,
    );
    const staleThresholdSeconds =
      (this.config.get<number>('SNAPSHOT_STALE_THRESHOLD_MINUTES') ?? 60) * 60;
    const stale = ageSeconds > staleThresholdSeconds;

    return { payload: row.payload, ageSeconds, stale };
  }

  async getSnapshotStatus(boardIds: string[]): Promise<BoardSnapshotStatus[]> {
    const rows = await this.snapshotRepo.find();

    const staleThresholdSeconds =
      (this.config.get<number>('SNAPSHOT_STALE_THRESHOLD_MINUTES') ?? 60) * 60;

    return boardIds.map((boardId) => {
      const aggregate = rows.find(
        (r) => r.boardId === boardId && r.snapshotType === 'aggregate',
      );
      const trend = rows.find(
        (r) => r.boardId === boardId && r.snapshotType === 'trend',
      );

      // Use the most recent snapshot for age/staleness
      const latestRow = [aggregate, trend]
        .filter((r): r is DoraSnapshot => r !== undefined)
        .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0];

      if (!latestRow) {
        return {
          boardId,
          computedAt: null,
          ageSeconds: null,
          isStale: null,
          hasAggregate: false,
          hasTrend: false,
        };
      }

      const ageSeconds = Math.floor(
        (Date.now() - latestRow.computedAt.getTime()) / 1000,
      );
      const isStale = ageSeconds > staleThresholdSeconds;

      return {
        boardId,
        computedAt: latestRow.computedAt,
        ageSeconds,
        isStale,
        hasAggregate: aggregate !== undefined,
        hasTrend: trend !== undefined,
      };
    });
  }
}
