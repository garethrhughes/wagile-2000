import {
  IsOptional,
  IsString,
  IsArray,
  IsIn,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBoardConfigDto {
  @ApiPropertyOptional({ enum: ['scrum', 'kanban'] })
  @IsOptional()
  @IsString()
  @IsIn(['scrum', 'kanban'])
  boardType?: string;

  @ApiPropertyOptional({ type: [String], example: ['Done', 'Closed', 'Released'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  doneStatusNames?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Bug', 'Incident'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  failureIssueTypes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['is caused by'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  failureLinkTypes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['regression', 'incident'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  failureLabels?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Bug', 'Incident'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  incidentIssueTypes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Done', 'Resolved'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recoveryStatusNames?: string[];

  @ApiPropertyOptional({ type: [String], example: [] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  incidentLabels?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['10303'],
    description: 'Status IDs that represent the Kanban backlog (never-on-board). When set, issues whose current statusId is in this list are excluded from flow metrics.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  backlogStatusIds?: string[];

  @ApiPropertyOptional({
    type: String,
    example: '2024-01-01',
    description: 'ISO date (YYYY-MM-DD) lower bound for Kanban flow metrics. Issues whose board-entry date is before this date are excluded. Null means no lower bound.',
  })
  @IsOptional()
  @IsString()
  dataStartDate?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['In Progress', 'In Development'],
    description: 'Status names that indicate active work has begun (cycle time start event)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inProgressStatusNames?: string[];
}
