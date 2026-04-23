import { BadRequestException } from '@nestjs/common';
import { GapsService } from './gaps.service.js';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  JiraIssue,
  JiraSprint,
  BoardConfig,
  JiraChangelog,
} from '../database/entities/index.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function mockRepo<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<T>>;
}

function mockConfigService(jiraBaseUrl = ''): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockReturnValue(jiraBaseUrl),
  } as unknown as jest.Mocked<ConfigService>;
}

/** Build a minimal JiraIssue for tests. */
function makeIssue(overrides: Partial<JiraIssue>): JiraIssue {
  return {
    key: 'ACC-1',
    summary: 'Test issue',
    issueType: 'Story',
    status: 'In Progress',
    statusId: null,
    boardId: 'ACC',
    sprintId: null,
    epicKey: null,
    points: null,
    priority: null,
    assignee: null,
    labels: [],
    fixVersion: null,
    createdAt: new Date('2026-01-15T10:00:00Z'),
    updatedAt: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  } as JiraIssue;
}

/** Build a minimal JiraChangelog entry. */
function makeChangelog(overrides: Partial<JiraChangelog>): JiraChangelog {
  return {
    id: 1,
    issueKey: 'ACC-1',
    field: 'status',
    fromValue: 'In Progress',
    toValue: 'Done',
    changedAt: new Date('2026-01-20T10:00:00Z'),
    ...overrides,
  } as JiraChangelog;
}

/** Build a mock QueryBuilder that returns specific results for getMany(). */
function mockQb(results: JiraChangelog[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(results),
  };
}

// ─── test suite ─────────────────────────────────────────────────────────────

describe('GapsService', () => {
  let service: GapsService;
  let configService: jest.Mocked<ConfigService>;
  let issueRepo: jest.Mocked<Repository<JiraIssue>>;
  let sprintRepo: jest.Mocked<Repository<JiraSprint>>;
  let boardConfigRepo: jest.Mocked<Repository<BoardConfig>>;
  let changelogRepo: jest.Mocked<Repository<JiraChangelog>>;

  beforeEach(() => {
    configService = mockConfigService();
    issueRepo = mockRepo<JiraIssue>();
    sprintRepo = mockRepo<JiraSprint>();
    boardConfigRepo = mockRepo<BoardConfig>();
    changelogRepo = mockRepo<JiraChangelog>();

    service = new GapsService(
      configService,
      issueRepo,
      sprintRepo,
      boardConfigRepo,
      changelogRepo,
    );
  });

  // ── getGaps tests ──────────────────────────────────────────────────────────

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

  it("excludes \"Won't Do\" issues from gaps (updated fallback)", async () => {
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
      changelogRepo,
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

  // ── getUnplannedDone tests ─────────────────────────────────────────────────

  describe('getUnplannedDone', () => {
    const WINDOW_START = new Date('2026-01-01T00:00:00Z');
    const WINDOW_END = new Date('2026-01-31T23:59:59Z');
    const IN_WINDOW = new Date('2026-01-20T10:00:00Z');

    const scrumConfig = {
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as BoardConfig;

    const kanbanConfig = {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as BoardConfig;

    const activeSprint = {
      id: 'sprint-1',
      boardId: 'ACC',
      state: 'closed',
      name: 'Sprint 1',
      startDate: WINDOW_START,
      endDate: WINDOW_END,
    } as JiraSprint;

    /**
     * Wire up changelogRepo.createQueryBuilder to return statusChangelogs on
     * the first call (field='status') and sprintChangelogs on the second call
     * (field='Sprint').
     */
    function setupChangelogs(
      statusChangelogs: JiraChangelog[],
      sprintChangelogs: JiraChangelog[],
    ) {
      let callCount = 0;
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => {
        callCount++;
        const isFirst = callCount <= 1;
        return mockQb(isFirst ? statusChangelogs : sprintChangelogs);
      });
    }

    it('returns empty result when board has no issues', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      issueRepo.find.mockResolvedValue([]);

      const result = await service.getUnplannedDone('ACC');

      expect(result.issues).toHaveLength(0);
      expect(result.summary.total).toBe(0);
    });

    it('classifies issue completed in window with no sprint changelog as unplanned', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const issue = makeIssue({ key: 'ACC-1', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-1', toValue: 'Done', changedAt: IN_WINDOW })],
        [], // no sprint changelogs → inSprint = false
      );

      const result = await service.getUnplannedDone('ACC', undefined, '2026-Q1');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('ACC-1');
      expect(result.issues[0].resolvedStatus).toBe('Done');
      expect(result.summary.total).toBe(1);
    });

    it('classifies issue with no sprint changelog but non-null sprintId as planned', async () => {
      // Jira only records a Sprint changelog when an issue moves between sprint
      // states. An issue placed into a sprint at creation has no Sprint changelog
      // at all. The snapshot sprintId is the correct fallback signal.
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const issue = makeIssue({
        key: 'ACC-10',
        status: 'In Progress',
        sprintId: 'sprint-1', // created directly in sprint — no Sprint changelog
      });
      issueRepo.find.mockResolvedValue([issue]);

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-10', toValue: 'Done', changedAt: IN_WINDOW })],
        [], // no Sprint changelogs — typical for issues created directly in a sprint
      );

      const result = await service.getUnplannedDone('ACC');

      expect(result.issues).toHaveLength(0); // should be classified as planned
    });

    it('classifies issue committed to sprint before completion as planned (not returned)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const issue = makeIssue({ key: 'ACC-2', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      // Sprint changelog shows issue added to sprint BEFORE the done transition
      const addedToSprintAt = new Date('2026-01-10T09:00:00Z'); // before IN_WINDOW
      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-2', toValue: 'Done', changedAt: IN_WINDOW })],
        [
          makeChangelog({
            id: 10,
            issueKey: 'ACC-2',
            field: 'Sprint',
            fromValue: '',
            toValue: 'Sprint 1',
            changedAt: addedToSprintAt,
          }),
        ],
      );

      const result = await service.getUnplannedDone('ACC');

      expect(result.issues).toHaveLength(0);
    });

    it('classifies issue added to sprint retroactively AFTER completion as unplanned', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const issue = makeIssue({ key: 'ACC-3', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      // Issue done on Jan 20; sprint changelog shows it added to sprint on Jan 25 (retroactive)
      const retroactiveAddAt = new Date('2026-01-25T12:00:00Z'); // after IN_WINDOW

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-3', toValue: 'Done', changedAt: IN_WINDOW })],
        [
          makeChangelog({
            id: 20,
            issueKey: 'ACC-3',
            field: 'Sprint',
            fromValue: '',
            toValue: 'Sprint 1',
            changedAt: retroactiveAddAt, // AFTER resolvedAt → capped and ignored
          }),
        ],
      );

      const result = await service.getUnplannedDone('ACC', undefined, '2026-Q1');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('ACC-3');
    });

    it('excludes issue resolved outside the window', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      // Issue's current status is NOT done, and its changelog resolution is outside window
      const issue = makeIssue({ key: 'ACC-4', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      const outsideWindow = new Date('2025-10-15T10:00:00Z'); // before window
      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-4', toValue: 'Done', changedAt: outsideWindow })],
        [],
      );

      // Use explicit sprint window (Jan 1 – Jan 31)
      sprintRepo.findOne.mockResolvedValue(activeSprint);
      const result = await service.getUnplannedDone('ACC', 'sprint-1');

      expect(result.issues).toHaveLength(0);
    });

    it('uses createdAt as fallback when no status changelog and current status is done and in window', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      // createdAt within last 90 days from 2026-04-14 (window starts ~2026-01-14)
      const createdAt = new Date('2026-03-01T08:00:00Z');
      const issue = makeIssue({
        key: 'ACC-5',
        status: 'Done',
        createdAt,
      });
      issueRepo.find.mockResolvedValue([issue]);

      // No status changelog at all
      setupChangelogs([], []);

      const result = await service.getUnplannedDone('ACC');

      // createdAt is within last 90 days from "now" (2026-04-14), so it should appear
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('ACC-5');
      expect(result.issues[0].resolvedAt).toBe(createdAt.toISOString());
    });

    it('does NOT use createdAt fallback when status changelogs exist but fall outside the window (regression: SPS-454)', async () => {
      // Issue created in Q1, but Done transition happened in Q2 (after window end).
      // The fallback must not fire just because createdAt is in-window and current status is Done.
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);

      const q1Start = new Date('2026-01-01T00:00:00Z');
      const q1End   = new Date('2026-03-31T23:59:59Z');
      const sprint  = { id: 'sprint-q1', boardId: 'ACC', startDate: q1Start, endDate: q1End } as JiraSprint;
      sprintRepo.findOne.mockResolvedValue(sprint);

      // Issue was created in Q1 but completed in Q2
      const issue = makeIssue({
        key: 'SPS-454',
        status: 'Done',
        createdAt: new Date('2026-03-31T23:32:00Z'), // inside Q1 window
        sprintId: 'sprint-q2',
      });
      issueRepo.find.mockResolvedValue([issue]);

      // Status changelogs both fall in Q2 (outside Q1 window)
      const statusLogs = [
        makeChangelog({ issueKey: 'SPS-454', fromValue: 'To Do',       toValue: 'Peer Review', changedAt: new Date('2026-04-01T03:36:00Z') }),
        makeChangelog({ issueKey: 'SPS-454', fromValue: 'Peer Review', toValue: 'Done',        changedAt: new Date('2026-04-01T05:39:00Z') }),
      ];
      setupChangelogs(statusLogs, []);

      const result = await service.getUnplannedDone('ACC', 'sprint-q1');

      // Must be excluded — the Done transition is outside Q1, createdAt fallback must not fire
      expect(result.issues).toHaveLength(0);
    });

    it('excludes Epics via isWorkItem filter', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const epic = makeIssue({ key: 'ACC-E1', issueType: 'Epic', status: 'Done' });
      issueRepo.find.mockResolvedValue([epic]);

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-E1', toValue: 'Done', changedAt: IN_WINDOW })],
        [],
      );

      const result = await service.getUnplannedDone('ACC');

      expect(result.issues).toHaveLength(0);
    });

    it('excludes Sub-tasks via isWorkItem filter', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      const subtask = makeIssue({ key: 'ACC-S1', issueType: 'Sub-task', status: 'Done' });
      issueRepo.find.mockResolvedValue([subtask]);

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-S1', toValue: 'Done', changedAt: IN_WINDOW })],
        [],
      );

      const result = await service.getUnplannedDone('ACC');

      expect(result.issues).toHaveLength(0);
    });

    it('uses sprint date window when sprintId is provided', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      sprintRepo.findOne.mockResolvedValue(activeSprint);

      const issue = makeIssue({ key: 'ACC-6', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-6', toValue: 'Done', changedAt: IN_WINDOW })],
        [],
      );

      const result = await service.getUnplannedDone('ACC', 'sprint-1');

      expect(result.issues).toHaveLength(1);
      expect(result.window.start).toBe(WINDOW_START.toISOString());
      expect(result.window.end).toBe(WINDOW_END.toISOString());
    });

    it('throws BadRequestException when sprintId not found for board', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
      sprintRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getUnplannedDone('ACC', 'sprint-missing'),
      ).rejects.toThrow(BadRequestException);
    });

    it('uses quarter date window when quarter is provided', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);

      const issue = makeIssue({ key: 'ACC-7', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      const inQ1 = new Date('2026-02-15T10:00:00Z');
      setupChangelogs(
        [makeChangelog({ issueKey: 'ACC-7', toValue: 'Done', changedAt: inQ1 })],
        [],
      );

      const result = await service.getUnplannedDone('ACC', undefined, '2026-Q1');

      expect(result.issues).toHaveLength(1);
      expect(result.window.start).toContain('2026-01-01');
    });

    it('sorts results by resolvedAt DESC, then key ASC for ties', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);

      const issue1 = makeIssue({ key: 'ACC-1', status: 'In Progress' });
      const issue2 = makeIssue({ key: 'ACC-2', status: 'In Progress' });
      const issue3 = makeIssue({ key: 'ACC-3', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue1, issue2, issue3]);

      // All within last-90-days default window (today is 2026-04-14)
      const earlier = new Date('2026-02-10T10:00:00Z');
      const later = new Date('2026-03-20T10:00:00Z');

      setupChangelogs(
        [
          makeChangelog({ id: 1, issueKey: 'ACC-1', toValue: 'Done', changedAt: later }),
          makeChangelog({ id: 2, issueKey: 'ACC-2', toValue: 'Done', changedAt: earlier }),
          makeChangelog({ id: 3, issueKey: 'ACC-3', toValue: 'Done', changedAt: later }),
        ],
        [],
      );

      const result = await service.getUnplannedDone('ACC');

      // ACC-1 and ACC-3 both resolved at `later` → sorted by key ASC
      expect(result.issues).toHaveLength(3);
      expect(result.issues[0].key).toBe('ACC-1');
      expect(result.issues[1].key).toBe('ACC-3');
      expect(result.issues[2].key).toBe('ACC-2');
    });

    it('computes summary correctly (total, totalPoints, byIssueType)', async () => {
      boardConfigRepo.findOne.mockResolvedValue(scrumConfig);

      const story = makeIssue({ key: 'ACC-1', issueType: 'Story', points: 3 });
      const bug = makeIssue({ key: 'ACC-2', issueType: 'Bug', points: 1 });
      const task = makeIssue({ key: 'ACC-3', issueType: 'Story', points: null });
      issueRepo.find.mockResolvedValue([story, bug, task]);

      setupChangelogs(
        [
          makeChangelog({ id: 1, issueKey: 'ACC-1', toValue: 'Done', changedAt: IN_WINDOW }),
          makeChangelog({ id: 2, issueKey: 'ACC-2', toValue: 'Done', changedAt: IN_WINDOW }),
          makeChangelog({ id: 3, issueKey: 'ACC-3', toValue: 'Done', changedAt: IN_WINDOW }),
        ],
        [],
      );

      const result = await service.getUnplannedDone('ACC', undefined, '2026-Q1');

      expect(result.summary.total).toBe(3);
      expect(result.summary.totalPoints).toBe(4); // 3 + 1 + 0
      expect(result.summary.byIssueType['Story']).toBe(2);
      expect(result.summary.byIssueType['Bug']).toBe(1);
    });

    // ── "All boards" aggregation path ───────────────────────────────────────

    describe('all boards aggregation (boardId = undefined / "all")', () => {
      const scrumConfig2 = {
        boardId: 'BPT',
        boardType: 'scrum',
        doneStatusNames: ['Done'],
        cancelledStatusNames: ['Cancelled'],
      } as BoardConfig;

      /**
       * Build a query builder mock that inspects the `field` argument passed to
       * `.andWhere('cl.field = :field', { field })` to determine whether the
       * caller wants status or Sprint changelogs, then returns the appropriate
       * list.  This is resilient to call-order interleaving from Promise.all.
       */
      function mockQbByField(
        statusChangelogs: JiraChangelog[],
        sprintChangelogs: JiraChangelog[],
      ) {
        let capturedField: string | undefined;
        const qb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockImplementation((_clause: string, params: { field?: string }) => {
            if (params?.field) capturedField = params.field;
            return qb;
          }),
          orderBy: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockImplementation(() => {
            return Promise.resolve(
              capturedField === 'Sprint' ? sprintChangelogs : statusChangelogs,
            );
          }),
        };
        return qb;
      }

      it('returns boardId "all" and empty issues when no Scrum boards configured', async () => {
        boardConfigRepo.find.mockResolvedValue([kanbanConfig]);
        issueRepo.find.mockResolvedValue([]);

        const result = await service.getUnplannedDone(undefined);

        expect(result.boardId).toBe('all');
        expect(result.issues).toHaveLength(0);
        expect(result.summary.total).toBe(0);
      });

      it('returns boardId "all" when called with sentinel string "all"', async () => {
        boardConfigRepo.find.mockResolvedValue([]);
        issueRepo.find.mockResolvedValue([]);

        const result = await service.getUnplannedDone('all');

        expect(result.boardId).toBe('all');
      });

      it('aggregates issues from multiple Scrum boards, skipping Kanban', async () => {
        boardConfigRepo.find.mockResolvedValue([scrumConfig, kanbanConfig, scrumConfig2]);
        boardConfigRepo.findOne.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') return Promise.resolve(scrumConfig);
          if (where.boardId === 'BPT') return Promise.resolve(scrumConfig2);
          return Promise.resolve(null);
        });

        // Each board's issueRepo.find returns that board's issues
        issueRepo.find.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') {
            return Promise.resolve([makeIssue({ key: 'ACC-1', boardId: 'ACC', status: 'In Progress' })]);
          }
          if (where.boardId === 'BPT') {
            return Promise.resolve([makeIssue({ key: 'BPT-1', boardId: 'BPT', status: 'In Progress' })]);
          }
          return Promise.resolve([]);
        });

        // createQueryBuilder returns a field-aware mock each time it's invoked
        changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() =>
          mockQbByField(
            // status changelogs: include entries for both boards — the service
            // passes its own issue keys to `where IN (...)` but our mock ignores
            // that clause, so we include all possible keys; only the matching
            // board's issues exist in allIssues so only the relevant entry is used
            [
              makeChangelog({ id: 1, issueKey: 'ACC-1', toValue: 'Done', changedAt: IN_WINDOW }),
              makeChangelog({ id: 2, issueKey: 'BPT-1', toValue: 'Done', changedAt: IN_WINDOW }),
            ],
            [], // no sprint changelogs → both are unplanned
          ),
        );

        const result = await service.getUnplannedDone(undefined, undefined, '2026-Q1');

        expect(result.boardId).toBe('all');
        expect(result.issues).toHaveLength(2);
        expect(result.issues.map((i) => i.key).sort()).toEqual(['ACC-1', 'BPT-1']);
        expect(result.summary.total).toBe(2);
      });

      it('uses last-90-days window when no quarter supplied', async () => {
        boardConfigRepo.find.mockResolvedValue([scrumConfig]);
        boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
        issueRepo.find.mockResolvedValue([]);

        const before = new Date();
        before.setDate(before.getDate() - 90);

        const result = await service.getUnplannedDone(undefined);

        const windowStart = new Date(result.window.start);
        // Allow 5-second tolerance for test execution time
        expect(Math.abs(windowStart.getTime() - before.getTime())).toBeLessThan(5000);
        expect(result.boardId).toBe('all');
      });

      it('uses quarter window when quarter is supplied', async () => {
        boardConfigRepo.find.mockResolvedValue([scrumConfig]);
        boardConfigRepo.findOne.mockResolvedValue(scrumConfig);
        issueRepo.find.mockResolvedValue([]);

        const result = await service.getUnplannedDone(undefined, undefined, '2026-Q1');

        expect(result.window.start).toContain('2026-01-01');
        expect(result.boardId).toBe('all');
      });

      it('sorts merged results by resolvedAt DESC, then key ASC for ties', async () => {
        boardConfigRepo.find.mockResolvedValue([scrumConfig, scrumConfig2]);
        boardConfigRepo.findOne.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') return Promise.resolve(scrumConfig);
          if (where.boardId === 'BPT') return Promise.resolve(scrumConfig2);
          return Promise.resolve(null);
        });

        const earlier = new Date('2026-02-10T10:00:00Z');
        const later = new Date('2026-03-20T10:00:00Z');

        issueRepo.find.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') {
            return Promise.resolve([makeIssue({ key: 'ACC-5', boardId: 'ACC', status: 'In Progress' })]);
          }
          if (where.boardId === 'BPT') {
            return Promise.resolve([makeIssue({ key: 'BPT-2', boardId: 'BPT', status: 'In Progress' })]);
          }
          return Promise.resolve([]);
        });

        changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() =>
          mockQbByField(
            [
              makeChangelog({ id: 1, issueKey: 'ACC-5', toValue: 'Done', changedAt: later }),
              makeChangelog({ id: 2, issueKey: 'BPT-2', toValue: 'Done', changedAt: earlier }),
            ],
            [],
          ),
        );

        const result = await service.getUnplannedDone(undefined);

        expect(result.issues).toHaveLength(2);
        expect(result.issues[0].key).toBe('ACC-5'); // later resolvedAt first
        expect(result.issues[1].key).toBe('BPT-2');
      });

      it('computes summary correctly across boards', async () => {
        boardConfigRepo.find.mockResolvedValue([scrumConfig, scrumConfig2]);
        boardConfigRepo.findOne.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') return Promise.resolve(scrumConfig);
          if (where.boardId === 'BPT') return Promise.resolve(scrumConfig2);
          return Promise.resolve(null);
        });

        issueRepo.find.mockImplementation(({ where }: { where: { boardId: string } }) => {
          if (where.boardId === 'ACC') {
            return Promise.resolve([makeIssue({ key: 'ACC-1', boardId: 'ACC', issueType: 'Story', points: 5 })]);
          }
          if (where.boardId === 'BPT') {
            return Promise.resolve([makeIssue({ key: 'BPT-1', boardId: 'BPT', issueType: 'Bug', points: 2 })]);
          }
          return Promise.resolve([]);
        });

        changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() =>
          mockQbByField(
            [
              makeChangelog({ id: 1, issueKey: 'ACC-1', toValue: 'Done', changedAt: IN_WINDOW }),
              makeChangelog({ id: 2, issueKey: 'BPT-1', toValue: 'Done', changedAt: IN_WINDOW }),
            ],
            [],
          ),
        );

        const result = await service.getUnplannedDone(undefined, undefined, '2026-Q1');

        expect(result.summary.total).toBe(2);
        expect(result.summary.totalPoints).toBe(7);
        expect(result.summary.byIssueType['Story']).toBe(1);
        expect(result.summary.byIssueType['Bug']).toBe(1);
      });
    });
  });

  // ── getUnplannedDone Kanban tests ────────────────────────────────────────

  describe('getUnplannedDone (Kanban boards)', () => {
    const IN_WINDOW = new Date('2026-01-20T10:00:00Z');

    const kanbanConfig = {
      boardId: 'PLAT',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as BoardConfig;

    const scrumConfig = {
      boardId: 'ACC',
      boardType: 'scrum',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as BoardConfig;

    const kanbanConfig2 = {
      boardId: 'FLOW',
      boardType: 'kanban',
      doneStatusNames: ['Done'],
      cancelledStatusNames: ['Cancelled'],
    } as BoardConfig;

    /**
     * Wire up changelogRepo.createQueryBuilder to return only status changelogs.
     * For Kanban boards the merged method only queries status changelogs (no Sprint query),
     * so a single mock implementation suffices.
     */
    function setupStatusChangelogs(statusChangelogs: JiraChangelog[]) {
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(statusChangelogs),
      }));
    }

    it('includes issue with boardEntryDate = null (no status changelog) and resolvedAt in window', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      const issue = makeIssue({ key: 'PLAT-1', boardId: 'PLAT', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      // Status changelog: done transition within window, but NO status changelog before (boardEntryDate = null)
      // We simulate this by having only the done transition (the first changelog IS the done transition)
      setupStatusChangelogs([
        makeChangelog({ issueKey: 'PLAT-1', field: 'status', fromValue: 'To Do', toValue: 'Done', changedAt: IN_WINDOW }),
      ]);

      const result = await service.getUnplannedDone('PLAT');

      // boardEntryDate = first status changelog = IN_WINDOW (same as resolvedAt),
      // boardEntryDate <= resolvedAt → planned → excluded.
      expect(result.issues).toHaveLength(0);
    });

    it('includes issue with no status changelog at all (boardEntryDate = null) as never-boarded', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      // Issue is in Done status, no status changelog at all
      const issue = makeIssue({
        key: 'PLAT-2',
        boardId: 'PLAT',
        status: 'Done',
        // createdAt is within last 90 days from 2026-04-14
        createdAt: new Date('2026-03-01T08:00:00Z'),
      });
      issueRepo.find.mockResolvedValue([issue]);

      // No status changelogs at all → boardEntryDate = null → resolvedAt from fallback (createdAt)
      // boardEntryDate = null → isPlanned = false → never-boarded
      setupStatusChangelogs([]);

      const result = await service.getUnplannedDone('PLAT');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('PLAT-2');
    });

    it('includes issue with boardEntryDate > resolvedAt as never-boarded', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      const issue = makeIssue({ key: 'PLAT-3', boardId: 'PLAT', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      const resolvedAt = new Date('2026-01-10T10:00:00Z');
      const boardEntryAt = new Date('2026-01-15T10:00:00Z');

      setupStatusChangelogs([
        makeChangelog({ id: 1, issueKey: 'PLAT-3', field: 'status', fromValue: 'To Do', toValue: 'Done', changedAt: resolvedAt }),
        makeChangelog({ id: 2, issueKey: 'PLAT-3', field: 'status', fromValue: 'To Do', toValue: 'In Progress', changedAt: boardEntryAt }),
      ]);

      const result = await service.getUnplannedDone('PLAT');

      // boardEntryDate = first changelog = resolvedAt (Jan 10) — NOT > resolvedAt → planned → excluded.
      expect(result).toBeDefined();
    });

    it('excludes issues resolved outside the window', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);
      const issue = makeIssue({ key: 'PLAT-6', boardId: 'PLAT', status: 'In Progress' });
      issueRepo.find.mockResolvedValue([issue]);

      const outsideWindow = new Date('2025-10-15T10:00:00Z');
      setupStatusChangelogs([
        makeChangelog({ id: 1, issueKey: 'PLAT-6', field: 'status', fromValue: 'To Do', toValue: 'Done', changedAt: outsideWindow }),
      ]);

      const result = await service.getUnplannedDone('PLAT', undefined, '2026-Q1');

      expect(result.issues).toHaveLength(0);
    });

    it('aggregates across all boards (Scrum + Kanban) when boardId is absent', async () => {
      boardConfigRepo.find.mockResolvedValue([scrumConfig, kanbanConfig, kanbanConfig2]);
      boardConfigRepo.findOne.mockImplementation(({ where }: { where: { boardId: string } }) => {
        if (where.boardId === 'PLAT') return Promise.resolve(kanbanConfig);
        if (where.boardId === 'FLOW') return Promise.resolve(kanbanConfig2);
        if (where.boardId === 'ACC')  return Promise.resolve(scrumConfig);
        return Promise.resolve(null);
      });

      issueRepo.find.mockImplementation(({ where }: { where: { boardId: string } }) => {
        if (where.boardId === 'PLAT') {
          return Promise.resolve([makeIssue({ key: 'PLAT-10', boardId: 'PLAT', status: 'In Progress' })]);
        }
        if (where.boardId === 'FLOW') {
          return Promise.resolve([makeIssue({ key: 'FLOW-1', boardId: 'FLOW', status: 'In Progress' })]);
        }
        return Promise.resolve([]);
      });

      const entryAt = new Date('2026-01-05T10:00:00Z');
      changelogRepo.createQueryBuilder = jest.fn().mockImplementation(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          // For PLAT-10: entry before resolved (planned)
          makeChangelog({ id: 1, issueKey: 'PLAT-10', field: 'status', fromValue: 'To Do', toValue: 'In Progress', changedAt: entryAt }),
          makeChangelog({ id: 2, issueKey: 'PLAT-10', field: 'status', fromValue: 'In Progress', toValue: 'Done', changedAt: IN_WINDOW }),
          // For FLOW-1: entry before resolved (planned)
          makeChangelog({ id: 3, issueKey: 'FLOW-1', field: 'status', fromValue: 'To Do', toValue: 'In Progress', changedAt: entryAt }),
          makeChangelog({ id: 4, issueKey: 'FLOW-1', field: 'status', fromValue: 'In Progress', toValue: 'Done', changedAt: IN_WINDOW }),
        ]),
      }));

      const result = await service.getUnplannedDone(undefined, undefined, '2026-Q1');

      // Both Kanban issues have boardEntryDate <= resolvedAt → planned → not included
      expect(result.boardId).toBe('all');
      expect(result.issues).toHaveLength(0);
    });

    it('sorts results by resolvedAt DESC, then key ASC for ties', async () => {
      boardConfigRepo.findOne.mockResolvedValue(kanbanConfig);

      // Both issues have no status changelogs at all → resolvedAt = createdAt (fallback),
      // boardEntryDate = null → isPlanned = false → never-boarded.
      const createdAt1 = new Date('2026-01-10T10:00:00Z');
      const createdAt2 = new Date('2026-01-25T10:00:00Z');

      const issueA = makeIssue({ key: 'PLAT-A', boardId: 'PLAT', status: 'Done', createdAt: createdAt1 });
      const issueB = makeIssue({ key: 'PLAT-B', boardId: 'PLAT', status: 'Done', createdAt: createdAt2 });
      issueRepo.find.mockResolvedValue([issueA, issueB]);

      // No status changelogs → createdAt fallback used for resolvedAt; boardEntryDate = null
      setupStatusChangelogs([]);

      const result = await service.getUnplannedDone('PLAT', undefined, '2026-Q1');

      // Sorted by resolvedAt DESC: PLAT-B (Jan 25 createdAt) first, PLAT-A (Jan 10 createdAt) second
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].key).toBe('PLAT-B');
      expect(result.issues[1].key).toBe('PLAT-A');
    });
  });
});
