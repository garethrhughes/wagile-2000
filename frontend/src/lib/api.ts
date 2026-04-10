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
  commitment: number;
  added: number;
  removed: number;
  completed: number;
  scopeChangePct: number;
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

interface DoraMetricsBoard {
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

interface QuarterInfo {
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
