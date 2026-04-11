import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('board_configs')
export class BoardConfig {
  @PrimaryColumn()
  boardId!: string;

  @Column({ default: 'scrum' })
  boardType!: string; // 'scrum' | 'kanban'

  @Column('simple-array', { default: 'Done,Closed,Released' })
  doneStatusNames!: string[];

  @Column('simple-json', { default: '["Bug","Incident"]' })
  failureIssueTypes!: string[];

  @Column('simple-json', { default: '["is caused by","caused by"]' })
  failureLinkTypes!: string[];

  @Column('simple-json', { default: '["regression","incident","hotfix"]' })
  failureLabels!: string[];

  @Column('simple-json', { default: '["Bug","Incident"]' })
  incidentIssueTypes!: string[];

  @Column('simple-json', { default: '["Done","Resolved"]' })
  recoveryStatusNames!: string[];

  @Column('simple-json', { default: '[]' })
  incidentLabels!: string[];

  @Column({ type: 'simple-json', default: '["Critical"]' })
  incidentPriorities!: string[];

  /**
   * Status IDs (not names) that represent the backlog / pre-board state for
   * Kanban boards.  Issues whose current statusId is in this list have never
   * been pulled onto the board and should be excluded from flow metrics.
   * When empty the fallback heuristic (no status changelog = backlog) is used.
   */
  @Column({ type: 'simple-json', default: '[]' })
  backlogStatusIds!: string[];

  /**
   * Optional ISO date string (YYYY-MM-DD) used as a hard lower bound for
   * Kanban flow metrics.  Issues whose board-entry date is before this date
   * are excluded from all Kanban period calculations (quarters, weeks, and
   * detail views).  Null means no lower bound.
   */
  @Column({ type: 'varchar', nullable: true, default: null })
  dataStartDate!: string | null;

  /**
   * Status names that represent active work has begun on an issue.
   * Used as the cycle-time start event: first transition to one of these
   * statuses marks when engineering work began.
   * Uses simple-json to support status names containing commas.
   */
  @Column({ type: 'simple-json', default: '["In Progress"]' })
  inProgressStatusNames!: string[];
}
