/**
 * Utilities for working with calendar quarters used by the trend endpoint.
 */

export interface QuarterDates {
  label: string;    // e.g. "2026-Q1"
  startDate: Date;
  endDate: Date;
}

/**
 * Converts a quarter label (e.g. "2026-Q1") to start/end Date objects.
 * Returns the last 90 days as a fallback for invalid input.
 */
export function quarterToDates(quarter: string): QuarterDates {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90);
    return { label: quarter, startDate, endDate };
  }

  const year = parseInt(match[1], 10);
  const q = parseInt(match[2], 10);
  const startMonth = (q - 1) * 3;

  return {
    label: quarter,
    startDate: new Date(year, startMonth, 1),
    endDate: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
  };
}

/**
 * Returns the N most recent quarters ending at or before today (inclusive of
 * the current in-progress quarter), newest first.
 *
 * E.g. called on 2026-04-11 (Q2 2026) with n=4 returns:
 *   ['2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3']
 */
export function listRecentQuarters(n: number): QuarterDates[] {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed
  const currentQ = Math.floor(currentMonth / 3) + 1; // 1-4

  const result: QuarterDates[] = [];
  let year = currentYear;
  let q = currentQ;

  for (let i = 0; i < n; i++) {
    const label = `${year}-Q${q}`;
    result.push(quarterToDates(label));
    q -= 1;
    if (q < 1) {
      q = 4;
      year -= 1;
    }
  }

  return result; // newest first
}
