import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CycleTimeQueryDto {
  /** Comma-separated board IDs, or omitted for all boards */
  @ApiPropertyOptional({ description: 'Comma-separated board IDs. Defaults to all boards.' })
  @IsOptional()
  @IsString()
  boardId?: string;

  /** YYYY-MM-DD:YYYY-MM-DD explicit range */
  @ApiPropertyOptional({ description: 'Explicit date range in YYYY-MM-DD:YYYY-MM-DD format' })
  @IsOptional()
  @IsString()
  period?: string;

  /** Single sprint ID */
  @ApiPropertyOptional({ description: 'Single sprint ID to resolve date range from' })
  @IsOptional()
  @IsString()
  sprintId?: string;

  /** Quarter in YYYY-QN format */
  @ApiPropertyOptional({ description: 'Quarter in YYYY-QN format, e.g. 2026-Q1' })
  @IsOptional()
  @IsString()
  quarter?: string;

  /** Filter to a single Jira issue type, e.g. "Story" */
  @ApiPropertyOptional({ description: 'Filter to a single Jira issue type, e.g. Story' })
  @IsOptional()
  @IsString()
  issueType?: string;
}
