# 0025 — MTTR Uses Calendar Hours, Not Working Hours

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0029 — Working-Time Service: Exclude Weekends from Flow Metrics](../proposals/0029-working-time-service.md)

## Context

ADR-0024 introduced weekend exclusion for cycle-time and lead-time metrics via
`WorkingTimeService`. The question arose whether the same exclusion should be applied to
MTTR (Mean Time to Restore), which measures elapsed hours between an incident being opened
and the system returning to a healthy state.

MTTR is one of the four core DORA metrics. Unlike cycle time and lead time — which measure
engineering throughput within working hours — MTTR measures incident recovery, which is an
operational obligation that does not pause outside business hours. A P1 production outage
raised on a Saturday requires resolution regardless of the day.

---

## Options Considered

### Option A — Keep MTTR as calendar hours; do not apply `WorkingTimeService` (selected)

- **Summary:** `MttrService` continues to divide the elapsed milliseconds by
  `(1000 * 60 * 60)` to yield calendar hours. A code comment explicitly documents that
  calendar hours are intentional for this metric.
- **Pros:**
  - Correct semantics: production incidents are not bounded by working hours.
  - Consistent with DORA industry-standard definitions, which measure MTTR in calendar time.
  - No change to `MttrService` logic; the existing calculation is already correct.
  - Avoids artificially deflating MTTR figures by excluding weekend recovery time.
- **Cons:**
  - MTTR and cycle time/lead time now use different time semantics. This difference must
    be clearly surfaced in documentation and UI labels.

### Option B — Apply working-hour exclusion to MTTR

- **Summary:** `MttrService` calls `WorkingTimeService.workingHoursBetween()` so that
  weekend hours are excluded from incident duration.
- **Pros:**
  - Consistent time semantics across all duration metrics.
- **Cons:**
  - Incorrect for the use case: a P1 incident lasting from Saturday 14:00 to Sunday 10:00
    would report 0 working hours, implying the incident was instantaneously resolved.
    This is factually wrong and would make MTTR values appear deceptively low.
  - Diverges from industry-standard DORA MTTR definition.
  - On-call engineers working weekends would have their response effort invisible in the
    metric. Ruled out.

---

## Decision

> `MttrService` intentionally does **not** apply working-time exclusion. MTTR is calculated
> in calendar hours (total elapsed milliseconds ÷ 3,600,000). A comment in
> `backend/src/metrics/mttr.service.ts` documents that this is a deliberate decision:
> production incidents are not bounded by working hours and must be measured in calendar time.

---

## Rationale

Production incidents impose obligations on engineering teams at any hour of any day. A
Saturday outage that takes four hours to resolve is a four-hour MTTR — that time is
meaningful and should not be erased from the metric. The DORA research framework measures
MTTR in calendar time for this reason. Applying working-hour exclusion to MTTR would
produce an artificially optimistic figure that conceals weekend incident response burden.

---

## Consequences

### Positive

- MTTR values accurately represent the real elapsed recovery time including weekend
  incidents, which is the correct and industry-standard measurement.
- The `MttrService` implementation requires no change beyond adding an explanatory comment.
- The distinction between MTTR (calendar hours) and cycle/lead time (working days) is
  semantically correct and defensible to stakeholders.

### Negative / Trade-offs

- MTTR and cycle-time/lead-time metrics use different time semantics. The UI and
  documentation must make this explicit to avoid confusion. MTTR is displayed in hours
  (calendar); cycle time and lead time are displayed in working days.
- The deliberate divergence from `WorkingTimeService` must be explained to any developer
  who later reviews the metric services and wonders why MTTR is the exception.

### Risks

- Future developers may incorrectly apply `WorkingTimeService` to `MttrService` for
  consistency. The code comment and this ADR serve as the guard against that mistake.

---

## Related Decisions

- [ADR-0024](0024-weekend-exclusion-from-cycle-time-and-lead-time.md) — The decision to
  exclude weekends from cycle time and lead time, which this decision deliberately does
  not extend to MTTR
- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — Per-board MTTR
  configuration; the calendar-hours calculation operates within that per-board framework
