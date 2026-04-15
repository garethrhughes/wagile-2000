import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJiraFieldConfig1776207911000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "jira_field_config" (
        "id"                      integer NOT NULL DEFAULT 1,
        "storyPointsFieldIds"     text NOT NULL DEFAULT '["story_points","customfield_10016","customfield_10026","customfield_10028","customfield_11031"]',
        "epicLinkFieldId"         varchar NULL DEFAULT 'customfield_10014',
        "jpdDeliveryLinkInward"   text NOT NULL DEFAULT '["is implemented by","is delivered by"]',
        "jpdDeliveryLinkOutward"  text NOT NULL DEFAULT '["implements","delivers"]',
        CONSTRAINT "PK_jira_field_config" PRIMARY KEY ("id")
      )
    `);

    // Insert the singleton row so it is immediately available without
    // requiring a YAML seed or a manual INSERT.
    await queryRunner.query(`
      INSERT INTO "jira_field_config" ("id")
      VALUES (1)
      ON CONFLICT ("id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "jira_field_config"`);
  }
}
