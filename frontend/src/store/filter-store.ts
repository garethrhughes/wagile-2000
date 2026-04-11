import { create } from 'zustand';

export interface FilterState {
  selectedBoards: string[];
  periodType: 'sprint' | 'quarter';
  selectedSprint: string | null;
  selectedQuarter: string | null;
  setSelectedBoards: (boards: string[]) => void;
  setPeriodType: (type: 'sprint' | 'quarter') => void;
  setSelectedSprint: (sprintId: string | null) => void;
  setSelectedQuarter: (quarter: string | null) => void;
  setAllBoards: () => void;
}

const ALL_BOARDS = ['ACC', 'BPT', 'SPS', 'OCS', 'DATA', 'PLAT']

export const useFilterStore = create<FilterState>((set) => ({
  selectedBoards: ALL_BOARDS,
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

  setAllBoards: () => set({ selectedBoards: ALL_BOARDS }),
}))

export { ALL_BOARDS }
