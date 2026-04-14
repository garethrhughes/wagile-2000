import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UnplannedDoneQueryDto {
  @ApiProperty({ description: 'Board identifier (e.g. ACC, BPT)' })
  @IsNotEmpty()
  @IsString()
  boardId!: string;

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
