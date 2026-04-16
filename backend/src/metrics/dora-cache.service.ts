/**
 * DoraCacheService
 *
 * A lightweight in-memory TTL cache for expensive DORA metric computations.
 * This avoids re-running the full multi-table DB query set on every HTTP
 * request.  Data staleness is acceptable: DORA metrics are calculated from
 * historical Jira data that changes only during a background sync.
 *
 * Design constraints:
 * - No external dependencies (no Redis, no NestJS CacheModule)
 * - Injectable NestJS service (singleton by default)
 * - Thread-safe for single-threaded Node.js event loop
 * - Default TTL: 60 seconds (configurable per-entry)
 */
import { Injectable } from '@nestjs/common';
import { quarterToDates } from './period-utils.js';

const DEFAULT_TTL_MS = 60_000; // 60 seconds

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms
}

@Injectable()
export class DoraCacheService {
  /** 15-minute TTL used for trend responses where every period is historical. */
  static readonly HISTORICAL_TTL_MS = 900_000;
  private readonly store = new Map<string, CacheEntry<unknown>>();

  /**
   * Retrieve a cached value.
   * Returns `undefined` if the key does not exist or has expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      // Lazy eviction — remove the stale entry on access
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Store a value under `key` with an optional TTL (ms).
   * Defaults to 60 000 ms (60 s) when `ttlMs` is omitted.
   */
  set<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Remove a single key from the cache.
   * No-op if the key does not exist.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently in the store (including expired ones). */
  size(): number {
    return this.store.size;
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the given quarter label's end date is in the past,
   * meaning the data for that quarter is immutable and can be cached for longer.
   *
   * @param quarter - Quarter label in YYYY-QN format (e.g. "2025-Q1")
   * @param tz      - IANA timezone (default 'UTC')
   */
  static isHistoricalQuarter(quarter: string, tz = 'UTC'): boolean {
    try {
      const { endDate } = quarterToDates(quarter, tz);
      // quarterToDates returns a 90-day fallback for invalid input — detect by
      // checking that the label matches the expected pattern.
      if (!/^\d{4}-Q[1-4]$/.test(quarter)) return false;
      return endDate < new Date();
    } catch {
      return false;
    }
  }

  /**
   * Build a deterministic cache key from an arbitrary params object.
   *
   * Keys are sorted alphabetically before serialisation so that
   * `{ a: '1', b: '2' }` and `{ b: '2', a: '1' }` produce the same key.
   *
   * @param params  - Query parameters (all values will be stringified)
   * @param namespace - Optional prefix to namespace keys by caller
   */
  static buildKey(
    params: Record<string, string | number | boolean | undefined | null>,
    namespace?: string,
  ): string {
    const sorted = Object.keys(params)
      .sort()
      .reduce<Record<string, string>>((acc, k) => {
        const v = params[k];
        if (v !== undefined && v !== null) {
          acc[k] = String(v);
        }
        return acc;
      }, {});

    const payload = JSON.stringify(sorted);
    return namespace ? `${namespace}:${payload}` : payload;
  }
}
