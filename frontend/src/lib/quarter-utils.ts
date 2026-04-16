function parseQuarterParts(
  date: Date,
  tz: string,
): { year: number; month: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
    })
    const parts = formatter.format(date).split('-').map(Number)
    const year = parts[0]
    const month = parts[1] ?? 1
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      throw new RangeError('Invalid parsed values')
    }
    return { year, month }
  } catch {
    // Fall back to UTC on invalid timezone or parse failure
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
    })
    const parts = formatter.format(date).split('-').map(Number)
    const year = parts[0] ?? new Date().getUTCFullYear()
    const month = parts[1] ?? 1
    return { year, month }
  }
}

export function getQuarterKey(isoDate: string | null, tz: string): string | null {
  if (!isoDate) return null
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return null
  const { year, month } = parseQuarterParts(d, tz)
  const q = Math.floor((month - 1) / 3) + 1
  return `${year}-Q${q}`
}

export function getCurrentQuarterKey(tz: string): string {
  const now = new Date()
  const { year, month } = parseQuarterParts(now, tz)
  const q = Math.floor((month - 1) / 3) + 1
  return `${year}-Q${q}`
}
