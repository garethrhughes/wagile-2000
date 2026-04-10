import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateJiraIssueLinksTable1775820877077
  implements MigrationInterface
{
  name = 'CreateJiraIssueLinksTable1775820877077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS jira_issue_links (
        id SERIAL PRIMARY KEY,
        source_issue_key VARCHAR NOT NULL,
        target_issue_key VARCHAR NOT NULL,
        link_type_name VARCHAR NOT NULL,
        is_inward BOOLEAN NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jira_issue_links_source ON jira_issue_links(source_issue_key)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_jira_issue_links_target ON jira_issue_links(target_issue_key)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS jira_issue_links`);
  }
}
