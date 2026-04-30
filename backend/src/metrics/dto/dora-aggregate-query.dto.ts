import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DoraAggregateQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated board IDs (e.g. ACC,BPT,PLAT). Defaults to all boards.',
  })
  @IsOptional()
  @IsString()
  boardId?: string;

  @ApiPropertyOptional({
    description:
      'Calendar quarter in YYYY-QN format (e.g. 2026-Q2). ' +
      'Defaults to the current calendar quarter when omitted.',
    example: '2026-Q2',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-Q[1-4]$/, { message: 'quarter must be in YYYY-QN format, e.g. 2026-Q2' })
  quarter?: string;

  @ApiPropertyOptional({
    description:
      'Sprint ID — when provided, metrics are scoped to the sprint window ' +
      'instead of a calendar quarter.',
  })
  @IsOptional()
  @IsString()
  sprintId?: string;
}
