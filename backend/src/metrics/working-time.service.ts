import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WorkingTimeConfigEntity } from '../database/entities/index.js';
import { startOfDayInTz } from './tz-utils.js';

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

    // Shared formatter for weekday names — constructed once to avoid allocating
    // a new Intl.DateTimeFormat on every calendar-day iteration.
    const weekdayFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    });

    let totalMs = 0;

    // Shared formatter for local date strings ("YYYY-MM-DD" via en-CA locale).
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Determine the local calendar date of `start` in the target timezone.
    let dayStr = dateFmt.format(start); // "YYYY-MM-DD"

    for (;;) {
      const [y, m, d] = dayStr.split('-').map(Number); // m is 1-indexed

      // UTC instant for the start of this local calendar day.
      // m is 1-indexed (from en-CA split); startOfDayInTz uses 0-indexed months.
      const dayStart = startOfDayInTz(y, m - 1, d, timezone);

      // If this day's start is at or beyond `end`, we are done.
      if (dayStart >= end) break;

      // Advance local date by 1 calendar day (JS Date handles month/year rollover).
      const nextDateUtc = new Date(Date.UTC(y, m - 1, d + 1));
      const ny = nextDateUtc.getUTCFullYear();
      const nm = nextDateUtc.getUTCMonth() + 1; // keep 1-indexed for string formatting
      const nd = nextDateUtc.getUTCDate();
      const nextStr = `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;

      // UTC instant for the start of the NEXT local calendar day.
      // nm is 1-indexed; convert to 0-indexed for startOfDayInTz.
      const nextDayStart = startOfDayInTz(ny, nm - 1, nd, timezone);

      // Effective interval within [start, end] for this calendar day.
      const intervalStart = dayStart < start ? start : dayStart;
      const intervalEnd = nextDayStart < end ? nextDayStart : end;

      if (intervalStart < intervalEnd) {
        // Classify the day using the midpoint to avoid boundary ambiguity.
        const midpointMs = (dayStart.getTime() + nextDayStart.getTime()) / 2;
        const weekday = getWeekday(new Date(midpointMs), weekdayFmt);

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
   *
   * `workingHoursBetween()` currently measures the full overlapping duration
   * within configured working weekdays, so a full working weekday can
   * contribute up to 24 hours. Convert those hours into day units using a
   * 24-hour day to keep day-based metrics and thresholds consistent.
   */
  workingDaysBetween(
    start: Date,
    end: Date,
    config: WorkingTimeConfig,
  ): number {
    return this.workingHoursBetween(start, end, config) / 24;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the ISO weekday (0 = Sunday, 1 = Monday, …, 6 = Saturday) for a
 * Date using the provided `Intl.DateTimeFormat` (must be configured with
 * `{ weekday: 'short' }` in the desired IANA timezone).  Accepts a
 * pre-constructed formatter to avoid repeated allocations in tight loops.
 */
function getWeekday(date: Date, formatter: Intl.DateTimeFormat): number {
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
