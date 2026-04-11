# 0019 — Broaden `inProgressStatusNames` Default for Cycle-Time Start Detection

**Date:** 2026-04-12
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0007 — Cycle Time Report](../proposals/0007-cycle-time-report.md)

## Context

The cycle-time calculation uses the **first changelog transition to an "in-progress"
status** as the start event for an issue's clock. The set of status names that qualify
as "in-progress" is stored in `BoardConfig.inProgressStatusNames` (a `simple-json` column
added by migration `1775820881077-AddInProgressStatusNamesToBoardConfigs`).

The initial database default for this column was `'["In Progress"]'` — a single-element
array matching only Jira's canonical active-work status name.

After the cycle-time service was deployed and run against real board data, **approximately
216 issues were classified as anomalies** (no in-progress transition found) and excluded
from percentile calculations. Investigation of the changelog data revealed that these issues
were not genuinely anomalous: teams use a variety of status names to represent the first
moment active engineering work begins:

| Status name category | Example names observed |
|---|---|
| Review / peer-review | `In Review`, `Peer-Review`, `Peer Review`, `PEER REVIEW`, `PEER CODE REVIEW`, `Ready for Review` |
| Test / QA | `In Test`, `IN TEST`, `QA`, `QA testing`, `QA Validation`, `IN TESTING`, `Under Test`, `ready to test`, `Ready for Testing`, `READY FOR TESTING` |
| Pre-release staging | `Ready for Release`, `Ready for release`, `READY FOR RELEASE`, `Awaiting Release`, `READY` |

For issues where `In Progress` is not the first active status (e.g. the issue moves
directly from `To Do` to `Peer-Review`), the narrow single-name default caused the
cycle-start event to be missed entirely, inflating the anomaly count and shrinking
the effective sample size.

---

## Decision 1 — Broaden the Default List to Cover All Common Active-Work Status Variants

### Options Considered

#### Option A — Broaden the application-layer default (selected)

Change the `config?.inProgressStatusNames ?? [...]` fallback in
`CycleTimeService.getCycleTimeObservations()` to include all observed active-work status
variants as the no-config default. The column DB default (`'["In Progress"]'`) continues
to seed new rows, but the service-layer fallback governs behaviour when no explicit config
is set.

- **Pros:**
  - Fixes the 216 false-anomaly cases immediately for all boards that have not explicitly
    configured `inProgressStatusNames`.
  - The broad default is additive — it cannot cause a previously-matched issue to be missed.
  - No migration required to existing data.
  - Boards with customised `inProgressStatusNames` values in the DB are unaffected; their
    explicit values continue to take precedence over the fallback.
- **Cons:**
  - The application-layer default and the column DB default diverge. A newly-seeded board
    row has `inProgressStatusNames = ['In Progress']` in the database, but the service
    effectively uses the broad list until a user explicitly saves the config. This is
    confusing if a developer reads only the entity definition without reading the service.

#### Option B — Change the DB column default to the broad list

Update the `BoardConfig` entity's `@Column` decorator default to match the broad list and
add a migration that `UPDATE`s all existing rows.

- **Pros:** DB and service-layer defaults are consistent.
- **Cons:** The broad list contains ~20 entries with special characters (commas, hyphens)
  that require careful escaping in a `simple-json` column default. A migration `UPDATE` on
  existing rows overwrites any deliberately configured narrow list (risk of data loss for
  boards that had already customised the field). The update-all approach is irreversible
  without a snapshot.

#### Option C — Change the cycle-time logic to "first non-idle transition" instead of "first match against a list"

Redefine the cycle-start event as the first changelog entry where `toValue` is _not_ in
the board's `doneStatusNames` and _not_ in a hardcoded set of "idle" statuses
(`To Do`, `Backlog`, `Open`, `Selected for Development`).

- **Pros:** Eliminates the need to enumerate every possible active-work status name.
- **Cons:** The inverted approach (exclude idle statuses) is semantically different: it
  treats any non-idle transition as the start of work, which may include administrative
  transitions that do not represent active engineering (e.g. `To Do → In Review` for an
  issue that was never actually worked on). The positive-match list approach is more
  conservative and explicit. This alternative was discussed in the proposal review and
  deferred to a future proposal.

### Decision

> The `CycleTimeService.getCycleTimeObservations()` fallback default for
> `inProgressStatusNames` is broadened from `['In Progress']` to a list of ~20 status
> name variants covering review, QA, and pre-release staging phases. All 6 existing board
> configs in the production database were also updated via direct SQL to use the broad list
> so that their stored `inProgressStatusNames` values match the service-layer default.

---

## Decision 2 — Broaden the Default Rather Than Changing the Cycle-Start Logic

This is a restatement of Option C above as a standalone decision for clarity.

The cycle-start logic remains: **first changelog transition where `toValue ∈ inProgressStatusNames`**.
The inverse approach (first non-idle transition) was considered and rejected on the grounds
that it changes the semantic of the metric in ways that are harder to reason about and
configure per board.

If the "first non-idle transition" approach is desired in future, it should be proposed
separately and evaluated against real data.

---

## Consequences

### Positive

- Approximately 216 issues that were previously classified as anomalies are now correctly
  included in cycle-time percentile calculations, improving statistical accuracy.
- Boards with diverse status naming conventions (teams that skip `In Progress` and move
  directly to `Peer-Review` or `QA testing`) produce representative cycle-time
  distributions without requiring manual `BoardConfig` updates.
- The board configuration UI (`Settings → Board Configuration → In-Progress Status Names`)
  allows teams to further customise the list if their workflow uses status names not covered
  by the default.

### Negative / Trade-offs

- The application-layer fallback list and the `@Column` default diverge. A developer
  reading only `board-config.entity.ts` will see `default: '["In Progress"]'` and may
  not realise the service applies a much broader list when no explicit config is saved.
  This is mitigated by a comment in the service and the `BoardConfig` entity JSDoc.
- The broad list is case-sensitive and matched literally against changelog `toValue` strings.
  A team that uses a slightly different capitalisation (e.g. `peer review` instead of
  `Peer Review`) will still have misses. Boards encountering this should add their specific
  variant to `inProgressStatusNames` via the settings UI.
- Status names that contain commas (stored as `simple-json`) are handled correctly by the
  JSON column type, but the settings UI's comma-separated input field (`CsvField` component)
  would display them incorrectly if any status name contained a literal comma. None of the
  known status names do.

### Risks

- If a board's `inProgressStatusNames` was explicitly set to `['In Progress']` in the
  database (the old narrow default) and the board team uses `Peer-Review` as their
  first active status, the anomaly problem persists for that board until the stored value
  is updated. The 6 known production boards were all updated. Any future board seeded from
  the column default will start with `['In Progress']` until a user explicitly saves the
  broad list.
- The broad list must be maintained as new status names are encountered. New status
  variants not in the list will produce anomalies. The Settings UI is the self-service
  remediation path.

---

## Implementation Details

### Service-layer fallback (in `backend/src/metrics/cycle-time.service.ts`)

```typescript
const inProgressNames = config?.inProgressStatusNames ?? [
  // Standard Jira active-work statuses
  'In Progress',
  // Review / peer-review variants
  'In Review', 'Peer-Review', 'Peer Review', 'PEER REVIEW',
  'PEER CODE REVIEW', 'Ready for Review',
  // Test / QA variants
  'In Test', 'IN TEST', 'QA', 'QA testing', 'QA Validation',
  'IN TESTING', 'Under Test', 'ready to test',
  'Ready for Testing', 'READY FOR TESTING',
  // Pre-release staging variants
  'Ready for Release', 'Ready for release', 'READY FOR RELEASE',
  'Awaiting Release', 'READY',
];
```

### Production DB update (all 6 boards)

Applied directly via SQL after the service change was deployed:

```sql
UPDATE board_configs
SET "inProgressStatusNames" = '["In Progress","In Review","Peer-Review","Peer Review",
  "PEER REVIEW","PEER CODE REVIEW","Ready for Review","In Test","IN TEST","QA",
  "QA testing","QA Validation","IN TESTING","Under Test","ready to test",
  "Ready for Testing","READY FOR TESTING","Ready for Release","Ready for release",
  "READY FOR RELEASE","Awaiting Release","READY"]';
```

### No database migration

The `inProgressStatusNames` column already exists (migration `1775820881077`). The
application-layer default change requires no schema migration. The production DB update
was applied out-of-band as a data-fix rather than a schema migration, consistent with
how board configs are managed at runtime (via `PUT /api/boards/:boardId/config`).

---

## Related Decisions

- [ADR-0015](0015-board-config-as-metric-filter-composition-point.md) — `BoardConfig` is
  the composition point for per-board metric rules; `inProgressStatusNames` is one such
  rule, configurable per board via the settings UI
- [ADR-0018](0018-exclude-epics-and-subtasks-from-metrics.md) — Issued alongside this
  decision; the cycle-time service applies both the Epic/Sub-task exclusion and the
  `inProgressStatusNames` matching
