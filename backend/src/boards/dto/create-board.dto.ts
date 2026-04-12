import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBoardDto {
  @ApiProperty({ example: 'ACC', description: 'Jira project key used as the board identifier' })
  @IsString()
  @IsNotEmpty()
  boardId!: string;

  @ApiProperty({ enum: ['scrum', 'kanban'] })
  @IsString()
  @IsIn(['scrum', 'kanban'])
  boardType!: 'scrum' | 'kanban';
}
