// ---------------------------------------------------------------------------
// DORA band classification – pure functions (mirrors backend dora-bands.ts)
// ---------------------------------------------------------------------------

export type DoraBand = 'elite' | 'high' | 'medium' | 'low';

/**
 * Classify deployment frequency by deploys-per-day.
 *
 * Elite  : ≥ 1 deploy/day  (on-demand)
 * High   : ≥ 1/7           (weekly–monthly)
 * Medium : ≥ 1/30          (monthly–every-6-months)
 * Low    : < 1/30
 */
export function classifyDeploymentFrequency(deploymentsPerDay: number): DoraBand {
  if (deploymentsPerDay >= 1) return 'elite';
  if (deploymentsPerDay >= 1 / 7) return 'high';
  if (deploymentsPerDay >= 1 / 30) return 'medium';
  return 'low';
}

/**
 * Classify lead time for changes by median days.
 *
 * Elite  : < 1 day
 * High   : < 7 days
 * Medium : < 30 days
 * Low    : ≥ 30 days
 */
export function classifyLeadTime(medianDays: number): DoraBand {
  if (medianDays <= 1) return 'elite';
  if (medianDays <= 7) return 'high';
  if (medianDays <= 30) return 'medium';
  return 'low';
}

/**
 * Classify change failure rate by percentage.
 *
 * Elite  : < 5 %
 * High   : < 10 %
 * Medium : < 15 %
 * Low    : ≥ 15 %
 */
export function classifyChangeFailureRate(percentage: number): DoraBand {
  if (percentage <= 5) return 'elite';
  if (percentage <= 10) return 'high';
  if (percentage <= 15) return 'medium';
  return 'low';
}

/**
 * Classify MTTR by median hours.
 *
 * Elite  : < 1 hour
 * High   : < 24 hours
 * Medium : < 168 hours (1 week)
 * Low    : ≥ 168 hours
 */
export function classifyMTTR(medianHours: number): DoraBand {
  if (medianHours < 1) return 'elite';
  if (medianHours < 24) return 'high';
  if (medianHours < 168) return 'medium';
  return 'low';
}

/**
 * Tailwind class string for a given DORA band.
 */
export function bandColor(band: DoraBand): string {
  switch (band) {
    case 'elite':
      return 'text-green-600 bg-green-50 border-green-200';
    case 'high':
      return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'medium':
      return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'low':
      return 'text-red-600 bg-red-50 border-red-200';
  }
}
