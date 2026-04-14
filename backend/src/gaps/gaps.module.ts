import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  JiraIssue,
  JiraSprint,
  BoardConfig,
  JiraChangelog,
} from '../database/entities/index.js';
import { GapsController } from './gaps.controller.js';
import { GapsService } from './gaps.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([JiraIssue, JiraSprint, BoardConfig, JiraChangelog]),
  ],
  controllers: [GapsController],
  providers: [GapsService],
})
export class GapsModule {}
