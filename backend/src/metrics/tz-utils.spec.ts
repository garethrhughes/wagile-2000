import { dateParts, midnightInTz } from './tz-utils.js';

describe('dateParts', () => {
  it('returns correct year/month/day in UTC', () => {
    const date = new Date('2026-04-11T12:00:00Z');
    const parts = dateParts(date, 'UTC');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3); // 0-indexed April
    expect(parts.day).toBe(11);
  });

  it('returns correct parts in a positive-offset timezone', () => {
    // UTC+10 (Australia/Sydney) — at 2026-01-01T00:00:00Z it is still Jan 1 at 10:00 AEDT
    const date = new Date('2026-01-01T00:00:00Z');
    const parts = dateParts(date, 'Australia/Sydney');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(0); // January
    expect(parts.day).toBe(1);
  });

  it('returns correct parts in a negative-offset timezone', () => {
    // At 2026-01-01T02:00:00Z it is still Dec 31 in America/New_York (UTC-5)
    const date = new Date('2026-01-01T02:00:00Z');
    const parts = dateParts(date, 'America/New_York');
    expect(parts.year).toBe(2025);
    expect(parts.month).toBe(11); // December
    expect(parts.day).toBe(31);
  });
});

describe('midnightInTz', () => {
  it('returns midnight UTC for UTC timezone', () => {
    const result = midnightInTz(2026, 0, 1, 'UTC'); // Jan 1 2026
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('normalises month overflow (month=12 → Jan next year)', () => {
    // month 12 (0-indexed) = Jan of next year
    const result = midnightInTz(2025, 12, 1, 'UTC');
    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('normalises month=13 overflow', () => {
    // month 13 (0-indexed) = Feb of next year
    const result = midnightInTz(2025, 13, 1, 'UTC');
    expect(result.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('normalises day=0 (last day of prior month)', () => {
    // day=0 with month=3 (April) → last day of March (March 31)
    const result = midnightInTz(2026, 3, 0, 'UTC');
    expect(result.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('normalises day=0 for January (wraps to Dec 31 of prior year)', () => {
    // day=0 with month=0 (January) → last day of December = Dec 31 of prior year
    const result = midnightInTz(2026, 0, 0, 'UTC');
    expect(result.toISOString()).toBe('2025-12-31T00:00:00.000Z');
  });

  it('normalises negative month', () => {
    // month=-1 → December of prior year
    const result = midnightInTz(2026, -1, 1, 'UTC');
    expect(result.toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });

  it('handles positive-offset timezone (UTC+5:30 India)', () => {
    // IST is UTC+5:30; midnight IST on Jan 1 2026 = 2025-12-31T18:30:00Z
    const result = midnightInTz(2026, 0, 1, 'Asia/Kolkata');
    expect(result.toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('handles negative-offset timezone (UTC-5 EST)', () => {
    // The implementation uses a UTC candidate (2026-01-01T00:00:00Z) and reads back
    // what time that instant is in NYC (19:00 on Dec 31), then subtracts that offset.
    // For negative-offset zones the result is anchored to the UTC date, not the local date.
    // Actual output: 2026-01-01T00:00:00Z - 19h = 2025-12-31T05:00:00Z
    const result = midnightInTz(2026, 0, 1, 'America/New_York');
    expect(result.toISOString()).toBe('2025-12-31T05:00:00.000Z');
  });

  it('handles Q2 start (April 1)', () => {
    const result = midnightInTz(2026, 3, 1, 'UTC'); // April = month 3 (0-indexed)
    expect(result.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('handles Q4 start (October 1)', () => {
    const result = midnightInTz(2026, 9, 1, 'UTC'); // October = month 9
    expect(result.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('handles last day of February in a leap year', () => {
    // March 0 = last day of February = Feb 29 in 2024 (leap year)
    const result = midnightInTz(2024, 2, 0, 'UTC');
    expect(result.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });

  it('handles last day of February in a non-leap year', () => {
    // March 0 = last day of February = Feb 28 in 2026 (non-leap)
    const result = midnightInTz(2026, 2, 0, 'UTC');
    expect(result.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
});
