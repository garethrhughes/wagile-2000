import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('sprint_reports')
export class SprintReport {
  @PrimaryColumn()
  boardId!: string;

  @PrimaryColumn()
  sprintId!: string;

  @Column()
  sprintName!: string;

  @Column({ type: 'timestamptz', nullable: true })
  startDate!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endDate!: Date | null;

  @Column({ type: 'float' })
  compositeScore!: number;

  @Column()
  compositeBand!: string;

  @Column({ type: 'jsonb' })
  payload!: object;

  @Column({ type: 'timestamptz' })
  generatedAt!: Date;
}
