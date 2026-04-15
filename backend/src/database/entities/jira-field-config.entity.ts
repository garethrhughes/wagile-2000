import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * Singleton entity (always id = 1) that stores Jira-instance-specific field
 * configuration.  These values are global to the tenant, not per-board.
 *
 * Values are populated on application startup from the optional `jira:` stanza
 * in `config/boards.yaml`.  If the stanza is absent the defaults here match
 * the previous hardcoded values so all existing deployments continue to work
 * without any YAML change.
 */
@Entity('jira_field_config')
export class JiraFieldConfig {
  /**
   * Always 1.  There is exactly one row in this table — the singleton pattern
   * avoids the complexity of a keyless table while making the "global config"
   * semantics explicit.
   */
  @PrimaryColumn()
  id!: number;

  /**
   * Custom field IDs to probe for story points, tried in order.
   * The first field that returns a numeric value wins.
   *
   * Common variants:
   *   story_points      — legacy Jira Server / some older cloud projects
   *   customfield_10016 — "Story point estimate" (classic projects)
   *   customfield_10026 — "Story Points" (classic projects, older)
   *   customfield_10028 — "Story Points" (some cloud instances)
   *   customfield_11031 — "Story point estimate" (team-managed / next-gen)
   */
  @Column({
    type: 'simple-json',
    default: '["story_points","customfield_10016","customfield_10026","customfield_10028","customfield_11031"]',
  })
  storyPointsFieldIds!: string[];

  /**
   * Custom field ID for the legacy Epic Link field used by classic Jira
   * projects that predate the modern "parent" link relationship.
   * Set to null to suppress both the fields= query entry and the extraction
   * fallback (safe for tenants who have fully migrated to next-gen projects).
   */
  @Column({ type: 'varchar', nullable: true, default: 'customfield_10014' })
  epicLinkFieldId!: string | null;

  /**
   * Inward link type name substrings used to identify JPD delivery links.
   * Matched case-insensitively as substrings of the link type's inward label.
   */
  @Column({
    type: 'simple-json',
    default: '["is implemented by","is delivered by"]',
  })
  jpdDeliveryLinkInward!: string[];

  /**
   * Outward link type name substrings used to identify JPD delivery links.
   * Matched case-insensitively as substrings of the link type's outward label.
   */
  @Column({
    type: 'simple-json',
    default: '["implements","delivers"]',
  })
  jpdDeliveryLinkOutward!: string[];
}
