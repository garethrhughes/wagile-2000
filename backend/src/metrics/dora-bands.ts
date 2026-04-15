export type DoraBand = 'elite' | 'high' | 'medium' | 'low';

export function classifyDeploymentFrequency(
  deploymentsPerDay: number,
): DoraBand {
  if (deploymentsPerDay >= 1) return 'elite'; // at least daily (on-demand)
  if (deploymentsPerDay >= 1 / 7) return 'high'; // at least weekly
  if (deploymentsPerDay >= 1 / 30) return 'medium'; // at least monthly
  return 'low';
}

/**
 * Classifies a cycle-time median (first active-work status → done) using the
 * DORA Lead Time for Changes band thresholds from the 2023 State of DevOps
 * report.
 *
 * NOTE: This application measures cycle time, not the full DORA lead time
 * (commit → deploy).  The thresholds are re-applied to the cycle-time proxy
 * because it is the closest available signal without commit-level integration.
 * See Proposal 0030 Fix D-2 and the DORA Metrics Reference (0021) for full
 * rationale.
 */
export function classifyLeadTime(medianDays: number): DoraBand {
  if (medianDays < 1) return 'elite';
  if (medianDays <= 7) return 'high';
  if (medianDays <= 30) return 'medium';
  return 'low';
}

export function classifyChangeFailureRate(percentage: number): DoraBand {
  if (percentage <= 5) return 'elite';
  if (percentage <= 10) return 'high';
  if (percentage <= 15) return 'medium';
  return 'low';
}

export function classifyMTTR(medianHours: number): DoraBand {
  if (medianHours < 1) return 'elite';
  if (medianHours < 24) return 'high';
  if (medianHours < 168) return 'medium'; // 7 days
  return 'low';
}
