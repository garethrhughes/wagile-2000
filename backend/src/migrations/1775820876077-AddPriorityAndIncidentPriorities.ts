import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPriorityAndIncidentPriorities1775820876077
  implements MigrationInterface
{
  name = 'AddPriorityAndIncidentPriorities1775820876077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE jira_issues ADD COLUMN IF NOT EXISTS priority VARCHAR NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE board_configs ADD COLUMN IF NOT EXISTS incident_priorities TEXT NOT NULL DEFAULT '["Critical"]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE jira_issues DROP COLUMN IF EXISTS priority`,
    );
    await queryRunner.query(
      `ALTER TABLE board_configs DROP COLUMN IF EXISTS incident_priorities`,
    );
  }
}
