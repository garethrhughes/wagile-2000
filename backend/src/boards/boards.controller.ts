import {
  Controller,
  Get,
  Put,
  Param,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { BoardsService } from './boards.service.js';
import { UpdateBoardConfigDto } from './dto/update-board-config.dto.js';

@ApiTags('boards')
@Controller('api/boards')
export class BoardsController {
  constructor(private readonly boardsService: BoardsService) {}

  @ApiOperation({ summary: 'List all board configurations' })
  @Get()
  async getAll() {
    return this.boardsService.getAll();
  }

  @ApiOperation({ summary: 'Get board configuration' })
  @ApiParam({ name: 'boardId', description: 'Board identifier (e.g. ACC, PLAT)' })
  @Get(':boardId/config')
  async getConfig(@Param('boardId') boardId: string) {
    return this.boardsService.getConfig(boardId);
  }

  @ApiOperation({ summary: 'Update board configuration' })
  @ApiParam({ name: 'boardId', description: 'Board identifier (e.g. ACC, PLAT)' })
  @Put(':boardId/config')
  async updateConfig(
    @Param('boardId') boardId: string,
    @Body() dto: UpdateBoardConfigDto,
  ) {
    return this.boardsService.updateConfig(boardId, dto);
  }
}
