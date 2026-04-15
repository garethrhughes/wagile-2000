# 0026 — `hoursPerDay` Is a Normalisation Factor, Not a Clock-Hour Boundary

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0029 — Working-Time Service: Exclude Weekends from Flow Metrics](../proposals/0029-working-time-service.md)

## Context

`WorkingTimeService` (introduced via ADR-0024) calculates working-day durations between two
timestamps. A key design question was the granularity at which weekend exclusion operates:
should the service also exclude non-business clock hours within a working day (e.g. only
count 09:00–17:00), or should it treat each working calendar day as fully available?

The `hoursPerDay` configuration field (default: 8) controls how accumulated working time is
converted to working-day units. There were two competing interpretations of what this field
should do.

---

## Options Considered

### Option A — `hoursPerDay` as a normalisation divisor; no intra-day time-of-day boundary (selected)

- **Summary:** `WorkingTimeService` accumulates **all** milliseconds that fall on a calendar
  day classified as a working day (full 24-hour day). To convert hours to working-day units,
  the total accumulated hours are divided by `hoursPerDay`. There is no 09:00–17:00 (or
  configurable `workStartHour`–`workEndHour`) boundary within a day.
- **Pros:**
  - Simpler algorithm: classify each calendar day as working or non-working; no intra-day
    time-of-day arithmetic.
  - Jira timestamps reflect when engineers actually clicked buttons — this frequently happens
    before standup or late in the evening. Excluding those clicks from the metric would
    silently under-count real work transitions.
  - The project measures team-level flow throughput, not individual working hours. Day-level
    granularity (Friday → Monday = 0 weekend days) is the appropriate resolution.
  - Adding clock-hour boundaries would require two additional config fields (`workStartHour`,
    `workEndHour`) and a more complex algorithm for the fractional first/last day calculation.
- **Cons:**
  - An issue started at 23:59 Friday and finished at 00:01 Monday gets credit for a tiny
    fraction of Friday and a tiny fraction of Monday, rather than 0. This is technically
    correct (real work transitions occurred) and the fractions are very small.
  - The `hoursPerDay` divisor is a convention; strictly speaking, a day contains 24h of
    accumulated time, not 8h. Teams must understand that `hoursPerDay` rescales the output
    unit, not the input window.

### Option B — Clock-hour bounded working hours (e.g. 09:00–17:00)

- **Summary:** Within each working calendar day, only milliseconds between `workStartHour`
  and `workEndHour` are accumulated. Time outside those hours is discarded.
- **Pros:**
  - Precisely models a defined business-hours window.
  - The `hoursPerDay` field becomes redundant (it equals `workEndHour - workStartHour`).
- **Cons:**
  - Requires two new config fields and a significantly more complex intra-day algorithm.
  - Jira transitions outside business hours (common for engineers) are silently zeroed,
    producing incorrect results for teams with flexible hours.
  - The DORA metrics framework uses calendar-day granularity; this proposal already moves
    away from strict DORA semantics for cycle time. Adding sub-day precision increases
    divergence without proportional insight.
  - Ruled out as disproportionately complex for the accuracy gain.

---

## Decision

> `WorkingTimeService` accumulates all milliseconds within a calendar day that is classified
> as a working day (i.e. it applies a full 24-hour window per working day). There is no
> `workStartHour`/`workEndHour` boundary. The `hoursPerDay` configuration field (default: 8)
> is a normalisation divisor: total accumulated working hours are divided by `hoursPerDay`
> to yield working-day units. This produces fractional working-day values consistent with
> the existing calendar-day arithmetic that `hoursPerDay` replaces.

---

## Rationale

Flow metrics for a software team measure throughput at the granularity of days, not hours.
The key signal is whether an issue was being worked on across calendar days that contained
engineering work — not whether the specific timestamps fell within a defined clock window.
Engineers transition issues at all hours; a 22:00 "In Progress" click is genuine signal.
The simpler full-day accumulation model captures this correctly while avoiding the complexity
and configuration overhead of a clock-hour boundary approach.

---

## Consequences

### Positive

- The algorithm is straightforward: for each day boundary between `start` and `end`, ask
  "is this a working day?" — no intra-day time-of-day logic required.
- Jira transition timestamps at any hour of a working day are counted, reflecting actual
  engineer activity regardless of when it occurred.
- The API surface of `WorkingTimeConfig` remains lean: `workDays`, `hoursPerDay`,
  `holidays` — no `workStartHour`/`workEndHour` to configure or document.

### Negative / Trade-offs

- `hoursPerDay: 8` with a 24h accumulation window means a full working day accumulates 24h
  and is then divided by 8 to yield 1.0 working day. This is semantically a scaling factor,
  not a literal description of hours worked. Teams expecting the value to bound intra-day
  accumulation will be surprised.
- Very short durations (minutes) within a working day will produce very small but non-zero
  working-day fractions. This is correct but differs from a clock-hour model that might
  round such intervals to a small canonical value.

### Risks

- Operators who set `hoursPerDay: 24` expecting it to mean "all hours count" will get the
  same behaviour as the default but with 1/3 the day-unit values (3× more granular). The
  `boards.example.yaml` documentation must explain that `hoursPerDay` is the normalisation
  denominator, not the working window width.

---

## Related Decisions

- [ADR-0024](0024-weekend-exclusion-from-cycle-time-and-lead-time.md) — The parent decision
  establishing `WorkingTimeService` and the weekend exclusion behaviour
- [ADR-0027](0027-day-boundary-algorithm-uses-intl-binary-search.md) — The implementation
  decision for how calendar-day boundaries are located in the configured timezone
