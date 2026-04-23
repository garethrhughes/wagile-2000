/**
 * dora-snapshot.entity.spec.ts
 *
 * Structural tests for the DoraSnapshot entity:
 * - Verify that composite PK columns exist with the right names
 * - Verify that `payload` is declared as jsonb
 * - Verify that `computedAt` is managed by TypeORM UpdateDateColumn
 */
import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { DoraSnapshot } from './dora-snapshot.entity.js';

describe('DoraSnapshot entity', () => {
  it('has a table name of dora_snapshots', () => {
    const tables = getMetadataArgsStorage().tables;
    const meta = tables.find((t) => t.target === DoraSnapshot);
    expect(meta?.name).toBe('dora_snapshots');
  });

  it('has boardId and snapshotType as primary columns', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === DoraSnapshot,
    );
    const pkCols = cols
      .filter((c) => c.options.primary === true)
      .map((c) => c.propertyName);
    expect(pkCols).toContain('boardId');
    expect(pkCols).toContain('snapshotType');
  });

  it('has a jsonb payload column', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === DoraSnapshot,
    );
    const payloadCol = cols.find((c) => c.propertyName === 'payload');
    expect(payloadCol).toBeDefined();
    expect(payloadCol?.options.type).toBe('jsonb');
  });

  it('has a computedAt UpdateDateColumn', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === DoraSnapshot,
    );
    const computedAtCol = cols.find((c) => c.propertyName === 'computedAt');
    expect(computedAtCol).toBeDefined();
    // UpdateDateColumn uses mode 'updateDate'
    expect(computedAtCol?.mode).toBe('updateDate');
  });

  it('has triggeredBy and stale columns', () => {
    const cols = getMetadataArgsStorage()
      .columns.filter((c) => c.target === DoraSnapshot)
      .map((c) => c.propertyName);
    expect(cols).toContain('triggeredBy');
    expect(cols).toContain('stale');
  });
});
