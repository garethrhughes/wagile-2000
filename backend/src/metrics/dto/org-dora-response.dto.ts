import type { DoraBand } from '../dora-bands.js';
import type { DoraMetricsResult } from '../metrics.service.js';

/**
 * Per-board breakdown entry returned by the aggregate endpoint.
 * Extends DoraMetricsResult with the board's type so the frontend
 * can render the Scrum/Kanban badge without a second round-trip.
 * (Resolves Open Question 5 / RC-4)
 */
export interface DoraMetricsBoardBreakdown extends DoraMetricsResult {
  boardType: 'scrum' | 'kanban';
}

export interface OrgDeploymentFrequencyResult {
  totalDeployments: number;
  deploymentsPerDay: number;
  band: DoraBand;
  periodDays: number;
  contributingBoards: number;
}

export interface OrgLeadTimeResult {
  medianDays: number;
  p95Days: number;
  band: DoraBand;
  sampleSize: number;
  contributingBoards: number;
  /** Issues completed in-window but excluded because no in-progress transition was found */
  anomalyCount: number;
}

export interface OrgCfrResult {
  totalDeployments: number;
  failureCount: number;
  changeFailureRate: number;
  band: DoraBand;
  contributingBoards: number;
  anyBoardUsingDefaultConfig: boolean;
  boardsUsingDefaultConfig: string[];
}

export interface OrgMttrResult {
  medianHours: number;
  band: DoraBand;
  incidentCount: number;
  contributingBoards: number;
}

export interface OrgDoraResult {
  period: { label: string; start: string; end: string };
  orgDeploymentFrequency: OrgDeploymentFrequencyResult;
  orgLeadTime: OrgLeadTimeResult;
  orgChangeFailureRate: OrgCfrResult;
  orgMttr: OrgMttrResult;
  boardBreakdowns: DoraMetricsBoardBreakdown[];
  anyBoardUsingDefaultConfig: boolean;
  boardsUsingDefaultConfig: string[];
}

export type TrendResponse = OrgDoraResult[];
