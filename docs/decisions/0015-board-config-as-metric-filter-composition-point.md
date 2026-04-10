# ADR-0015 — BoardConfig as the Sole Composition Point for Metric Filter Rules

**Date:** 2026-04-10
**Status:** Proposed (pending acceptance of Proposal 0003)
**Author:** Architect Agent
**Supersedes:** N/A
**Related proposals:** [0003](../proposals/0003-mttr-priority-filter-and-cfr-causal-link.md)

---

## Context

ADR-0003 established that per-board configuration rules for CFR and MTTR are stored in
the `BoardConfig` entity and loaded at runtime, never hardcoded. That decision covered
issue-type and label-based rules.

Proposal 0003 extends this pattern in two directions:

1. **Attribute filter (MTTR):** A new `incidentPriorities` array on `BoardConfig` gates
   whether an incident-candidate issue passes MTTR calculation based on the issue's
   `priority` field. This is a new dimension of filtering — not based on issue type or
   label membership, but on a structured attribute field (`priority`) of the issue.

2. **Relationship filter (CFR):** The existing `failureLinkTypes` array on `BoardConfig`
   is activated to gate whether a failure-candidate issue is counted based on the
   presence of a qualifying issue link in `jira_issue_links`. This is a new dimension of
   filtering — not based on issue attributes at all, but on the existence of a
   relationship between issues.

Together, these two changes establish a three-tier filter pattern for metric issue
classification:

```
Tier 1 — Type / Label (OR)     → already established in ADR-0003
Tier 2 — Attribute (AND)       → new: incidentPriorities / priority field
Tier 3 — Relationship (AND)    → new: failureLinkTypes / jira_issue_links
```

Both Tier 2 and Tier 3 filters follow the **empty-list-means-disabled** convention:
when the config array is empty, the corresponding filter tier is skipped entirely,
making the behaviour backwards-compatible with existing boards that have no config.

---

## Decision

**`BoardConfig` is the sole composition point for all metric filter rules.** All filter
dimensions — type membership, label membership, attribute values, and issue relationships
— are expressed as arrays of strings on `BoardConfig` and evaluated inside the relevant
metric service (`MttrService`, `CfrService`). No filter logic is hardcoded in services.

The evaluation order within a metric service is:

1. **Tier 1 (type/label OR-gate):** Issue must match at least one configured issue type
   or label. This identifies the candidate set.
2. **Tier 2 (attribute AND-gate):** If the config array is non-empty, the issue's
   corresponding attribute must be in the list. Null/missing attribute values do not
   match any list entry and are excluded.
3. **Tier 3 (relationship AND-gate):** If the config array is non-empty, the issue must
   have at least one row in the relevant relationship table matching a configured type.

Services are the only place where filter rules are applied. Controllers and resolvers
receive only the final computed metric result. This extends ADR-0003's principle.

---

## Consequences

**Positive:**
- Filter behaviour for any board is fully inspectable and editable via the settings page
  without code changes.
- Adding a new filter dimension in the future (e.g. a component filter, a fix-version
  filter) follows the established pattern: add a column to `BoardConfig`, add a `CsvField`
  to the settings page, add an AND-gate in the relevant service.
- The empty-list-means-disabled convention means new filter fields never break existing
  boards: columns default to `'[]'` and the filter tier is a no-op.

**Negative / Trade-offs:**
- `BoardConfig` grows with each new filter dimension. If the number of filter arrays
  becomes large (>8–10), the entity may warrant breaking into sub-tables or a more
  flexible JSONB "rules" column. This is not a concern at the current scale (7 config
  fields after Proposal 0003).
- Tier 3 (relationship) filtering requires an additional database query per metric
  calculation (the `jira_issue_links` sub-query in `CfrService`). This is acceptable
  given the single-board, bounded query pattern, but must be monitored if board issue
  counts grow significantly.
- The `incidentPriorities` Tier 2 filter requires the `JiraIssue.priority` column to be
  populated by the sync service. If the sync does not yet write `priority`, all issues
  will have `priority = null` and the filter will exclude them all when
  `incidentPriorities` is non-empty. This makes the sync dependency explicit and visible
  (rather than silently wrong).

---

## Compliance Notes

- All Jira API calls remain routed through `JiraClientService`. The sync service reads
  `fields.issuelinks` from the existing issue fetch response — no new Jira endpoints.
- `ConfigService` (not `process.env`) must be used for any environment variables in
  affected services.
- Migrations must have both `up()` and `down()` methods implemented.
- No TypeScript `any` types may be introduced.
