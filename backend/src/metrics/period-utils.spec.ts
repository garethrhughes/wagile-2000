import { quarterToDates, listRecentQuarters } from './period-utils.js';

describe('quarterToDates', () => {
  it('returns Q1 dates for 2026-Q1 in UTC', () => {
    const { label, startDate, endDate } = quarterToDates('2026-Q1', 'UTC');
    expect(label).toBe('2026-Q1');
    expect(startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // End date should be 23:59:59.999 on March 31
    expect(endDate.toISOString()).toBe('2026-03-31T23:59:59.999Z');
  });

  it('returns Q2 dates for 2026-Q2 in UTC', () => {
    const { startDate, endDate } = quarterToDates('2026-Q2', 'UTC');
    expect(startDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('returns Q3 dates for 2025-Q3 in UTC', () => {
    const { startDate, endDate } = quarterToDates('2025-Q3', 'UTC');
    expect(startDate.toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2025-09-30T23:59:59.999Z');
  });

  it('returns Q4 dates for 2025-Q4 in UTC (tests Dec 31 end)', () => {
    const { startDate, endDate } = quarterToDates('2025-Q4', 'UTC');
    expect(startDate.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(endDate.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });

  it('handles Q4 → Q1 year boundary: start of next quarter is Jan 1 next year', () => {
    const { endDate } = quarterToDates('2025-Q4', 'UTC');
    const nextStart = new Date(endDate.getTime() + 1);
    expect(nextStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns fallback (last 90 days) for invalid quarter label', () => {
    const before = new Date();
    const { label, startDate, endDate } = quarterToDates('invalid');
    const after = new Date();
    expect(label).toBe('invalid');
    // endDate should be approximately now
    expect(endDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(endDate.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
    // startDate should be approximately 90 days before endDate
    const diffDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(diffDays)).toBe(90);
  });

  it('handles positive UTC offset timezone correctly for Q1', () => {
    // Asia/Kolkata (UTC+5:30) — midnight IST Jan 1 = 18:30 UTC Dec 31 prior
    const { startDate } = quarterToDates('2026-Q1', 'Asia/Kolkata');
    expect(startDate.toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('handles negative UTC offset timezone correctly for Q1', () => {
    // America/New_York (UTC-5 in winter / EST): midnight on Jan 1 2026 in New York
    // is 05:00 UTC (UTC-5), not 2025-12-31T05:00:00Z.
    // The old broken midnightInTz algorithm returned 2025-12-31T05:00:00Z due to
    // a sign error.  Fix A-1 (Proposal 0030) corrects this.
    const { startDate } = quarterToDates('2026-Q1', 'America/New_York');
    expect(startDate.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });
});

describe('listRecentQuarters', () => {
  it('returns n quarters newest first', () => {
    const quarters = listRecentQuarters(4, 'UTC');
    expect(quarters).toHaveLength(4);
    // Each quarter's endDate should be >= the next quarter's endDate
    for (let i = 0; i < quarters.length - 1; i++) {
      expect(quarters[i].startDate.getTime()).toBeGreaterThan(
        quarters[i + 1].startDate.getTime(),
      );
    }
  });

  it('returns labels in YYYY-QN format', () => {
    const quarters = listRecentQuarters(4, 'UTC');
    for (const q of quarters) {
      expect(q.label).toMatch(/^\d{4}-Q[1-4]$/);
    }
  });

  it('first quarter includes today', () => {
    const now = new Date();
    const [first] = listRecentQuarters(1, 'UTC');
    expect(first.startDate.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(first.endDate.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('returns 1 quarter when n=1', () => {
    const quarters = listRecentQuarters(1, 'UTC');
    expect(quarters).toHaveLength(1);
  });

  it('consecutive quarters are adjacent (no gaps)', () => {
    const quarters = listRecentQuarters(4, 'UTC');
    for (let i = 0; i < quarters.length - 1; i++) {
      // The end of quarters[i+1] + 1ms should equal the start of quarters[i]
      const gapMs = quarters[i].startDate.getTime() - quarters[i + 1].endDate.getTime();
      expect(gapMs).toBe(1); // exactly 1ms gap (23:59:59.999 → 00:00:00.000)
    }
  });
});
