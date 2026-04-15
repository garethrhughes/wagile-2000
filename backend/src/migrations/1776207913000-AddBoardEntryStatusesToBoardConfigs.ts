import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBoardEntryStatusesToBoardConfigs1776207913000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // C-3 (Proposal 0030): configurable board-entry status list for Kanban boards.
    // Nullable TEXT column; NULL means use the extended code-level default list.
    // Stored as JSON-encoded string array (simple-json pattern) when explicitly set.
    await queryRunner.query(
      `ALTER TABLE "board_configs" ADD COLUMN IF NOT EXISTS "boardEntryStatuses" TEXT NULL DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" DROP COLUMN IF EXISTS "boardEntryStatuses"`,
    );
  }
}
