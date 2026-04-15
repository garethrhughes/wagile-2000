import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BoardConfig, RoadmapConfig, JiraFieldConfig } from '../database/entities/index.js';
import { BoardsYamlFileSchema } from './schemas/boards-yaml.schema.js';
import { RoadmapYamlFileSchema } from './schemas/roadmap-yaml.schema.js';

export interface YamlSeedStatus {
  boardsFileFound: boolean;
  boardsApplied: number;
  roadmapFileFound: boolean;
  roadmapsApplied: number;
  jiraFieldConfigApplied: boolean;
  lastAppliedAt: string | null;
  error: string | null;
}

/**
 * Thin abstraction over the filesystem. Exists solely to make YamlConfigService
 * testable without mocking the entire node:fs module.
 */
export interface FileReader {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string): string;
}

const defaultFileReader: FileReader = {
  existsSync: (filePath: string) => fs.existsSync(filePath),
  readFileSync: (filePath: string) => fs.readFileSync(filePath, 'utf-8'),
};

@Injectable()
export class YamlConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(YamlConfigService.name);
  // Not injected via NestJS DI — FileReader is a TypeScript interface with no
  // runtime token.  emitDecoratorMetadata would emit Object for it at the
  // constructor parameter position, causing an UnknownDependenciesException.
  // Instead we default to defaultFileReader here and allow tests to override
  // via withFileReader() without touching the DI container at all.
  private fileReader: FileReader = defaultFileReader;

  private seedStatus: YamlSeedStatus = {
    boardsFileFound: false,
    boardsApplied: 0,
    roadmapFileFound: false,
    roadmapsApplied: 0,
    jiraFieldConfigApplied: false,
    lastAppliedAt: null,
    error: null,
  };

  constructor(
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
    @InjectRepository(JiraFieldConfig)
    private readonly jiraFieldConfigRepo: Repository<JiraFieldConfig>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Override the FileReader used for filesystem access.  Only intended for
   * use in unit tests — production code always uses the defaultFileReader
   * assigned above.
   */
  withFileReader(fileReader: FileReader): this {
    this.fileReader = fileReader;
    return this;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.applyBoardsYaml();
      await this.applyRoadmapYaml();
      this.seedStatus.lastAppliedAt = new Date().toISOString();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.seedStatus.error = message;
      // Re-throw so NestJS startup fails with a clear, readable message
      throw err;
    }
  }

  getLastSeedStatus(): YamlSeedStatus {
    return { ...this.seedStatus };
  }

  private async applyBoardsYaml(): Promise<void> {
    const filePath =
      this.configService.get<string>('BOARD_CONFIG_FILE') ??
      path.join(process.cwd(), 'config/boards.yaml');

    if (!this.fileReader.existsSync(filePath)) {
      this.logger.warn('config/boards.yaml not found — skipping board YAML seed.');
      this.seedStatus.boardsFileFound = false;
      return;
    }

    this.seedStatus.boardsFileFound = true;
    const raw = this.fileReader.readFileSync(filePath);
    // js-yaml v4: load() uses DEFAULT_SCHEMA (safe) by default — safeLoad() was removed in v4.
    const parsed: unknown = yaml.load(raw);

    // An empty or whitespace-only YAML file yields null — treat identically to a
    // missing file rather than letting Zod report an opaque "Expected object" error.
    if (parsed == null) {
      this.logger.warn('config/boards.yaml is empty — skipping board YAML seed.');
      return;
    }

    const result = BoardsYamlFileSchema.safeParse(parsed);

    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`boards.yaml validation failed:\n${details}`);
    }

    const { boards, jira } = result.data;
    let applied = 0;

    for (const board of boards) {
      // Build upsert payload — only include fields explicitly specified in YAML.
      // Undefined fields are omitted so they do not overwrite existing DB values.
      // boardType is optional: if absent from the YAML entry it is not included,
      // leaving the existing DB value untouched.
      const payload: Partial<BoardConfig> & Pick<BoardConfig, 'boardId'> = {
        boardId: board.boardId,
      };

      if (board.boardType !== undefined) {
        payload.boardType = board.boardType;
      }

      if (board.doneStatusNames !== undefined) {
        payload.doneStatusNames = board.doneStatusNames;
      }
      if (board.inProgressStatusNames !== undefined) {
        payload.inProgressStatusNames = board.inProgressStatusNames;
      }
      if (board.cancelledStatusNames !== undefined) {
        payload.cancelledStatusNames = board.cancelledStatusNames;
      }
      if (board.failureIssueTypes !== undefined) {
        payload.failureIssueTypes = board.failureIssueTypes;
      }
      if (board.failureLinkTypes !== undefined) {
        payload.failureLinkTypes = board.failureLinkTypes;
      }
      if (board.failureLabels !== undefined) {
        payload.failureLabels = board.failureLabels;
      }
      if (board.incidentIssueTypes !== undefined) {
        payload.incidentIssueTypes = board.incidentIssueTypes;
      }
      if (board.recoveryStatusNames !== undefined) {
        payload.recoveryStatusNames = board.recoveryStatusNames;
      }
      if (board.incidentLabels !== undefined) {
        payload.incidentLabels = board.incidentLabels;
      }
      if (board.incidentPriorities !== undefined) {
        payload.incidentPriorities = board.incidentPriorities;
      }
      if (board.backlogStatusIds !== undefined) {
        payload.backlogStatusIds = board.backlogStatusIds;
      }
      if (board.dataStartDate !== undefined) {
        payload.dataStartDate = board.dataStartDate ?? null;
      }

      await this.boardConfigRepo.upsert(payload, { conflictPaths: ['boardId'] });
      applied++;
    }

    this.seedStatus.boardsApplied = applied;
    this.logger.log(`YAML config: ${applied} board config(s) applied from boards.yaml`);

    // Apply jira: stanza if present — only write fields that are explicitly
    // specified so that a partial stanza does not wipe out other fields.
    if (jira !== undefined) {
      await this.applyJiraStanza(jira);
    }
  }

  /**
   * Upsert the singleton JiraFieldConfig row from the `jira:` stanza.
   * Only fields explicitly set in YAML are written; all others keep their
   * current DB values (or migration defaults if the row is brand-new).
   */
  private async applyJiraStanza(
    jira: NonNullable<ReturnType<typeof BoardsYamlFileSchema.parse>['jira']>,
  ): Promise<void> {
    const payload: Partial<JiraFieldConfig> & Pick<JiraFieldConfig, 'id'> = { id: 1 };

    if (jira.storyPointsFieldIds !== undefined) {
      payload.storyPointsFieldIds = jira.storyPointsFieldIds;
    }
    if (jira.epicLinkFieldId !== undefined) {
      payload.epicLinkFieldId = jira.epicLinkFieldId;
    }
    if (jira.jpdDeliveryLinkInward !== undefined) {
      payload.jpdDeliveryLinkInward = jira.jpdDeliveryLinkInward;
    }
    if (jira.jpdDeliveryLinkOutward !== undefined) {
      payload.jpdDeliveryLinkOutward = jira.jpdDeliveryLinkOutward;
    }

    await this.jiraFieldConfigRepo.upsert(payload, { conflictPaths: ['id'] });
    this.seedStatus.jiraFieldConfigApplied = true;
    this.logger.log('YAML config: jira field config applied from boards.yaml jira: stanza');
  }

  private async applyRoadmapYaml(): Promise<void> {
    const filePath =
      this.configService.get<string>('ROADMAP_CONFIG_FILE') ??
      path.join(process.cwd(), 'config/roadmap.yaml');

    if (!this.fileReader.existsSync(filePath)) {
      this.logger.warn('config/roadmap.yaml not found — skipping roadmap YAML seed.');
      this.seedStatus.roadmapFileFound = false;
      return;
    }

    this.seedStatus.roadmapFileFound = true;
    const raw = this.fileReader.readFileSync(filePath);
    // js-yaml v4: load() uses DEFAULT_SCHEMA (safe) by default — safeLoad() was removed in v4.
    const parsed: unknown = yaml.load(raw);

    // An empty or whitespace-only YAML file yields null — treat identically to a
    // missing file rather than letting Zod report an opaque "Expected object" error.
    if (parsed == null) {
      this.logger.warn('config/roadmap.yaml is empty — skipping roadmap YAML seed.');
      return;
    }

    const result = RoadmapYamlFileSchema.safeParse(parsed);

    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`roadmap.yaml validation failed:\n${details}`);
    }

    const { roadmaps } = result.data;
    let applied = 0;

    for (const roadmap of roadmaps) {
      // Build upsert payload — only include fields explicitly specified in YAML.
      const payload: Partial<RoadmapConfig> & Pick<RoadmapConfig, 'jpdKey'> = {
        jpdKey: roadmap.jpdKey,
      };

      if (roadmap.description !== undefined) {
        payload.description = roadmap.description ?? null;
      }
      if (roadmap.startDateFieldId !== undefined) {
        payload.startDateFieldId = roadmap.startDateFieldId ?? null;
      }
      if (roadmap.targetDateFieldId !== undefined) {
        payload.targetDateFieldId = roadmap.targetDateFieldId ?? null;
      }

      // RoadmapConfig uses an auto-generated numeric PK (id).
      // The jpdKey column has a UNIQUE constraint, making it the conflict target.
      await this.roadmapConfigRepo.upsert(payload, { conflictPaths: ['jpdKey'] });
      applied++;
    }

    this.seedStatus.roadmapsApplied = applied;
    this.logger.log(`YAML config: ${applied} roadmap config(s) applied from roadmap.yaml`);
  }
}
