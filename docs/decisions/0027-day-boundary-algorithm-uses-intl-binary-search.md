# 0027 — Day-Boundary Algorithm Uses `Intl.DateTimeFormat` with Binary Search

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0029 — Working-Time Service: Exclude Weekends from Flow Metrics](../proposals/0029-working-time-service.md)

## Context

`WorkingTimeService` must split a `[start, end]` interval at calendar-day boundaries in a
given IANA timezone (e.g. `Australia/Sydney`) to classify each day as a working day or
non-working day. This requires locating the exact UTC instant at which the local clock
transitions from one calendar day to the next (i.e. local midnight).

Two broad implementation approaches were considered: offset arithmetic (derive local midnight
from the UTC offset of the timezone at a given instant) and `Intl.DateTimeFormat` formatting
with binary search (probe the timezone's formatting output to bracket the boundary).

---

## Options Considered

### Option A — `Intl.DateTimeFormat` formatting + binary search over ±14h UTC window (selected)

- **Summary:** To find the midnight boundary on a given calendar day in a given timezone,
  the algorithm observes the formatted day value at two candidate UTC instants (e.g.
  `now - 14h` and `now + 14h`). If they differ, a binary search narrows the interval until
  the UTC millisecond of the local midnight transition is identified to within 1ms. Uses
  `Intl.DateTimeFormat` (already available in all Node.js versions supported by the project)
  with no external libraries.
- **Pros:**
  - **Correct by construction**: the algorithm does not rely on offset arithmetic; it
    observes the actual formatted day string produced by the JavaScript runtime's timezone
    database (CLDR/ICU). DST transitions, irregular offsets, and historical timezone changes
    are all handled correctly.
  - No external timezone library required (`date-fns-tz`, `luxon`, `dayjs/timezone`, etc.).
  - The binary search converges in ≤28 iterations (log₂(28h × 3600000ms) ≈ 27.5).
  - The existing `tz-utils.ts` module already uses `Intl.DateTimeFormat` in `dateParts()`;
    the boundary finder extends the same pattern.
- **Cons:**
  - Binary search is less immediately readable than a single arithmetic expression.
  - Each binary search iteration formats a date; ~28 `Intl.DateTimeFormat` calls per
    day boundary. For a 30-day span this is ~840 format calls — negligible in practice
    but more than offset arithmetic.

### Option B — UTC offset arithmetic

- **Summary:** Obtain the UTC offset of the timezone at a given UTC instant (e.g. via
  `Intl.DateTimeFormat(...).formatToParts()` to extract the timezone offset string), then
  compute local midnight as `floor((utcMs + offsetMs) / dayMs) * dayMs - offsetMs`.
- **Pros:**
  - One `formatToParts()` call to get the offset; simple arithmetic thereafter.
  - Easy to understand.
- **Cons:**
  - **Incorrect for negative UTC offsets**: for timezones west of UTC (e.g. `America/New_York`,
    UTC-5), the arithmetic inverts and produces the wrong midnight. This is a systematic bug
    that affects roughly half the world's timezones.
  - **Incorrect during DST transitions**: if the offset changes between the time of the
    `formatToParts()` call and the boundary being computed, the derived midnight is off by
    one hour.
  - The project's primary deployment is `Australia/Sydney` (UTC+10/+11), so the bug would
    not manifest immediately — but shipping known-broken code for negative-offset timezones
    is not acceptable. Ruled out.

### Option C — External timezone library (`date-fns-tz` or `luxon`)

- **Summary:** Use a library that exposes timezone-aware day boundaries directly.
- **Pros:**
  - High-level API; well-tested edge cases (DST, leap years, etc.).
- **Cons:**
  - Adds a new production dependency for functionality achievable with `Intl.DateTimeFormat`
    which is already in use. `luxon` is 67kB; `date-fns-tz` is 12kB — meaningful additions
    for a server-side bundle, and both require ongoing maintenance. Ruled out.

---

## Decision

> Calendar-day boundaries in a given IANA timezone are located using `Intl.DateTimeFormat`
> formatting combined with a binary search over a ±14h UTC window centred on the expected
> local midnight. The algorithm is correct for all IANA timezones including negative-offset
> zones and across DST transitions. No external timezone library is introduced.

---

## Rationale

Offset arithmetic is attractive for its simplicity but is demonstrably wrong for
negative-offset timezones — a class of bugs that would silently corrupt working-day
calculations for a large fraction of potential deployments. Binary search on `Intl.DateTimeFormat`
output is correct by construction because it directly observes the runtime's timezone
database rather than deriving boundaries from offset values that can be stale or inverted.
The performance cost (~28 format calls per day boundary) is negligible at the data volumes
of this tool.

---

## Consequences

### Positive

- `WorkingTimeService` produces correct results for all IANA timezones, including those
  with negative UTC offsets (`America/*`, `Pacific/*` west of the date line) and those
  with sub-hour offsets (e.g. `Asia/Kolkata` UTC+5:30).
- DST transition days are handled correctly — the local midnight on a spring-forward or
  fall-back day is identified at the correct UTC instant.
- No new production dependencies are introduced.

### Negative / Trade-offs

- The binary search implementation is less immediately obvious than a single arithmetic
  expression. It requires a comment explaining the algorithm for maintainers.
- Approximately 28 `Intl.DateTimeFormat` format calls per calendar-day boundary. For a
  365-day span, this is ~10,000 calls per `workingDaysBetween()` invocation. This is
  acceptable for a server-side calculation over hundreds of issues but should be noted in
  the implementation.

### Risks

- If the Node.js `Intl` implementation changes how it formats timezone offsets or day
  values in a future version, the binary search may need adjustment. This is guarded by
  the unit tests for `WorkingTimeService` which exercise known boundary cases.

---

## Related Decisions

- [ADR-0024](0024-weekend-exclusion-from-cycle-time-and-lead-time.md) — The parent decision
  establishing `WorkingTimeService` and its timezone-aware requirements
- [ADR-0026](0026-hours-per-day-as-normalisation-factor.md) — The normalisation model that
  determines how the accumulated working time from this algorithm is converted to day units
