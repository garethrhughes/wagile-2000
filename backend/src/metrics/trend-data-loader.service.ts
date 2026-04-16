/**
 * TrendDataLoader
 *
 * Loads all data needed to compute DORA metrics for a board across an
 * arbitrary date range in a single bulk pass (2–4 queries per board).
 *
 * The returned TrendDataSlice is passed to the calculateFromData() /
 * getLeadTimeObservationsFromData() / getMttrObservationsFromData() overloads
 * on each metric service so that getDoraTrend() can fan out to N period
 * calculations entirely in memory — without re-querying the DB per period.
 *
 * Query budget per board:
 *   1. Issues (boardId) — no date filter; see note below
 *   2. Status changelogs (issueKeys IN, changedAt BETWEEN rangeStart and rangeEnd)
 *   3. Released versions (projectKey, releaseDate BETWEEN)
 *   4. Issue links (sourceIssueKey IN)
 *
 * Note on issue date filter: Issues are loaded without a date constraint
 * because Lead Time and MTTR need to find issues that may have been created
 * before the trend window but whose in-progress transitions and done/recovery
 * transitions fall within it.  Filtering by createdAt or updatedAt would
 * silently exclude those issues and produce incorrect (low) medians.  The
 * extra rows are cheap to transfer compared to the changelogs they would bring.
 *
 * Compared to the previous per-period path (≈9 queries × boards × periods),
 * a trend with 8 quarters and 5 boards drops from ~360 to ~20 queries.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import {
  JiraIssue,
  JiraChangelog,
  JiraVersion,
  BoardConfig,
  JiraIssueLink,
  WorkingTimeConfigEntity,
} from '../database/entities/index.js';
import { WorkingTimeService } from './working-time.service.js';
import { isWorkItem } from './issue-type-filters.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pre-loaded data for a single board, covering a full date range that spans
 * all trend periods.  Each calculateFromData() call slices this in memory
 * to the specific period it needs.
 */
export interface TrendDataSlice {
  boardId: string;
  boardConfig: BoardConfig | null;
  /** Working-time config used by LeadTimeService for weekend exclusion. */
  wtEntity: WorkingTimeConfigEntity;
  /** All work items for the board (Epics and Sub-tasks excluded). */
  issues: JiraIssue[];
  /**
   * Status changelogs for work items with changedAt BETWEEN rangeStart and
   * rangeEnd, ordered ascending by changedAt.
   *
   * **Ordering contract**: all callers that iterate this array to find "first"
   * or "last" transitions (e.g. getMttrObservationsFromData) rely on ascending
   * order.  Do not pass unsorted arrays.
   */
  changelogs: JiraChangelog[];
  /** Released versions with releaseDate BETWEEN rangeStart and rangeEnd. */
  versions: JiraVersion[];
  /** All issue links where sourceIssueKey is one of the board's work items. */
  issueLinks: JiraIssueLink[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class TrendDataLoader {
  constructor(
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(JiraVersion)
    private readonly versionRepo: Repository<JiraVersion>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(JiraIssueLink)
    private readonly issueLinkRepo: Repository<JiraIssueLink>,
    private readonly workingTimeService: WorkingTimeService,
  ) {}

  async load(
    boardId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<TrendDataSlice> {
    // Load board config, working-time config, and all raw issues in parallel
    const [boardConfig, wtEntity, rawIssues] = await Promise.all([
      this.boardConfigRepo.findOne({ where: { boardId } }),
      this.workingTimeService.getConfig(),
      this.issueRepo.find({ where: { boardId } }),
    ]);

    const issues = rawIssues.filter((i) => isWorkItem(i.issueType));

    if (issues.length === 0) {
      return { boardId, boardConfig, wtEntity, issues: [], changelogs: [], versions: [], issueLinks: [] };
    }

    const issueKeys = issues.map((i) => i.key);

    // Load changelogs, versions, and issue links in parallel
    const [changelogs, versions, issueLinks] = await Promise.all([
      this.changelogRepo
        .createQueryBuilder('cl')
        .where('cl.issueKey IN (:...keys)', { keys: issueKeys })
        .andWhere('cl.field = :field', { field: 'status' })
        // Bound changelogs to the trend span to avoid loading transitions that
        // pre-date the earliest period (lower bound) or post-date the latest
        // period (upper bound).  Lead Time and MTTR in-memory paths need
        // pre-period in-progress transitions only within the full span, not
        // from unbounded history.
        .andWhere('cl.changedAt >= :from', { from: rangeStart })
        .andWhere('cl.changedAt <= :to', { to: rangeEnd })
        .orderBy('cl.changedAt', 'ASC')
        .getMany(),
      this.versionRepo.find({
        where: {
          projectKey: boardId,
          released: true,
          releaseDate: Between(rangeStart, rangeEnd),
        },
      }),
      this.issueLinkRepo.find({
        where: { sourceIssueKey: In(issueKeys) },
      }),
    ]);

    return { boardId, boardConfig, wtEntity, issues, changelogs, versions, issueLinks };
  }
}
