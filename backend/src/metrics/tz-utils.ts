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
 * Returns a Date representing midnight (00:00:00.000) in `tz` for the given
 * calendar date components. The returned Date is a UTC instant.
 */
export function midnightInTz(
  year: number,
  month: number, // 0-indexed
  day: number,
  tz: string,
): Date {
  // Form the target local ISO string (no zone suffix — will be treated as UTC approximation)
  const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;
  // Use UTC as the initial candidate
  const candidate = new Date(iso + 'Z');
  // Find what local calendar date the candidate corresponds to in `tz`
  const localParts = dateParts(candidate, tz);
  // Compute UTC equivalent of midnight local using the detected offset
  const localMidnight = new Date(
    Date.UTC(localParts.year, localParts.month, localParts.day),
  );
  const offsetMs = candidate.getTime() - localMidnight.getTime();
  // Subtract the offset to get the UTC instant that is midnight in `tz`
  return new Date(candidate.getTime() - offsetMs);
}
