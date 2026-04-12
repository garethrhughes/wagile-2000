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
  /** Force a re-fetch regardless of current status. Call after add or delete. */
  refreshBoards: () => Promise<void>
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
      // Non-fatal: pages degrade gracefully with empty board lists.
      set({ status: 'error' })
    }
  },

  refreshBoards: async () => {
    set({ status: 'idle' })
    await get().fetchBoards()
  },
}))
