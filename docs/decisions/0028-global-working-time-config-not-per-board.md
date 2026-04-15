# 0028 — Global Working-Time Config, Not Per-Board

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0029 — Working-Time Service: Exclude Weekends from Flow Metrics](../proposals/0029-working-time-service.md)

## Context

The working-time configuration introduced in ADR-0024 (`excludeWeekends`, `workDays`,
`hoursPerDay`, `holidays`) needed a storage scope decision: should these settings apply
globally to all boards, or should each board be able to configure its own working week
independently via `BoardConfig`?

The project already has a well-established per-board configuration mechanism (`BoardConfig`
entity with `doneStatusNames`, `inProgressStatusNames`, `failureIssueTypes`, etc.) and a
global singleton pattern for tenant-wide settings (`JiraFieldConfig`, PK=1, introduced in
ADR-0021). The working-time config is of a fundamentally different character from the
board-specific status name mappings.

---

## Options Considered

### Option A — Global singleton `WorkingTimeConfigEntity` (PK=1) (selected)

- **Summary:** A single row in `working_time_config` (always `id = 1`) stores `excludeWeekends`,
  `workDays`, `hoursPerDay`, and `holidays`. All boards use the same values. The stanza is
  configured via `workingTime:` in `boards.yaml` and upserted on boot by `YamlConfigService`.
- **Pros:**
  - A team's working week is an organisation-wide constant, not a per-board property.
    Cross-board DORA aggregate views (deployment frequency, lead time across boards) require
    a consistent time unit to be meaningful.
  - Per-board inconsistency would allow board A to report "3 working days" and board B to
    report "3.5 calendar days" for identical timespans — making the multi-board comparison
    view actively misleading.
  - Mirrors the `JiraFieldConfig` singleton pattern established in ADR-0021, keeping the
    config model consistent.
  - Simple to implement: `WorkingTimeService` loads one row, not one row per board.
- **Cons:**
  - Teams in different geographic locations (e.g. one board owned by an APAC team, another
    by a MENA team with a Sun–Thu working week) cannot be independently configured without
    a code change or a future schema migration.

### Option B — Per-board working-time settings as additional `BoardConfig` columns

- **Summary:** Add `excludeWeekends`, `workDays`, `hoursPerDay`, and `holidays` columns to
  the existing `board_configs` table. Each board independently declares its working week.
- **Pros:**
  - Supports multi-region organisations with different working weeks per board.
- **Cons:**
  - Breaks cross-board DORA aggregation: if board A uses Mon–Fri 8h/day and board B uses
    Sun–Thu 7.5h/day, the aggregated multi-board cycle-time distribution combines
    incommensurable day-unit values.
  - Requires a DB migration and DTO change for `BoardConfig`; adds four new fields to the
    settings UI for every board — significant overhead for an edge case.
  - The `excludeWeekends` flag can always be promoted to `BoardConfig` in a future proposal
    if a genuine multi-region requirement emerges. Starting global is the right default.
  - Ruled out.

---

## Decision

> `WorkingTimeConfigEntity` is a singleton entity (table `working_time_config`, PK=1) that
> applies uniformly to all boards. It stores `excludeWeekends` (boolean, default `true`),
> `workDays` (integer array, default `[1,2,3,4,5]`), `hoursPerDay` (integer, default `8`),
> and `holidays` (ISO date string array, default `[]`). Per-board working-time settings are
> not supported in this implementation.

---

## Rationale

A team's working week is an organisational constant. The multi-board DORA aggregate view is
a first-class feature of this dashboard; it requires that cycle-time and lead-time values
from different boards use the same time unit. Per-board settings would undermine that
consistency and add disproportionate complexity for a use case (multi-region working-week
variation) that is not present in the target organisation. The global singleton model can be
evolved to per-board in a future proposal if evidence of need emerges.

---

## Consequences

### Positive

- Cross-board DORA aggregate metrics use a consistent time unit, making comparisons valid.
- The `WorkingTimeService` loads a single config row — simple, fast, and easy to reason about.
- The `workingTime:` stanza in `boards.yaml` is a single top-level key, not nested under
  each board definition.

### Negative / Trade-offs

- Organisations with boards owned by teams in different geographic regions with different
  standard working weeks cannot configure them independently without a future schema change.
  This is an accepted limitation for the current scope.

### Risks

- If the tool is adopted by a multi-region organisation, per-board working-time config will
  need to be introduced. The singleton pattern can be extended to a per-board pattern via
  a migration that copies the global row values into a new `BoardConfig` column with the
  same defaults, preserving existing behaviour.

---

## Related Decisions

- [ADR-0024](0024-weekend-exclusion-from-cycle-time-and-lead-time.md) — The parent decision
  establishing `WorkingTimeService` and its configuration needs
- [ADR-0021](0021-jira-field-ids-externalised-to-yaml-config.md) — The `JiraFieldConfig`
  singleton pattern that this decision mirrors
- [ADR-0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) — The per-board
  `BoardConfig` pattern that this decision consciously does not extend to working-time settings
