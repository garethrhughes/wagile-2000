# 0023 — `jpdDeliveryLinkInward` / `jpdDeliveryLinkOutward` Accept String or Array

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent
**Proposal:** [0028 — Jira Field ID and Instance-Specific Value Externalisation](../proposals/0028-jira-field-id-externalisation.md)

## Context

The `jira:` YAML stanza introduced in ADR-0021 includes two fields — `jpdDeliveryLinkInward`
and `jpdDeliveryLinkOutward` — that hold lists of JPD delivery link type name substrings.
The Zod schema validating `boards.yaml` must declare the shape of these fields.

The values are typically short lists (one or two entries matching Atlassian defaults), but an
operator with a single custom link type name would naturally write a bare scalar string rather
than a one-element YAML array. Requiring array syntax for a common single-value case
(`- "is implemented by"` vs `"is implemented by"`) adds friction with no technical benefit.

---

## Options Considered

### Option A — Accept only YAML arrays (`z.array(z.string())`) (rejected)

- **Summary:** The Zod schema declares both fields as `z.array(z.string())`. Operators must
  always use YAML list syntax, even for a single value.
- **Pros:** Schema is simple and unambiguous; no transform logic.
- **Cons:** Operators writing a single link type name must remember to use the YAML list
  syntax (`- "value"` or `["value"]`). A bare scalar produces a Zod validation error with a
  confusing message. This is hostile UX for the most common configuration case.

### Option B — Accept only bare strings (`z.string()`) (rejected)

- **Summary:** Both fields are declared as `z.string()`. Multiple link type names would need
  to be comma-separated or some other delimiter, or the feature simply can't support multiple
  values.
- **Pros:** Simplest schema.
- **Cons:** Loses the ability to configure multiple link type names — directly contradicts
  the multi-value use case where an organisation uses both Atlassian default and custom link
  types. Ruled out.

### Option C — Union with coercion: string is auto-wrapped into a single-element array (selected)

- **Summary:** The Zod schema declares `z.union([z.string().transform(s => [s]), z.array(z.string())])`.
  A bare string is transparently coerced to a one-element array. An array is passed through
  unchanged. The rest of the application always receives `string[]`.
- **Pros:**
  - Operators naturally write a bare scalar for the common single-value case; no YAML list
    syntax required.
  - Multiple values are still supported by writing a YAML array.
  - The downstream code (`SyncService`, `JiraFieldConfig` entity) always works with
    `string[]` — no branching on the input type in application code.
- **Cons:**
  - The Zod schema is slightly more complex than a plain `z.array(z.string())`.
  - Developers reading the schema must understand the union-with-transform pattern.

---

## Decision

> The Zod schema for `jpdDeliveryLinkInward` and `jpdDeliveryLinkOutward` in
> `boards-yaml.schema.ts` uses `z.union([z.string().transform(s => [s]), z.array(z.string())])`.
> A bare scalar string is automatically coerced to a single-element array. The `JiraFieldConfig`
> entity stores both fields as `simple-json` `string[]` columns. All downstream code receives
> a `string[]` unconditionally.

---

## Rationale

Operators configuring a single link type name — the common case — should not be required
to use YAML array syntax. The coercion union is a one-time complexity cost in the schema
layer that is completely transparent to the rest of the application. The alternative of
requiring array syntax for a single value imposes a recurring UX burden every time an
operator touches the config file.

---

## Consequences

### Positive

- Operators can write `jpdDeliveryLinkInward: "is implemented by"` (scalar) or
  `jpdDeliveryLinkInward: ["is implemented by", "is delivered by"]` (array) with equal
  validity. Both produce identical runtime behaviour.
- Application code never needs to check `Array.isArray()`; the value is always `string[]`.

### Negative / Trade-offs

- The Zod union-with-transform pattern is less immediately obvious than a plain array
  schema. New developers maintaining the schema should read this ADR for context.
- The `z.union` ordering matters: string is tested before array, so a YAML value that is
  already an array will not be matched by the string branch. This is correct but requires
  understanding union evaluation order.

### Risks

- If Zod's `union` discrimination behaviour changes in a future major version, the transform
  may no longer fire as expected. This is mitigated by the project's pinned Zod version and
  the unit tests for the YAML schema.

---

## Related Decisions

- [ADR-0021](0021-jira-field-ids-externalised-to-yaml-config.md) — The parent decision
  that introduced the `jira:` stanza and these two fields
