import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('jpd_ideas')
export class JpdIdea {
  @PrimaryColumn()
  key!: string;

  @Column()
  summary!: string;

  @Column()
  status!: string;

  @Column()
  jpdKey!: string;

  @Column('simple-array', { nullable: true })
  deliveryIssueKeys!: string[] | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  startDate!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  targetDate!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  syncedAt!: Date;
}
