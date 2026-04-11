# 0008 — Exclude Epics and Sub-tasks from All Metric Calculations

**Status:** Accepted
**Date:** 2026-04-11

---

## 1. Problem

Epics are container issues in Jira that group Stories and Tasks. Sub-tasks are child fragments of a Story. Neither represents an independently deliverable unit of work, and both distort every flow metric when included:

- **Deployment frequency / lead time / MTTR / CFR** — Epics and Sub-tasks are counted alongside Stories, inflating issue counts and skewing durations.
- **Cycle time** — Epic cycle times span months (they close only when all children close), pulling percentiles far right.
- **Planning accuracy** — Sprint commitment/completion counts include Epics, making boards look like they carry more work than they do.
- **Quarter/week detail views** — Issue tables show Epics alongside Stories, confusing the per-issue breakdown.

The fix is already partially in place. Several Kanban paths already filter correctly. The work is to close the remaining gaps consistently.

---

## 2. Current State — Full Inventory

### ✅ Already filtering `Epic` AND `Sub-task` correctly

| File | Location | Method |
|---|---|---|
| `planning/planning.service.ts` | Lines 470–471 | `getKanbanQuarters()` |
| `planning/planning.service.ts` | Lines 631–632 | `getKanbanWeeks()` |
| `roadmap/roadmap.service.ts` | Lines 168–169 | `getKanbanAccuracy()` |
| `roadmap/roadmap.service.ts` | Lines 379–380 | `getKanbanWeeklyAccuracy()` |
| `roadmap/roadmap.service.ts` | Lines 519–520 | `getSprintAccuracy()` private helper |
| `sprint/sprint-detail.service.ts` | Line 243 | `getDetail()` |

### ❌ Missing Epic/Sub-task filter (gaps to fix)

| File | Line | Method | Notes |
|---|---|---|---|
| `planning/planning.service.ts` | 141 | `getSprintAccuracy()` | Loads all board issues; no issueType filter |
| `metrics/lead-time.service.ts` | 54 | `getLeadTimeObservations()` | No issueType filter |
| `metrics/mttr.service.ts` | 54 | `getMttrObservations()` | No issueType filter |
| `metrics/cfr.service.ts` | 67 | `calculate()` | No issueType filter on `allIssues`; also line 110 secondary query |
| `metrics/deployment-frequency.service.ts` | 63, 103 | `calculate()` | No issueType filter |
| `metrics/cycle-time.service.ts` | 104 | `getCycleTimeObservations()` | Only filters if caller passes `issueTypeFilter` explicitly |
| `quarter/quarter-detail.service.ts` | 150 | `getDetail()` | No issueType filter on initial issue load |
| `week/week-detail.service.ts` | 158 | `getDetail()` | No issueType filter on initial issue load |

---

## 3. Sub-tasks — Recommendation

**Exclude Sub-tasks alongside Epics.** Rationale:

- All six existing correct filter sites already exclude both: `i.issueType !== 'Epic' && i.issueType !== 'Sub-task'`
- Sub-tasks have no independent sprint assignment or board-entry event — they inherit from their parent Story
- Including Sub-tasks double-counts work (the Story and all its Sub-tasks all appear in the same period)
- The fix to all gap sites must match the existing pattern: exclude both `'Epic'` and `'Sub-task'`

---

## 4. Configuration vs Hardcoding — Recommendation

**Hardcode as a shared constant.** Do not add a new `BoardConfig` column.

Rationale:
- `'Epic'` and `'Sub-task'` are Jira-standard issue type names — not team-specific. No board legitimately wants Epics counted as deliverable work.
- Adding a per-board `excludedIssueTypes` column would add DB migration, DTO changes, settings UI, and `ConfigService` lookup to every service — significant complexity for zero practical benefit.
- The existing correct call sites all hardcode the same two-condition filter. Consistency demands the same pattern at the new sites.

The constant lives in a new shared file `backend/src/metrics/issue-type-filters.ts` (see Section 6).

---

## 5. Centralisation Strategy

**Shared constant + utility function, used at every call site.**

A new file `backend/src/metrics/issue-type-filters.ts` exports:

```typescript
/** Issue types that are never counted as deliverable work items. */
export const EXCLUDED_ISSUE_TYPES = ['Epic', 'Sub-task'] as const;

/** Returns true if the issue should be included in flow metrics. */
export function isWorkItem(issueType: string): boolean {
  return !EXCLUDED_ISSUE_TYPES.includes(issueType as typeof EXCLUDED_ISSUE_TYPES[number]);
}
```

Every call site replaces its inline filter with:

```typescript
import { isWorkItem } from '../metrics/issue-type-filters.js';
// ...
.filter((i) => isWorkItem(i.issueType))
```

And the existing correct sites are updated to use the same utility for consistency (no behaviour change, just DRY).

**Why not a DB-layer approach?** TypeORM `find({ where: { boardId, issueType: Not(In(['Epic', 'Sub-task'])) } })` is possible but couples the exclusion to the ORM call, making it invisible at a glance. The function approach is explicit at the call site and easier to audit.

---

## 6. Complete Change List

### New file
- `backend/src/metrics/issue-type-filters.ts` — exports `EXCLUDED_ISSUE_TYPES` and `isWorkItem()`

### Backend changes (gaps to close)

**`backend/src/planning/planning.service.ts`** — `getSprintAccuracy()`, after line 141:
```typescript
const boardIssues = (await this.issueRepo.find({
  where: { boardId: sprint.boardId },
})).filter((i) => isWorkItem(i.issueType));
```

**`backend/src/metrics/lead-time.service.ts`** — `getLeadTimeObservations()`, after the `find()` call:
```typescript
const issues = (await this.issueRepo.find({ where: issueWhere }))
  .filter((i) => isWorkItem(i.issueType));
```

**`backend/src/metrics/mttr.service.ts`** — `getMttrObservations()`, after the `find()` call:
```typescript
const allIssues = (await this.issueRepo.find({ where: { boardId } }))
  .filter((i) => isWorkItem(i.issueType));
```

**`backend/src/metrics/cfr.service.ts`** — `calculate()`, two `find()` calls (lines 67 and 110):
```typescript
// Primary load (line 67):
const allIssues = (await this.issueRepo.find({ where: { boardId } }))
  .filter((i) => isWorkItem(i.issueType));

// Secondary linked-issue load (line 110) — also filter:
const linkedIssues = (await this.issueRepo.find({ ... }))
  .filter((i) => isWorkItem(i.issueType));
```

**`backend/src/metrics/deployment-frequency.service.ts`** — `calculate()`, both `find()` calls (lines 63 and 103):
```typescript
const issues = (await this.issueRepo.find({ where: { boardId, sprintId } }))
  .filter((i) => isWorkItem(i.issueType));
```

**`backend/src/metrics/cycle-time.service.ts`** — `getCycleTimeObservations()`, after the `find()` call (line 104). Remove the `issueTypeFilter` pass-through for `'Epic'`/`'Sub-task'` and always apply `isWorkItem` as a base filter:
```typescript
const issues = (await this.issueRepo.find({ where: issueWhere }))
  .filter((i) => isWorkItem(i.issueType));
```
The `issueTypeFilter` param can remain for user-driven issue type filtering (e.g. "show only Bugs") — it stacks on top of the base exclusion.

**`backend/src/quarter/quarter-detail.service.ts`** — `getDetail()`, after line 150:
```typescript
const issues = (await this.issueRepo.find({ where: { boardId } }))
  .filter((i) => isWorkItem(i.issueType));
```

**`backend/src/week/week-detail.service.ts`** — `getDetail()`, after line 158:
```typescript
const issues = (await this.issueRepo.find({ where: { boardId } }))
  .filter((i) => isWorkItem(i.issueType));
```

### Existing correct sites — update to use `isWorkItem` (no behaviour change)

Replace inline `i.issueType !== 'Epic' && i.issueType !== 'Sub-task'` with `isWorkItem(i.issueType)` in:
- `planning/planning.service.ts` lines 471, 632
- `roadmap/roadmap.service.ts` lines 169, 380, 520
- `sprint/sprint-detail.service.ts` line 243

---

## 7. Frontend Impact

No frontend changes required. The frontend displays whatever the backend returns — once Epics and Sub-tasks are excluded from the service layer, they disappear from all charts and tables automatically.

The one exception to check: the cycle time page's issue type filter populates from `availableIssueTypes` derived from `observations`. Since `CycleTimeService` will no longer return Epic observations, `'Epic'` will no longer appear in the filter dropdown. This is the correct behaviour.

---

## 8. Migration

**No DB migration required.** This is a pure application-layer filter change. No new columns, no schema changes.

---

## 9. Implementation Steps

All changes are safe to land in a single PR:

1. Create `backend/src/metrics/issue-type-filters.ts`
2. Update the 8 gap services (add `.filter((i) => isWorkItem(i.issueType))` after each `issueRepo.find()`)
3. Update the 6 existing correct sites to use `isWorkItem` (DRY cleanup, no behaviour change)
4. Run `npx tsc --noEmit` and `npm run lint` on backend
5. Run `npx tsc --noEmit` and `npm run lint` on frontend (no changes expected, verify clean)

---

## 10. Risks

- **Metrics will change for boards that currently include Epics.** Deployment frequency may drop (fewer "issues completed"), lead times may shorten (Epic durations were inflating p95). This is the correct outcome — the numbers were wrong before.
- **CFR secondary query** — the linked-issue load in `cfr.service.ts` around line 110 must also be filtered. Missing this would allow Epic-type issues to re-enter via the failure-link path.
- **Cycle time issueTypeFilter** — if a caller currently passes `issueTypeFilter: 'Epic'` explicitly to get Epic cycle times, that will still work (the user filter stacks on top of `isWorkItem`). No existing callers do this.
- **`sprint-detail` and `quarter-detail` failure classification** — both services check `incidentIssueTypes.includes(issue.issueType)`. If `'Epic'` were in `incidentIssueTypes`, excluding Epics first would change failure counts. In practice no board has `'Epic'` as an incident type. Low risk.
