import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { YamlConfigService } from './yaml-config.service.js';
import type { FileReader } from './yaml-config.service.js';
import { BoardConfig, RoadmapConfig, JiraFieldConfig } from '../database/entities/index.js';

/** Minimal ConfigService stub — returns undefined for all keys (uses service defaults). */
const stubConfigService = {
  get: jest.fn().mockReturnValue(undefined),
} as unknown as ConfigService;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockBoardRepo(): jest.Mocked<Pick<Repository<BoardConfig>, 'upsert'>> {
  return {
    upsert: jest.fn().mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] }),
  } as unknown as jest.Mocked<Pick<Repository<BoardConfig>, 'upsert'>>;
}

function mockRoadmapRepo(): jest.Mocked<Pick<Repository<RoadmapConfig>, 'upsert'>> {
  return {
    upsert: jest.fn().mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] }),
  } as unknown as jest.Mocked<Pick<Repository<RoadmapConfig>, 'upsert'>>;
}

function mockJiraFieldConfigRepo(): jest.Mocked<Pick<Repository<JiraFieldConfig>, 'upsert'>> {
  return {
    upsert: jest.fn().mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] }),
  } as unknown as jest.Mocked<Pick<Repository<JiraFieldConfig>, 'upsert'>>;
}

/**
 * Build a FileReader that returns the given content for specific path suffixes.
 * Paths that don't match any key return false / throw.
 */
function makeFileReader(files: Record<string, string>): FileReader {
  return {
    existsSync(filePath: string): boolean {
      return Object.keys(files).some((suffix) => filePath.endsWith(suffix));
    },
    readFileSync(filePath: string): string {
      const key = Object.keys(files).find((suffix) => filePath.endsWith(suffix));
      if (!key) throw new Error(`File not found in test fixture: ${filePath}`);
      return files[key];
    },
  };
}

/** FileReader that reports all files as absent */
const noFilesReader: FileReader = {
  existsSync: () => false,
  readFileSync: () => { throw new Error('readFileSync called on absent file'); },
};

function buildService(
  boardRepo: unknown,
  roadmapRepo: unknown,
  fileReader: FileReader = noFilesReader,
  jiraFieldConfigRepo: unknown = mockJiraFieldConfigRepo(),
): YamlConfigService {
  return new YamlConfigService(
    boardRepo as Repository<BoardConfig>,
    roadmapRepo as Repository<RoadmapConfig>,
    jiraFieldConfigRepo as Repository<JiraFieldConfig>,
    stubConfigService,
  ).withFileReader(fileReader);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('YamlConfigService', () => {
  let boardRepo: jest.Mocked<Pick<Repository<BoardConfig>, 'upsert'>>;
  let roadmapRepo: jest.Mocked<Pick<Repository<RoadmapConfig>, 'upsert'>>;
  let jiraFieldConfigRepo: jest.Mocked<Pick<Repository<JiraFieldConfig>, 'upsert'>>;

  beforeEach(() => {
    boardRepo = mockBoardRepo();
    roadmapRepo = mockRoadmapRepo();
    jiraFieldConfigRepo = mockJiraFieldConfigRepo();
  });

  // -------------------------------------------------------------------------
  // Missing files — non-fatal no-ops
  // -------------------------------------------------------------------------

  describe('missing YAML files', () => {
    it('skips both files and makes no upserts when neither exists', async () => {
      const service = buildService(boardRepo, roadmapRepo, noFilesReader);

      await service.onApplicationBootstrap();

      expect(boardRepo.upsert).not.toHaveBeenCalled();
      expect(roadmapRepo.upsert).not.toHaveBeenCalled();
    });

    it('updates seed status correctly when both files are missing', async () => {
      const service = buildService(boardRepo, roadmapRepo, noFilesReader);

      await service.onApplicationBootstrap();

      const status = service.getLastSeedStatus();
      expect(status.boardsFileFound).toBe(false);
      expect(status.boardsApplied).toBe(0);
      expect(status.roadmapFileFound).toBe(false);
      expect(status.roadmapsApplied).toBe(0);
      expect(status.error).toBeNull();
      expect(status.lastAppliedAt).not.toBeNull();
    });

    it('processes roadmap YAML even when boards YAML is missing', async () => {
      const roadmapYaml = `
roadmaps:
  - jpdKey: DISC
    description: "Discovery roadmap"
    startDateFieldId: "customfield_10015"
    targetDateFieldId: "customfield_10021"
`;
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': roadmapYaml }),
      );

      await service.onApplicationBootstrap();

      expect(boardRepo.upsert).not.toHaveBeenCalled();
      expect(roadmapRepo.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Valid boards YAML — upsert behaviour
  // -------------------------------------------------------------------------

  describe('valid boards.yaml', () => {
    const validBoardsYaml = `
boards:
  - boardId: ACC
    boardType: scrum
    doneStatusNames:
      - Done
      - Closed
      - Released
    inProgressStatusNames:
      - In Progress
    cancelledStatusNames:
      - Cancelled
    failureIssueTypes:
      - Bug
    failureLinkTypes:
      - "is caused by"
    failureLabels:
      - regression
    incidentIssueTypes:
      - Bug
    recoveryStatusNames:
      - Done
    incidentLabels: []
    incidentPriorities:
      - Critical
    backlogStatusIds: []
    dataStartDate: null

  - boardId: PLAT
    boardType: kanban
    doneStatusNames:
      - Done
      - Released
    dataStartDate: "2024-01-01"
`;

    it('calls upsert once per board entry', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      expect(boardRepo.upsert).toHaveBeenCalledTimes(2);
    });

    it('upserts ACC with correct payload and conflictPaths boardId', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (boardRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<BoardConfig>,
        { conflictPaths: string[] },
      ];
      expect(firstCall[0].boardId).toBe('ACC');
      expect(firstCall[0].boardType).toBe('scrum');
      expect(firstCall[1]).toEqual({ conflictPaths: ['boardId'] });
    });

    it('normalises boardId to uppercase (acc → ACC)', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: acc
    boardType: scrum
`,
        }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (boardRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<BoardConfig>,
        unknown,
      ];
      expect(firstCall[0].boardId).toBe('ACC');
    });

    it('records correct boardsApplied count in seed status', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().boardsApplied).toBe(2);
    });

    it('sets boardsFileFound to true', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().boardsFileFound).toBe(true);
    });

    it('writes dataStartDate null when YAML value is null', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      const calls = (boardRepo.upsert as jest.Mock).mock.calls as [
        Partial<BoardConfig>,
        unknown,
      ][];
      const accCall = calls.find((c) => c[0].boardId === 'ACC');
      expect(accCall).toBeDefined();
      expect(accCall![0].dataStartDate).toBeNull();
    });

    it('writes dataStartDate string when YAML specifies an ISO date', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': validBoardsYaml }),
      );

      await service.onApplicationBootstrap();

      const calls = (boardRepo.upsert as jest.Mock).mock.calls as [
        Partial<BoardConfig>,
        unknown,
      ][];
      const platCall = calls.find((c) => c[0].boardId === 'PLAT');
      expect(platCall).toBeDefined();
      expect(platCall![0].dataStartDate).toBe('2024-01-01');
    });
  });

  // -------------------------------------------------------------------------
  // Partial YAML — absent optional fields must not appear in upsert payload
  // -------------------------------------------------------------------------

  describe('partial boards YAML (absent optional fields)', () => {
    it('does not include failureLabels in upsert payload when absent from YAML', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
    doneStatusNames:
      - Done
`,
        }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (boardRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<BoardConfig>,
        unknown,
      ];
      expect('failureLabels' in firstCall[0]).toBe(false);
    });

    it('does not include inProgressStatusNames or dataStartDate in payload when absent', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
`,
        }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (boardRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<BoardConfig>,
        unknown,
      ];
      expect('inProgressStatusNames' in firstCall[0]).toBe(false);
      expect('dataStartDate' in firstCall[0]).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Empty boards list
  // -------------------------------------------------------------------------

  describe('empty boards list', () => {
    it('makes zero upserts and records zero applied', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': `boards: []` }),
      );

      await service.onApplicationBootstrap();

      expect(boardRepo.upsert).not.toHaveBeenCalled();
      expect(service.getLastSeedStatus().boardsApplied).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid boards YAML — fatal startup errors
  // -------------------------------------------------------------------------

  describe('invalid boards.yaml', () => {
    it('throws on invalid boardType', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: invalid-type
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /boards.yaml validation failed/,
      );
    });

    it('throws on duplicate boardId', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
  - boardId: ACC
    boardType: kanban
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Duplicate boardId/,
      );
    });

    it('throws on invalid dataStartDate format', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
    dataStartDate: "01/01/2024"
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /boards.yaml validation failed/,
      );
    });

    it('throws on empty boardId string', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ""
    boardType: scrum
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /boards.yaml validation failed/,
      );
    });

    it('records error in seed status when startup fails', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: bad-type
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow();

      const status = service.getLastSeedStatus();
      expect(status.error).not.toBeNull();
    });

    it('throws on malformed YAML syntax and sets error in seed status', async () => {
      // This YAML has an unclosed flow-sequence — js-yaml will throw a YAMLException
      // rather than returning a parsed object, so it must propagate as a startup error.
      const malformedYaml = 'boards:\n  - boardId: ACC\n  bad yaml: [\n';
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': malformedYaml }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow();

      const status = service.getLastSeedStatus();
      expect(status.error).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Valid roadmap YAML
  // -------------------------------------------------------------------------

  describe('valid roadmap.yaml', () => {
    const validRoadmapYaml = `
roadmaps:
  - jpdKey: DISC
    description: "Discovery roadmap"
    startDateFieldId: "customfield_10015"
    targetDateFieldId: "customfield_10021"

  - jpdKey: STRAT
    description: "Strategic initiatives"
    startDateFieldId: null
    targetDateFieldId: null
`;

    it('calls upsert once per roadmap entry', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': validRoadmapYaml }),
      );

      await service.onApplicationBootstrap();

      expect(roadmapRepo.upsert).toHaveBeenCalledTimes(2);
    });

    it('upserts DISC with correct payload and conflictPaths jpdKey', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': validRoadmapYaml }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (roadmapRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<RoadmapConfig>,
        { conflictPaths: string[] },
      ];
      expect(firstCall[0].jpdKey).toBe('DISC');
      expect(firstCall[0].startDateFieldId).toBe('customfield_10015');
      expect(firstCall[1]).toEqual({ conflictPaths: ['jpdKey'] });
    });

    it('writes null for startDateFieldId and targetDateFieldId when set to null', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': validRoadmapYaml }),
      );

      await service.onApplicationBootstrap();

      const calls = (roadmapRepo.upsert as jest.Mock).mock.calls as [
        Partial<RoadmapConfig>,
        unknown,
      ][];
      const stratCall = calls.find((c) => c[0].jpdKey === 'STRAT');
      expect(stratCall).toBeDefined();
      expect(stratCall![0].startDateFieldId).toBeNull();
      expect(stratCall![0].targetDateFieldId).toBeNull();
    });

    it('records correct roadmapsApplied count in seed status', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': validRoadmapYaml }),
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().roadmapsApplied).toBe(2);
    });

    it('sets roadmapFileFound to true', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'roadmap.yaml': validRoadmapYaml }),
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().roadmapFileFound).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid roadmap YAML
  // -------------------------------------------------------------------------

  describe('invalid roadmap.yaml', () => {
    it('throws on duplicate jpdKey', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'roadmap.yaml': `
roadmaps:
  - jpdKey: DISC
    description: "First"
  - jpdKey: DISC
    description: "Duplicate"
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /Duplicate jpdKey/,
      );
    });

    it('throws on empty jpdKey', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'roadmap.yaml': `
roadmaps:
  - jpdKey: ""
    description: "Empty key"
`,
        }),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        /roadmap.yaml validation failed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Partial roadmap YAML — absent optional fields must not appear in upsert payload
  // -------------------------------------------------------------------------

  describe('partial roadmap YAML (absent optional fields)', () => {
    it('does not include description or targetDateFieldId in payload when absent from YAML', async () => {
      // Only jpdKey and startDateFieldId are specified; description and
      // targetDateFieldId are omitted entirely (not null — truly absent).
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'roadmap.yaml': `
roadmaps:
  - jpdKey: DISC
    startDateFieldId: "customfield_10015"
`,
        }),
      );

      await service.onApplicationBootstrap();

      const firstCall = (roadmapRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<RoadmapConfig>,
        unknown,
      ];
      expect(firstCall[0].jpdKey).toBe('DISC');
      expect(firstCall[0].startDateFieldId).toBe('customfield_10015');
      // Absent fields must NOT be present in the upsert payload at all
      expect('description' in firstCall[0]).toBe(false);
      expect('targetDateFieldId' in firstCall[0]).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getLastSeedStatus
  // -------------------------------------------------------------------------

  describe('getLastSeedStatus', () => {
    it('returns a copy of the status (not a reference)', async () => {
      const service = buildService(boardRepo, roadmapRepo, noFilesReader);
      await service.onApplicationBootstrap();

      const status1 = service.getLastSeedStatus();
      const status2 = service.getLastSeedStatus();

      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });

    it('sets lastAppliedAt to a valid ISO timestamp after successful bootstrap', async () => {
      const service = buildService(boardRepo, roadmapRepo, noFilesReader);
      await service.onApplicationBootstrap();

      const { lastAppliedAt } = service.getLastSeedStatus();
      expect(lastAppliedAt).not.toBeNull();
      expect(() => new Date(lastAppliedAt!).toISOString()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // jira: stanza — JiraFieldConfig upsert behaviour
  // -------------------------------------------------------------------------

  describe('jira: stanza in boards.yaml', () => {
    const boardsWithJiraStanza = `
boards:
  - boardId: ACC
    boardType: scrum

jira:
  storyPointsFieldIds:
    - customfield_10016
    - customfield_10028
    - story_points
  epicLinkFieldId: customfield_10014
  jpdDeliveryLinkInward: "is delivered by"
  jpdDeliveryLinkOutward: "delivers"
`;

    it('upserts JiraFieldConfig when jira: stanza is present', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': boardsWithJiraStanza }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      expect(jiraFieldConfigRepo.upsert).toHaveBeenCalledTimes(1);
    });

    it('upserts singleton row id=1 with correct payload', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': boardsWithJiraStanza }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      const call = (jiraFieldConfigRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<JiraFieldConfig>,
        { conflictPaths: string[] },
      ];
      expect(call[0].id).toBe(1);
      expect(call[0].storyPointsFieldIds).toEqual([
        'customfield_10016',
        'customfield_10028',
        'story_points',
      ]);
      expect(call[0].epicLinkFieldId).toBe('customfield_10014');
      expect(call[0].jpdDeliveryLinkInward).toEqual(['is delivered by']);
      expect(call[0].jpdDeliveryLinkOutward).toEqual(['delivers']);
      expect(call[1]).toEqual({ conflictPaths: ['id'] });
    });

    it('sets jiraFieldConfigApplied to true in seed status when stanza is present', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({ 'boards.yaml': boardsWithJiraStanza }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().jiraFieldConfigApplied).toBe(true);
    });

    it('does not upsert JiraFieldConfig when jira: stanza is absent', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
`,
        }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      expect(jiraFieldConfigRepo.upsert).not.toHaveBeenCalled();
    });

    it('leaves jiraFieldConfigApplied false when jira: stanza is absent', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum
`,
        }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      expect(service.getLastSeedStatus().jiraFieldConfigApplied).toBe(false);
    });

    it('upserts partial jira: stanza with only explicitly set fields', async () => {
      // Only storyPointsFieldIds is set; epicLinkFieldId is absent entirely.
      const service = buildService(
        boardRepo,
        roadmapRepo,
        makeFileReader({
          'boards.yaml': `
boards:
  - boardId: ACC
    boardType: scrum

jira:
  storyPointsFieldIds:
    - customfield_10016
`,
        }),
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      const call = (jiraFieldConfigRepo.upsert as jest.Mock).mock.calls[0] as [
        Partial<JiraFieldConfig>,
        unknown,
      ];
      expect(call[0].storyPointsFieldIds).toEqual(['customfield_10016']);
      // Absent fields must NOT be present in the payload
      expect('epicLinkFieldId' in call[0]).toBe(false);
      expect('jpdDeliveryLinkInward' in call[0]).toBe(false);
      expect('jpdDeliveryLinkOutward' in call[0]).toBe(false);
    });

    it('does not upsert JiraFieldConfig when no boards.yaml is present', async () => {
      const service = buildService(
        boardRepo,
        roadmapRepo,
        noFilesReader,
        jiraFieldConfigRepo,
      );

      await service.onApplicationBootstrap();

      expect(jiraFieldConfigRepo.upsert).not.toHaveBeenCalled();
    });
  });
});
