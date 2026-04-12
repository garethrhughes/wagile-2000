# 0015 — Configurable Board IDs: Replace Hardcoded Constants with Dynamic API Data

**Date:** 2026-04-12
**Status:** Accepted
**Implemented:** 2026-04-12
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

Board IDs (`ACC`, `BPT`, `SPS`, `OCS`, `DATA`, `PLAT`) and their type classifications
(scrum vs. kanban) are currently hardcoded in two forms across the frontend:

1. **`ALL_BOARDS`** — `frontend/src/store/filter-store.ts` — a module-level constant
   exported and imported by five page components and the test suite.
2. **`KANBAN_BOARDS`** — a `new Set(['PLAT'])` literal duplicated independently in
   `frontend/src/app/planning/page.tsx` and `frontend/src/app/roadmap/page.tsx`.

Adding a new board, removing a retired one, or reclassifying a board between scrum and
kanban requires finding every occurrence of these constants, editing code, and
redeploying the frontend. The system already stores this information authoritatively in
the `board_configs` Postgres table, and `GET /api/boards` (→ `BoardConfig[]`) already
returns exactly the data needed. There is no reason for the frontend to maintain a
second, drift-prone copy.

---

## Proposed Solution

Introduce a single new Zustand store — `frontend/src/store/boards-store.ts` — that
fetches `GET /api/boards` once on application load and exposes the results as
`allBoards: string[]` and `kanbanBoardIds: Set<string>`. All five affected page
components replace their imports of `ALL_BOARDS` / `KANBAN_BOARDS` with reads from this
store. The `ALL_BOARDS` export in `filter-store.ts` is removed; `setAllBoards()` is
updated to use the dynamic list. No backend changes are required.

### New store: `boards-store.ts`

```typescript
// frontend/src/store/boards-store.ts

import { create } from 'zustand'
import { getBoards, type BoardConfig } from '@/lib/api'

interface BoardsState {
  /** Ordered list of all board IDs known to the backend. Empty until loaded. */
  allBoards: string[]
  /** Set of board IDs whose boardType === 'kanban'. */
  kanbanBoardIds: Set<string>
  /** Loading state for the initial fetch. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Populate the store by calling GET /api/boards. Idempotent if already ready. */
  fetchBoards: () => Promise<void>
}

export const useBoardsStore = create<BoardsState>((set, get) => ({
  allBoards: [],
  kanbanBoardIds: new Set(),
  status: 'idle',

  fetchBoards: async () => {
    // Idempotency guard: don't re-fetch if already loaded or in-flight.
    if (get().status === 'ready' || get().status === 'loading') return

    set({ status: 'loading' })
    try {
      const boards: BoardConfig[] = await getBoards()
      set({
        allBoards: boards.map((b) => b.boardId),
        kanbanBoardIds: new Set(
          boards.filter((b) => b.boardType === 'kanban').map((b) => b.boardId),
        ),
        status: 'ready',
      })
    } catch {
      // Non-fatal: pages degrade gracefully (see Edge Cases).
      set({ status: 'error' })
    }
  },
}))
```

**Key design decisions:**

- **Single source of truth per process.** Zustand's store is a singleton within a
  browser tab. Every component that calls `useBoardsStore()` reads the same already-
  fetched data — no duplicate network requests.
- **Idempotency guard.** `fetchBoards()` is a no-op if the store is already `ready` or
  `loading`. Components can call it unconditionally in their own `useEffect` without
  risk of fan-out.
- **No SSR concerns.** All pages that use board lists are `'use client'` components
  under the Next.js App Router. The store is never accessed server-side.

### Fetch trigger: `AppInitialiser` client component

Rather than having every page race to call `fetchBoards()` independently, a single thin
client component mounts once in the root layout and triggers the fetch:

```typescript
// frontend/src/components/layout/app-initialiser.tsx

'use client'

import { useEffect } from 'react'
import { useBoardsStore } from '@/store/boards-store'

export function AppInitialiser() {
  const fetchBoards = useBoardsStore((s) => s.fetchBoards)

  useEffect(() => {
    void fetchBoards()
  }, [fetchBoards])

  return null
}
```

This component is added to the root layout alongside `<Sidebar>`:

```tsx
// frontend/src/app/layout.tsx  (illustrative delta)

import { AppInitialiser } from '@/components/layout/app-initialiser'

// Inside <body>:
<AppInitialiser />
<Sidebar />
{children}
```

The fetch fires immediately on first navigation to any page. Because the App Router
keeps the root layout mounted across route transitions, `AppInitialiser` mounts exactly
once per browser session.

### Changes to `filter-store.ts`

The `ALL_BOARDS` constant and its export are removed. `setAllBoards()` is rewritten to
read `allBoards` from `useBoardsStore` at call time:

```typescript
// filter-store.ts  (after)

import { create } from 'zustand'
import { useBoardsStore } from './boards-store'

export interface FilterState {
  selectedBoards: string[]
  periodType: 'sprint' | 'quarter'
  selectedSprint: string | null
  selectedQuarter: string | null
  setSelectedBoards: (boards: string[]) => void
  setPeriodType: (type: 'sprint' | 'quarter') => void
  setSelectedSprint: (sprintId: string | null) => void
  setSelectedQuarter: (quarter: string | null) => void
  /** Reset selectedBoards to the full list from the boards store. */
  setAllBoards: () => void
}

export const useFilterStore = create<FilterState>((set) => ({
  selectedBoards: [],       // starts empty; populated after boards load
  periodType: 'quarter',
  selectedSprint: null,
  selectedQuarter: null,

  setSelectedBoards: (boards) => set({ selectedBoards: boards }),
  setPeriodType: (type) => set({ periodType: type }),
  setSelectedSprint: (sprintId) => set({ selectedSprint: sprintId }),
  setSelectedQuarter: (quarter) => set({ selectedQuarter: quarter }),

  setAllBoards: () =>
    set({ selectedBoards: useBoardsStore.getState().allBoards }),
}))
```

> **Note on cross-store access.** Calling `useBoardsStore.getState()` directly (the
> Zustand `.getState()` imperative accessor) inside an action is the canonical Zustand
> pattern for reading another store from outside React. It does not create a React hook
> dependency and is safe inside a `set()` action body.

**`selectedBoards` initial value.** The store now initialises to `[]` instead of
`ALL_BOARDS`. Components that render board chip lists will see an empty list until
`BoardsState.status` becomes `'ready'`. The DORA page already handles this correctly
(it falls through to an idle/loading state when `selectedBoards.length === 0`). The
other pages render no chips when `allBoards` is empty, which is the correct degraded
state during the brief loading window.

Separately, once boards load, `AppInitialiser` (or an effect on any page that uses the
filter store) should call `setAllBoards()` to pre-populate `selectedBoards` — see the
`AppInitialiser` enhancement below.

### Enhanced `AppInitialiser`: seed `filterStore` after boards load

```typescript
// frontend/src/components/layout/app-initialiser.tsx  (enhanced)

'use client'

import { useEffect } from 'react'
import { useBoardsStore } from '@/store/boards-store'
import { useFilterStore } from '@/store/filter-store'

export function AppInitialiser() {
  const fetchBoards = useBoardsStore((s) => s.fetchBoards)
  const boardsStatus = useBoardsStore((s) => s.status)
  const setAllBoards = useFilterStore((s) => s.setAllBoards)

  // Trigger the board list fetch once on mount
  useEffect(() => {
    void fetchBoards()
  }, [fetchBoards])

  // Once boards are ready, seed the filter store's selectedBoards
  // (only if they haven't been set by the user yet, i.e., still empty)
  useEffect(() => {
    if (boardsStatus === 'ready') {
      const current = useFilterStore.getState().selectedBoards
      if (current.length === 0) {
        setAllBoards()
      }
    }
  }, [boardsStatus, setAllBoards])

  return null
}
```

This ensures that the first time a user visits the DORA page (where `selectedBoards`
defaults to all boards), the filter is pre-populated from the API-driven list rather
than from a hardcoded constant.

### Changes to page components

All five pages follow the same migration pattern — replace the import and use the store.

#### Pattern: `ALL_BOARDS` usage

**Before (every page):**
```typescript
import { ALL_BOARDS } from '@/store/filter-store'
// ...
{ALL_BOARDS.map((boardId) => (
  <BoardChip ... />
))}
```

**After:**
```typescript
import { useBoardsStore } from '@/store/boards-store'
// ...
const allBoards = useBoardsStore((s) => s.allBoards)
// ...
{allBoards.map((boardId) => (
  <BoardChip ... />
))}
```

#### Pattern: `KANBAN_BOARDS` usage

**Before (`planning/page.tsx`, `roadmap/page.tsx`):**
```typescript
const KANBAN_BOARDS = new Set(['PLAT'])
// ...
const isKanban = KANBAN_BOARDS.has(selectedBoard)
```

**After:**
```typescript
import { useBoardsStore } from '@/store/boards-store'
// ...
const kanbanBoardIds = useBoardsStore((s) => s.kanbanBoardIds)
// ...
const isKanban = kanbanBoardIds.has(selectedBoard)
```

#### `cycle-time/page.tsx` — default board fallback

```typescript
// Before:
const selectedBoard = searchParams.get('board') ?? (ALL_BOARDS[0] ?? 'ACC')

// After:
const allBoards = useBoardsStore((s) => s.allBoards)
const selectedBoard = searchParams.get('board') ?? (allBoards[0] ?? '')
```

The fallback becomes `''` (empty string) rather than `'ACC'`. When `allBoards` is
empty (store not yet loaded), `selectedBoard` is `''` and the API call will either
be skipped or return an empty result — both are handled gracefully by the existing
loading/empty-state logic. Once boards load, the first board in the list is used as
the default, which is the natural ordering from the database.

#### `dora/page.tsx` — `ALL_BOARDS` as URL parameter default

```typescript
// Before:
const selectedBoards = useMemo(
  () => (boardsParam ? boardsParam.split(',').filter(Boolean) : ALL_BOARDS),
  [boardsParam],
)

// After:
const allBoards = useBoardsStore((s) => s.allBoards)
const selectedBoards = useMemo(
  () => (boardsParam ? boardsParam.split(',').filter(Boolean) : allBoards),
  [boardsParam, allBoards],
)
```

`allBoards` is now a dependency of the memo. When `allBoards` changes from `[]` to the
full list (after load), `selectedBoards` is recomputed. The existing DORA page guard
(`if (selectedBoards.length === 0) setPageState({ status: 'idle' })`) prevents a
spurious fetch during the loading window.

> **Note:** `dora/page.tsx` already calls `getBoards()` directly in a `useEffect` to
> populate `kanbanBoardIds` (for sprint-mode availability detection). After this change,
> that local call is replaced by reading `useBoardsStore((s) => s.kanbanBoardIds)`,
> eliminating the redundant per-page fetch entirely.

### Full file inventory of changes

| File | Change |
|---|---|
| `frontend/src/store/boards-store.ts` | **New file** |
| `frontend/src/components/layout/app-initialiser.tsx` | **New file** |
| `frontend/src/app/layout.tsx` | Mount `<AppInitialiser />` |
| `frontend/src/store/filter-store.ts` | Remove `ALL_BOARDS` const + export; update `setAllBoards()`; `selectedBoards` starts `[]` |
| `frontend/src/app/dora/page.tsx` | Replace `ALL_BOARDS` import + remove local `getBoards()` call |
| `frontend/src/app/cycle-time/page.tsx` | Replace `ALL_BOARDS` import |
| `frontend/src/app/planning/page.tsx` | Replace `ALL_BOARDS` import; replace `KANBAN_BOARDS` constant |
| `frontend/src/app/gaps/page.tsx` | Replace `ALL_BOARDS` import |
| `frontend/src/app/roadmap/page.tsx` | Replace `ALL_BOARDS` import; replace `KANBAN_BOARDS` constant |
| `frontend/src/store/stores.test.ts` | Update tests (see Migration section) |

**Backend: zero changes.** `GET /api/boards`, `BoardConfig` entity, and all services
are untouched.

---

## Detailed Design

### Data flow diagram

```
App mounts (root layout)
  │
  └─► <AppInitialiser /> (client component, renders null)
        │
        ├─► useBoardsStore.fetchBoards()
        │     │
        │     └─► GET /api/boards  →  BoardConfig[]
        │           │
        │           └─► useBoardsStore.setState({
        │                 allBoards: ['ACC','BPT',...],
        │                 kanbanBoardIds: Set{'PLAT'},
        │                 status: 'ready'
        │               })
        │
        └─► (once status === 'ready')
              useFilterStore.setAllBoards()
                └─► selectedBoards = useBoardsStore.getState().allBoards


Page renders (e.g. /planning)
  │
  ├─► const allBoards     = useBoardsStore(s => s.allBoards)       // ['ACC',...]
  ├─► const kanbanBoardIds = useBoardsStore(s => s.kanbanBoardIds)  // Set{'PLAT'}
  │
  ├─► Board chips rendered from allBoards
  └─► isKanban = kanbanBoardIds.has(selectedBoard)
```

### Store lifecycle states

```
idle ──fetchBoards()──► loading ──success──► ready
                               └──error───► error
```

- `idle` → initial state; no fetch attempted yet.
- `loading` → fetch in flight; pages render with empty `allBoards`.
- `ready` → nominal state; `allBoards` and `kanbanBoardIds` are populated.
- `error` → fetch failed; `allBoards` remains `[]`; pages degrade to empty chip
  lists (see Edge Cases).

### Rendering during loading window

The transition from `idle`/`loading` to `ready` is brief (it is the first network
request the app makes, alongside the initial page data fetch). In practice, board chips
will render as empty for less than the time of a single round-trip. No loading skeleton
is introduced for the chip row — the empty render is acceptable UX for an internal
tool. A loading skeleton can be added in a follow-up if desired.

Pages with a single-board selector (Planning, Cycle Time, Roadmap) default to `''` or
the first element of an empty array when `allBoards` is `[]`. Their data-fetch
`useEffect` guards against empty `selectedBoard` strings (either by the `isKanban`
check resolving to `false` and the board-specific API returning an empty result, or by
the existing `selectedBoards.length === 0` guard on the DORA page). No visible error
state is shown during the window.

---

## Alternatives Considered

### Alternative A — Augment `filter-store.ts` directly

Add `allBoards`, `kanbanBoardIds`, and `fetchBoards` directly to the existing
`FilterState` / `useFilterStore`.

**Why considered:** Fewer files; consumers of board list data already import
`filter-store`.

**Why ruled out:** `filter-store` owns UI filter state (selected boards, period type,
sprint/quarter selection). Board catalogue data (what boards exist and their types) is
a different concern — it is infrastructure metadata, not user preference. Mixing the
two makes the store harder to test (e.g., resetting filter state in tests must not
reset the loaded board catalogue) and muddies the module's responsibility. Separation
is the correct design at a very low complexity cost (one 30-line file).

### Alternative B — Fetch boards inside each page component independently

Each page calls `getBoards()` in its own `useEffect`, exactly as `dora/page.tsx`
already does for its local `kanbanBoardIds` ref.

**Why considered:** No new abstraction required; each page is self-contained.

**Why ruled out:** This is the current partial approach and it already causes drift —
`dora/page.tsx` fetches boards dynamically but only for kanban detection, while the
same page still uses the hardcoded `ALL_BOARDS` for chip rendering. Full page-by-page
adoption would result in five separate `GET /api/boards` calls per page load, no
shared loading state, and no central place to handle the error. A store is the
canonical Zustand pattern for shared async data.

### Alternative C — Server component data prop drilling

Fetch boards in the root server component (layout) and pass them down as a prop or via
React context.

**Why considered:** Avoids a client-side fetch for data that doesn't change often; zero
network waterfall on first paint.

**Why ruled out:** All five pages that need board data are `'use client'` components.
Passing data from a server component to a client component requires serialisation via
props, which would propagate a `boardsList` prop through every page wrapper — a
significant refactor. The App Router does support this pattern, but the cost is high
for a single-user internal tool where the latency of one extra API call is negligible.
The store approach is simpler and consistent with the existing Zustand usage in the
codebase.

### Alternative D — Embed board catalogue in `next.config` or environment variable

Set `NEXT_PUBLIC_BOARDS=ACC,BPT,SPS,OCS,DATA,PLAT` and read it at runtime.

**Why considered:** Zero API call; trivially replaces the hardcoded constant.

**Why ruled out:** Doesn't eliminate the redeploy requirement — changing the env var
still requires a redeploy. Also provides no way to express `boardType` (scrum vs.
kanban) without additional env vars. Defeats the purpose of the database-driven config.

### Alternative E — Keep `ALL_BOARDS` as a build-time fallback

Retain the hardcoded constant but override it once the API responds. Pages show the
hardcoded list instantly and then re-render when the API result arrives.

**Why considered:** Avoids empty board chips during the loading window; no UX
regression.

**Why ruled out:** Re-introduces drift as a deliberate design decision. If a board is
added or removed, the build-time fallback will be wrong until the next deploy. The
proposal's goal is to make a database change sufficient; any retained hardcoded fallback
undermines this. The loading window is brief enough that an empty chip row is not a
meaningful UX problem.

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| `GET /api/boards` fails (network error / API down) | `useBoardsStore.status` → `'error'`; `allBoards = []`; `kanbanBoardIds = Set{}`. All pages render with empty chip rows and no boards selectable. Existing page data-fetch effects either do not fire (empty board list) or use `''` as board ID and receive empty / 400 responses, which the existing error state handles. No crash. |
| Database has zero `board_configs` rows | `GET /api/boards` returns `[]`; `allBoards = []`. Same degraded behaviour as the error case. Not expected in production (the sync creates board configs on first run), but safe. |
| New board added to database | On next page load / app session, `GET /api/boards` returns the new board. No deploy required. |
| Board removed from database | New session omits it from chip lists. Any URL bookmark with the removed board ID as a query param will result in an API call for a non-existent board — the existing `setError` / `EmptyState` paths handle this correctly. |
| `selectedBoards` in `filter-store` starts `[]` | DORA page guard: `if (selectedBoards.length === 0) setPageState({ status: 'idle' })` already exists. Other pages do not use `filter-store.selectedBoards` directly — they read `allBoards` from `boards-store`. |
| `cycle-time` fallback board is `''` | The Cycle Time page fetches data for `selectedBoard` in a `useEffect`. An empty string sent to `getCycleTime({ boardId: '' })` will return an empty result or a 400 error, which the `setError` / `EmptyState` paths handle. Once boards load, `allBoards[0]` will be a valid board ID and the default resolves correctly. |
| `AppInitialiser` mounts but root layout is not a client component | `AppInitialiser` itself is a `'use client'` component. The root layout can be a server component — it simply renders `<AppInitialiser />` as a client island. This is standard Next.js App Router composition. |
| `dora/page.tsx` local `getBoards()` call (existing) | Removed entirely as part of this migration. The `kanbanBoardIds` ref and `boardsLoaded` state are replaced by `useBoardsStore((s) => s.kanbanBoardIds)` and `useBoardsStore((s) => s.status)`. The `sprintModeAvailable` memo's `boardsLoaded` dependency becomes `status === 'ready'`. |
| Test suite references to `ALL_BOARDS` | `stores.test.ts` currently imports `ALL_BOARDS` from `filter-store`. After removal, these tests must be rewritten to assert against `useBoardsStore.getState().allBoards` or to mock the boards store with a known fixture. See Migration section. |
| Server-side rendering (Next.js) | No page using boards data is a server component (`'use client'` is present on all five pages). Zustand stores are initialised client-side only. No SSR hydration mismatch risk. |

---

## Migration Path

### Step 1 — Add `boards-store.ts`

Create `frontend/src/store/boards-store.ts` as specified above. No existing code
changes. Run the test suite — should pass unchanged.

### Step 2 — Add `AppInitialiser` and mount in root layout

Create `frontend/src/components/layout/app-initialiser.tsx`. Add `<AppInitialiser />`
to `frontend/src/app/layout.tsx`. Verify in browser that `GET /api/boards` fires once
on first load.

### Step 3 — Migrate `filter-store.ts`

Remove `ALL_BOARDS` constant and export. Update `selectedBoards` initial value to `[]`.
Update `setAllBoards()` to read from `useBoardsStore.getState().allBoards`. Update
`AppInitialiser` to seed `selectedBoards` after boards load (as described above).

At this point the `stores.test.ts` test suite will fail — expected. Do not merge until
Step 7.

### Step 4 — Migrate page components (one page per commit, or all together)

For each of the five pages, in the order below (lowest-risk first):

1. `gaps/page.tsx` — replace `ALL_BOARDS` import; read `allBoards` from store.
2. `planning/page.tsx` — replace `ALL_BOARDS` and `KANBAN_BOARDS`.
3. `roadmap/page.tsx` — replace `ALL_BOARDS` and `KANBAN_BOARDS`.
4. `cycle-time/page.tsx` — replace `ALL_BOARDS`; update fallback default.
5. `dora/page.tsx` — replace `ALL_BOARDS`; remove local `getBoards()` / `kanbanBoardIds` ref / `boardsLoaded` state; read `kanbanBoardIds` from store.

### Step 5 — Remove `ALL_BOARDS` from `filter-store.ts` export

Once all page components no longer import `ALL_BOARDS`, remove the export line. The
TypeScript compiler will confirm no remaining imports.

### Step 6 — Update `stores.test.ts`

Rewrite the three test cases that reference `ALL_BOARDS`:

- `'starts with all boards selected'` → mock `useBoardsStore` to return a known
  `allBoards` array; call `setAllBoards()`; assert `selectedBoards` equals the mocked
  list.
- `'setAllBoards restores selectedBoards to ALL_BOARDS'` → same mocking approach.
- `beforeEach` that seeds `selectedBoards: ALL_BOARDS` → seed with a fixed array
  `['ACC', 'BPT']` (representative fixture, not imported from the store).

Add new tests for `boards-store.ts`:

- `fetchBoards` transitions status from `idle` → `loading` → `ready`.
- `fetchBoards` populates `allBoards` and `kanbanBoardIds` from the mocked API response.
- `fetchBoards` on error sets status to `'error'` and leaves lists empty.
- Idempotency: calling `fetchBoards()` twice does not fire the API twice.

### Step 7 — End-to-end verification

- Manually add a new `board_configs` row to the local database (or remove one).
- Reload the app without redeploying.
- Verify board chips update to reflect the change.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | No schema changes. No new migrations. `board_configs` and `GET /api/boards` are unchanged. |
| API contract | None | No new endpoints. No changes to existing response shapes. |
| Backend | None | Zero changes to any backend file. |
| Frontend — new files | 2 new files | `boards-store.ts`, `app-initialiser.tsx` |
| Frontend — changed files | 7 files | `filter-store.ts`, `layout.tsx`, and 5 page components |
| Tests | Updated + new unit tests | `stores.test.ts` must be updated; new tests for `boards-store.ts` |
| Jira API | No new calls | Board data comes from Postgres via the existing `GET /api/boards` endpoint |
| Performance | Neutral / slight improvement | One shared `GET /api/boards` call per session replaces the per-page local fetch in `dora/page.tsx`; all other pages gain their first dynamic fetch but save a deploy round-trip for any future board change |
| UX | Negligible regression during loading | Empty chip row for < 1 network round-trip on first page load; acceptable for an internal tool |

---

## Open Questions

1. **Board ordering.** The `board_configs` table has no explicit `displayOrder` column.
   The API currently returns boards in the order they were inserted. Is the current
   insertion order (`ACC`, `BPT`, `SPS`, `OCS`, `DATA`, `PLAT`) the desired display
   order, or should a `displayOrder` column be added to `board_configs`? This proposal
   preserves insertion order. If ordering matters, a follow-up schema change can add
   the column.

2. **`setAllBoards()` timing.** The proposed `AppInitialiser` seeds `selectedBoards`
   once `boards-store` reaches `'ready'`. If the user navigates to the DORA page before
   boards load, `selectedBoards` will be `[]` momentarily. This is handled by the
   existing DORA page guard. Confirm this is an acceptable UX trade-off, or whether a
   Suspense boundary / loading skeleton should be introduced for the board chips row.

3. **Board removal and stale URL params.** If a board ID is removed from the database
   and a user has a bookmarked URL containing that board ID as a query parameter (e.g.,
   `/dora?boards=ACC,OLD`), the removed board will silently produce an API error or
   empty result. Confirm whether a "board not found" warning or auto-cleanup of stale
   URL params is desired.

---

## Acceptance Criteria

- [ ] `frontend/src/store/boards-store.ts` exists and exports `useBoardsStore` with
      `allBoards: string[]`, `kanbanBoardIds: Set<string>`, `status`, and `fetchBoards`.

- [ ] `frontend/src/components/layout/app-initialiser.tsx` exists, is mounted in the
      root layout, and calls `fetchBoards()` exactly once per browser session regardless
      of how many pages are visited.

- [ ] `frontend/src/store/filter-store.ts` no longer contains or exports `ALL_BOARDS`.
      `setAllBoards()` reads from `useBoardsStore.getState().allBoards`.

- [ ] No page component (`dora`, `cycle-time`, `planning`, `gaps`, `roadmap`) imports
      `ALL_BOARDS` from `filter-store`. TypeScript compilation confirms zero import sites.

- [ ] No page component contains a hardcoded `KANBAN_BOARDS` constant. Kanban detection
      uses `useBoardsStore((s) => s.kanbanBoardIds).has(boardId)`.

- [ ] `dora/page.tsx` no longer contains a local `getBoards()` call or a `kanbanBoardIds`
      ref. It reads kanban classification from `useBoardsStore`.

- [ ] Adding a new `board_configs` row to the database and reloading the frontend (no
      redeploy) causes the new board to appear in all board chip lists.

- [ ] Removing a `board_configs` row and reloading causes the board to disappear from
      all chip lists without a JS error.

- [ ] When `GET /api/boards` fails, the app renders normally with empty board chip rows
      and no unhandled promise rejection or React error boundary trip.

- [ ] `stores.test.ts` is updated: all references to the removed `ALL_BOARDS` export are
      replaced with store mocks or fixed fixtures; all tests pass.

- [ ] New unit tests for `boards-store.ts` cover: successful fetch, error fetch,
      idempotent re-call, and correct derivation of `kanbanBoardIds`.

- [ ] No new npm dependencies are introduced.

- [ ] No database migrations are required.

- [ ] No backend files are modified.
