import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDoraSnapshotsTable
 *
 * Creates the `dora_snapshots` table used to store pre-computed DORA metric
 * results written by the Lambda snapshot worker (or the in-process fallback).
 *
 * One row per (boardId, snapshotType) composite primary key.
 * snapshotType is either 'aggregate' or 'trend'.
 */
export class AddDoraSnapshotsTable1776400000000 implements MigrationInterface {
  name = 'AddDoraSnapshotsTable1776400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dora_snapshots" (
        "boardId"       varchar NOT NULL,
        "snapshotType"  varchar NOT NULL,
        "payload"       jsonb   NOT NULL,
        "computedAt"    timestamptz NOT NULL DEFAULT now(),
        "triggeredBy"   varchar NOT NULL,
        "stale"         boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_dora_snapshots" PRIMARY KEY ("boardId", "snapshotType")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dora_snapshots_boardId"
       ON "dora_snapshots" ("boardId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_dora_snapshots_boardId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "dora_snapshots"`);
  }
}
