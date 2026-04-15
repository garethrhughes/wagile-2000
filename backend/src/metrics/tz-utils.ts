/**
 * Timezone utility helpers for quarter/week boundary calculations.
 * Uses Intl.DateTimeFormat — no external dependencies.
 */

/**
 * Returns { year, month (0-indexed), day } for a Date in the given IANA timezone.
 */
export function dateParts(
  date: Date,
  tz: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA produces "YYYY-MM-DD"
  const [year, month, day] = formatter.format(date).split('-').map(Number);
  return { year, month: month - 1, day }; // month is 0-indexed to match Date API
}

/**
 * Returns the UTC instant corresponding to 00:00:00.000 on the given
 * calendar date in the specified IANA timezone.
 *
 * Uses a binary-search / offset-probe approach that is correct for both
 * positive and negative UTC offsets, including DST transitions.
 *
 * This was previously only in WorkingTimeService as a private helper.
 * Promoted here (Proposal 0030 Fix A-1) so all callers can use the correct
 * implementation without requiring injection of WorkingTimeService.
 *
 * @param year  — Full year, e.g. 2026
 * @param month — 0-indexed month (0 = January, 11 = December)
 * @param day   — 1-indexed day of month
 * @param tz    — IANA timezone name, e.g. 'America/New_York'
 */
export function startOfDayInTz(
  year: number,
  month: number, // 0-indexed
  day: number,
  tz: string,
): Date {
  // Anchor to UTC midnight of the target CALENDAR date.
  // Binary-search bounds: ±14h/+13h window guarantees we bracket every IANA offset.
  const anchorUtcMs = Date.UTC(year, month, day, 0, 0, 0);

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // Build target string in YYYY-MM-DD format (1-indexed month to match en-CA output)
  const targetStr = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // Binary search bounds: anchored to UTC midnight with ±14h/+13h window.
  let lo = anchorUtcMs - 14 * 3_600_000; // guaranteed before midnight local
  let hi = anchorUtcMs + 13 * 3_600_000; // guaranteed after midnight local

  // Narrow to the first UTC millisecond whose local date equals targetStr.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const localDate = formatter.format(new Date(mid));
    if (localDate >= targetStr) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return new Date(hi);
}

/**
 * Returns a Date representing midnight (00:00:00.000) in `tz` for the given
 * calendar date components. The returned Date is a UTC instant.
 *
 * This is an alias for `startOfDayInTz` with month/overflow normalisation
 * support. Callers that use the day=0 or month overflow convention (e.g.
 * quarter boundary arithmetic) should call this function.
 *
 * @deprecated Use `startOfDayInTz` directly for new call sites. This alias
 *   is retained for backward compatibility and will be removed in a future
 *   cleanup pass (see Proposal 0030 Fix A-1, Open Question §3).
 */
export function midnightInTz(
  year: number,
  month: number, // 0-indexed
  day: number,
  tz: string,
): Date {
  // Normalise month overflow (e.g. month=12 → Jan of next year)
  while (month > 11) { month -= 12; year += 1; }
  while (month < 0)  { month += 12; year -= 1; }

  // Normalise day=0 (JS "last day of prior month" convention) to a real calendar day
  if (day === 0) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  return startOfDayInTz(year, month, day, tz);
}
