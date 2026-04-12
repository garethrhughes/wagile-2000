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
  // Normalise day=0 (JS "last day of prior month" convention) to a real calendar day
  if (day === 0) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    day = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;
  const candidate = new Date(iso + 'Z');

  // Find the time-of-day the UTC candidate shows in `tz`.
  // If offset is +11, candidate shows 11:00 — we need to subtract 11h to land at midnight local.
  // If offset is -5, candidate shows 19:00 previous day — we add 5h (subtract negative).
  const timeFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = timeFmt.formatToParts(candidate);
  const hStr = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mStr = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const sStr = parts.find((p) => p.type === 'second')?.value ?? '00';
  let hours = parseInt(hStr, 10);
  // hour12:false can return '24' for midnight in some runtimes — normalise
  if (hours === 24) hours = 0;
  const offsetMs =
    hours * 3_600_000 +
    parseInt(mStr, 10) * 60_000 +
    parseInt(sStr, 10) * 1_000;

  return new Date(candidate.getTime() - offsetMs);
}
