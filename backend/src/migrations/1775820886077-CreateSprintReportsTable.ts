import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSprintReportsTable1775820886077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sprint_reports" (
        "boardId"        varchar NOT NULL,
        "sprintId"       varchar NOT NULL,
        "sprintName"     varchar NOT NULL,
        "startDate"      timestamptz,
        "endDate"        timestamptz,
        "compositeScore" float NOT NULL,
        "compositeBand"  varchar NOT NULL,
        "payload"        jsonb NOT NULL,
        "generatedAt"    timestamptz NOT NULL,
        PRIMARY KEY ("boardId", "sprintId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sprint_reports"`);
  }
}
