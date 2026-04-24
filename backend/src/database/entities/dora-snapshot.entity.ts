import {
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type DoraSnapshotType = 'aggregate' | 'trend' | 'trend-display';

@Entity('dora_snapshots')
@Index(['boardId'])
export class DoraSnapshot {
  /**
   * Composite primary key: one row per board per snapshot type.
   * boardId: e.g. 'ACC', 'PLAT'
   */
  @PrimaryColumn()
  boardId!: string;

  @PrimaryColumn()
  snapshotType!: DoraSnapshotType;

  /**
   * The full serialised result from MetricsService.getDoraAggregate() or
   * MetricsService.getDoraTrend(). Stored as JSONB for efficient read and
   * optional future Postgres-side querying.
   */
  @Column({ type: 'jsonb' })
  payload!: object;

  /**
   * Wall-clock timestamp when this snapshot was last computed.
   * Used by the API to attach staleness metadata to the response.
   */
  @UpdateDateColumn({ type: 'timestamptz' })
  computedAt!: Date;

  /**
   * The boardId of the sync that triggered this computation.
   * Matches SyncLog.boardId for correlation in debugging.
   */
  @Column({ type: 'varchar' })
  triggeredBy!: string;

  /**
   * Whether this snapshot is considered stale. Set to true by the API layer
   * when computedAt is older than 2× the sync interval (1 hour).
   * Computed at read time — not stored. This column is reserved for future
   * use (e.g. explicit invalidation on board config change before recompute
   * has completed).
   */
  @Column({ default: false })
  stale!: boolean;
}
