import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module.js';
import { JiraModule } from './jira/jira.module.js';
import { SyncModule } from './sync/sync.module.js';
import { BoardsModule } from './boards/boards.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { PlanningModule } from './planning/planning.module.js';
import { RoadmapModule } from './roadmap/roadmap.module.js';
import { SprintModule } from './sprint/sprint.module.js';
import { QuarterModule } from './quarter/quarter.module.js';
import { WeekModule } from './week/week.module.js';
import { GapsModule } from './gaps/gaps.module.js';
import { AppConfigModule } from './config/config.module.js';
import { SprintReportModule } from './sprint-report/sprint-report.module.js';

// YamlConfigModule is intentionally NOT imported here directly.
// AppConfigModule already imports and re-exports YamlConfigModule.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres'),
        database: config.get<string>('DB_DATABASE', 'ai_starter'),
        ssl: config.get<string>('NODE_ENV') === 'production'
          ? { rejectUnauthorized: false }
          : false,
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        migrationsRun: true,
        synchronize: false,
      }),
    }),
    JiraModule,
    SyncModule,
    BoardsModule,
    MetricsModule,
    PlanningModule,
    RoadmapModule,
    SprintModule,
    QuarterModule,
    WeekModule,
    GapsModule,
    HealthModule,
    AppConfigModule,
    SprintReportModule,
  ],
})
export class AppModule {}
