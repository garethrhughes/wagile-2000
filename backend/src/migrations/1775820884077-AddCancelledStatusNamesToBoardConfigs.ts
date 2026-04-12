import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCancelledStatusNamesToBoardConfigs1775820884077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs"
         ADD COLUMN IF NOT EXISTS "cancelledStatusNames" TEXT NOT NULL DEFAULT '["Cancelled","Won''t Do"]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs" DROP COLUMN IF EXISTS "cancelledStatusNames"`,
    );
  }
}
