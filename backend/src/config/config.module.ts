import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller.js';
import { YamlConfigModule } from '../yaml-config/yaml-config.module.js';

@Module({
  imports: [YamlConfigModule],
  controllers: [ConfigController],
})
export class AppConfigModule {}
