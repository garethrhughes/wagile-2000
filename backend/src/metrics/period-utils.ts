/**
 * Utilities for working with calendar quarters used by the trend endpoint.
 */

import { dateParts, midnightInTz } from './tz-utils.js';

export interface QuarterDates {
  label: string;    // e.g. "2026-Q1"
  startDate: Date;
  endDate: Date;
}

/**
 * Converts a quarter label (e.g. "2026-Q1") to start/end Date objects.
 * Returns the last 90 days as a fallback for invalid input.
 *
 * @param quarter - Quarter label in YYYY-QN format
 * @param tz      - IANA timezone (default 'UTC')
 */
export function quarterToDates(quarter: string, tz = 'UTC'): QuarterDates {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90);
    return { label: quarter, startDate, endDate };
  }

  const year = parseInt(match[1], 10);
  const q = parseInt(match[2], 10);
  const startMonth = (q - 1) * 3; // 0-indexed

  const startDate = midnightInTz(year, startMonth, 1, tz);
  // Last day of quarter: month startMonth+3 day 0 = last day of month startMonth+2
  const endDate = midnightInTz(year, startMonth + 3, 0, tz);
  endDate.setUTCHours(23, 59, 59, 999);

  return { label: quarter, startDate, endDate };
}

/**
 * Returns the N most recent quarters ending at or before today (inclusive of
 * the current in-progress quarter), newest first.
 *
 * E.g. called on 2026-04-11 (Q2 2026) with n=4 returns:
 *   ['2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3']
 *
 * @param n  - Number of quarters to return
 * @param tz - IANA timezone (default 'UTC')
 */
export function listRecentQuarters(n: number, tz = 'UTC'): QuarterDates[] {
  const now = new Date();
  const { year: currentYear, month: currentMonth } = dateParts(now, tz);
  const currentQ = Math.floor(currentMonth / 3) + 1; // 1-4

  const result: QuarterDates[] = [];
  let year = currentYear;
  let q = currentQ;

  for (let i = 0; i < n; i++) {
    const label = `${year}-Q${q}`;
    result.push(quarterToDates(label, tz));
    q -= 1;
    if (q < 1) {
      q = 4;
      year -= 1;
    }
  }

  return result; // newest first
}
