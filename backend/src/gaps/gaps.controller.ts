import { Controller, Get } from '@nestjs/common';
import { GapsService, GapsResponse } from './gaps.service.js';

@Controller('api/gaps')
export class GapsController {
  constructor(private readonly gapsService: GapsService) {}

  @Get()
  getGaps(): Promise<GapsResponse> {
    return this.gapsService.getGaps();
  }
}
