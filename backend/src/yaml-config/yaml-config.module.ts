import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BoardConfig, RoadmapConfig, JiraFieldConfig } from '../database/entities/index.js';
import { YamlConfigService } from './yaml-config.service.js';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([BoardConfig, RoadmapConfig, JiraFieldConfig])],
  providers: [YamlConfigService],
  exports: [YamlConfigService],
})
export class YamlConfigModule {}
