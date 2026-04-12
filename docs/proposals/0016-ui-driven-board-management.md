# 0016 — UI-Driven Board Management: Remove `JIRA_BOARD_IDS` and Replace with CRUD API + Settings UI

**Date:** 2026-04-12
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

The set of tracked boards is currently controlled by the `JIRA_BOARD_IDS` environment
variable in `backend/.env` (e.g. `ACC,BPT,SPS,OCS,DATA,PLAT`). This variable is read
in two places inside `SyncService`: `syncAll()` builds the board list from it, and
`getStatus()` uses it to enumerate boards for the status report. Adding or removing a
board therefore requires an environment change and a process restart — an operator task,
not a UI task.

Proposal 0015 completed the *read* side of the problem: `GET /api/boards` now drives
the board chip bar on every page, and all pages read from the Zustand `boards-store`
rather than hardcoded constants. The *write* side remains entirely absent: there is no
API endpoint to create or delete a `board_configs` row, the Settings page only displays
boards that already exist in the database, and the `SyncService` is still anchored to
the env var rather than the live database contents.

The result is a split authority model: the database is the read source, the env var is
the write source, and neither is sufficient alone. `ensureBoardConfig()` in
`SyncService` exists as a band-aid to create rows that the env var references but the
database does not yet have, embedding a hardcoded `boardId === 'PLAT'` kanban heuristic
that has no place in a data-driven design. `BoardsService.seedDefaults()` is dead code
that reinforces the same pattern. This proposal removes the env var entirely and makes
the database the single source of truth for both reading and writing board configuration.

---

## Proposed Solution

Introduce `POST /api/boards` and `DELETE /api/boards/:boardId` endpoints backed by two
new methods on `BoardsService`. Remove `JIRA_BOARD_IDS` from env files and all backend
code. Rewrite `syncAll()` and `getStatus()` in `SyncService` to query `board_configs`
directly. Add an "Add Board" and "Delete Board" UI to the Settings page, mirroring the
existing JPD add/delete pattern. Add a `refreshBoards()` method to `boards-store` so
that all pages update immediately after an add or delete. Define empty-state UI for all
pages that render board chip bars.

### Data flow after this change

```
Settings UI — Add Board
  │
  ├─► POST /api/boards  { boardId: "NEW", boardType: "scrum" }
  │     │
  │     └─► BoardsService.createBoard()
  │           └─► INSERT INTO board_configs (boardId, boardType, …defaults)
  │                 └─► 200 BoardConfig | 409 if already exists
  │
  └─► refreshBoards() in boards-store
        └─► GET /api/boards  →  boards-store.allBoards updated
              └─► All pages re-render with new board chip


Settings UI — Delete Board
  │
  ├─► DELETE /api/boards/:boardId
  │     │
  │     └─► BoardsService.deleteBoard()
  │           └─► DELETE FROM board_configs WHERE boardId = :boardId
  │                 (orphaned jira_issues / jira_sprints / jira_changelogs remain;
  │                  they are invisible once the board config row is gone)
  │
  └─► refreshBoards() in boards-store
        └─► board removed from allBoards → chips disappear from all pages


Scheduled sync (every 30 min) — syncAll()
  │
  └─► boardConfigRepo.find()  →  all board_configs rows
        │
        └─► syncBoard(boardId) per row  (no env var read)
```

### New / changed files

| File | Change |
|---|---|
| `backend/src/boards/boards.service.ts` | Add `createBoard()`, `deleteBoard()`; remove `seedDefaults()` and `DEFAULT_BOARDS` constant |
| `backend/src/boards/boards.controller.ts` | Add `POST /` and `DELETE /:boardId` handlers |
| `backend/src/boards/dto/create-board.dto.ts` | **New file** — `CreateBoardDto` |
| `backend/src/sync/sync.service.ts` | Rewrite `syncAll()` and `getStatus()` to use `boardConfigRepo.find()`; remove `ConfigService` dependency if it is only used for `JIRA_BOARD_IDS`; keep `ensureBoardConfig()` as a no-op safety net but remove hardcoded `'PLAT'` heuristic |
| `backend/.env` | Remove `JIRA_BOARD_IDS` line |
| `backend/.env.example` | Remove `JIRA_BOARD_IDS` line; add migration note comment |
| `frontend/src/lib/api.ts` | Add `createBoard()` and `deleteBoard()` functions |
| `frontend/src/store/boards-store.ts` | Add `refreshBoards()` method |
| `frontend/src/app/settings/page.tsx` | Add Board and Delete Board UI sections |
| `frontend/src/app/dora/page.tsx` | Add empty-state component when `allBoards` is `[]` and status is `'ready'` |
| `frontend/src/app/planning/page.tsx` | Same empty-state pattern |
| `frontend/src/app/cycle-time/page.tsx` | Same empty-state pattern |
| `frontend/src/app/roadmap/page.tsx` | Same empty-state pattern |
| `frontend/src/app/gaps/page.tsx` | Same empty-state pattern |

---

## Detailed Design

### Backend

#### 1. `CreateBoardDto` — `backend/src/boards/dto/create-board.dto.ts`

```typescript
import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBoardDto {
  @ApiProperty({ example: 'ACC', description: 'Jira project key used as the board identifier' })
  @IsString()
  @IsNotEmpty()
  boardId!: string;

  @ApiProperty({ enum: ['scrum', 'kanban'] })
  @IsString()
  @IsIn(['scrum', 'kanban'])
  boardType!: string;
}
```

The `boardId` is validated as non-empty string. Normalisation (uppercasing) is applied
in the service, not the DTO, so the DTO remains a pure validation layer.

#### 2. `BoardsService` additions

```typescript
// New method
async createBoard(dto: CreateBoardDto): Promise<BoardConfig> {
  const boardId = dto.boardId.trim().toUpperCase();

  const existing = await this.boardConfigRepo.findOne({ where: { boardId } });
  if (existing) {
    throw new ConflictException(`Board "${boardId}" already exists`);
  }

  const config = this.boardConfigRepo.create({
    boardId,
    boardType: dto.boardType,
  });
  return this.boardConfigRepo.save(config);
}

// New method
async deleteBoard(boardId: string): Promise<void> {
  const result = await this.boardConfigRepo.delete({ boardId });
  if (result.affected === 0) {
    throw new NotFoundException(`Board "${boardId}" not found`);
  }
}
```

**`createBoard()` design decisions:**

- Normalise `boardId` to uppercase before the uniqueness check and insert. Jira project
  keys are always uppercase (e.g. `ACC`, `PLAT`); accepting lowercase input and
  normalising prevents duplicate rows like `acc` and `ACC`.
- All `BoardConfig` columns other than `boardId` and `boardType` use their entity-level
  defaults (see `board-config.entity.ts`). The operator sets fine-grained config via
  the existing `PUT /api/boards/:boardId/config` endpoint after the board is created.
- `ConflictException` maps to HTTP 409, which the frontend can distinguish from a
  validation error (400) to show "board already exists" feedback.

**`deleteBoard()` design decisions:**

- Uses TypeORM `delete()` (hard delete). Orphaned rows in `jira_issues`,
  `jira_sprints`, `jira_changelogs`, `jira_versions`, and `sync_logs` for the deleted
  `boardId` are intentionally left in place (see Orphaned Data below).
- `NotFoundException` maps to HTTP 404.
- `seedDefaults()` and the `DEFAULT_BOARDS` constant are removed entirely. They have
  had no callers since the `JIRA_BOARD_IDS` env var was the primary board-seeding
  mechanism.

#### 3. `BoardsController` additions

```typescript
@ApiOperation({ summary: 'Create a new board configuration' })
@Post()
async create(@Body() dto: CreateBoardDto): Promise<BoardConfig> {
  return this.boardsService.createBoard(dto);
}

@ApiOperation({ summary: 'Delete a board configuration' })
@ApiParam({ name: 'boardId', description: 'Board identifier (e.g. ACC, PLAT)' })
@HttpCode(204)
@Delete(':boardId')
async delete(@Param('boardId') boardId: string): Promise<void> {
  return this.boardsService.deleteBoard(boardId);
}
```

`DELETE` returns **204 No Content** on success, consistent with REST convention and the
existing `deleteRoadmapConfig` pattern in `RoadmapController`.

#### 4. `SyncService` — remove `JIRA_BOARD_IDS`

```typescript
// Before:
async syncAll(): Promise<{ boards: string[]; results: SyncLog[] }> {
  const boardIdsStr = this.configService.get<string>(
    'JIRA_BOARD_IDS',
    'ACC,BPT,SPS,OCS,DATA,PLAT',
  );
  const boardIds = boardIdsStr.split(',').map((id) => id.trim());
  ...
}

// After:
async syncAll(): Promise<{ boards: string[]; results: SyncLog[] }> {
  const configs = await this.boardConfigRepo.find();
  const boardIds = configs.map((c) => c.boardId);
  const results: SyncLog[] = [];

  for (const boardId of boardIds) {
    const result = await this.syncBoard(boardId);
    results.push(result);
  }

  try {
    await this.syncRoadmaps();
  } catch (error) { ... }

  return { boards: boardIds, results };
}
```

```typescript
// Before:
async getStatus(): Promise<...> {
  const boardIdsStr = this.configService.get<string>(
    'JIRA_BOARD_IDS',
    'ACC,BPT,SPS,OCS,DATA,PLAT',
  );
  const boardIds = boardIdsStr.split(',').map((id) => id.trim());
  ...
}

// After:
async getStatus(): Promise<...> {
  const configs = await this.boardConfigRepo.find();
  const boardIds = configs.map((c) => c.boardId);
  ...
}
```

`ConfigService` may no longer be needed in `SyncService` after this change. Verify at
implementation time whether any other config reads remain; if not, remove the
constructor dependency to reduce coupling.

#### 5. `ensureBoardConfig()` — keep as a safety net, remove the heuristic

`ensureBoardConfig()` currently creates a `board_configs` row if one does not exist,
using `boardId === 'PLAT'` to guess `kanban`. Once `createBoard()` is the authoritative
creation path, `syncBoard()` should never encounter a missing config for a known board
(the board was added via the UI before sync ran). However, the guard provides defence
in depth against data anomalies (e.g., a row deleted directly in the database while a
sync is in flight).

Remove the `'PLAT'` heuristic and replace the fallback with `'scrum'` as the default:

```typescript
private async ensureBoardConfig(boardId: string): Promise<BoardConfig> {
  const existing = await this.boardConfigRepo.findOne({ where: { boardId } });
  if (existing) return existing;

  // Safety net: should not occur in normal operation.
  // If reached, a board config was deleted while sync was running.
  this.logger.warn(
    `Board config for "${boardId}" not found during sync. ` +
    `Creating a fallback scrum config. Re-add the board via Settings.`
  );
  const config = this.boardConfigRepo.create({ boardId, boardType: 'scrum' });
  return this.boardConfigRepo.save(config);
}
```

#### 6. Orphaned data strategy

When a board is deleted via `DELETE /api/boards/:boardId`, the following rows remain in
the database without a corresponding `board_configs` entry:

| Table | Rows keyed by `boardId` | Fate |
|---|---|---|
| `jira_issues` | `boardId` column | Remain; invisible to all API calls that join or filter by active boards |
| `jira_sprints` | `boardId` column | Remain; invisible to sprint-listing queries |
| `jira_changelogs` | `issueKey` (indirect) | Remain; not queried directly by boardId |
| `jira_versions` | `projectKey` column | Remain; invisible to version queries |
| `sync_logs` | `boardId` column | Remain; appear in raw log queries but are not shown in the sync status UI (which now reads active boards only) |

**Rationale for soft orphaning over cascade delete:**

The delete operation is irreversible if cascaded. Historical data for a board (issues,
sprints, changelogs) may be valuable for auditing or re-ingestion if the board is
re-added later. The `board_configs` row being absent is sufficient to remove all UI
surface — the board will not appear in chips, sync will not run for it, and metric
queries will never include its boardId. A future "purge board data" operation can be
added as a deliberate, separate administrative action if space becomes a concern.

This is consistent with how `deleteRoadmapConfig` works in the existing codebase:
deleting a `roadmap_config` row leaves `jpd_ideas` rows in place.

---

### Frontend

#### 7. `api.ts` additions

```typescript
export interface CreateBoardRequest {
  boardId: string;
  boardType: 'scrum' | 'kanban';
}

export function createBoard(body: CreateBoardRequest): Promise<BoardConfig> {
  return apiFetch<BoardConfig>('/api/boards', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteBoard(boardId: string): Promise<void> {
  return apiFetch(`/api/boards/${encodeURIComponent(boardId)}`, {
    method: 'DELETE',
  });
}
```

`deleteBoard` returns `Promise<void>` because the backend returns 204 No Content. The
existing `apiFetch` helper calls `res.json()` unconditionally; it must be updated to
handle 204 responses without calling `.json()`, or `deleteBoard` should use a raw
`fetch` call. The cleanest fix is a small change to `apiFetch`:

```typescript
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  ...
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, `API error ${res.status}: ${body}`)
  }

  // 204 No Content — return undefined (caller must type as Promise<void>)
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}
```

This is a non-breaking additive fix; `deleteRoadmapConfig` already expects `void` and
would benefit from the same guard.

#### 8. `boards-store.ts` — `refreshBoards()` method

```typescript
interface BoardsState {
  allBoards: string[]
  kanbanBoardIds: Set<string>
  status: 'idle' | 'loading' | 'ready' | 'error'
  fetchBoards: () => Promise<void>
  /** Force a re-fetch regardless of current status. Call after add or delete. */
  refreshBoards: () => Promise<void>
}

// Inside the store:
refreshBoards: async () => {
  set({ status: 'idle' })
  const { fetchBoards } = get()
  await fetchBoards()
},
```

`refreshBoards()` resets `status` to `'idle'` then calls `fetchBoards()`. Because
`fetchBoards()` has an idempotency guard that skips re-fetching when `status` is already
`'ready'` or `'loading'`, the reset to `'idle'` is required to make the subsequent call
effective. The two-step approach avoids duplicating the fetch logic.

`AppInitialiser` does not call `refreshBoards()` — it only calls `fetchBoards()`. The
reset + re-fetch is intentionally opt-in, triggered only by Settings page actions.

#### 9. Settings page — Add Board UI

The "Board Configuration" section gains an "Add Board" panel above the board tabs,
modelled on the JPD "Add" flow:

```
┌─────────────────────────────────────────────────────────────┐
│  Board Configuration                                         │
│                                                              │
│  Add a board                                                 │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Board ID  e.g.  │  │ scrum     ▼  │  │  + Add Board │   │
│  │ ACC             │  └──────────────┘  └──────────────┘   │
│  └─────────────────┘                                         │
│                                                              │
│  ── Configured boards ──────────────────────────────────────│
│  [ ACC ]  [ BPT ]  [ SPS ]  [ OCS ]  [ DATA ]  [ PLAT ]    │
│                                                              │
│  (selected board config form...)                            │
└─────────────────────────────────────────────────────────────┘
```

Component-level state additions:

```typescript
const [newBoardId, setNewBoardId] = useState('');
const [newBoardType, setNewBoardType] = useState<'scrum' | 'kanban'>('scrum');
const [boardAdding, setBoardAdding] = useState(false);
```

Handler:

```typescript
const handleAddBoard = useCallback(async () => {
  const id = newBoardId.trim().toUpperCase();
  if (!id) return;
  setBoardAdding(true);
  try {
    const created = await createBoard({ boardId: id, boardType: newBoardType });
    setBoardList((prev) => [...prev, created.boardId]);
    setActiveBoard(created.boardId);
    setNewBoardId('');
    setNewBoardType('scrum');
    show('success', `Board "${created.boardId}" added`);
    refreshBoards(); // update global store
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      show('error', `Board "${id}" already exists`);
    } else {
      show('error', 'Failed to add board');
    }
  } finally {
    setBoardAdding(false);
  }
}, [newBoardId, newBoardType, show, refreshBoards]);
```

The `refreshBoards` function is obtained from the boards store:

```typescript
const refreshBoards = useBoardsStore((s) => s.refreshBoards);
```

#### 10. Settings page — Delete Board UI

Each board tab gains an `×` button (displayed inline in the tab, shown on hover to
avoid visual clutter). A `window.confirm()` prompt guards against accidental deletion —
consistent with the internal tool's no-modal-library convention and matching how
`deleteRoadmapConfig` works (which also uses no confirmation; this proposal adds a
confirmation step to make the irreversible data-hide action more deliberate).

```
[ ACC ×]  [ BPT ×]  [ SPS ×]  ...
```

Tab button update:

```tsx
<button
  key={id}
  type="button"
  onClick={() => setActiveBoard(id)}
  className={`group relative flex items-center gap-1.5 px-4 py-2 text-sm font-medium
    transition-colors ${activeBoard === id ? 'border-b-2 border-blue-600 text-blue-600'
    : 'text-muted hover:text-foreground'}`}
>
  {id}
  <span
    role="button"
    aria-label={`Remove board ${id}`}
    onClick={(e) => {
      e.stopPropagation();
      void handleDeleteBoard(id);
    }}
    className="ml-0.5 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-red-100
      hover:text-red-600 group-hover:opacity-100"
  >
    <X className="h-3 w-3" />
  </span>
</button>
```

Handler:

```typescript
const handleDeleteBoard = useCallback(async (id: string) => {
  if (!window.confirm(`Remove board "${id}"? Synced data is retained but the board
    will no longer appear in the dashboard.`)) return;

  try {
    await deleteBoard(id);
    setBoardList((prev) => prev.filter((b) => b !== id));
    if (activeBoard === id) {
      const remaining = boardList.filter((b) => b !== id);
      setActiveBoard(remaining[0] ?? null);
      setConfig(null);
    }
    show('success', `Board "${id}" removed`);
    refreshBoards(); // update global store
  } catch {
    show('error', `Failed to remove board "${id}"`);
  }
}, [activeBoard, boardList, show, refreshBoards]);
```

#### 11. Empty states

When `boards-store.status === 'ready'` and `allBoards.length === 0`, every page that
renders a board chip bar or board selector must show a meaningful empty state. The
common pattern is a centred card with a link to `/settings`:

```tsx
// Reusable inline component (or extracted to components/ui/no-boards-state.tsx)
function NoBoardsConfigured() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border
      border-dashed border-border bg-card py-16 text-center">
      <p className="text-sm font-medium text-foreground">No boards configured</p>
      <p className="mt-1 text-sm text-muted">
        Add a board in{' '}
        <a href="/settings" className="text-blue-600 underline hover:text-blue-700">
          Settings
        </a>{' '}
        to start tracking metrics.
      </p>
    </div>
  );
}
```

Empty state trigger condition per page:

| Page | Trigger condition | Replaces |
|---|---|---|
| **DORA** (`/dora`) | `boardsStatus === 'ready' && allBoards.length === 0` | The entire metrics grid area |
| **Planning** (`/planning`) | `boardsStatus === 'ready' && allBoards.length === 0` | The board selector + data table |
| **Cycle Time** (`/cycle-time`) | `boardsStatus === 'ready' && allBoards.length === 0` | The board selector + chart area |
| **Roadmap** (`/roadmap`) | `boardsStatus === 'ready' && allBoards.length === 0` | The board selector + table |
| **Gaps** (`/gaps`) | `boardsStatus === 'ready' && allBoards.length === 0` | The issues table |
| **Settings** (`/settings`) | `boardList.length === 0 && !boardAdding` | The existing "No boards available. Please sync data first." message (update copy) |

The `boardsStatus` discriminant is important: pages must not show the empty state during
the brief `loading` window (which would cause a flash). The empty state only appears
once `status === 'ready'` confirms the fetch succeeded and the list is genuinely empty.

Settings page specifically: the existing message "No boards available. Please sync data
first." is misleading in a world where boards are managed via the UI. Replace with:

> "No boards configured yet. Use the form above to add your first board."

The "Add Board" form is always visible above this message, so the user has an immediate
action path.

---

## Migration Path for Existing Deployments

Operators who already have boards configured via `JIRA_BOARD_IDS` need to understand
that the variable is no longer read and can be removed.

### Steps

1. **Before upgrading**, verify that all board IDs currently in `JIRA_BOARD_IDS` already
   have rows in `board_configs`. Because `SyncService.ensureBoardConfig()` creates a row
   on every sync run, any deployment that has ever completed a sync will already have
   all boards in the database. Confirm with:
   ```sql
   SELECT board_id FROM board_configs;
   ```
   If any `JIRA_BOARD_IDS` value is missing, add it via the new UI before deploying,
   or manually insert it:
   ```sql
   INSERT INTO board_configs (board_id, board_type, ...) VALUES ('NEWBOARD', 'scrum', ...);
   ```

2. **Deploy** the new backend and frontend.

3. **Remove `JIRA_BOARD_IDS`** from `.env`. The application will start without it.
   No restart required for this specific change once the code is deployed — the variable
   is simply no longer read.

4. **Verify** that the Settings page shows all expected boards and that a manual sync
   (`POST /api/sync`) completes successfully.

### Rollback

If rollback is needed, re-add `JIRA_BOARD_IDS` to `.env` and redeploy the previous
version. Because the `board_configs` rows are never deleted by the migration, the
previous `ensureBoardConfig()` logic will find them and skip re-creation. No data loss
occurs during upgrade or rollback.

### `.env.example` migration note

```bash
# JIRA_BOARD_IDS is no longer used. Boards are managed via the Settings UI.
# See docs/proposals/0016-ui-driven-board-management.md for migration steps.
# JIRA_BOARD_IDS=ACC,BPT,SPS,OCS,DATA,PLAT
```

---

## Alternatives Considered

### Alternative A — Keep `JIRA_BOARD_IDS` as a seed-on-startup mechanism

On application boot, read `JIRA_BOARD_IDS`, call `ensureBoardConfig()` for each entry,
then allow the UI to manage boards from that point forward. The env var becomes a
one-time initialisation hint rather than the live source of truth.

**Why considered:** Low migration friction for existing deployments — the operator
doesn't need to add boards via the UI before they appear in sync.

**Why ruled out:** It maintains dual authority. If an operator adds a board via the UI
but the env var still lists the old set, startup reconciliation would re-create deleted
boards. Any future "board was intentionally removed via UI" state is overridden at next
restart. The env var remains a source of confusion and potential drift. The correct
long-term design is a single write path; the migration cost (one SQL check before
upgrading) is minimal.

### Alternative B — Cascade delete related data on board deletion

When `DELETE /api/boards/:boardId` is called, also delete all `jira_issues`,
`jira_sprints`, `jira_changelogs`, `jira_versions`, and `sync_logs` rows for that
`boardId`.

**Why considered:** Keeps the database clean; prevents unbounded orphaned row growth if
boards are frequently added and deleted.

**Why ruled out:** The delete is irreversible. Historical sprint data, changelogs, and
DORA metrics history for a board represent significant ingestion work (potentially
thousands of API calls to Jira). Deleting them on a board config removal — which is a
UI operation that can be triggered accidentally — is disproportionately destructive.
The "soft orphan" approach retains the data and allows re-addition of a board to
immediately resume showing historical data without a full re-sync. A deliberate purge
can be a future, separately-gated operation.

### Alternative C — Add a `DELETE /api/boards/:boardId/data` endpoint for explicit purge

Implement both soft delete (as proposed) and a separate purge endpoint for operators
who want to reclaim space.

**Why considered:** Gives operators the option of both behaviours.

**Why ruled out:** Premature. The current data volumes for a single-team internal tool
are small (order of thousands of rows). The complexity of a purge endpoint (it must
cascade across five tables atomically) is not justified until there is a demonstrated
operational need. Can be added as a follow-up proposal.

### Alternative D — Inline board type detection via Jira API during `createBoard()`

When the operator enters a board ID in the "Add Board" form, call the Jira Agile API
(`GET /agile/1.0/board?projectKeyOrId=…`) in the backend to auto-detect whether the
board is `scrum` or `kanban`, removing the need for the operator to specify `boardType`
manually.

**Why considered:** Better UX — the operator only needs to enter the project key; the
type is inferred automatically.

**Why ruled out:** Adds a Jira API call to what should be a simple database insert.
This creates a new failure mode: board creation fails if Jira is temporarily unavailable,
even though the creation is purely a local database operation. It also complicates the
API contract (the endpoint must now handle Jira API errors). The operator knows whether
their board is scrum or kanban; a two-field form is not burdensome. Auto-detection can
be added as a UX enhancement in a follow-up.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | No migrations required | `board_configs` table structure is unchanged. The operations are `INSERT` and `DELETE` on existing rows. Orphaned rows in related tables are explicitly retained by design. |
| API contract | Additive | Two new endpoints: `POST /api/boards` (201) and `DELETE /api/boards/:boardId` (204). Existing `GET /api/boards` and `PUT /api/boards/:boardId/config` are unchanged. `apiFetch` gains a 204 guard (non-breaking). |
| Backend — `SyncService` | Internal change only | `syncAll()` and `getStatus()` now query `boardConfigRepo` instead of reading an env var. Observable behaviour is identical when boards are already in the database. `ConfigService` injection may be removable if `JIRA_BOARD_IDS` was its only use. |
| Backend — `BoardsService` | Additive | `createBoard()` and `deleteBoard()` added. `seedDefaults()` and `DEFAULT_BOARDS` removed (dead code removal). |
| Frontend — `api.ts` | Additive | `createBoard()`, `deleteBoard()`, `CreateBoardRequest` type added. `apiFetch` gains 204 guard. |
| Frontend — `boards-store.ts` | Additive | `refreshBoards()` method added. No existing behaviour changes. |
| Frontend — `settings/page.tsx` | Enhanced | Add Board form + Delete button per tab. Local state additions only; no new store dependencies. |
| Frontend — 5 page components | Additive | Empty-state UI added for the `allBoards === []` + `status === 'ready'` case. No existing data-flow changes. |
| Tests | New unit + integration tests | `BoardsService.createBoard()`, `deleteBoard()`, HTTP 409 path, HTTP 404 path; `boards-store.refreshBoards()`; Settings page add/delete flows. |
| Jira API | No new calls | Board creation is a local database operation; type detection is manual. |
| Env var | Removed | `JIRA_BOARD_IDS` removed from `.env`, `.env.example`, and all backend code. See Migration Path. |

---

## Open Questions

1. **Board ID normalisation scope.** This proposal normalises `boardId` to uppercase in
   `BoardsService.createBoard()`. Should the same normalisation apply to
   `PUT /api/boards/:boardId/config` and `DELETE /api/boards/:boardId`? Currently the
   route param is used as-is. Inconsistency could lead to a 404 if the operator passes
   lowercase in a URL. Recommend normalising in all three places, but this is an
   implementation detail to confirm.

2. **Confirmation UX.** `window.confirm()` is used for the delete confirmation to match
   the internal-tool, no-modal-library convention. If the team later introduces a modal
   library (e.g., shadcn/ui `AlertDialog`), the delete confirmation should be updated to
   use it. Accept `window.confirm()` as sufficient for now?

3. **Re-extraction of `NoBoardsConfigured`** into a shared component file. The empty
   state is identical across five pages. Should it live in
   `frontend/src/components/ui/no-boards-state.tsx` (new file), or is inline duplication
   acceptable given the small size? The proposal recommends extraction but defers to
   implementation preference.

4. **`ConfigService` removal.** After `JIRA_BOARD_IDS` is the only `ConfigService` read
   in `SyncService` removed, does `ConfigService` still have other reads in that file?
   A quick audit is needed at implementation time to determine whether the constructor
   injection can be removed. This has no observable behaviour impact but reduces
   unnecessary coupling.

5. **Sort order of boards in `GET /api/boards`.** The `boardConfigRepo.find()` call
   returns rows in insertion order (PostgreSQL heap order, effectively). If operators
   add boards in a non-alphabetical order and care about chip display order, a
   `displayOrder` column or an `ORDER BY board_id` sort may be desirable. This proposal
   leaves ordering as-is (insertion order, consistent with the status quo established in
   proposal 0015). If ordering is a concern, it should be addressed in a follow-up.

---

## Acceptance Criteria

**Backend**

- [ ] `POST /api/boards` accepts `{ boardId, boardType }`, normalises `boardId` to
      uppercase, creates a `board_configs` row with all other columns at entity defaults,
      and returns the new `BoardConfig` (HTTP 201).

- [ ] `POST /api/boards` returns HTTP 409 with a meaningful error message if a
      `board_configs` row for that `boardId` (case-insensitive) already exists.

- [ ] `POST /api/boards` returns HTTP 400 if `boardId` is empty/missing or `boardType`
      is not `'scrum'` or `'kanban'`.

- [ ] `DELETE /api/boards/:boardId` deletes the `board_configs` row and returns HTTP 204.

- [ ] `DELETE /api/boards/:boardId` returns HTTP 404 if no row with that `boardId` exists.

- [ ] `DELETE /api/boards/:boardId` does **not** delete rows in `jira_issues`,
      `jira_sprints`, `jira_changelogs`, `jira_versions`, or `sync_logs` for that board.

- [ ] `SyncService.syncAll()` calls `boardConfigRepo.find()` to obtain the board list.
      No reference to `JIRA_BOARD_IDS` or `ConfigService.get('JIRA_BOARD_IDS', ...)`.

- [ ] `SyncService.getStatus()` calls `boardConfigRepo.find()` to obtain the board list.
      No reference to `JIRA_BOARD_IDS`.

- [ ] `ensureBoardConfig()` no longer contains the `boardId === 'PLAT'` heuristic.
      The fallback board type is `'scrum'` with a warning log.

- [ ] `BoardsService.seedDefaults()` and the `DEFAULT_BOARDS` constant are removed.

- [ ] `JIRA_BOARD_IDS` is absent from `backend/.env`, `backend/.env.example`, and all
      backend TypeScript source files.

- [ ] A manual sync (`POST /api/sync`) triggered immediately after `POST /api/boards`
      for a new board produces a `SyncLog` entry for that board.

**Frontend**

- [ ] `frontend/src/lib/api.ts` exports `createBoard(body: CreateBoardRequest): Promise<BoardConfig>`
      and `deleteBoard(boardId: string): Promise<void>`.

- [ ] `apiFetch` handles HTTP 204 responses without calling `.json()`, returning
      `undefined` as `T`.

- [ ] `useBoardsStore` exposes `refreshBoards(): Promise<void>` that resets `status` to
      `'idle'` and re-calls `fetchBoards()`.

- [ ] The Settings page "Board Configuration" section includes an "Add Board" form with
      a text input for board ID and a `<select>` for board type (`scrum` / `kanban`).

- [ ] Submitting the add form with a valid new board ID calls `POST /api/boards`, adds
      the new board to the local tab list, activates the new board's tab, clears the
      form inputs, calls `refreshBoards()`, and shows a success toast.

- [ ] Submitting the add form when the board already exists shows an error toast
      ("Board already exists") without adding a duplicate tab.

- [ ] Each board tab in the Settings page has a delete affordance (×) that, after a
      `window.confirm()` prompt, calls `DELETE /api/boards/:boardId`, removes the tab,
      navigates to the first remaining tab (or no tab if none remain), calls
      `refreshBoards()`, and shows a success toast.

- [ ] Cancelling the `window.confirm()` prompt takes no action (board is not deleted).

- [ ] All five metric pages (DORA, Planning, Cycle Time, Roadmap, Gaps) show the
      `NoBoardsConfigured` empty state — with a link to `/settings` — when
      `boards-store.status === 'ready'` and `boards-store.allBoards.length === 0`.

- [ ] The `NoBoardsConfigured` empty state does **not** appear while `status` is
      `'idle'` or `'loading'` (no flash on initial load).

- [ ] The Settings page empty-state message reads "No boards configured yet. Use the
      form above to add your first board." — not the previous "No boards available.
      Please sync data first." text.

- [ ] Adding a board in Settings causes the new board chip to appear in the DORA page
      chip bar on the same browser session without a full page reload (via
      `refreshBoards()`).

- [ ] Deleting the last board in Settings causes all metric pages to show the empty
      state without a JS error.

- [ ] No new npm dependencies are introduced.

- [ ] No database migrations are required.
