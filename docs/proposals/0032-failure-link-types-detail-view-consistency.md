# 0032 — Apply `failureLinkTypes` AND-gate consistently across all detail views

**Date:** 2026-04-16
**Status:** Draft
**Author:** Architect Agent
**Related ADRs:** None yet — will be created on acceptance
**Supersedes:** Proposal 0030 §Fix B-5 (intentional-omission documentation comments)

---

## Problem Statement

`failureLinkTypes` is a `BoardConfig` setting that requires a Jira causal issue
link (e.g. `"caused by"`) before an issue is classified as a failure.  This
AND-gate is correctly applied in the aggregate CFR service
(`backend/src/metrics/cfr.service.ts` lines 176–191), but is **completely
ignored** in all three detail views:

- `backend/src/sprint/sprint-detail.service.ts` lines 461–463
- `backend/src/quarter/quarter-detail.service.ts` lines 306–308
- `backend/src/week/week-detail.service.ts` lines 305–307

As a result, every `Bug`-typed issue (or any issue matching `failureIssueTypes`
/ `failureLabels`) is marked `isFailure = true` in sprint, quarter, and week
detail views regardless of whether it has the required causal link.  This causes
all bugs to appear as failures in the sprint overview, which is incorrect for
teams that use causal links to distinguish deployment-caused failures from
ordinary bugs.

This inconsistency was introduced in Proposal 0030 §B-5, which added inline
comments describing the omission as intentional.  This proposal supersedes that
decision and implements the gate.

---

## Proposed Solution

Apply the same `failureLinkTypes` AND-gate logic used in `CfrService`
(lines 176–191) to all three detail services.

### Step-by-step implementation

**Step 1 — Inject `Repository<JiraIssueLink>` into each detail service.**

Each of `SprintDetailService`, `QuarterDetailService`, and `WeekDetailService`
already receives TypeORM repositories via constructor injection.  Add a
`@InjectRepository(JiraIssueLink)` parameter to each.

**Step 2 — After the issue set for the view is known, perform a single bulk
query.**

```typescript
// Load once per detail-view request, after the issue key set is known.
const failureLinkTypes: string[] = config?.failureLinkTypes ?? [];

let issueKeysWithCausalLink = new Set<string>();

if (failureLinkTypes.length > 0) {
  const linkRows = await this.issueLinkRepo
    .createQueryBuilder('l')
    .select('l.sourceIssueKey', 'key')
    .where('l.sourceIssueKey IN (:...keys)', { keys: issueKeys })
    .andWhere('LOWER(l.linkTypeName) IN (:...types)', {
      types: failureLinkTypes.map((t) => t.toLowerCase()),
    })
    .getRawMany<{ key: string }>();

  issueKeysWithCausalLink = new Set(linkRows.map((r) => r.key));
}
```

The query is issued once per detail-view call — not once per issue — ensuring
O(1) round-trips to the database regardless of how many issues are in the view.

**Step 3 — Build a `Set<string>` of issue keys that have a matching causal
link.**

The `Set` is constructed from the bulk query result (see Step 2 above).

**Step 4 — Apply the AND-gate to `isFailure`.**

```typescript
// BEFORE (type/label match only):
const isFailure =
  failureIssueTypes.includes(issue.issueType) ||
  (failureLabels.length > 0 && issue.labels?.some((l) => failureLabels.includes(l)));

// AFTER (type/label match AND causal-link gate):
const passesTypeGate =
  failureIssueTypes.includes(issue.issueType) ||
  (failureLabels.length > 0 && issue.labels?.some((l) => failureLabels.includes(l)));

const passesLinkGate =
  failureLinkTypes.length === 0 ||
  issueKeysWithCausalLink.has(issue.key);

const isFailure = passesTypeGate && passesLinkGate;
```

When `failureLinkTypes` is empty (the default), `passesLinkGate` is always
`true` — the gate is a no-op and backward compatibility is fully preserved.

**Step 5 — Register `JiraIssueLink` in `TypeOrmModule.forFeature`.**

Update the module definitions to expose the `JiraIssueLink` repository:

| Module file | Change |
|---|---|
| `backend/src/sprint/sprint.module.ts` | Add `JiraIssueLink` to `TypeOrmModule.forFeature([...])` |
| `backend/src/quarter/quarter.module.ts` | Same |
| `backend/src/week/week.module.ts` | Same |

**Step 6 — Remove the 0030 §B-5 intentional-omission comments.**

The comments added to `quarter-detail.service.ts` and `week-detail.service.ts`
by Proposal 0030 §B-5 must be removed.  Replace them with a short comment at
the AND-gate site describing the active behaviour:

```typescript
// failureLinkTypes AND-gate: when configured, only issues with a matching
// causal link (e.g. 'caused by') are classified as failures.  When
// failureLinkTypes is empty (the default), all type/label matches qualify.
// See Proposal 0032.
```

### Data flow

```
Detail view request
  └─ load BoardConfig (failureLinkTypes)
       ├─ [if failureLinkTypes.length > 0]
       │    └─ SELECT sourceIssueKey FROM jira_issue_links
       │         WHERE sourceIssueKey IN (...issueKeys)
       │         AND LOWER(linkTypeName) IN (...failureLinkTypes)
       │    └─ build Set<issueKey>
       └─ for each issue:
            isFailure = passesTypeGate AND passesLinkGate
```

### Files affected

| File | Change |
|---|---|
| `backend/src/sprint/sprint-detail.service.ts` | Inject `JiraIssueLinkRepository`; add bulk link query; apply AND-gate at lines 461–463 |
| `backend/src/sprint/sprint.module.ts` | Add `JiraIssueLink` to `TypeOrmModule.forFeature` |
| `backend/src/sprint/sprint-detail.service.spec.ts` | New test cases (see Acceptance Criteria) |
| `backend/src/quarter/quarter-detail.service.ts` | Same service changes; remove 0030 §B-5 comment; apply AND-gate at lines 306–308 |
| `backend/src/quarter/quarter.module.ts` | Add `JiraIssueLink` to `TypeOrmModule.forFeature` |
| `backend/src/quarter/quarter-detail.service.spec.ts` | New test cases |
| `backend/src/week/week-detail.service.ts` | Same service changes; remove 0030 §B-5 comment; apply AND-gate at lines 305–307 |
| `backend/src/week/week.module.ts` | Add `JiraIssueLink` to `TypeOrmModule.forFeature` |
| `backend/src/week/week-detail.service.spec.ts` | New test cases |

---

## Alternatives Considered

### Alternative A — Keep the omission intentional (status quo from 0030 §B-5)

The 0030 documentation rationale was: detail views show "all incidents in
the period" rather than the strict CFR numerator, so the link gate should not
apply.  This was ruled out because it produces a visible user-facing
inconsistency: the CFR aggregate number and the sprint/quarter/week drill-down
use different classification rules for the same issues.  On a board where
`failureLinkTypes` is configured, every bug appears as a failure in the sprint
view even when CFR correctly excludes it.  The inconsistency erodes trust in
both numbers.

### Alternative B — Add a separate `detailFailureLinkTypes` config field

Introduce a second `BoardConfig` field that controls the AND-gate in detail
views independently of `failureLinkTypes`.  Ruled out as over-engineering: the
correct mental model is that `failureLinkTypes` defines what a failure *is* for
the board.  Both the aggregate metric and the detail view should agree on that
definition.  A second config field would require documentation explaining when
to set them differently, which is unlikely to be a real use case.

### Alternative C — Compute the causal-link set in a shared helper and cache it

Pre-compute the `Set<issueKey>` once per board per sync cycle and store it in
a short-lived cache.  Ruled out as premature: the bulk query (a single `IN`
clause across the already-fetched issue key set) adds negligible latency
compared to the surrounding Postgres queries that retrieve changelog and issue
data.  Introduce caching only if profiling shows it is necessary.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes; `JiraIssueLink` entity and table already exist |
| API contract | None | `isFailure` field already present on detail view response DTOs; its value changes for issues on boards with `failureLinkTypes` configured |
| Frontend | None | No frontend changes required; the `isFailure` flag is already consumed correctly |
| Tests | New unit tests in three spec files | See Acceptance Criteria |
| Jira API | No new calls | All changes operate on already-synced `jira_issue_links` data |
| Backward compatibility | Full | Gate is skipped when `failureLinkTypes = []` (the default); zero behaviour change for boards without causal-link configuration |

---

## Open Questions

None.

---

## Acceptance Criteria

- [ ] `SprintDetailService`, `QuarterDetailService`, and `WeekDetailService` all
      inject `Repository<JiraIssueLink>` and perform a bulk causal-link query
      when `failureLinkTypes` is non-empty.
- [ ] On a board with `failureLinkTypes: ['caused by']`, a `Bug` that has no
      `"caused by"` link is **not** marked `isFailure = true` in sprint, quarter,
      and week detail views.
- [ ] On the same board, a `Bug` that **does** have a `"caused by"` link **is**
      marked `isFailure = true` in all three detail views.
- [ ] On a board with `failureLinkTypes: []` (the default), all `Bug` issues
      matching `failureIssueTypes` are still marked `isFailure = true` — no
      regression.
- [ ] The AND-gate logic is consistent with the existing gate in
      `CfrService` (lines 176–191): same query pattern, same empty-list guard.
- [ ] `JiraIssueLink` is registered in `TypeOrmModule.forFeature` for
      `SprintModule`, `QuarterModule`, and `WeekModule`.
- [ ] The intentional-omission comments added by Proposal 0030 §B-5 are removed
      from `quarter-detail.service.ts` and `week-detail.service.ts`.
- [ ] A replacement comment at the AND-gate site in each file references
      Proposal 0032 and describes the active gate behaviour.
- [ ] TypeScript compilation passes without errors across the full backend.
- [ ] No existing passing tests are broken by this change.
