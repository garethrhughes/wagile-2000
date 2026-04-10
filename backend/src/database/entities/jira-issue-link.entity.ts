import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('jira_issue_links')
@Index(['sourceIssueKey'])
@Index(['targetIssueKey'])
export class JiraIssueLink {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar' })
  sourceIssueKey!: string;

  @Column({ type: 'varchar' })
  targetIssueKey!: string;

  @Column({ type: 'varchar' })
  linkTypeName!: string;

  @Column({ type: 'boolean' })
  isInward!: boolean;
}
