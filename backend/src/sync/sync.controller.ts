import { Controller, Post, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { SyncService } from './sync.service.js';

@ApiTags('sync')
@Controller('api/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @ApiOperation({ summary: 'Trigger a full sync of all boards (fire-and-forget)' })
  @Post()
  @HttpCode(202)
  triggerSync(@Res({ passthrough: true }) res: Response) {
    if (this.syncService.isSyncRunning) {
      res.status(HttpStatus.CONFLICT);
      return { status: 'conflict', message: 'A sync is already in progress.' };
    }

    // Run in background — do not await. A full sync across all boards takes
    // several minutes (changelog fetches per issue) and will exceed the
    // CloudFront 60-second origin timeout if awaited synchronously.
    this.syncService.syncAll().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // SyncService already logs per-board failures; this catches unexpected
      // top-level errors (e.g. DB connection lost before syncAll starts).
      console.error(`[SyncController] syncAll() rejected unexpectedly: ${msg}`);
    });
    return { status: 'accepted', message: 'Sync started. Poll /api/sync/status for progress.' };
  }

  @ApiOperation({ summary: 'Get sync status per board' })
  @Get('status')
  async getStatus() {
    return this.syncService.getStatus();
  }
}
