/**
 * Shared statistical utilities extracted from lead-time.service.ts and
 * mttr.service.ts to eliminate duplication and expose them to MetricsService.
 */

/**
 * Computes the p-th percentile of a *pre-sorted* array of numbers.
 * Uses linear interpolation between adjacent ranks.
 * Returns 0 for an empty array.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Rounds a number to at most 2 decimal places.
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
