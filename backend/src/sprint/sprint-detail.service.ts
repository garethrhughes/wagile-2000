import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  BoardConfig,
  JiraChangelog,
  JiraIssue,
  JiraIssueLink,
  JiraSprint,
  JpdIdea,
  RoadmapConfig,
} from '../database/entities/index.js';
import { isWorkItem } from '../metrics/issue-type-filters.js';
import { WorkingTimeService } from '../metrics/working-time.service.js';

// ---------------------------------------------------------------------------
// Response interfaces (exported for use by the controller and frontend types)
// ---------------------------------------------------------------------------

/** Board configuration rules applied to derive per-issue annotations */
export interface SprintDetailBoardConfig {
  doneStatusNames: string[];
  failureIssueTypes: string[];
  failureLabels: string[];
  failureLinkTypes: string[];
  incidentIssueTypes: string[];
  incidentLabels: string[];
}

export interface SprintDetailIssue {
  /** Jira issue key, e.g. "ACC-123" */
  key: string;

  /** Issue summary / title */
  summary: string;

  /** Current status at time of last sync */
  currentStatus: string;

  /** Jira issue type, e.g. "Story", "Bug", "Task" */
  issueType: string;

  /**
   * True if the issue was added to the sprint AFTER sprint start
   * (using the 5-minute grace period defined in PlanningService).
   */
  addedMidSprint: boolean;

  /**
   * Roadmap link status for the issue:
   *  - 'in-scope'  : issue's epic is linked to a JPD idea AND either:
   *                    (a) completed on or before idea.targetDate, OR
   *                    (b) in-flight (not done/cancelled) in an active sprint
   *                        with idea.targetDate not yet lapsed (green tick)
   *  - 'linked'    : issue's epic is linked to a JPD idea but neither (a) nor (b)
   *                  applies (amber tick — on roadmap but overdue or not started in
   *                  a closed sprint)
   *  - 'none'      : no roadmap link, or issue is cancelled (dash)
   */
  roadmapStatus: 'in-scope' | 'linked' | 'none';

  /**
   * True if the issue matches incidentIssueTypes OR incidentLabels
   * from BoardConfig. This is the MTTR signal.
   */
  isIncident: boolean;

  /**
   * True if the issue matches failureIssueTypes OR failureLabels
   * from BoardConfig, AND passes the failureLinkTypes AND-gate.
   * When failureLinkTypes is non-empty, the issue must also have a matching
   * causal Jira link (e.g. 'caused by') to be classified as a failure.
   * When failureLinkTypes is empty (the default), the link gate is skipped
   * and all type/label matches qualify. This is the CFR signal.
   * See Proposal 0032.
   */
  isFailure: boolean;

  /**
   * True if the issue transitioned to a doneStatusName between
   * sprint.startDate and sprint.endDate (inclusive), or if the
   * issue's current status is already in doneStatusNames.
   */
  completedInSprint: boolean;

  /**
   * Lead time in days, or null if it cannot be computed.
   * = (firstInProgressTransitionDate OR issue.createdAt) → firstDoneTransitionDate
   * Negative values (data anomalies) are clamped to null.
   * Rounded to 2 decimal places.
   */
  leadTimeDays: number | null;

  /**
   * ISO 8601 timestamp of the issue's first done-status transition,
   * or null if no such transition is found.
   */
  resolvedAt: string | null;

  /**
   * Deep link to the issue in Jira Cloud.
   * Constructed as: `${JIRA_BASE_URL}/browse/${key}`
   * Empty string if JIRA_BASE_URL is not configured.
   */
  jiraUrl: string;
}

export interface SprintDetailSummary {
  /** Count of issues present at sprint start that have not been removed
   *  (excludes issues removed from the sprint mid-flight) */
  committedCount: number;

  /** Count of issues added after sprint start */
  addedMidSprintCount: number;

  /** Count of issues removed during the sprint */
  removedCount: number;

  /** Count of issues completed within the sprint window */
  completedInSprintCount: number;

  /** Count of issues linked to a JPD roadmap item */
  roadmapLinkedCount: number;

  /** Count of issues classified as incidents (MTTR signal) */
  incidentCount: number;

  /** Count of issues classified as failures (CFR signal) */
  failureCount: number;

  /** Median lead time in days across completed issues, or null if no completed issues */
  medianLeadTimeDays: number | null;
}

export interface SprintDetailResponse {
  sprintId: string;
  sprintName: string;
  state: string;             // 'active' | 'closed' | 'future'
  startDate: string | null;  // ISO 8601
  endDate: string | null;    // ISO 8601

  /** The BoardConfig rules applied to derive annotations */
  boardConfig: SprintDetailBoardConfig;

  /** Aggregate summary bar counts */
  summary: SprintDetailSummary;

  /**
   * All issues that were part of this sprint (committed + added - removed).
   * Epics and Sub-tasks are excluded.
   * Sorted: incomplete issues first (alphabetical by key), then completed.
   */
  issues: SprintDetailIssue[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPRINT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SprintDetailService {
  private readonly logger = new Logger(SprintDetailService.name);
  private readonly jiraBaseUrl: string;

  constructor(
    @InjectRepository(JiraSprint)
    private readonly sprintRepo: Repository<JiraSprint>,
    @InjectRepository(JiraIssue)
    private readonly issueRepo: Repository<JiraIssue>,
    @InjectRepository(JiraChangelog)
    private readonly changelogRepo: Repository<JiraChangelog>,
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(JpdIdea)
    private readonly jpdIdeaRepo: Repository<JpdIdea>,
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
    @InjectRepository(JiraIssueLink)
    private readonly issueLinkRepo: Repository<JiraIssueLink>,
    private readonly configService: ConfigService,
    private readonly workingTimeService: WorkingTimeService,
  ) {
    const baseUrl = this.configService.get<string>('JIRA_BASE_URL', '');
    if (!baseUrl) {
      this.logger.warn(
        'JIRA_BASE_URL is not configured — jiraUrl fields will be empty strings',
      );
    }
    this.jiraBaseUrl = baseUrl;
  }

  async getDetail(
    boardId: string,
    sprintId: string,
  ): Promise<SprintDetailResponse> {
    // -----------------------------------------------------------------------
    // Query 1: Load sprint
    // -----------------------------------------------------------------------
    const sprint = await this.sprintRepo.findOne({
      where: { id: sprintId, boardId },
    });
    if (!sprint) {
      throw new NotFoundException(
        `Sprint "${sprintId}" not found on board "${boardId}"`,
      );
    }

    // -----------------------------------------------------------------------
    // Query 2: Load BoardConfig — reject Kanban boards
    // -----------------------------------------------------------------------
    const boardConfig = await this.boardConfigRepo.findOne({
      where: { boardId },
    });
    if (boardConfig?.boardType === 'kanban') {
      throw new BadRequestException(
        'Sprint detail view is not available for Kanban boards',
      );
    }

    const doneStatusNames: string[] = boardConfig?.doneStatusNames ?? [
      'Done',
      'Closed',
      'Released',
    ];
    const failureIssueTypes: string[] = boardConfig?.failureIssueTypes ?? ['Bug', 'Incident'];
    const failureLabels: string[] = boardConfig?.failureLabels ?? ['regression', 'incident', 'hotfix'];
    const failureLinkTypes: string[] = boardConfig?.failureLinkTypes ?? [];
    const incidentIssueTypes: string[] = boardConfig?.incidentIssueTypes ?? ['Bug', 'Incident'];
    const incidentLabels: string[] = boardConfig?.incidentLabels ?? [];
    const cancelledStatusNames: string[] = boardConfig?.cancelledStatusNames ?? ['Cancelled', "Won't Do"];
    const incidentPriorities: string[] = boardConfig?.incidentPriorities ?? ['Critical'];

    const boardConfigShape: SprintDetailBoardConfig = {
      doneStatusNames,
      failureIssueTypes,
      failureLabels,
      failureLinkTypes,
      incidentIssueTypes,
      incidentLabels,
    };

    // -----------------------------------------------------------------------
    // Query 3: Load all board issues (needed to replay changelogs correctly)
    // Cannot rely on sprintId column — it stores only the last-synced sprint.
    // -----------------------------------------------------------------------
    const allBoardIssues = await this.issueRepo.find({
      where: { boardId },
    });

    // Filter out Epics and Sub-tasks immediately
    const boardIssues = allBoardIssues.filter(
      (i) => isWorkItem(i.issueType),
    );

    if (boardIssues.length === 0) {
      return this.buildEmptyResponse(sprint, boardConfigShape);
    }

    const allKeys = boardIssues.map((i) => i.key);
    const issueByKey = new Map<string, JiraIssue>(
      boardIssues.map((i) => [i.key, i]),
    );

    // -----------------------------------------------------------------------
    // Query 4: Bulk-load Sprint-field changelogs for all board issue keys
    // -----------------------------------------------------------------------
    const sprintChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: allKeys })
      .andWhere('cl.field = :field', { field: 'Sprint' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // -----------------------------------------------------------------------
    // Sprint membership reconstruction (mirrors PlanningService algorithm)
    // -----------------------------------------------------------------------
    const sprintName = sprint.name;

    // Group Sprint-field changelogs by issue, keeping only those that reference
    // this sprint by name
    const logsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of sprintChangelogs) {
      if (
        sprintValueContains(cl.fromValue, sprintName) ||
        sprintValueContains(cl.toValue, sprintName)
      ) {
        const list = logsByIssue.get(cl.issueKey) ?? [];
        list.push(cl);
        logsByIssue.set(cl.issueKey, list);
      }
    }

    // Include issues currently assigned to this sprint with no changelog
    // (created directly into the sprint — PlanningService pattern §4b)
    for (const issue of boardIssues) {
      if (issue.sprintId === sprint.id && !logsByIssue.has(issue.key)) {
        logsByIssue.set(issue.key, []);
      }
    }

    if (logsByIssue.size === 0) {
      return this.buildEmptyResponse(sprint, boardConfigShape);
    }

    // Classify each issue as committed, added, or removed
    const sprintStart = sprint.startDate;
    const sprintEnd = sprint.endDate ?? new Date();

    const committedKeys = new Set<string>();
    const addedKeys = new Set<string>();
    const removedKeys = new Set<string>();

    if (sprintStart) {
      // -----------------------------------------------------------------------
      // Query 5: Load closed sprint names for carry-over detection.
      // Deferred to here so the query only runs when there are issues and
      // changelogs to classify. Only issues moved from a closed sprint are
      // genuine carry-overs; moves from future/groomed sprints are additions.
      // Only `name` is selected to minimise the data fetched.
      // -----------------------------------------------------------------------
      const closedSprintsForBoard = await this.sprintRepo.find({
        where: { boardId, state: 'closed' },
        select: ['name'],
      });
      const closedSprintNames = new Set(closedSprintsForBoard.map((s) => s.name));

      const effectiveSprintStart = new Date(
        sprintStart.getTime() + SPRINT_GRACE_PERIOD_MS,
      );

      for (const [issueKey, logs] of logsByIssue) {
        const issue = issueByKey.get(issueKey);
        const createdAt = issue?.createdAt;

        // Issues with no sprint changelog were assigned at creation.
        // If created after the grace period, treat as mid-sprint addition.
        const createdMidSprint =
          logs.length === 0 &&
          createdAt != null &&
          createdAt > effectiveSprintStart;

        const wasAtStart =
          !createdMidSprint &&
          wasInSprintAtDate(logs, sprintName, sprintStart);

        let inSprintAtEnd = wasAtStart || createdMidSprint;
        let wasAddedDuringSprint = createdMidSprint;
        // Carry-overs from a previous sprint are treated as committed, not added.
        // See proposal 0038: when fromValue contains a different sprint name, the
        // issue was moved via Jira's "Complete Sprint" carry-over flow.
        let wasCarryOver = false;

        for (const cl of logs) {
          if (cl.changedAt <= sprintStart) continue;
          if (cl.changedAt > sprintEnd) break; // ignore post-sprint changes

          if (sprintValueContains(cl.toValue, sprintName)) {
            if (!inSprintAtEnd && !wasAtStart) {
              if (isCarryOverFromSprint(cl.fromValue, sprintName, closedSprintNames)) {
                wasCarryOver = true;
              } else {
                wasAddedDuringSprint = true;
              }
            }
            inSprintAtEnd = true;
          }
          if (
            sprintValueContains(cl.fromValue, sprintName) &&
            !sprintValueContains(cl.toValue, sprintName)
          ) {
            inSprintAtEnd = false;
          }
        }

        if (wasAtStart || wasCarryOver) {
          committedKeys.add(issueKey);
          if (!inSprintAtEnd) {
            removedKeys.add(issueKey);
          }
        } else if (wasAddedDuringSprint) {
          addedKeys.add(issueKey);
          if (!inSprintAtEnd) {
            removedKeys.add(issueKey);
          }
        }
      }
    } else {
      // No start date — treat all issues with changelogs as committed
      for (const issueKey of logsByIssue.keys()) {
        committedKeys.add(issueKey);
      }
    }

    // Build final issue set: (committed ∪ added) \ removed
    const finalIssueKeys = new Set<string>([...committedKeys, ...addedKeys]);
    for (const key of removedKeys) {
      finalIssueKeys.delete(key);
    }

    if (finalIssueKeys.size === 0) {
      return this.buildEmptyResponse(sprint, boardConfigShape);
    }

    // -----------------------------------------------------------------------
    // Query 6: Bulk-load status-field changelogs for sprint member issues
    // -----------------------------------------------------------------------
    const finalKeys = [...finalIssueKeys];
    const statusChangelogs = await this.changelogRepo
      .createQueryBuilder('cl')
      .where('cl.issueKey IN (:...keys)', { keys: finalKeys })
      .andWhere('cl.field = :field', { field: 'status' })
      .orderBy('cl.changedAt', 'ASC')
      .getMany();

    // Group status changelogs by issue
    const statusLogsByIssue = new Map<string, JiraChangelog[]>();
    for (const cl of statusChangelogs) {
      const list = statusLogsByIssue.get(cl.issueKey) ?? [];
      list.push(cl);
      statusLogsByIssue.set(cl.issueKey, list);
    }

    // -----------------------------------------------------------------------
    // failureLinkTypes AND-gate: bulk causal-link query (Query 6b)
    //
    // When failureLinkTypes is non-empty, only issues with a matching causal
    // link (e.g. 'caused by') are classified as failures.  When
    // failureLinkTypes is empty (the default), all type/label matches qualify.
    // See Proposal 0032.
    // -----------------------------------------------------------------------
    let keysWithCausalLink = new Set<string>();
    if (failureLinkTypes.length > 0) {
      const linkRows = await this.issueLinkRepo
        .createQueryBuilder('l')
        .select('l.sourceIssueKey', 'key')
        .where('l.sourceIssueKey IN (:...keys)', { keys: finalKeys })
        .andWhere('LOWER(l.linkTypeName) IN (:...types)', {
          types: failureLinkTypes.map((t) => t.toLowerCase()),
        })
        .getRawMany<{ key: string }>();
      keysWithCausalLink = new Set(linkRows.map((r) => r.key));
    }

    // -----------------------------------------------------------------------
    // Queries 6 & 7: Load roadmap ideas (RoadmapConfig-scoped)
    //
    // Build epicKey → targetDate map with no date-window filter.
    // Per-issue classification happens in the annotation loop below using
    // doneTransition.changedAt vs idea.targetDate (end-of-day UTC).
    // -----------------------------------------------------------------------
    const roadmapConfigs = await this.roadmapConfigRepo.find();
    const epicIdeaMap = new Map<string, { targetDate: Date }>();

    if (roadmapConfigs.length > 0) {
      const jpdKeys = roadmapConfigs.map((c) => c.jpdKey);
      const jpdIdeas = await this.jpdIdeaRepo.find({
        where: { jpdKey: In(jpdKeys) },
      });

      for (const idea of jpdIdeas) {
        if (!idea.deliveryIssueKeys || idea.targetDate === null) continue;
        for (const epicKey of idea.deliveryIssueKeys.filter(Boolean)) {
          const existing = epicIdeaMap.get(epicKey);
          if (!existing || idea.targetDate > existing.targetDate) {
            epicIdeaMap.set(epicKey, { targetDate: idea.targetDate });
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Derive per-issue annotations
    // -----------------------------------------------------------------------
    const issues: SprintDetailIssue[] = [];

    // Load working-time config once for the whole batch.
    const wtEntity = await this.workingTimeService.getConfig();
    const wtConfig = this.workingTimeService.toConfig(wtEntity);

    for (const issueKey of finalIssueKeys) {
      const issue = issueByKey.get(issueKey);
      if (!issue) continue;

      const issueLogs = statusLogsByIssue.get(issueKey) ?? [];

      // addedMidSprint
      const addedMidSprint = addedKeys.has(issueKey);

      // isIncident: must match type/label AND pass priority AND-gate
      // (consistent with MttrService; incidentPriorities = [] means all priorities qualify)
      const matchesIncidentTypeOrLabel =
        incidentIssueTypes.includes(issue.issueType) ||
        (incidentLabels.length > 0 &&
          issue.labels.some((l) => incidentLabels.includes(l)));
      const isIncident =
        matchesIncidentTypeOrLabel &&
        (incidentPriorities.length === 0 ||
          incidentPriorities.includes(issue.priority ?? ''));

      // isFailure: type/label match AND causal-link gate
      // failureLinkTypes AND-gate: when configured, only issues with a matching
      // causal link (e.g. 'caused by') are classified as failures.  When
      // failureLinkTypes is empty (the default), all type/label matches qualify.
      // See Proposal 0032.
      const passesTypeGate =
        failureIssueTypes.includes(issue.issueType) ||
        issue.labels.some((l) => failureLabels.includes(l));
      const passesLinkGate =
        failureLinkTypes.length === 0 || keysWithCausalLink.has(issue.key);
      const isFailure = passesTypeGate && passesLinkGate;

      // completedInSprint
      // Case 1 (changelog): a status changelog transitioned TO a done status
      // within the sprint window (>= startDate guard prevents crediting
      // completions from a prior sprint).
      const sprintWindowEnd = sprint.endDate ?? new Date();
      const completedByChangelog =
        sprintStart !== null &&
        issueLogs.some(
          (cl) =>
            doneStatusNames.includes(cl.toValue ?? '') &&
            cl.changedAt >= sprintStart &&
            cl.changedAt <= sprintWindowEnd,
        );

      // Case 2 (fallback): no status changelog exists at all (truly truncated
      // data — issue was created directly in the sprint with no transitions
      // recorded) and the current status is already in doneStatusNames.
      // Must NOT fire when changelog exists but done-transition is absent
      // (e.g. completed in a prior sprint and still showing as done).
      const completedInSprint =
        completedByChangelog ||
        (issueLogs.length === 0 && doneStatusNames.includes(issue.status));

      // leadTimeDays and resolvedAt
      // Use In Progress → Done; fall back to createdAt → Done
      const inProgressTransition = issueLogs.find(
        (cl) => cl.toValue === 'In Progress',
      );
      const startTime = inProgressTransition
        ? inProgressTransition.changedAt
        : issue.createdAt;

      const doneTransition = issueLogs.find((cl) =>
        doneStatusNames.includes(cl.toValue ?? ''),
      );
      const resolvedAt = doneTransition
        ? doneTransition.changedAt.toISOString()
        : null;

      // roadmapStatus: per-issue delivery against roadmap targetDate
      //
      //   in-scope (green)  = linked to idea AND:
      //                         (a) completed on or before targetDate, OR
      //                         (b) in-flight in an active sprint with targetDate not yet lapsed
      //   linked   (amber)  = linked to idea AND neither (a) nor (b)
      //   none              = no roadmap link, OR issue is cancelled
      //
      // Cancelled issues always get 'none' so they don't inflate the amber count
      // and are excluded from coverage metrics in calculateSprintAccuracy.
      let roadmapStatus: 'in-scope' | 'linked' | 'none' = 'none';
      if (!cancelledStatusNames.includes(issue.status) && issue.epicKey !== null) {
        const idea = epicIdeaMap.get(issue.epicKey);
        if (idea) {
          const targetEndOfDay = new Date(idea.targetDate.getTime());
          targetEndOfDay.setUTCHours(23, 59, 59, 999);

          const resolvedDate = doneTransition?.changedAt ?? null;

          // Condition A: delivered on time
          const deliveredOnTime = resolvedDate !== null && resolvedDate <= targetEndOfDay;

          // Condition B: in-flight and on track
          const todayStart = new Date();
          todayStart.setUTCHours(0, 0, 0, 0);
          const isInFlight =
            sprint.state === 'active' &&
            idea.targetDate >= todayStart &&
            !doneStatusNames.includes(issue.status) &&
            !cancelledStatusNames.includes(issue.status);

          roadmapStatus = deliveredOnTime || isInFlight ? 'in-scope' : 'linked';
        }
      }

      let leadTimeDays: number | null = null;
      if (doneTransition) {
        const rawDays = wtEntity.excludeWeekends
          ? this.workingTimeService.workingDaysBetween(startTime, doneTransition.changedAt, wtConfig)
          : (doneTransition.changedAt.getTime() - startTime.getTime()) / 86_400_000;
        // Clamp negative values (data anomalies) to null
        leadTimeDays =
          rawDays >= 0
            ? Math.round(rawDays * 100) / 100
            : null;
      }

      // jiraUrl
      const jiraUrl = this.jiraBaseUrl
        ? `${this.jiraBaseUrl}/browse/${issue.key}`
        : '';

      issues.push({
        key: issue.key,
        summary: issue.summary,
        currentStatus: issue.status,
        issueType: issue.issueType,
        addedMidSprint,
        roadmapStatus,
        isIncident,
        isFailure,
        completedInSprint,
        leadTimeDays,
        resolvedAt,
        jiraUrl,
      });
    }

    // Sort: incomplete issues first (alphabetical by key), then completed
    issues.sort((a, b) => {
      if (a.completedInSprint !== b.completedInSprint) {
        return a.completedInSprint ? 1 : -1;
      }
      return a.key.localeCompare(b.key);
    });

    // -----------------------------------------------------------------------
    // Summary computation
    // -----------------------------------------------------------------------
    const leadTimeSamples = issues
      .filter((i) => i.leadTimeDays !== null)
      .map((i) => i.leadTimeDays as number)
      .sort((a, b) => a - b);

    const medianLeadTimeDays =
      leadTimeSamples.length > 0
        ? // TODO: extract to shared utility (see proposal §7.5)
          median(leadTimeSamples)
        : null;

    const summary: SprintDetailSummary = {
      // committedCount: issues present at sprint start that have not been removed
      // (excludes issues removed from the sprint mid-flight)
      committedCount: issues.filter((i) => !i.addedMidSprint).length,
      addedMidSprintCount: issues.filter((i) => i.addedMidSprint).length,
      removedCount: removedKeys.size,
      completedInSprintCount: issues.filter((i) => i.completedInSprint).length,
      roadmapLinkedCount: issues.filter((i) => i.roadmapStatus !== 'none').length,
      incidentCount: issues.filter((i) => i.isIncident).length,
      failureCount: issues.filter((i) => i.isFailure).length,
      medianLeadTimeDays,
    };

    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      endDate: sprint.endDate ? sprint.endDate.toISOString() : null,
      boardConfig: boardConfigShape,
      summary,
      issues,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildEmptyResponse(
    sprint: JiraSprint,
    boardConfig: SprintDetailBoardConfig,
  ): SprintDetailResponse {
    return {
      sprintId: sprint.id,
      sprintName: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate ? sprint.startDate.toISOString() : null,
      endDate: sprint.endDate ? sprint.endDate.toISOString() : null,
      boardConfig,
      summary: {
        committedCount: 0,
        addedMidSprintCount: 0,
        removedCount: 0,
        completedInSprintCount: 0,
        roadmapLinkedCount: 0,
        incidentCount: 0,
        failureCount: 0,
        medianLeadTimeDays: null,
      },
      issues: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, not exported)
// ---------------------------------------------------------------------------

/**
 * Exact sprint-name match inside a comma-separated Sprint field value.
 * Prevents "Sprint 1" from matching "Sprint 10".
 */
function sprintValueContains(
  value: string | null,
  sprintName: string,
): boolean {
  if (!value) return false;
  return value.split(',').some((s) => s.trim() === sprintName);
}

/**
 * Returns true when a Sprint-field changelog `fromValue` indicates that
 * the issue was carried over from a **closed** sprint — i.e. it was moved
 * from a completed sprint into the current one via Jira's "Complete Sprint"
 * carry-over flow.
 *
 * Issues moved from future/groomed sprints (not in closedSprintNames) are
 * NOT carry-overs — they are mid-sprint scope additions.
 *
 * When Jira's "Complete Sprint" carry-over runs, the changelog entry has:
 *   fromValue: "<previous sprint name>"
 *   toValue:   "<current sprint name>"
 *
 * A backlog addition has fromValue = null or "".
 * See ADR 0039.
 */
function isCarryOverFromSprint(
  fromValue: string | null,
  currentSprintName: string,
  closedSprintNames: Set<string>,
): boolean {
  if (!fromValue) return false;
  return fromValue.split(',').some((s) => {
    const name = s.trim();
    return name !== '' && name !== currentSprintName && closedSprintNames.has(name);
  });
}

/**
 * Check if an issue was in the sprint at the given date by replaying
 * Sprint-field changelogs. Applies a 5-minute grace period to absorb
 * Jira's bulk-add delay.
 *
 * Returns true when sprintChangelogs.length === 0 (issue created directly
 * in the sprint with no changelog — see proposal §6c).
 */
function wasInSprintAtDate(
  sprintChangelogs: JiraChangelog[],
  sprintName: string,
  date: Date,
): boolean {
  const effectiveDate = new Date(date.getTime() + SPRINT_GRACE_PERIOD_MS);
  let inSprint = false;

  for (const cl of sprintChangelogs) {
    if (cl.changedAt > effectiveDate) break;

    if (sprintValueContains(cl.toValue, sprintName)) {
      inSprint = true;
    }
    if (
      sprintValueContains(cl.fromValue, sprintName) &&
      !sprintValueContains(cl.toValue, sprintName)
    ) {
      inSprint = false;
    }
  }

  // No changelog = issue was assigned at creation
  if (sprintChangelogs.length === 0) {
    return true;
  }

  return inSprint;
}

/**
 * Compute the median of a sorted array of numbers.
 * Returns null for an empty array.
 * TODO: extract to shared utility (see proposal §7.5)
 */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const index = 0.5 * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
}
