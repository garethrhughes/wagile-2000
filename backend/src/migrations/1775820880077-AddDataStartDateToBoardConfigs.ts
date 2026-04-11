import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDataStartDateToBoardConfigs1775820880077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" ADD COLUMN IF NOT EXISTS "dataStartDate" character varying DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" DROP COLUMN IF EXISTS "dataStartDate"`,
    );
  }
}
