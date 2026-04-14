import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAssigneeToJiraIssues1775820887077 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jira_issues"
         ADD COLUMN IF NOT EXISTS "assignee" varchar NULL DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jira_issues" DROP COLUMN IF EXISTS "assignee"`,
    );
  }
}
