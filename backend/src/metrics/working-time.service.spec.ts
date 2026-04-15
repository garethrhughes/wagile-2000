/**
 * Unit tests for WorkingTimeService — pure calculation methods.
 *
 * The service is instantiated directly (no NestJS module) with mocked
 * dependencies.  All assertions target workingHoursBetween() and
 * workingDaysBetween() directly.
 *
 * Algorithm summary:
 *   - workingHoursBetween accumulates the wall-clock hours that fall on
 *     working calendar days (workDays, minus holidays) in the configured tz.
 *   - workingDaysBetween = workingHoursBetween / hoursPerDay.
 *   - A full calendar day contributes 24h; a partial day contributes the
 *     portion that overlaps with [start, end].
 */

import { WorkingTimeService, type WorkingTimeConfig } from './working-time.service.js';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WorkingTimeConfigEntity } from '../database/entities/index.js';

function buildService(): WorkingTimeService {
  const repo = {
    findOne: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<Repository<WorkingTimeConfigEntity>>;

  const configService = {
    get: jest.fn().mockImplementation((key: string, def?: unknown) => {
      if (key === 'TIMEZONE') return 'UTC';
      return def ?? '';
    }),
  } as unknown as jest.Mocked<ConfigService>;

  return new WorkingTimeService(repo, configService);
}

// Convenience: Mon–Fri work week, 8 h/day, no holidays, UTC
const MON_FRI_UTC: WorkingTimeConfig = {
  timezone: 'UTC',
  workDays: [1, 2, 3, 4, 5], // Mon=1 … Fri=5
  hoursPerDay: 8,
  holidays: [],
};

describe('WorkingTimeService — workingHoursBetween', () => {
  let service: WorkingTimeService;

  beforeEach(() => {
    service = buildService();
  });

  it('returns 0 when start === end', () => {
    const t = new Date('2026-04-13T10:00:00Z'); // Monday
    expect(service.workingHoursBetween(t, t, MON_FRI_UTC)).toBe(0);
  });

  it('returns 0 when start is after end', () => {
    const a = new Date('2026-04-14T00:00:00Z');
    const b = new Date('2026-04-13T00:00:00Z');
    expect(service.workingHoursBetween(a, b, MON_FRI_UTC)).toBe(0);
  });

  it('returns 24 for a full Monday (Mon 00:00 → Tue 00:00 UTC)', () => {
    // 2026-04-13 is a Monday
    const start = new Date('2026-04-13T00:00:00Z');
    const end = new Date('2026-04-14T00:00:00Z');
    expect(service.workingHoursBetween(start, end, MON_FRI_UTC)).toBe(24);
  });

  it('returns 24 for Fri 00:00 → Mon 00:00 UTC (only Friday is a work day)', () => {
    // 2026-04-17 is a Friday, 2026-04-20 is a Monday
    const start = new Date('2026-04-17T00:00:00Z');
    const end = new Date('2026-04-20T00:00:00Z');
    // Fri=24h, Sat=0h, Sun=0h
    expect(service.workingHoursBetween(start, end, MON_FRI_UTC)).toBe(24);
  });

  it('returns 0 for a full Saturday', () => {
    // 2026-04-18 is a Saturday
    const start = new Date('2026-04-18T00:00:00Z');
    const end = new Date('2026-04-19T00:00:00Z');
    expect(service.workingHoursBetween(start, end, MON_FRI_UTC)).toBe(0);
  });

  it('returns 12 for Fri 18:00 → Mon 06:00 UTC (6h Fri + 6h Mon)', () => {
    // 2026-04-17 Fri, 2026-04-20 Mon
    const start = new Date('2026-04-17T18:00:00Z');
    const end = new Date('2026-04-20T06:00:00Z');
    // Fri: 18:00–24:00 = 6h; Sat: 0; Sun: 0; Mon: 00:00–06:00 = 6h
    expect(service.workingHoursBetween(start, end, MON_FRI_UTC)).toBe(12);
  });

  it('excludes a holiday on Monday — span Mon 00:00 → Tue 00:00 returns 0', () => {
    // 2026-04-13 Monday is a holiday
    const config: WorkingTimeConfig = {
      ...MON_FRI_UTC,
      holidays: ['2026-04-13'],
    };
    const start = new Date('2026-04-13T00:00:00Z');
    const end = new Date('2026-04-14T00:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(0);
  });

  it('non-holiday Tuesday is unaffected by Monday holiday', () => {
    const config: WorkingTimeConfig = {
      ...MON_FRI_UTC,
      holidays: ['2026-04-13'],
    };
    const start = new Date('2026-04-14T00:00:00Z'); // Tuesday
    const end = new Date('2026-04-15T00:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(24);
  });

  it('handles a Sun–Thu work week: Sunday counts', () => {
    const sunThuConfig: WorkingTimeConfig = {
      ...MON_FRI_UTC,
      workDays: [0, 1, 2, 3, 4], // Sun=0, Mon=1, …, Thu=4
    };
    // 2026-04-19 is a Sunday — should count
    const start = new Date('2026-04-19T00:00:00Z');
    const end = new Date('2026-04-20T00:00:00Z');
    expect(service.workingHoursBetween(start, end, sunThuConfig)).toBe(24);
  });

  it('handles a Sun–Thu work week: Saturday does not count', () => {
    const sunThuConfig: WorkingTimeConfig = {
      ...MON_FRI_UTC,
      workDays: [0, 1, 2, 3, 4],
    };
    // 2026-04-18 is a Saturday — should NOT count
    const start = new Date('2026-04-18T00:00:00Z');
    const end = new Date('2026-04-19T00:00:00Z');
    expect(service.workingHoursBetween(start, end, sunThuConfig)).toBe(0);
  });
});

describe('WorkingTimeService — workingDaysBetween', () => {
  let service: WorkingTimeService;

  beforeEach(() => {
    service = buildService();
  });

  it('returns 0 when start === end', () => {
    const t = new Date('2026-04-13T10:00:00Z');
    expect(service.workingDaysBetween(t, t, MON_FRI_UTC)).toBe(0);
  });

  it('returns 3.0 for full Monday (24h ÷ 8 h/day = 3.0)', () => {
    // 2026-04-13 is a Monday
    const start = new Date('2026-04-13T00:00:00Z');
    const end = new Date('2026-04-14T00:00:00Z');
    expect(service.workingDaysBetween(start, end, MON_FRI_UTC)).toBe(3);
  });

  it('returns 3.0 for Fri 00:00 → Mon 00:00 (only Friday: 24h ÷ 8 = 3.0)', () => {
    // 2026-04-17 Fri, 2026-04-20 Mon
    const start = new Date('2026-04-17T00:00:00Z');
    const end = new Date('2026-04-20T00:00:00Z');
    expect(service.workingDaysBetween(start, end, MON_FRI_UTC)).toBe(3);
  });

  it('returns 0 for full Saturday', () => {
    const start = new Date('2026-04-18T00:00:00Z');
    const end = new Date('2026-04-19T00:00:00Z');
    expect(service.workingDaysBetween(start, end, MON_FRI_UTC)).toBe(0);
  });

  it('returns 1.5 for Fri 18:00 → Mon 06:00 UTC (12h ÷ 8 = 1.5)', () => {
    const start = new Date('2026-04-17T18:00:00Z');
    const end = new Date('2026-04-20T06:00:00Z');
    expect(service.workingDaysBetween(start, end, MON_FRI_UTC)).toBe(1.5);
  });

  it('returns 0 when Monday is a holiday and span is Mon 00:00 → Tue 00:00', () => {
    const config: WorkingTimeConfig = {
      ...MON_FRI_UTC,
      holidays: ['2026-04-13'],
    };
    const start = new Date('2026-04-13T00:00:00Z');
    const end = new Date('2026-04-14T00:00:00Z');
    expect(service.workingDaysBetween(start, end, config)).toBe(0);
  });

  it('returns 0 when hoursPerDay is 0 (guard against divide-by-zero)', () => {
    const config: WorkingTimeConfig = { ...MON_FRI_UTC, hoursPerDay: 0 };
    const start = new Date('2026-04-13T00:00:00Z');
    const end = new Date('2026-04-14T00:00:00Z');
    expect(service.workingDaysBetween(start, end, config)).toBe(0);
  });
});

describe('WorkingTimeService — timezone boundary correctness', () => {
  let service: WorkingTimeService;

  beforeEach(() => {
    service = buildService();
  });

  // -------------------------------------------------------------------------
  // America/New_York (negative UTC offset — EDT = UTC-4 in April 2026)
  // -------------------------------------------------------------------------
  // DST in 2026: clocks spring forward on 2026-03-08 → April is UTC-4 (EDT).
  //
  // Friday April 17 NY local: 2026-04-17T04:00:00Z → 2026-04-18T04:00:00Z
  // Monday April 20 NY local: 2026-04-20T04:00:00Z → 2026-04-21T04:00:00Z
  //
  // Span: 2026-04-17T22:00:00Z (Fri 18:00 EDT) → 2026-04-20T13:00:00Z (Mon 09:00 EDT)
  // Expected: Friday portion (22:00Z–04:00Z = 6h) + Monday portion (04:00Z–13:00Z = 9h) = 15h
  // Saturday and Sunday are not working days and must contribute 0h.

  it('America/New_York: Fri 18:00 EDT → Mon 09:00 EDT counts only Friday and Monday hours', () => {
    const config: WorkingTimeConfig = {
      timezone: 'America/New_York',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    const start = new Date('2026-04-17T22:00:00Z'); // Fri 18:00 EDT
    const end = new Date('2026-04-20T13:00:00Z');   // Mon 09:00 EDT
    // 6h Friday + 9h Monday = 15h; Sat/Sun = 0h
    expect(service.workingHoursBetween(start, end, config)).toBe(15);
  });

  it('America/New_York: full Saturday returns 0', () => {
    const config: WorkingTimeConfig = {
      timezone: 'America/New_York',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    // Saturday April 18 NY: 2026-04-18T04:00:00Z → 2026-04-19T04:00:00Z
    const start = new Date('2026-04-18T04:00:00Z');
    const end = new Date('2026-04-19T04:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(0);
  });

  it('America/New_York: full Monday returns 24h', () => {
    const config: WorkingTimeConfig = {
      timezone: 'America/New_York',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    // Monday April 20 NY: 2026-04-20T04:00:00Z → 2026-04-21T04:00:00Z
    const start = new Date('2026-04-20T04:00:00Z');
    const end = new Date('2026-04-21T04:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(24);
  });

  // -------------------------------------------------------------------------
  // Australia/Sydney (positive UTC offset — AEST = UTC+10 in April 2026)
  // -------------------------------------------------------------------------
  // DST in 2026: clocks fall back on 2026-04-05 (first Sunday April).
  // April 13 onwards is AEST UTC+10.
  //
  // Monday April 13 Sydney local: 2026-04-13T14:00:00Z → 2026-04-14T14:00:00Z
  // Tuesday April 14 Sydney local: 2026-04-14T14:00:00Z → 2026-04-15T14:00:00Z

  it('Australia/Sydney: full Monday (AEST) returns 24h', () => {
    const config: WorkingTimeConfig = {
      timezone: 'Australia/Sydney',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    // Mon April 13 AEST (UTC+10): midnight = 2026-04-12T14:00:00Z
    // Tue April 14 AEST midnight  = 2026-04-13T14:00:00Z
    const start = new Date('2026-04-12T14:00:00Z');
    const end = new Date('2026-04-13T14:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(24);
  });

  it('Australia/Sydney: Fri 18:00 AEST → Mon 09:00 AEST counts only Friday and Monday hours', () => {
    const config: WorkingTimeConfig = {
      timezone: 'Australia/Sydney',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    // AEST = UTC+10. local = UTC + 10h, so local midnight = UTC - 10h.
    //
    // Fri April 17 AEST: dayStart = 2026-04-16T14:00:00Z, nextDayStart = 2026-04-17T14:00:00Z
    // Fri 18:00 AEST = 2026-04-17T08:00:00Z
    //   → Friday portion: 2026-04-17T08:00:00Z → 2026-04-17T14:00:00Z = 6h ✓
    //
    // Sat/Sun: skipped (not work days)
    //
    // Mon April 20 AEST: dayStart = 2026-04-19T14:00:00Z, nextDayStart = 2026-04-20T14:00:00Z
    // Mon 09:00 AEST = April 20 09:00 - 10h = April 19 23:00 UTC = 2026-04-19T23:00:00Z
    //   → Monday portion: 2026-04-19T14:00:00Z → 2026-04-19T23:00:00Z = 9h ✓
    //
    // Total = 6h + 9h = 15h
    const start = new Date('2026-04-17T08:00:00Z'); // Fri 18:00 AEST
    const end = new Date('2026-04-19T23:00:00Z');   // Mon 09:00 AEST
    expect(service.workingHoursBetween(start, end, config)).toBe(15);
  });

  it('Australia/Sydney: full Saturday (AEST) returns 0', () => {
    const config: WorkingTimeConfig = {
      timezone: 'Australia/Sydney',
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [],
    };
    // Sat April 18 AEST (UTC+10): midnight = 2026-04-17T14:00:00Z
    // Sun April 19 AEST midnight  = 2026-04-18T14:00:00Z
    const start = new Date('2026-04-17T14:00:00Z');
    const end = new Date('2026-04-18T14:00:00Z');
    expect(service.workingHoursBetween(start, end, config)).toBe(0);
  });
});

describe('WorkingTimeService — getConfig / toConfig', () => {
  it('returns in-memory default when no DB row found', async () => {
    const service = buildService();
    const entity = await service.getConfig();
    expect(entity.id).toBe(1);
    expect(entity.excludeWeekends).toBe(true);
    expect(entity.workDays).toEqual([1, 2, 3, 4, 5]);
    expect(entity.hoursPerDay).toBe(8);
    expect(entity.holidays).toEqual([]);
  });

  it('toConfig enriches entity with timezone from ConfigService', () => {
    const service = buildService();
    const entity = Object.assign(new WorkingTimeConfigEntity(), {
      id: 1,
      excludeWeekends: true,
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: ['2026-01-01'],
    });
    const config = service.toConfig(entity);
    expect(config.timezone).toBe('UTC');
    expect(config.workDays).toEqual([1, 2, 3, 4, 5]);
    expect(config.hoursPerDay).toBe(8);
    expect(config.holidays).toEqual(['2026-01-01']);
  });
});
