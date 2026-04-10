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
}
