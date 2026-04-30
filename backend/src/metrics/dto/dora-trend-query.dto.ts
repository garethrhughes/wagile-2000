import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /api/metrics/dora/trend
 * `boardId` is comma-separated (same semantics as MetricsQueryDto.boardId).
 */
export class DoraTrendQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated board IDs. Defaults to all boards.',
  })
  @IsOptional()
  @IsString()
  boardId?: string;

  @ApiPropertyOptional({
    description: 'Number of periods to return (default 8, max 20)',
    default: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Period mode: "quarter" (default) or "sprint".',
    enum: ['quarter', 'sprint'],
    default: 'quarter',
  })
  @IsOptional()
  @IsString()
  mode?: 'quarter' | 'sprint';

  @ApiPropertyOptional({
    description:
      'Sprint ID — only used when mode=sprint and a single boardId is given.',
  })
  @IsOptional()
  @IsString()
  sprintId?: string;
}
