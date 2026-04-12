import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { BoardsService } from './boards.service.js';
import { CreateBoardDto } from './dto/create-board.dto.js';
import { UpdateBoardConfigDto } from './dto/update-board-config.dto.js';
import { BoardConfig } from '../database/entities/board-config.entity.js';

@ApiTags('boards')
@Controller('api/boards')
export class BoardsController {
  constructor(private readonly boardsService: BoardsService) {}

  @ApiOperation({ summary: 'List all board configurations' })
  @Get()
  async getAll() {
    return this.boardsService.getAll();
  }

  @ApiOperation({ summary: 'Create a new board configuration' })
  @Post()
  async create(@Body() dto: CreateBoardDto): Promise<BoardConfig> {
    return this.boardsService.createBoard(dto);
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

  @ApiOperation({ summary: 'Delete a board configuration' })
  @ApiParam({ name: 'boardId', description: 'Board identifier (e.g. ACC, PLAT)' })
  @HttpCode(204)
  @Delete(':boardId')
  async delete(@Param('boardId') boardId: string): Promise<void> {
    return this.boardsService.deleteBoard(boardId);
  }
}
