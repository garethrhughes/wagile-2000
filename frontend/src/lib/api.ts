// ---------------------------------------------------------------------------
// API client – typed wrappers for every backend endpoint
// ---------------------------------------------------------------------------

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ---- Shared types --------------------------------------------------------

export type DoraBand = 'elite' | 'high' | 'medium' | 'low';

export interface MetricResult {
  value: number;
  unit: string;
  band: DoraBand;
  trend?: number[];
}

export interface BoardConfig {
  boardId: string;
  boardType: string;
  doneStatusNames: string[];
  failureIssueTypes: string[];
  failureLinkTypes: string[];
  failureLabels: string[];
  incidentIssueTypes: string[];
  recoveryStatusNames: string[];
  incidentLabels: string[];
}

export interface SprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  commitment: number;
  added: number;
  removed: number;
  completed: number;
  scopeChangePercent: number;
  completionRate: number;
}

export interface MetricsQueryParams {
  boardId: string;
  period?: 'sprint' | 'quarter';
  sprintId?: string;
  quarter?: string;
}

export interface PlanningQueryParams {
  boardId: string;
  sprintId?: string;
  quarter?: string;
}

export interface SprintInfo {
  id: string;
  name: string;
  state: string;
}

interface SyncStatusItem {
  boardId: string;
  lastSync: string | null;
  status: string;
}

type SyncStatusResponse = SyncStatusItem[];

export interface DoraMetricsBoard {
  boardId: string;
  period: { start: string; end: string };
  deploymentFrequency: {
    boardId: string;
    totalDeployments: number;
    deploymentsPerDay: number;
    band: DoraBand;
    periodDays: number;
  };
  leadTime: {
    boardId: string;
    medianDays: number;
    p95Days: number;
    band: DoraBand;
    sampleSize: number;
  };
  changeFailureRate: {
    boardId: string;
    totalDeployments: number;
    failureCount: number;
    changeFailureRate: number;
    band: DoraBand;
    usingDefaultConfig: boolean;
  };
  mttr: {
    boardId: string;
    medianHours: number;
    band: DoraBand;
    incidentCount: number;
  };
}

type DoraMetricsResponse = DoraMetricsBoard[];

type PlanningAccuracyResponse = SprintAccuracy[];

export type SprintsResponse = SprintInfo[];

export interface QuarterInfo {
  quarter: string;
  startDate: string;
  endDate: string;
}

export type QuartersResponse = QuarterInfo[];

type BoardsResponse = BoardConfig[];

// ---- Error class ---------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---- Core fetch helper ---------------------------------------------------

function getApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('dashboard_api_key');
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(options?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    // On 401, clear the stored key so the AuthGate shows the login form
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('dashboard_api_key');
      window.location.reload();
    }
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ---- Query-string helper -------------------------------------------------

function toQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '',
  );
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries).toString();
}

// ---- Typed endpoint wrappers ---------------------------------------------

export function triggerSync(): Promise<{ message: string }> {
  return apiFetch('/api/sync', { method: 'POST' });
}

export function getSyncStatus(): Promise<SyncStatusResponse> {
  return apiFetch('/api/sync/status');
}

export function getBoards(): Promise<BoardsResponse> {
  return apiFetch('/api/boards');
}

export function getBoardConfig(boardId: string): Promise<BoardConfig> {
  return apiFetch(`/api/boards/${encodeURIComponent(boardId)}/config`);
}

export function updateBoardConfig(
  boardId: string,
  config: Partial<BoardConfig>,
): Promise<BoardConfig> {
  return apiFetch(`/api/boards/${encodeURIComponent(boardId)}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export function getDoraMetrics(
  params: MetricsQueryParams,
): Promise<DoraMetricsResponse> {
  return apiFetch(
    `/api/metrics/dora${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getDeploymentFrequency(
  params: MetricsQueryParams,
): Promise<unknown[]> {
  return apiFetch(
    `/api/metrics/deployment-frequency${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getLeadTime(
  params: MetricsQueryParams,
): Promise<unknown[]> {
  return apiFetch(
    `/api/metrics/lead-time${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getCfr(
  params: MetricsQueryParams,
): Promise<unknown[]> {
  return apiFetch(
    `/api/metrics/cfr${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getMttr(
  params: MetricsQueryParams,
): Promise<unknown[]> {
  return apiFetch(
    `/api/metrics/mttr${toQueryString({
      boardId: params.boardId,
      period: params.period,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getPlanningAccuracy(
  params: PlanningQueryParams,
): Promise<PlanningAccuracyResponse> {
  return apiFetch(
    `/api/planning/accuracy${toQueryString({
      boardId: params.boardId,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getSprints(boardId: string): Promise<SprintsResponse> {
  return apiFetch(
    `/api/planning/sprints${toQueryString({ boardId })}`,
  );
}

export function getQuarters(): Promise<QuartersResponse> {
  return apiFetch('/api/planning/quarters');
}

// ---- Roadmap Accuracy types and endpoints --------------------------------

export interface RoadmapConfig {
  id: number;
  jpdKey: string;
  description: string | null;
  createdAt: string;
}

export interface RoadmapSprintAccuracy {
  sprintId: string;
  sprintName: string;
  state: string;
  startDate: string | null;
  totalIssues: number;
  coveredIssues: number;
  uncoveredIssues: number;
  roadmapCoverage: number;
  linkedCompletedIssues: number;
  roadmapDeliveryRate: number;
}

export function getRoadmapAccuracy(params: {
  boardId: string;
  sprintId?: string;
  quarter?: string;
}): Promise<RoadmapSprintAccuracy[]> {
  return apiFetch(
    `/api/roadmap/accuracy${toQueryString({
      boardId: params.boardId,
      sprintId: params.sprintId,
      quarter: params.quarter,
    })}`,
  );
}

export function getRoadmapConfigs(): Promise<RoadmapConfig[]> {
  return apiFetch('/api/roadmap/configs');
}

export function createRoadmapConfig(body: {
  jpdKey: string;
  description?: string;
}): Promise<RoadmapConfig> {
  return apiFetch('/api/roadmap/configs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteRoadmapConfig(id: number): Promise<void> {
  return apiFetch(`/api/roadmap/configs/${id}`, { method: 'DELETE' });
}

export function triggerRoadmapSync(): Promise<{ message: string }> {
  return apiFetch('/api/roadmap/sync', { method: 'POST' });
}

// ---- Sprint Detail types and endpoint ------------------------------------

/** Board configuration rules applied to derive per-issue annotations */
export interface SprintDetailBoardConfig {
  doneStatusNames: string[]
  failureIssueTypes: string[]
  failureLabels: string[]
  incidentIssueTypes: string[]
  incidentLabels: string[]
}

export interface SprintDetailIssue {
  key: string
  summary: string
  currentStatus: string
  issueType: string
  addedMidSprint: boolean
  roadmapLinked: boolean
  isIncident: boolean
  isFailure: boolean
  completedInSprint: boolean
  leadTimeDays: number | null
  resolvedAt: string | null
  jiraUrl: string
}

export interface SprintDetailSummary {
  committedCount: number
  addedMidSprintCount: number
  removedCount: number
  completedInSprintCount: number
  roadmapLinkedCount: number
  incidentCount: number
  failureCount: number
  medianLeadTimeDays: number | null
}

export interface SprintDetailResponse {
  sprintId: string
  sprintName: string
  state: string
  startDate: string | null
  endDate: string | null
  boardConfig: SprintDetailBoardConfig
  summary: SprintDetailSummary
  issues: SprintDetailIssue[]
}

export function getSprintDetail(
  boardId: string,
  sprintId: string,
): Promise<SprintDetailResponse> {
  return apiFetch(
    `/api/sprints/${encodeURIComponent(boardId)}/${encodeURIComponent(sprintId)}/detail`,
  )
}

// ---- Quarter Detail types and endpoint -----------------------------------

export interface QuarterDetailIssue {
  key: string
  summary: string
  issueType: string
  priority: string | null
  status: string
  points: number | null
  epicKey: string | null
  assignedQuarter: string
  completedInQuarter: boolean
  addedMidQuarter: boolean
  linkedToRoadmap: boolean
  isIncident: boolean
  isFailure: boolean
  labels: string[]
  boardEntryDate: string
  jiraUrl: string
}

export interface QuarterDetailSummary {
  totalIssues: number
  completedIssues: number
  addedMidQuarter: number
  linkedToRoadmap: number
  totalPoints: number
  completedPoints: number
}

export interface QuarterDetailBoardConfig {
  boardType: string
  doneStatusNames: string[]
}

export interface QuarterDetailResponse {
  boardId: string
  quarter: string
  quarterStart: string
  quarterEnd: string
  summary: QuarterDetailSummary
  issues: QuarterDetailIssue[]
  boardConfig: QuarterDetailBoardConfig
}

export function getQuarterDetail(
  boardId: string,
  quarter: string,
): Promise<QuarterDetailResponse> {
  return apiFetch<QuarterDetailResponse>(
    `/api/quarters/${encodeURIComponent(boardId)}/${encodeURIComponent(quarter)}/detail`,
  )
}
