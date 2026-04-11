import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('roadmap_configs')
export class RoadmapConfig {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  jpdKey!: string;

  @Column({ type: 'varchar', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  startDateFieldId!: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  targetDateFieldId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
