import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query DTO for GET /api/metrics/cycle-time/trend
 * Mirrors DoraTrendQueryDto structure exactly (Issue 4).
 */
export class CycleTimeTrendQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated board IDs. Defaults to all boards.',
  })
  @IsOptional()
  @IsString()
  boardId?: string;

  @ApiPropertyOptional({
    description: 'Period mode: quarters (default) or sprints',
    enum: ['quarters', 'sprints'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['quarters', 'sprints'])
  mode?: 'quarters' | 'sprints';

  @ApiPropertyOptional({
    description: 'Number of periods to return (default 8, max 52)',
    default: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Filter to a single Jira issue type, e.g. Story',
  })
  @IsOptional()
  @IsString()
  issueType?: string;
}
