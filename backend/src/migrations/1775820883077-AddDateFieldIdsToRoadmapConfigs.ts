import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDateFieldIdsToRoadmapConfigs1775820883077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs"
         ADD COLUMN IF NOT EXISTS "startDateFieldId"  VARCHAR DEFAULT NULL,
         ADD COLUMN IF NOT EXISTS "targetDateFieldId" VARCHAR DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs" DROP COLUMN IF EXISTS "startDateFieldId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "roadmap_configs" DROP COLUMN IF EXISTS "targetDateFieldId"`,
    );
  }
}
