# 0024 — Weekend Exclusion from Cycle Time and Lead Time by Default

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0029 — Working-Time Service: Exclude Weekends from Flow Metrics](../proposals/0029-working-time-service.md)

## Context

Every duration calculation in the codebase used raw calendar milliseconds:
`CycleTimeService`, `LeadTimeService`, and `SprintDetailService` all computed elapsed time
as `(end.getTime() - start.getTime()) / 86_400_000`. No service subtracted weekend time.

The practical effect: an issue started at 17:00 Friday and completed at 09:00 Monday
registered as ~2.67 calendar days of cycle time when the actual engineering effort was
roughly 0.1 working days. For teams whose issues routinely straddle weekends, this inflation
was enough to push DORA classifications one full band lower than warranted. Five independent
duration expressions existed across three services with no shared utility — fixing one did
not fix the others.

---

## Options Considered

### Option A — Exclude weekends by default; configurable via `WorkingTimeConfigEntity` (selected)

- **Summary:** A new `WorkingTimeService` implements a day-boundary iteration algorithm
  that accumulates only milliseconds on configured working days. An `excludeWeekends` boolean
  flag (default `true`) in a singleton `WorkingTimeConfigEntity` (PK=1) provides a kill-switch.
  Configuration is loaded from an optional `workingTime:` stanza in `boards.yaml`.
- **Pros:**
  - Removes systematic weekend inflation from cycle-time and lead-time metrics.
  - Single shared utility: all three affected services call the same `workingDaysBetween()`
    method, eliminating duplicated arithmetic.
  - Kill-switch (`excludeWeekends: false`) allows teams to revert to calendar-day semantics
    without a code deployment.
  - `workDays`, `hoursPerDay`, and `holidays` are also configurable, supporting non Mon–Fri
    working weeks and public holiday exclusion.
- **Cons:**
  - Existing metric values will shift downward (working-day figures are always ≤ calendar-day
    figures). DORA band classifications may change.
  - Cached sprint report blobs remain stale until regenerated.

### Option B — Keep calendar-day arithmetic; add opt-in working-day mode

- **Summary:** Default remains calendar days; teams opt in to working-day mode.
- **Pros:** No change to existing metric values on upgrade.
- **Cons:** Calendar-day semantics are demonstrably incorrect for the stated use case
  (measuring engineering throughput). Defaulting to the wrong behaviour and requiring an
  opt-in means most deployments will continue producing inflated metrics.

### Option C — Per-request toggle (`?calendarDays=true` query parameter)

- **Summary:** Every metrics endpoint accepts a query parameter to switch between working-day
  and calendar-day modes per request.
- **Pros:** Flexible; teams can compare both views.
- **Cons:** Requires computing both durations for every observation (doubles computation),
  changes the API contract, and adds frontend complexity. The primary use case is a team
  that decides on one mode and leaves it. Deferred to a future proposal.

---

## Decision

> Weekend days (Saturday and Sunday) are excluded from cycle-time and lead-time calculations
> by default (`excludeWeekends: true`). The `WorkingTimeService.workingDaysBetween()` method
> is the single implementation of this logic. The three affected services
> (`CycleTimeService`, `LeadTimeService`, `SprintDetailService`) call this method instead of
> performing direct timestamp arithmetic. The behaviour can be reverted to calendar days
> by setting `excludeWeekends: false` in the `workingTime:` stanza of `boards.yaml`.

---

## Rationale

Calendar-day cycle time is systematically misleading for teams whose issues span weekends:
it overstates the time taken by engineering work and understates team throughput. Working-day
semantics reflect actual team output and are the expected default for engineering flow tools.
Defaulting to `excludeWeekends: true` ensures correct behaviour out of the box; the
kill-switch covers teams that prefer or require calendar-day comparability with other tools.

---

## Consequences

### Positive

- Cycle-time and lead-time percentiles reflect actual working time, removing weekend
  inflation. DORA band classifications become more accurate.
- The metric change is consistent across all boards — no per-board inconsistency.
- `WorkingTimeService` is a pure, deterministic utility that is straightforward to test.
- Future extensions (configurable working hours, alternative work weeks) can be added to
  `WorkingTimeService` without touching the individual metric services.

### Negative / Trade-offs

- **Metric values will decrease** for issues that previously spanned weekends. Teams should
  be informed that this is the correct outcome, not a regression.
- Cached sprint report blobs (`sprint_reports` table) retain old calendar-day values until
  regenerated. No automatic invalidation occurs; operators must trigger regeneration or
  clear the table manually.
- The frontend must display "working days" (abbreviated `wd`) rather than plain "days" when
  `excludeWeekends: true` so that stakeholders understand the unit change.

### Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Stakeholders misinterpret lower numbers as regression | Medium | Medium | UI unit label change (`wd` vs `cd`) and release notes explanation. |
| Stale sprint report blobs produce mixed units in comparisons | Medium | Low | Document that a full sprint report regeneration is recommended after enabling the feature. |
| Non Mon–Fri teams misconfigure `workDays` | Low | Medium | `boards.example.yaml` documents the integer encoding; defaults to Mon–Fri. |

---

## Related Decisions

- [ADR-0025](0025-mttr-uses-calendar-hours-not-working-hours.md) — The companion decision
  explicitly preserving calendar-hour semantics for MTTR
- [ADR-0026](0026-hours-per-day-as-normalisation-factor.md) — The decision specifying how
  `hoursPerDay` is used as a normalisation divisor, not a clock-hour boundary
- [ADR-0027](0027-day-boundary-algorithm-uses-intl-binary-search.md) — The implementation
  decision for timezone-correct calendar-day boundary detection
- [ADR-0028](0028-global-working-time-config-not-per-board.md) — The scoping decision for
  `WorkingTimeConfigEntity` as a global singleton
