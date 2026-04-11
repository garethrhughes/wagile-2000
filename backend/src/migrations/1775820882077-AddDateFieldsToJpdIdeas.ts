import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDateFieldsToJpdIdeas1775820882077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas"
         ADD COLUMN IF NOT EXISTS "startDate"  TIMESTAMP WITH TIME ZONE DEFAULT NULL,
         ADD COLUMN IF NOT EXISTS "targetDate" TIMESTAMP WITH TIME ZONE DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas" DROP COLUMN IF EXISTS "startDate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "jpd_ideas" DROP COLUMN IF EXISTS "targetDate"`,
    );
  }
}
