import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('config')
@Controller('api/config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Returns application-level configuration for the frontend' })
  @ApiResponse({ status: 200, description: 'App config' })
  getConfig(): { timezone: string } {
    return {
      timezone: this.configService.get<string>('TIMEZONE', 'UTC'),
    };
  }
}
