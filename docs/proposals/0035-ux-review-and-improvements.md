# 0035 — UX Review and Improvements

**Date:** 2026-04-16  
**Status:** Draft  
**Author:** Architect Agent  
**Related ADRs:** None yet

---

## Problem Statement

As the application has grown incrementally across 34 previous proposals, individual pages have
been built in isolation and have accumulated a set of divergent patterns, inconsistencies, and
gaps. There is no shared design system audit to unify the experience. Several pages use raw
Tailwind colour utilities (e.g. `bg-blue-50`, `hover:bg-gray-50`) alongside the defined
semantic token layer, which breaks dark-mode rendering and makes theming maintenance
error-prone. Navigation conventions, filter UI patterns, loading states, error handling, and
table behaviour all differ between pages. This proposal documents the full catalogue of issues
found during a systematic review and proposes a prioritised set of improvements.

---

## Findings Catalogue

### F-1 — Raw Colour Leakage (Dark Mode Breakage)

The CSS layer in `globals.css` defines a complete semantic token set (surface, border, text
variants, and squirrel scale) and a `.dark` theme override. However, many components bypass this
system and reference raw Tailwind palette utilities directly.

**Affected locations:**

| Location | Problematic class |
|---|---|
| `frontend/src/app/dora/page.tsx` — period toggle | `bg-blue-50 text-blue-700 hover:bg-gray-50` |
| `frontend/src/app/cycle-time/page.tsx` — quarter buttons | `border-blue-300 bg-blue-50 text-blue-700 border-border text-muted hover:bg-gray-50` |
| `frontend/src/app/cycle-time/page.tsx` — issue type filter | same pattern |
| `frontend/src/app/cycle-time/page.tsx` — issues table header | `bg-gray-50` |
| `frontend/src/app/roadmap/page.tsx` — board breakdown table | `bg-gray-50` |
| `frontend/src/app/settings/page.tsx` — disabled board type field | `bg-gray-50` |
| `frontend/src/app/sprint/[boardId]/[sprintId]/page.tsx` — table | `hover:bg-gray-50` |
| `frontend/src/app/gaps/page.tsx` — All board chip | `hover:bg-gray-50` |
| `frontend/src/components/ui/board-breakdown-table.tsx` — board type badges | `bg-purple-50 text-purple-700 border-purple-200` |

In dark mode, `bg-gray-50` renders as near-white, `bg-blue-50` stays light, and table headers
become unreadable against dark backgrounds.

**Impact:** Dark mode is defined in CSS but effectively non-functional.

---

### F-2 — Inconsistent Selected/Active State Pattern

Three different visual patterns are used to represent a "selected" chip or toggle button:

| Pattern | Used in |
|---|---|
| `bg-surface-active text-squirrel-700 border-squirrel-400` | `BoardChip` (correct — semantic) |
| `bg-blue-50 text-blue-700 border-blue-300` | Quarter buttons on Cycle Time, Issue type filter, period toggle on DORA |
| `border-b-2 border-blue-600 text-blue-600` | Board tabs on Settings |
| `bg-squirrel-500 text-white` | None yet — but the standard for primary action |

The `BoardChip` component is the only one using semantic tokens. All inline toggle buttons,
period selectors, and filter chips reinvent the selected state with raw colours.

---

### F-3 — Divergent Filter UI Structure Across Pages

Each page implements its filter bar slightly differently:

| Page | Board select behaviour | How quarter/period is shown |
|---|---|---|
| DORA | Multi-select chips, defaults to all boards | Segmented toggle (Quarter / Sprint) |
| Cycle Time | Single-select chips, defaults to first board | Row of quarter pill buttons |
| Planning | Single-select chips, no explicit default shown | Segmented toggle (Sprint / Quarter / Week for Kanban) |
| Roadmap | Single-select chips | Segmented toggle (Sprint / Quarter) |
| Gaps | Chips with a leading "All" button | No time period filter |

The inconsistency means users switching between pages must relearn the filter interaction every
time. Quarter selection in particular is shown as a pill row (Cycle Time) vs. not shown at all
(DORA defaults to current quarter automatically) vs. a toggle mode (Roadmap, Planning).

---

### F-4 — No Retry Action on Error States

When a page fails to load data, it shows an inline red error box:

```
<div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
  {pageState.message}
</div>
```

There is no retry button. Users must manually reload the browser or navigate away and back.
This affects: DORA, Cycle Time, Planning, Roadmap, Gaps, Sprint Detail, Week Detail.

---

### F-5 — Spinner-Only Loading States (No Skeleton)

All pages use a full-page centred `Loader2` spinner during data load. When data arrives, the
entire layout jumps into place. This causes significant layout shift and gives the user no
indication of what the page will contain while waiting.

The most affected page is DORA, where a 2×2 metric card grid, four trend charts, and a
breakdown table all appear simultaneously.

---

### F-6 — Duplicate Sync Logic in Two Components

`SyncStatus` component (`components/layout/sync-status.tsx`) and the bottom of the `Sidebar`
component both implement:
- `formatRelativeTime()`
- `latestSync()`
- Sync button
- `fetchStatus()` call in a `useEffect`

`SyncStatus` is defined but never mounted — the `ClientShell` only mounts `Sidebar`. The
`Sidebar` handles sync inline. The orphaned `SyncStatus` component is dead code and a
maintenance hazard.

---

### F-7 — Settings Page: `window.confirm()` for Destructive Actions

The "Remove board" action in Settings uses a browser-native `window.confirm()` dialog:

```ts
if (!window.confirm(`Remove board "${id}"? ...`)) return
```

This is inconsistent with the toast-based notification pattern used everywhere else on the
page and across the application. It is also unstyleable, not accessible via keyboard without
relying on browser defaults, and blocked by popup blockers in some enterprise environments.

---

### F-8 — Settings Page: Board Config Fields Lack Grouping

The board config section presents 10 CSV fields in an undifferentiated 2-column grid:

- Done Status Names
- In-Progress Status Names
- Cancelled Status Names
- Failure Issue Types
- Failure Labels
- Failure Link Types
- Incident Issue Types
- Recovery Status Names
- Incident Labels
- (+ Data Start Date and Board Type)

These fields belong to three distinct concerns: Workflow Statuses, CFR Detection, and MTTR
Detection. Without any grouping or explanatory text, the form is daunting, especially for a
new user configuring a board for the first time.

---

### F-9 — Settings Page: JPD Section Uses Internal Acronym

The Roadmap Config section is labelled "Roadmap Config (JPD)" where "JPD" (Jira Product
Discovery) is an internal term. No tooltip, help text, or explanation is provided. A user
unfamiliar with the Jira product line will not understand what this section configures.

---

### F-10 — No Breadcrumbs on Drill-Down Pages

Detail pages (`/sprint/[boardId]/[sprintId]`, `/week/[boardId]/[week]`,
`/quarter/[boardId]/[quarter]`, `/sprint-report/[boardId]/[sprintId]`) each render a generic
`<BackButton />` in the top-left. There is no context about:
- Which board/sprint/quarter this detail is for (beyond what is in the page body)
- Where "back" leads (the back button uses browser history, so it depends on how the user
  arrived)
- Where the user is in the application hierarchy

---

### F-11 — Cycle Time Issues Table Is Unbounded

The cycle time issues table renders every observation with no pagination, virtualisation, or
row limit. For a board with a large quarter (e.g. 300+ issues), the table will render all rows
into the DOM simultaneously, causing performance degradation.

---

### F-12 — DORA Page: Sprint Mode Constraint Is Not Explained Proactively

The Sprint toggle on the DORA page is disabled unless exactly one non-Kanban board is
selected. When multiple boards are selected, the Sprint button is greyed out with only a
`title` tooltip. There is no persistent inline explanation visible without hovering.

---

### F-13 — No Dark Mode Toggle in the UI

The `.dark` CSS class and full colour token set are defined, but there is no toggle control
anywhere in the application to enable dark mode. Dark mode tokens are effectively dead unless
a user manually adds the class to `<html>`. This is also where F-1 matters most — even if a
toggle were added today, many pages would still render incorrectly.

---

### F-14 — Roadmap Page: Quarter Helper Functions Are Duplicated

`getQuarterKey()` and `getCurrentQuarterKey()` are implemented identically in both
`planning/page.tsx` and `roadmap/page.tsx`. If the quarter boundary logic needs to change
(e.g. timezone handling), it must be updated in two places.

---

### F-15 — Gaps Page: "All" Board Chip Uses a Different Visual Component

The Gaps page board filter uses an inline `<button>` for "All" with `rounded-full` styling,
while all other pages use the `BoardChip` component with `rounded-lg`. The shape, size, and
interaction style differ from every other board filter in the application.

---

## Proposed Solution

Improvements are grouped into three priority tiers.

### Priority 1 — Correctness and Consistency (must-do)

**P1-A: Replace all raw colour references with semantic tokens**

Create a shared set of utility classes or extend the token system to cover the "selected
interactive element" state:

```css
/* globals.css */
--color-interactive-selected-bg:  var(--surface-active);     /* replaces bg-blue-50  */
--color-interactive-selected-fg:  var(--squirrel-700);        /* replaces text-blue-700 */
--color-interactive-selected-border: var(--squirrel-400);    /* replaces border-blue-300 */
--color-interactive-hover-bg:     var(--surface-hover);       /* replaces hover:bg-gray-50 */
--color-table-header-bg:          var(--surface-alt);         /* replaces bg-gray-50 in thead */
```

Replace every instance of the raw-colour patterns listed in F-1 and F-2 with semantic
equivalents. Board type badges (Scrum/Kanban) should similarly use a semantic token pair
rather than hardcoded purple/blue.

**P1-B: Extract a shared `ToggleChip` component**

Create `components/ui/toggle-chip.tsx` that encapsulates the "selectable pill/chip" pattern
(the reusable equivalent of the ad-hoc quarter buttons, issue type buttons, and period
buttons). It must:

- Use semantic tokens exclusively
- Accept `selected`, `disabled`, `onClick`
- Be visually consistent with `BoardChip`

Replace the inline button patterns in `dora/page.tsx` (period toggle), `cycle-time/page.tsx`
(quarter buttons, issue type filter), `planning/page.tsx`, and `roadmap/page.tsx` with this
component.

**P1-C: Delete `SyncStatus` component**

Remove `components/layout/sync-status.tsx`. It is dead code. Any future need for a top-bar
sync indicator should be addressed in a separate proposal.

**P1-D: Replace `window.confirm()` with inline confirmation**

In `settings/page.tsx`, replace the native confirm dialog with a two-step confirmation
pattern on the delete button: first click reveals a destructive confirm button inline; second
click (or a timeout) executes the deletion. This keeps all interactions within the application
UI.

---

### Priority 2 — Usability Improvements (high value)

**P2-A: Add retry button to all error states**

Extend the error display to include a "Try again" button that re-triggers the data fetch.
Each page already tracks `pageState` as a discriminated union; the retry just needs to reset
state to `loading` and re-invoke the load function.

**P2-B: Add page-level skeleton loading**

Replace the full-page spinner on DORA and Cycle Time with a skeleton layout that mirrors the
actual page structure:

- DORA: 4 skeleton metric cards (2×2) + 4 skeleton chart boxes + skeleton table rows
- Cycle Time: 4 skeleton percentile cards + 2 skeleton chart boxes + skeleton table rows

Skeletons use a `bg-surface-alt animate-pulse` fill. No new dependency needed — this is
Tailwind CSS animation.

**P2-C: Group Settings board config fields into sections**

Reorganise the board config form into three labelled sub-sections with a brief description
each:

- **Workflow Statuses** — Done Status Names, In-Progress Status Names, Cancelled Status Names,
  Data Start Date
- **CFR Detection** — Failure Issue Types, Failure Labels, Failure Link Types
- **MTTR Detection** — Incident Issue Types, Recovery Status Names, Incident Labels

No API change required. Layout change only.

**P2-D: Add help text to JPD config section**

Replace the section label "Roadmap Config (JPD)" with "Roadmap Config (Jira Product
Discovery)" and add a one-sentence description: "Jira Product Discovery (JPD) boards hold
your roadmap items. Configure them here to measure roadmap coverage accuracy."

**P2-E: Add explicit Sprint mode constraint hint on DORA page**

When multiple boards or a Kanban board is selected, show a persistent inline hint next to the
disabled Sprint button:

> "Sprint mode requires a single Scrum board"

Replace the `title` tooltip (which is only visible on hover/focus) with an inline `<p>` that
appears conditionally.

---

### Priority 3 — Polish and Future-Proofing

**P3-A: Add a dark mode toggle**

Add a sun/moon toggle button to the bottom of the sidebar (above Settings). Clicking it
toggles the `dark` class on `<html>`. Persist the preference in `localStorage`.

This is only meaningful after P1-A resolves the raw colour leakage — otherwise dark mode will
render incorrectly regardless of the toggle.

**P3-B: Add breadcrumb context to drill-down pages**

Replace the bare `<BackButton />` on detail pages with a breadcrumb strip:

```
Planning  /  ACC  /  Sprint 42
```

Where each segment is a link. The `boardId` and `sprintId`/`quarter`/`week` are already in
the URL params — construct the breadcrumb from them without an additional API call.

**P3-C: Paginate the cycle time issues table**

Add client-side pagination to the cycle time issues table with a configurable page size (25 /
50 / 100). Render only the current page slice. The `DataTable` component already handles
sorting — add a `pageSize` and `page` prop alongside a page selector below the table.

**P3-D: Extract shared quarter helpers**

Move `getQuarterKey()` and `getCurrentQuarterKey()` from `planning/page.tsx` and
`roadmap/page.tsx` into a shared utility file at `frontend/src/lib/quarter-utils.ts`. Adjust
both pages to import from there.

---

## Alternatives Considered

### Alternative A — Full design system library (e.g. shadcn/ui)

Adopting a component library would solve the visual inconsistency at scale but would require
a significant migration, introduce external dependencies, and likely conflict with Tailwind v4
CSS-first configuration. Ruled out: cost outweighs benefit for an internal tool at this scale.

### Alternative B — Do nothing / address per-feature

Continuing to fix colours and consistency issues on a per-PR basis is the current de-facto
approach and is what has created the accumulated inconsistency. Ruled out: without a
systematic fix, the issues compound.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes |
| API contract | None | No endpoint changes |
| Frontend | Component + page changes | P1-A/B touch most page files; P1-C removes a file; others are additive |
| Tests | Updated unit tests for renamed/replaced components; new test for `ToggleChip` | Existing visual tests for `BandBadge`, `MetricCard`, `DataTable` remain valid |
| Jira API | None | No new Jira calls |

---

## Open Questions

1. **P3-A (Dark mode toggle):** Should the preference be stored in `localStorage` or in the
   `BoardConfig`/backend settings? `localStorage` is simpler; backend setting would survive
   device changes. Given the single-user nature of the app, `localStorage` is sufficient.

2. **P1-B (ToggleChip):** Should `BoardChip` be refactored to use the new `ToggleChip`
   internally, or kept separate? Board chips and filter chips have slightly different visual
   weight. Recommended: keep `BoardChip` as-is (it is already semantic), build `ToggleChip`
   for the inline button patterns only.

3. **P2-B (Skeleton loading):** The skeleton approach works well for the DORA page where the
   layout is predictable. For Cycle Time, the issues table height is data-dependent. Accept
   a fixed-height table skeleton (e.g. 5 placeholder rows) rather than trying to match the
   actual count.

---

## Acceptance Criteria

- [ ] All raw colour utilities listed in F-1 are replaced with semantic token equivalents
- [ ] `ToggleChip` component exists and is used for all period toggle / quarter / issue-type
      filter buttons
- [ ] `SyncStatus` component file is deleted with no compilation errors
- [ ] Settings board delete action no longer uses `window.confirm()`; uses a two-step inline
      confirmation instead
- [ ] All error states across DORA, Cycle Time, Planning, Roadmap, Gaps, Sprint Detail, and
      Week Detail include a "Try again" button
- [ ] DORA and Cycle Time pages display a skeleton layout while loading (not a spinner)
- [ ] Settings board config form has three labelled sub-sections (Workflow, CFR, MTTR)
- [ ] JPD section has expanded label and a one-sentence description
- [ ] Dark mode toggle exists in the sidebar and persists preference in `localStorage`
- [ ] Cycle time issues table is paginated (max 50 rows visible at once)
- [ ] `getQuarterKey` and `getCurrentQuarterKey` exist only in `lib/quarter-utils.ts`
- [ ] Drill-down pages (Sprint Detail, Week Detail, Quarter Detail, Sprint Report) display a
      breadcrumb strip derived from URL params
- [ ] No regressions in the Vitest unit test suite
