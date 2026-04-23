import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BoardsService } from './boards.service.js';
import { BoardsController } from './boards.controller.js';
import { BoardConfig, DoraSnapshot } from '../database/entities/index.js';
import { LambdaInvokerService } from '../lambda/lambda-invoker.service.js';
import { InProcessSnapshotService } from '../lambda/in-process-snapshot.service.js';
import { MetricsModule } from '../metrics/metrics.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([BoardConfig, DoraSnapshot]),
    forwardRef(() => MetricsModule),
  ],
  controllers: [BoardsController],
  providers: [BoardsService, LambdaInvokerService, InProcessSnapshotService],
  exports: [BoardsService],
})
export class BoardsModule {}
