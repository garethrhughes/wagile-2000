import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BoardConfig } from '../database/entities/index.js';
import { CreateBoardDto } from './dto/create-board.dto.js';
import { UpdateBoardConfigDto } from './dto/update-board-config.dto.js';
import { LambdaInvokerService } from '../lambda/lambda-invoker.service.js';

@Injectable()
export class BoardsService {
  private readonly logger = new Logger(BoardsService.name);

  constructor(
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    private readonly lambdaInvoker: LambdaInvokerService,
  ) {}

  async getAll(): Promise<BoardConfig[]> {
    return this.boardConfigRepo.find();
  }

  async getConfig(boardId: string): Promise<BoardConfig> {
    let config = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (!config) {
      config = this.boardConfigRepo.create({
        boardId,
        boardType: 'scrum',
      });
      this.logger.warn(
        `Board config for "${boardId}" not found. Creating a fallback scrum config. ` +
        `Add the board via the Settings UI for proper configuration.`,
      );
      config = await this.boardConfigRepo.save(config);
    }
    return config;
  }

  async updateConfig(
    boardId: string,
    dto: UpdateBoardConfigDto,
  ): Promise<BoardConfig> {
    let config = await this.getConfig(boardId);
    config = this.boardConfigRepo.merge(config, dto);
    const saved = await this.boardConfigRepo.save(config);

    // Invalidate snapshot — config change affects all metric results.
    // Fire-and-forget: config update must not fail because Lambda invocation fails.
    this.lambdaInvoker.invokeSnapshotWorker(boardId).catch(() => {
      // Already logged inside invokeSnapshotWorker.
    });

    return saved;
  }

  async createBoard(dto: CreateBoardDto): Promise<BoardConfig> {
    const boardId = dto.boardId.trim().toUpperCase();

    const existing = await this.boardConfigRepo.findOne({ where: { boardId } });
    if (existing) {
      throw new ConflictException(`Board "${boardId}" already exists`);
    }

    const config = this.boardConfigRepo.create({
      boardId,
      boardType: dto.boardType,
    });
    return this.boardConfigRepo.save(config);
  }

  async deleteBoard(boardId: string): Promise<void> {
    const result = await this.boardConfigRepo.delete({ boardId });
    if (result.affected === 0) {
      throw new NotFoundException(`Board "${boardId}" not found`);
    }
  }
}
