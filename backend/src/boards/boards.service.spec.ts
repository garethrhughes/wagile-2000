import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BoardsService } from './boards.service.js';
import { BoardConfig } from '../database/entities/index.js';
import { CreateBoardDto } from './dto/create-board.dto.js';
import { UpdateBoardConfigDto } from './dto/update-board-config.dto.js';
import { LambdaInvokerService } from '../lambda/lambda-invoker.service.js';

function mockRepo(): jest.Mocked<Repository<BoardConfig>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((dto: Partial<BoardConfig>) => dto as BoardConfig),
    save: jest.fn().mockImplementation(async (e: BoardConfig) => e),
    merge: jest.fn().mockImplementation((_target: BoardConfig, dto: Partial<BoardConfig>) => ({
      ..._target,
      ...dto,
    }) as BoardConfig),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as jest.Mocked<Repository<BoardConfig>>;
}

function mockLambdaInvoker(): jest.Mocked<LambdaInvokerService> {
  return {
    invokeSnapshotWorker: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LambdaInvokerService>;
}

describe('BoardsService', () => {
  let service: BoardsService;
  let repo: jest.Mocked<Repository<BoardConfig>>;
  let lambdaInvoker: jest.Mocked<LambdaInvokerService>;

  beforeEach(() => {
    repo = mockRepo();
    lambdaInvoker = mockLambdaInvoker();
    service = new BoardsService(repo, lambdaInvoker);
  });

  // ---------------------------------------------------------------------------
  // getAll
  // ---------------------------------------------------------------------------

  describe('getAll', () => {
    it('returns all board configs', async () => {
      const configs = [
        { boardId: 'ACC', boardType: 'scrum' } as BoardConfig,
        { boardId: 'PLAT', boardType: 'kanban' } as BoardConfig,
      ];
      repo.find.mockResolvedValue(configs);

      const result = await service.getAll();
      expect(result).toHaveLength(2);
      expect(repo.find).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no boards exist', async () => {
      repo.find.mockResolvedValue([]);
      const result = await service.getAll();
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getConfig
  // ---------------------------------------------------------------------------

  describe('getConfig', () => {
    it('returns existing config when found', async () => {
      const existing = { boardId: 'ACC', boardType: 'scrum' } as BoardConfig;
      repo.findOne.mockResolvedValue(existing);

      const result = await service.getConfig('ACC');
      expect(result.boardId).toBe('ACC');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('creates and returns a fallback scrum config when not found', async () => {
      repo.findOne.mockResolvedValue(null);
      const created = { boardId: 'NEW', boardType: 'scrum' } as BoardConfig;
      repo.create.mockReturnValue(created);
      repo.save.mockResolvedValue(created);

      const result = await service.getConfig('NEW');
      expect(repo.create).toHaveBeenCalledWith({ boardId: 'NEW', boardType: 'scrum' });
      expect(repo.save).toHaveBeenCalled();
      expect(result.boardId).toBe('NEW');
      expect(result.boardType).toBe('scrum');
    });
  });

  // ---------------------------------------------------------------------------
  // updateConfig
  // ---------------------------------------------------------------------------

  describe('updateConfig', () => {
    it('merges dto into existing config and saves', async () => {
      const existing = { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'] } as unknown as BoardConfig;
      repo.findOne.mockResolvedValue(existing);

      const dto = { doneStatusNames: ['Done', 'Released'] } as unknown as UpdateBoardConfigDto;
      const merged = { ...existing, ...dto } as BoardConfig;
      repo.merge.mockReturnValue(merged);
      repo.save.mockResolvedValue(merged);

      const result = await service.updateConfig('ACC', dto);
      expect(repo.merge).toHaveBeenCalledWith(existing, dto);
      expect(repo.save).toHaveBeenCalledWith(merged);
      expect(result).toBe(merged);
    });

    it('triggers Lambda snapshot recompute after config update', async () => {
      const existing = { boardId: 'ACC', boardType: 'scrum' } as unknown as BoardConfig;
      repo.findOne.mockResolvedValue(existing);
      const dto = { doneStatusNames: ['Released'] } as unknown as UpdateBoardConfigDto;
      repo.merge.mockReturnValue({ ...existing, ...dto } as BoardConfig);
      repo.save.mockResolvedValue({ ...existing, ...dto } as BoardConfig);

      await service.updateConfig('ACC', dto);

      // Give the fire-and-forget promise a tick to execute
      await Promise.resolve();
      expect(lambdaInvoker.invokeSnapshotWorker).toHaveBeenCalledWith('ACC');
    });
  });

  // ---------------------------------------------------------------------------
  // createBoard
  // ---------------------------------------------------------------------------

  describe('createBoard', () => {
    it('creates a new board with trimmed, uppercased boardId', async () => {
      repo.findOne.mockResolvedValue(null);
      const dto: CreateBoardDto = { boardId: '  acc ', boardType: 'scrum' };
      const created = { boardId: 'ACC', boardType: 'scrum' } as BoardConfig;
      repo.create.mockReturnValue(created);
      repo.save.mockResolvedValue(created);

      const result = await service.createBoard(dto);
      expect(repo.create).toHaveBeenCalledWith({ boardId: 'ACC', boardType: 'scrum' });
      expect(result.boardId).toBe('ACC');
    });

    it('throws ConflictException when boardId already exists', async () => {
      repo.findOne.mockResolvedValue({ boardId: 'ACC' } as BoardConfig);
      const dto: CreateBoardDto = { boardId: 'ACC', boardType: 'scrum' };

      await expect(service.createBoard(dto)).rejects.toThrow(ConflictException);
    });

    it('creates kanban board type', async () => {
      repo.findOne.mockResolvedValue(null);
      const dto: CreateBoardDto = { boardId: 'PLAT', boardType: 'kanban' };
      const created = { boardId: 'PLAT', boardType: 'kanban' } as BoardConfig;
      repo.create.mockReturnValue(created);
      repo.save.mockResolvedValue(created);

      const result = await service.createBoard(dto);
      expect(result.boardType).toBe('kanban');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteBoard
  // ---------------------------------------------------------------------------

  describe('deleteBoard', () => {
    it('deletes an existing board', async () => {
      repo.delete.mockResolvedValue({ affected: 1 } as never);

      await service.deleteBoard('ACC');
      expect(repo.delete).toHaveBeenCalledWith({ boardId: 'ACC' });
    });

    it('throws NotFoundException when board does not exist', async () => {
      repo.delete.mockResolvedValue({ affected: 0 } as never);

      await expect(service.deleteBoard('NONEXISTENT')).rejects.toThrow(NotFoundException);
    });
  });
});
