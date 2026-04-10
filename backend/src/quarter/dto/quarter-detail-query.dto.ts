import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QuarterDetailParamsDto {
  @ApiProperty()
  @IsString()
  boardId!: string;

  @ApiProperty({ example: '2025-Q2' })
  @IsString()
  @Matches(/^\d{4}-Q[1-4]$/, { message: 'quarter must be in format YYYY-QN e.g. 2025-Q2' })
  quarter!: string;
}
