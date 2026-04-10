import {
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('jira_issues')
export class JiraIssue {
  @PrimaryColumn()
  key!: string;

  @Column()
  summary!: string;

  @Column()
  status!: string;

  @Column()
  issueType!: string;

  @Column({ type: 'varchar', nullable: true })
  fixVersion!: string | null;

  @Column({ type: 'float', nullable: true })
  points!: number | null;

  @Column({ type: 'varchar', nullable: true })
  sprintId!: string | null;

  @Column()
  boardId!: string;

  @Column({ type: 'varchar', nullable: true })
  epicKey!: string | null;

  @Column('simple-json', { default: '[]' })
  labels!: string[];

  @Column({ type: 'varchar', nullable: true, default: null })
  priority!: string | null;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
