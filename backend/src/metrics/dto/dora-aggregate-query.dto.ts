import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /api/metrics/dora/aggregate
 * Uses the same `boardId` (comma-separated) convention as MetricsQueryDto.
 */
export class DoraAggregateQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated board IDs (e.g. ACC,BPT,PLAT). Defaults to all boards.',
  })
  @IsOptional()
  @IsString()
  boardId?: string;

  @ApiPropertyOptional({
    description: 'Quarter in format YYYY-QN (e.g. 2025-Q1)',
    example: '2025-Q1',
  })
  @IsOptional()
  @IsString()
  quarter?: string;

  @ApiPropertyOptional({
    description: 'Sprint ID to scope metrics to',
  })
  @IsOptional()
  @IsString()
  sprintId?: string;

  @ApiPropertyOptional({
    description: 'Explicit date range in format YYYY-MM-DD:YYYY-MM-DD',
    example: '2025-01-01:2025-03-31',
  })
  @IsOptional()
  @IsString()
  period?: string;
}
