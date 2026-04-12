import { GapsService } from './gaps.service.js';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraSprint,
  BoardConfig,
} from '../database/entities/index.js';

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<Repository<T>>;
}

function mockConfigService(jiraBaseUrl = ''): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockReturnValue(jiraBaseUrl),
  } as unknown as jest.Mocked<ConfigService>;
}

describe('GapsService', () => {
  let service: GapsService;
  let configService: jest.Mocked<ConfigService>;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;

  beforeEach(() => {
    configService = mockConfigService();
    issueRepo = mockRepo<JiraIssue>();
    sprintRepo = mockRepo<JiraSprint>();
    boardConfigRepo = mockRepo<BoardConfig>();

    service = new GapsService(
      configService,
      issueRepo,
      sprintRepo,
      boardConfigRepo,
    );
  });

  it('returns empty arrays when there are no issues', async () => {
    boardConfigRepo.find.mockResolvedValue([]);
    sprintRepo.find.mockResolvedValue([]);
    issueRepo.find.mockResolvedValue([]);

    const result = await service.getGaps();

    expect(result.noEpic).toEqual([]);
    expect(result.noEstimate).toEqual([]);
  });

  it('excludes done issues from gaps', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'Done',
        sprintId: 'sprint-1',
        epicKey: null,
        points: null,
        summary: 'Done issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(0);
    expect(result.noEstimate).toHaveLength(0);
  });

  it('excludes cancelled issues from gaps (default "Cancelled")', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'Cancelled',
        sprintId: 'sprint-1',
        epicKey: null,
        points: null,
        summary: 'Cancelled issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(0);
  });

  it('excludes "Won\'t Do" issues from gaps (updated fallback)', async () => {
    boardConfigRepo.find.mockResolvedValue([
      // Board config with cancelledStatusNames including "Won't Do"
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ["Won't Do"] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: "Won't Do",
        sprintId: 'sprint-1',
        epicKey: null,
        points: null,
        summary: "Won't do issue",
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(0);
  });

  it('reports noEpic for issues with null epicKey in active sprint', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: 3,
        summary: 'No epic issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(1);
    expect(result.noEpic[0].key).toBe('ACC-1');
    // Has points so not in noEstimate
    expect(result.noEstimate).toHaveLength(0);
  });

  it('reports noEstimate for issues with null points on scrum boards', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: 'ACC-0',
        points: null,
        summary: 'No estimate',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEstimate).toHaveLength(1);
    expect(result.noEstimate[0].key).toBe('ACC-1');
    // Has epic so not in noEpic
    expect(result.noEpic).toHaveLength(0);
  });

  it('does NOT report noEstimate for Kanban boards', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'PLAT', boardType: 'kanban', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'PLAT', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'PLAT-1',
        boardId: 'PLAT',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: 'PLAT-0',
        points: null,
        summary: 'Kanban issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEstimate).toHaveLength(0);
  });

  it('excludes issues not in active sprint (backlog issues)', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'Backlog',
        sprintId: null, // not in any sprint
        epicKey: null,
        points: null,
        summary: 'Backlog issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(0);
    expect(result.noEstimate).toHaveLength(0);
  });

  it('excludes Epics from gaps report', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-E1',
        boardId: 'ACC',
        issueType: 'Epic',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: null,
        summary: 'Epic issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic).toHaveLength(0);
    expect(result.noEstimate).toHaveLength(0);
  });

  it('constructs jiraUrl when JIRA_BASE_URL is configured', async () => {
    service = new GapsService(
      mockConfigService('https://mycompany.atlassian.net'),
      issueRepo,
      sprintRepo,
      boardConfigRepo,
    );

    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: 3,
        summary: 'Issue',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic[0].jiraUrl).toBe('https://mycompany.atlassian.net/browse/ACC-1');
  });

  it('sorts results by boardId then key', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint 1' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-3',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: 3,
        summary: 'C',
      } as unknown as JiraIssue,
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: 3,
        summary: 'A',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic[0].key).toBe('ACC-1');
    expect(result.noEpic[1].key).toBe('ACC-3');
  });

  it('includes sprint name in gap issue', async () => {
    boardConfigRepo.find.mockResolvedValue([
      { boardId: 'ACC', boardType: 'scrum', doneStatusNames: ['Done'], cancelledStatusNames: ['Cancelled'] } as BoardConfig,
    ]);
    sprintRepo.find.mockResolvedValue([
      { id: 'sprint-1', boardId: 'ACC', state: 'active', name: 'Sprint Alpha' } as JiraSprint,
    ]);
    issueRepo.find.mockResolvedValue([
      {
        key: 'ACC-1',
        boardId: 'ACC',
        issueType: 'Story',
        status: 'In Progress',
        sprintId: 'sprint-1',
        epicKey: null,
        points: 3,
        summary: 'Test',
      } as unknown as JiraIssue,
    ]);

    const result = await service.getGaps();

    expect(result.noEpic[0].sprintName).toBe('Sprint Alpha');
  });
});
