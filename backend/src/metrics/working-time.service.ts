import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WorkingTimeConfigEntity } from '../database/entities/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Runtime working-time configuration — the entity enriched with the
 * tenant timezone from the environment.
 */
export interface WorkingTimeConfig {
  timezone: string;
  workDays: number[];
  hoursPerDay: number;
  holidays: string[];
}

// ---------------------------------------------------------------------------
// WorkingTimeService
// ---------------------------------------------------------------------------

@Injectable()
export class WorkingTimeService {
  private readonly logger = new Logger(WorkingTimeService.name);

  /**
   * In-memory default used when the `working_time_config` table row is absent
   * (e.g. a fresh DB that has not yet had migrations applied, or tests that
   * do not seed the table).
   */
  private static readonly DEFAULT_ENTITY: WorkingTimeConfigEntity = Object.assign(
    new WorkingTimeConfigEntity(),
    {
      id: 1,
      excludeWeekends: true,
      workDays: [1, 2, 3, 4, 5],
      hoursPerDay: 8,
      holidays: [] as string[],
    },
  );

  constructor(
    @InjectRepository(WorkingTimeConfigEntity)
    private readonly repo: Repository<WorkingTimeConfigEntity>,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // DB access
  // ---------------------------------------------------------------------------

  /**
   * Loads the singleton row (id = 1) from the database.
   * Returns the in-memory default when no row is found so callers never
   * receive null/undefined.
   */
  async getConfig(): Promise<WorkingTimeConfigEntity> {
    const entity = await this.repo.findOne({ where: { id: 1 } });
    if (!entity) {
      this.logger.warn(
        'working_time_config row not found — using in-memory defaults',
      );
      return WorkingTimeService.DEFAULT_ENTITY;
    }
    return entity;
  }

  // ---------------------------------------------------------------------------
  // Config conversion
  // ---------------------------------------------------------------------------

  /**
   * Converts a WorkingTimeConfigEntity into a WorkingTimeConfig, enriched
   * with the tenant timezone from the TIMEZONE environment variable.
   */
  toConfig(entity: WorkingTimeConfigEntity): WorkingTimeConfig {
    return {
      timezone: this.configService.get<string>('TIMEZONE', 'UTC'),
      workDays: entity.workDays,
      hoursPerDay: entity.hoursPerDay,
      holidays: entity.holidays,
    };
  }

  // ---------------------------------------------------------------------------
  // Core working-time algorithm
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of working hours between `start` and `end` in the
   * given working-time configuration.
   *
   * Algorithm:
   *   1. Walk calendar days in the given timezone from the day containing
   *      `start` through the day containing `end` (inclusive).
   *   2. For each calendar day, compute the millisecond overlap between
   *      [start, end] and [dayStart, dayEnd] in that timezone.
   *   3. Skip days that are non-working (weekday not in workDays) or are
   *      public holidays.
   *   4. Accumulate the overlapping milliseconds and convert to hours.
   *
   * NOTE: We accumulate ALL milliseconds that fall within a working calendar
   * day (00:00–23:59 in the configured timezone), not just hoursPerDay hours.
   * hoursPerDay is a normalisation factor: 24 raw hours / 8 hoursPerDay =
   * 3 working-day units. This is intentional — see Proposal 0029, §Algorithm
   * Design. Do NOT cap per-day accumulation to hoursPerDay * 3_600_000.
   *
   * DST safety: day boundaries are computed using startOfDayInTz() which uses
   * binary search to find the exact UTC instant of local midnight — this
   * correctly handles all IANA timezones including negative-offset zones
   * (e.g. America/New_York) and DST transitions.
   */
  workingHoursBetween(
    start: Date,
    end: Date,
    config: WorkingTimeConfig,
  ): number {
    if (start >= end) return 0;

    const { timezone, workDays, holidays } = config;
    const holidaySet = new Set(holidays);

    // Shared formatter for local date strings ("YYYY-MM-DD" via en-CA locale).
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    let totalMs = 0;

    // Determine the local calendar date of `start` in the target timezone.
    let dayStr = dateFmt.format(start); // "YYYY-MM-DD"

    for (;;) {
      const [y, m, d] = dayStr.split('-').map(Number); // m is 1-indexed

      // UTC instant for the start of this local calendar day.
      const dayStart = startOfDayInTz(y, m, d, timezone, dateFmt);

      // If this day's start is at or beyond `end`, we are done.
      if (dayStart >= end) break;

      // Advance local date by 1 calendar day (JS Date handles month/year rollover).
      const nextDateUtc = new Date(Date.UTC(y, m - 1, d + 1));
      const ny = nextDateUtc.getUTCFullYear();
      const nm = nextDateUtc.getUTCMonth() + 1; // keep 1-indexed
      const nd = nextDateUtc.getUTCDate();
      const nextStr = `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;

      // UTC instant for the start of the NEXT local calendar day.
      const nextDayStart = startOfDayInTz(ny, nm, nd, timezone, dateFmt);

      // Effective interval within [start, end] for this calendar day.
      const intervalStart = dayStart < start ? start : dayStart;
      const intervalEnd = nextDayStart < end ? nextDayStart : end;

      if (intervalStart < intervalEnd) {
        // Classify the day using the midpoint to avoid boundary ambiguity.
        const midpointMs = (dayStart.getTime() + nextDayStart.getTime()) / 2;
        const weekday = getWeekday(new Date(midpointMs), timezone);

        if (workDays.includes(weekday) && !holidaySet.has(dayStr)) {
          totalMs += intervalEnd.getTime() - intervalStart.getTime();
        }
      }

      // Safety guard: if nextDayStart did not advance, break to avoid infinite loop.
      if (nextDayStart <= dayStart) break;

      dayStr = nextStr;
    }

    return totalMs / 3_600_000;
  }

  /**
   * Returns the number of working days between `start` and `end`.
   * = workingHoursBetween / hoursPerDay
   */
  workingDaysBetween(
    start: Date,
    end: Date,
    config: WorkingTimeConfig,
  ): number {
    if (config.hoursPerDay <= 0) return 0;
    return this.workingHoursBetween(start, end, config) / config.hoursPerDay;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTC Date representing the start of the local calendar day
 * (year, month [1-indexed], day) in the given IANA timezone.
 *
 * Uses binary search over a ±14h window centred on noon UTC of that
 * calendar date. This correctly handles:
 *   - Positive-offset timezones (e.g. Australia/Sydney, UTC+11)
 *   - Negative-offset timezones (e.g. America/New_York, UTC-5)
 *   - DST transitions (clocks spring forward / fall back)
 *
 * The offset-arithmetic approach used by the previous midnightInTz() in
 * tz-utils.ts is broken for negative-offset zones: it computes the time of
 * day shown by the UTC-midnight candidate in the local zone, then subtracts
 * that offset — anchoring to the UTC date rather than the local date.
 * For New_York (UTC-5), Jan 1 00:00 UTC displays as Dec 31 19:00 in NY,
 * so offsetMs=19h and the result is Dec 31 05:00 UTC, not Jan 1 05:00 UTC.
 *
 * Binary search avoids all such offset arithmetic by directly testing
 * "does this UTC instant fall on the target local date?" and narrowing
 * until it finds the earliest UTC instant that does.
 *
 * @param year   Full year (e.g. 2026)
 * @param month  1-indexed month (1 = January)
 * @param day    Day of month (1–31)
 * @param tz     IANA timezone string
 * @param fmt    Pre-constructed Intl.DateTimeFormat for the timezone (optional —
 *               pass to avoid repeated construction in tight loops)
 */
function startOfDayInTz(
  year: number,
  month: number,
  day: number,
  tz: string,
  fmt?: Intl.DateTimeFormat,
): Date {
  // Anchor to UTC midnight of the target CALENDAR date (not local noon).
  //
  // Why UTC midnight, not noon?
  //   Using noon UTC as the anchor (the natural intuition) fails for large
  //   positive offsets.  For UTC+10 (Sydney AEST), noon UTC is already 22:00
  //   local — the same local date — so "lo = noon - 14h = 22:00Z - 14h =
  //   08:00Z" is still within the same local day.  The binary search never
  //   brackets the true midnight and returns a wrong result.
  //
  // By anchoring to UTC midnight (00:00Z) of the target calendar date:
  //   lo = 00:00Z - 14h  — guaranteed before local midnight for UTC+14
  //   hi = 00:00Z + 13h  — guaranteed after local midnight for UTC-12
  //
  // This correctly handles every IANA offset including extremes (UTC+14,
  // UTC-12) and DST transitions.
  const anchorUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);

  const formatter =
    fmt ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

  const targetStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

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
 * Returns the ISO weekday (0 = Sunday, 1 = Monday, …, 6 = Saturday) for a
 * Date in the given IANA timezone.  Uses `Intl.DateTimeFormat` so it is
 * DST-safe and does not depend on UTC weekday.
 */
function getWeekday(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const dayStr = formatter.format(date); // e.g. "Mon", "Tue", ...
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[dayStr] ?? 0;
}
