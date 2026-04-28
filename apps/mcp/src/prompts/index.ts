import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../client.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ─── Helper types ─────────────────────────────────────────────────────────────

interface Board {
  boardId: string;
  boardType: string;
  name?: string;
}

interface SyncEntry {
  boardId: string;
  syncedAt: string;
  status: string;
}

interface SprintSummary {
  id: string | number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

async function fetchJson<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const result = await apiGet<T>(path, params);
  return result.data;
}

async function fetchJsonSafe<T>(path: string, params?: Record<string, string | undefined>): Promise<T | null> {
  try {
    return await fetchJson<T>(path, params);
  } catch {
    return null;
  }
}

/** Returns `'pending'` if the response is 202, `null` if the request throws any error, or the response data otherwise. */
async function fetchJsonOrPending<T>(path: string, params?: Record<string, string | undefined>): Promise<T | 'pending' | null> {
  try {
    const result = await apiGet<T>(path, params);
    if (result.status === 202) return 'pending';
    return result.data;
  } catch {
    return null;
  }
}

function formatAge(syncedAt: string): string {
  const ageMs = Date.now() - new Date(syncedAt).getTime();
  const ageHours = ageMs / 1000 / 3600;
  if (ageHours < 1) return `${Math.round(ageHours * 60)}m ago`;
  return `${ageHours.toFixed(1)}h ago`;
}

function isStale(syncedAt: string): boolean {
  const ageMs = Date.now() - new Date(syncedAt).getTime();
  return ageMs > 2 * 60 * 60 * 1000; // > 2 hours
}

// ─── dora_health_report ───────────────────────────────────────────────────────

async function buildDoraHealthReport(quarter?: string): Promise<string> {
  const [boards, doraMetrics, doraTrend, syncStatus] = await Promise.all([
    fetchJson<Board[]>('/api/boards'),
    fetchJsonOrPending<unknown>('/api/metrics/dora/aggregate', quarter ? { quarter } : {}),
    fetchJsonSafe<unknown>('/api/metrics/dora/trend', { limit: '4' }),
    fetchJsonSafe<SyncEntry[]>('/api/sync/status'),
  ]);

  const periodLabel = quarter ?? 'current quarter';

  const lines: string[] = [
    `# DORA Health Report — ${periodLabel}`,
    '',
    '## Period',
    `Quarter: **${periodLabel}**`,
    '',
    '## Org-Level Summary',
  ];

  if (doraMetrics === null) {
    lines.push('_DORA snapshot data unavailable._');
  } else if (doraMetrics === 'pending') {
    lines.push('_DORA snapshot is still being computed. Please try again in a few moments._');
  } else {
    lines.push('```json', JSON.stringify(doraMetrics, null, 2), '```');
  }

  lines.push('', '## Board Breakdown');
  const boardList = Array.isArray(boards) ? boards : [];
  if (boardList.length === 0) {
    lines.push('_No boards configured._');
  } else {
    lines.push('| Board | Type |', '|---|---|');
    for (const b of boardList) {
      lines.push(`| ${b.boardId} | ${b.boardType} |`);
    }
  }

  lines.push('', '## Trend (Last 4 Quarters)');
  if (doraTrend === null) {
    lines.push('_Trend data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(doraTrend, null, 2), '```');
  }

  lines.push('', '## Data Freshness');
  const syncEntries = Array.isArray(syncStatus) ? syncStatus : [];
  if (syncEntries.length === 0) {
    lines.push('_Sync status unavailable._');
  } else {
    lines.push('| Board | Last Sync | Status |', '|---|---|---|');
    for (const entry of syncEntries) {
      const staleFlag = isStale(entry.syncedAt) ? ' ⚠️ STALE' : '';
      lines.push(`| ${entry.boardId} | ${formatAge(entry.syncedAt)}${staleFlag} | ${entry.status} |`);
    }
  }

  return lines.join('\n');
}

// ─── sprint_retrospective ─────────────────────────────────────────────────────

async function buildSprintRetrospective(boardId: string, sprintId: string): Promise<string> {
  const [sprintReport, sprintDetail, planningAccuracy] = await Promise.all([
    fetchJsonSafe<unknown>(`/api/sprint-report/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}`),
    fetchJsonSafe<unknown>(`/api/sprints/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}/detail`),
    fetchJsonSafe<unknown>('/api/planning/accuracy', { boardId, sprintId }),
  ]);

  const lines: string[] = [
    `# Sprint Retrospective — ${boardId} / Sprint ${sprintId}`,
    '',
    '## Sprint Summary',
  ];

  if (sprintReport === null) {
    lines.push('_Sprint report unavailable._');
  } else {
    lines.push('```json', JSON.stringify(sprintReport, null, 2), '```');
  }

  lines.push('', '## Planning Accuracy');
  if (planningAccuracy === null) {
    lines.push('_Planning accuracy data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(planningAccuracy, null, 2), '```');
  }

  lines.push('', '## Ticket Breakdown');
  if (sprintDetail === null) {
    lines.push('_Ticket detail unavailable._');
  } else {
    lines.push('```json', JSON.stringify(sprintDetail, null, 2), '```');
  }

  return lines.join('\n');
}

// ─── release_readiness ────────────────────────────────────────────────────────

async function buildReleaseReadiness(boardId: string, sprintId?: string): Promise<string> {
  // Resolve sprintId if not provided
  let resolvedSprintId = sprintId;
  if (!resolvedSprintId) {
    const sprints = await fetchJsonSafe<SprintSummary[]>('/api/planning/sprints', { boardId });
    if (Array.isArray(sprints) && sprints.length > 0) {
      const closed = sprints.filter((s) => s.state === 'closed');
      if (closed.length > 0) {
        const last = closed[closed.length - 1];
        resolvedSprintId = last ? String(last.id) : undefined;
      }
    }
  }

  const params: Record<string, string | undefined> = { boardId };
  if (resolvedSprintId) params['sprintId'] = resolvedSprintId;

  const [sprintReport, planningAccuracy, hygieneGaps, unplannedDone, doraMetrics] = await Promise.all([
    resolvedSprintId
      ? fetchJsonSafe<unknown>(`/api/sprint-report/${encodeURIComponent(boardId)}/${encodeURIComponent(resolvedSprintId)}`)
      : Promise.resolve(null),
    fetchJsonSafe<unknown>('/api/planning/accuracy', params),
    fetchJsonSafe<unknown>('/api/gaps'),
    fetchJsonSafe<unknown>('/api/gaps/unplanned-done', params),
    fetchJsonSafe<unknown>('/api/metrics/dora/aggregate', { boardId }),
  ]);

  const sprintLabel = resolvedSprintId ? `Sprint ${resolvedSprintId}` : 'latest sprint';

  const lines: string[] = [
    `# Release Readiness — ${boardId} / ${sprintLabel}`,
    '',
    '## Readiness Verdict',
    '_See sections below for full assessment._',
    '',
    '## Sprint Completion',
  ];

  if (planningAccuracy === null) {
    lines.push('_Planning accuracy data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(planningAccuracy, null, 2), '```');
  }

  lines.push('', '## Sprint Report & Recommendations');
  if (sprintReport === null) {
    lines.push('_Sprint report unavailable._');
  } else {
    lines.push('```json', JSON.stringify(sprintReport, null, 2), '```');
  }

  lines.push('', '## Quality Signals (DORA)');
  if (doraMetrics === null) {
    lines.push('_DORA metrics unavailable._');
  } else {
    lines.push('```json', JSON.stringify(doraMetrics, null, 2), '```');
  }

  lines.push('', '## Hygiene Gaps');
  if (hygieneGaps === null) {
    lines.push('_Hygiene gap data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(hygieneGaps, null, 2), '```');
  }

  lines.push('', '## Unplanned Work');
  if (unplannedDone === null) {
    lines.push('_Unplanned done data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(unplannedDone, null, 2), '```');
  }

  return lines.join('\n');
}

// ─── quarterly_planning_review ────────────────────────────────────────────────

async function buildQuarterlyPlanningReview(quarter?: string): Promise<string> {
  const [boards, quarters, doraMetrics, roadmapAccuracy, unplannedDone] = await Promise.all([
    fetchJson<Board[]>('/api/boards'),
    fetchJsonSafe<string[]>('/api/planning/quarters'),
    fetchJsonSafe<unknown>('/api/metrics/dora/aggregate', quarter ? { quarter } : {}),
    fetchJsonSafe<unknown>('/api/roadmap/accuracy', quarter ? { quarter } : {}),
    fetchJsonSafe<unknown>('/api/gaps/unplanned-done', quarter ? { quarter } : {}),
  ]);

  const boardList = Array.isArray(boards) ? boards : [];
  const scrumBoards = boardList.filter((b) => b.boardType !== 'kanban');
  const kanbanBoards = boardList.filter((b) => b.boardType === 'kanban');

  const resolvedQuarter = quarter ?? (Array.isArray(quarters) && quarters.length > 0 ? quarters[quarters.length - 1] : 'latest quarter');

  // Fetch planning accuracy per scrum board
  const planningResults = await Promise.all(
    scrumBoards.map(async (b) => {
      const data = await fetchJsonSafe<unknown>(
        '/api/planning/accuracy',
        { boardId: b.boardId, ...(quarter ? { quarter } : {}) },
      );
      return { boardId: b.boardId, data };
    }),
  );

  const lines: string[] = [
    `# Quarterly Planning Review — ${resolvedQuarter}`,
    '',
    '## Quarter Summary',
    `Period: **${resolvedQuarter}**`,
    `Scrum boards: ${scrumBoards.map((b) => b.boardId).join(', ') || 'none'}`,
    kanbanBoards.length > 0
      ? `Kanban boards (excluded from planning accuracy): ${kanbanBoards.map((b) => b.boardId).join(', ')}`
      : '',
    '',
    '## Planning Accuracy by Board',
  ];

  for (const { boardId, data } of planningResults) {
    lines.push(`\n### ${boardId}`);
    if (data === null) {
      lines.push('_Data unavailable._');
    } else {
      lines.push('```json', JSON.stringify(data, null, 2), '```');
    }
  }

  lines.push('', '## Org Delivery Health (DORA)');
  if (doraMetrics === null) {
    lines.push('_DORA metrics unavailable._');
  } else {
    lines.push('```json', JSON.stringify(doraMetrics, null, 2), '```');
  }

  lines.push('', '## Roadmap Coverage');
  if (roadmapAccuracy === null) {
    lines.push('_Roadmap accuracy data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(roadmapAccuracy, null, 2), '```');
  }

  lines.push('', '## Unplanned Work (Cross-Board)');
  if (unplannedDone === null) {
    lines.push('_Unplanned done data unavailable._');
  } else {
    lines.push('```json', JSON.stringify(unplannedDone, null, 2), '```');
  }

  lines.push('', '## Observations');
  lines.push('_Review the planning accuracy tables above for boards with >20% scope change or low completion rates._');

  return lines.join('\n');
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'dora_health_report',
    'Generate a full DORA health report across all boards for a given quarter, including org-level metric bands, per-board breakdowns, and a trend comparison against the previous quarter.',
    {
      quarter: z.string().optional().describe('Target quarter in YYYY-QN format. Defaults to the current quarter.'),
    },
    async ({ quarter }) => {
      const report = await buildDoraHealthReport(quarter);
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: report },
          },
        ],
      };
    },
  );

  server.prompt(
    'sprint_retrospective',
    'Produce a sprint retrospective summary for a given board and sprint, covering planning accuracy, ticket-level classification, scope changes, and recommendations.',
    {
      boardId: z.string().describe('Board identifier, e.g. "ACC"'),
      sprintId: z.string().describe('Sprint ID'),
    },
    async ({ boardId, sprintId }) => {
      const report = await buildSprintRetrospective(boardId, sprintId);
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: report },
          },
        ],
      };
    },
  );

  server.prompt(
    'release_readiness',
    'Assess whether a Scrum board is ready for a release at the end of the current or a specified sprint. Combines deployment health, hygiene gaps, unplanned work, and sprint completion rate.',
    {
      boardId: z.string().describe('Board identifier'),
      sprintId: z.string().optional().describe('Sprint ID. Defaults to the most recent completed sprint for the board.'),
    },
    async ({ boardId, sprintId }) => {
      const report = await buildReleaseReadiness(boardId, sprintId);
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: report },
          },
        ],
      };
    },
  );

  server.prompt(
    'quarterly_planning_review',
    'Review planning accuracy and delivery performance across all Scrum boards for a given quarter, suitable for an engineering leadership retrospective.',
    {
      quarter: z.string().optional().describe('Target quarter in YYYY-QN format. Defaults to the most recently completed quarter.'),
    },
    async ({ quarter }) => {
      const report = await buildQuarterlyPlanningReview(quarter);
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: report },
          },
        ],
      };
    },
  );
}

// Export build functions for testing
export {
  buildDoraHealthReport,
  buildSprintRetrospective,
  buildReleaseReadiness,
  buildQuarterlyPlanningReview,
};

// Re-export McpError for test use
export { McpError, ErrorCode };
