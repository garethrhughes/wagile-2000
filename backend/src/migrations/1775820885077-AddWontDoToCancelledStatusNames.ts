import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWontDoToCancelledStatusNames1775820885077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Update the column default so new rows include "Won't Do"
    await queryRunner.query(
      `ALTER TABLE "board_configs"
         ALTER COLUMN "cancelledStatusNames" SET DEFAULT '["Cancelled","Won''t Do"]'`,
    );

    // Patch existing rows that still have the old default ["Cancelled"]
    // Leave rows that have already been customised (anything other than the bare default).
    await queryRunner.query(
      `UPDATE "board_configs"
          SET "cancelledStatusNames" = '["Cancelled","Won''t Do"]'
        WHERE "cancelledStatusNames" = '["Cancelled"]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "board_configs"
         ALTER COLUMN "cancelledStatusNames" SET DEFAULT '["Cancelled"]'`,
    );

    await queryRunner.query(
      `UPDATE "board_configs"
          SET "cancelledStatusNames" = '["Cancelled"]'
        WHERE "cancelledStatusNames" = '["Cancelled","Won''t Do"]'`,
    );
  }
}
