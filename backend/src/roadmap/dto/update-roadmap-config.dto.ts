import { IsOptional, IsString, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateRoadmapConfigDto {
  @ApiPropertyOptional({
    type: String,
    example: 'customfield_10015',
    description: 'Jira custom field ID for the JPD idea start date (tenant-specific)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  startDateFieldId?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'customfield_10021',
    description: 'Jira custom field ID for the JPD idea target/due date (tenant-specific)',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  targetDateFieldId?: string | null;
}
