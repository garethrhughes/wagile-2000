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
  // starts empty; populated by AppInitialiser once boards load
  selectedBoards: [],
  periodType: 'quarter',
  selectedSprint: null,
  selectedQuarter: null,

  setSelectedBoards: (boards: string[]) => set({ selectedBoards: boards }),

  // Preserve existing selections when switching period type so dropdowns
  // keep their auto-selected values rather than forcing a re-pick.
  setPeriodType: (type: 'sprint' | 'quarter') => set({ periodType: type }),

  setSelectedSprint: (sprintId: string | null) =>
    set({ selectedSprint: sprintId }),

  setSelectedQuarter: (quarter: string | null) =>
    set({ selectedQuarter: quarter }),

  setAllBoards: () =>
    set({ selectedBoards: useBoardsStore.getState().allBoards }),
}))
