import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UnplannedDoneQueryDto {
  @ApiPropertyOptional({
    description:
      'Board identifier (e.g. ACC, BPT). Omit or pass "all" to aggregate across all Scrum boards.',
  })
  @IsOptional()
  @IsString()
  boardId?: string;

  @ApiPropertyOptional({ description: 'Sprint ID to scope the report to' })
  @IsOptional()
  @IsString()
  sprintId?: string;

  @ApiPropertyOptional({
    description: 'Quarter in format YYYY-QN (e.g. 2026-Q1)',
    example: '2026-Q1',
  })
  @IsOptional()
  @IsString()
  quarter?: string;
}
