import { Controller, Post, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SyncService } from './sync.service.js';

@ApiTags('sync')
@Controller('api/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @ApiOperation({ summary: 'Trigger a full sync of all boards' })
  @Post()
  async triggerSync() {
    return this.syncService.syncAll();
  }

  @ApiOperation({ summary: 'Get sync status per board' })
  @Get('status')
  async getStatus() {
    return this.syncService.getStatus();
  }
}
