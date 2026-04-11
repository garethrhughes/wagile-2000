import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInProgressStatusNamesToBoardConfigs1775820881077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" ADD COLUMN IF NOT EXISTS "inProgressStatusNames" TEXT NOT NULL DEFAULT '["In Progress"]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" DROP COLUMN IF EXISTS "inProgressStatusNames"`,
    );
  }
}
