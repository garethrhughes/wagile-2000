import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChangelogIndex1775795358706 implements MigrationInterface {
  name = 'AddChangelogIndex1775795358706';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_jira_changelogs_issueKey_field" ON "jira_changelogs" ("issueKey", "field")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_jira_changelogs_issueKey_field"`,
    );
  }
}
