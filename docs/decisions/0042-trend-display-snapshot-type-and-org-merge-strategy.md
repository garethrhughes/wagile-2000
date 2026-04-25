# 0042 — `trend-display` Snapshot Type, Org-Merge Strategy, and Trend Array Direction

**Date:** 2026-04-25
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The initial Lambda snapshot architecture (ADR-0040) defined two snapshot types for the
`dora_snapshots` table: `aggregate` and `trend`. During implementation (commit b929af2),
three concrete problems emerged that required the snapshot design to be refined before
the feature could ship:

### Problem 1 — Shape mismatch between per-board and org trend payloads

The DORA trend endpoint must serve two distinct consumers:

1. **Single-board trend chart** — the frontend expects `OrgDoraResult[]`, a structure
   containing `orgDeploymentFrequency`, `orgLeadTime`, `orgChangeFailureRate`, `orgMttr`
   fields and a `period.label` for each time period, with a `boardBreakdowns` field
   listing per-board contributions.
2. **Org-level trend merge** — when computing the org aggregate, the Lambda needs raw
   per-board metric payloads (e.g. `{ df: MetricResult, lt: ..., cfr: ..., mttr: ... }`)
   to merge across boards statistically. The consumer-facing `OrgDoraResult[]` shape is
   not suitable for merging because it has already been band-classified and rounded.

A single `trend` snapshot type cannot serve both purposes: it either stores raw
computation output (merge-friendly but not directly consumable by the frontend) or
stores the fully formatted frontend shape (consumable but not merge-friendly).

### Problem 2 — Org snapshot computed by re-loading all Jira data

The original proposal had the Lambda re-run `TrendDataLoader.load(allBoardIds, ...)` for
the org snapshot on every per-board invocation, loading all Jira data for all boards
inside the same Lambda execution. On large deployments this approach approaches or
exceeds the Lambda's 512 MB memory budget, and the redundant data loading (re-loading
boards that have already been individually computed) is wasteful.

### Problem 3 — Trend arrays rendered newest-first

The frontend trend charts were rendering periods in descending order (newest period on
the left, oldest on the right), which is counterintuitive for time-series charts. The
snapshot writer was the natural place to enforce the correct ordering convention.

---

## Decision

### 1. Three snapshot types: `aggregate`, `trend`, and `trend-display`

The `DoraSnapshotType` union is extended to three values:

```typescript
export type DoraSnapshotType = 'aggregate' | 'trend' | 'trend-display';
```

Semantics per type:

| Type | Stored payload shape | Primary consumer |
|---|---|---|
| `aggregate` | Single-period per-board summary (all four metric results) | DORA overview card |
| `trend` | Raw per-board metric output array `{ period, df, lt, cfr, mttr }[]` | Lambda org merge step |
| `trend-display` | `OrgDoraResult[]` — fully formatted, frontend-ready, with `period.label`, `boardBreakdowns`, `orgDeploymentFrequency`, etc. | `/api/metrics/dora/trend` endpoint |

The `trend` snapshot is an internal artifact consumed only by the Lambda org-merge step.
The `trend-display` snapshot is the external artifact consumed directly by the frontend
via the API endpoint.

### 2. Org snapshot computed by merging per-board `trend` snapshots

The Lambda is invoked twice per sync cycle:

1. **Per-board invocations** (one per board, fired by `SyncService.syncBoard()`) —
   each writes `aggregate`, `trend`, and `trend-display` snapshots for its board.
2. **Org invocation** (a single separate invocation fired by `LambdaInvokerService`
   after all per-board invocations have been dispatched) — reads the `trend` snapshots
   for all boards from `dora_snapshots`, merges raw metric payloads across boards to
   produce org-level `aggregate` and `trend-display` snapshots for `boardId = '__org__'`.

The org invocation never calls `TrendDataLoader` and never touches `JiraIssue` or
`JiraChangelog` tables. Its only reads are from `dora_snapshots` (small JSONB rows).
This caps the org Lambda's memory at well under 50 MB regardless of board count.

`InProcessSnapshotService` mirrors this split: `computeBoard(boardId)` and
`computeOrg()` are separate methods called sequentially by the sync post-hook.

### 3. `trend-display` payload shape includes `boardBreakdowns` and `period.label`

Each entry in a `trend-display` payload is an `OrgDoraResult`:

```typescript
interface OrgDoraResult {
  period: { label: string; startDate: string; endDate: string };
  orgDeploymentFrequency: MetricResult;
  orgLeadTime:            MetricResult;
  orgChangeFailureRate:   MetricResult;
  orgMttr:                MetricResult;
  boardBreakdowns: Array<{
    boardId: string;
    deploymentFrequency: MetricResult;
    leadTime:            MetricResult;
    changeFailureRate:   MetricResult;
    mttr:                MetricResult;
  }>;
}
```

`boardBreakdowns` was absent in the initial proposal. It is required by the frontend's
per-board comparison rows within the trend view.

### 4. `GET /api/metrics/dora/trend` selects snapshot type by query

- **Single-board query** (`?boardId=ACC`) → reads `trend-display` for `ACC`.
- **Multi-board or org query** (`?boardId=__org__` or no boardId) → reads `trend` for
  `__org__`.

In the current implementation, the org-level payload stored under `trend` is already
display-shaped for API consumption, so multi-board/org trend responses are served from
that snapshot type. `trend-display` remains the per-board display snapshot.

### 5. Trend arrays are stored oldest-to-newest; sort enforced at named write points

All `trend` and `trend-display` payloads must be written in ascending chronological
order (oldest quarter first, most recent quarter last). The frontend consumes this order
directly and must **not** reverse the array.

The sort is enforced at the following specific locations in the codebase:

| Location | How sort is enforced |
|---|---|
| `backend/src/lambda/snapshot.handler.ts` — per-board `trendPayload` | `.reverse()` applied after mapping over `quarters` (newest-first from `listRecentQuarters`) |
| `backend/src/lambda/snapshot.handler.ts` — per-board `trendDisplayPayload` | `.reverse()` applied after mapping over `quarters` |
| `backend/src/lambda/snapshot.handler.ts` — org `orgTrendPayload` | `mergedEntries` sorted ascending by `startDate.localeCompare()` before mapping |
| `backend/src/metrics/metrics.service.ts` — `getDoraTrend()` | `points.reverse()` on line ~308 after mapping over `quarters` |
| `backend/src/lambda/in-process-snapshot.service.ts` — org `orgTrend` | `.reverse()` after `Promise.all` over `quarters` (newest-first) |

The frontend (`frontend/src/app/dora/page.tsx`) stores the trend array from the API
directly into page state without reversing. No frontend sort is required or permitted —
the backend is the sole authority on array direction.

---

## Rationale

Separating `trend` (raw, merge-friendly) from `trend-display` (formatted, frontend-ready)
follows the principle of storing data in the format that best serves each consumer.
The Lambda merge step needs raw metric values to produce statistically meaningful
org-level medians and rates; the frontend needs a flat, pre-formatted structure it can
render without further computation.

Separating the org snapshot computation into its own invocation eliminates the
`TrendDataLoader` all-boards bulk load from the Lambda memory budget. Reading pre-computed
per-board `trend` snapshots (JSONB rows, < 50 KB each) scales linearly with board count
at negligible memory cost.

The trend array direction decision (oldest-to-newest) is a display convention, not a
calculation concern. Enforcing it at the snapshot write step means no consumer (API,
frontend) needs to sort or reverse the array.

---

## Consequences

### Positive

- The org snapshot computation is fast and memory-trivial: it reads 6 small JSONB rows
  and merges them.
- Frontend can consume `trend-display` snapshots directly without any post-processing.
- `boardBreakdowns` in the trend payload enables per-board drill-down without a second
  API call.
- Trend charts render in the correct chronological direction (oldest left, newest right)
  without any frontend transforms. The frontend must not reverse the array — ordering is
  enforced exclusively at the backend write points listed in §5 above.

### Negative / Trade-offs

- Three snapshot types per board instead of two: 3 × 6 boards + 2 org snapshots = 20
  rows in `dora_snapshots`. Trivial at this scale.
- The org invocation has a data dependency on all per-board `trend` snapshots being
  present. If a per-board invocation fails, the org merge uses stale per-board data.
  This is acceptable: the org snapshot's `computedAt` reflects the org invocation time;
  `X-Snapshot-Stale` headers surface any staleness to the consumer.
- `InProcessSnapshotService` must mirror the `computeBoard` / `computeOrg` split of the
  Lambda handler to maintain local dev parity. Changes to the snapshot computation logic
  must be applied in both places.

### Risks

- If a new `boardBreakdowns` field is added to `OrgDoraResult` in the future, all
  existing `trend-display` snapshots will be missing that field until the next sync cycle.
  The frontend must be robust to missing or null fields in the JSONB payload, treating
  them as empty arrays rather than crashing.

---

## Related Decisions

- [ADR-0040](0040-lambda-post-sync-dora-snapshot-computation.md) — The Lambda snapshot
  architecture that this ADR refines
- [ADR-0041](0041-postgres-advisory-lock-for-sync-serialisation.md) — Sync serialisation
  that ensures per-board snapshots are not written concurrently by two instances
