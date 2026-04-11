import { describe, it, expect, beforeEach } from 'vitest';
import { useFilterStore, ALL_BOARDS } from './filter-store';

// ---------------------------------------------------------------------------
// Filter Store
// ---------------------------------------------------------------------------

describe('useFilterStore', () => {
  beforeEach(() => {
    useFilterStore.setState({
      selectedBoards: ALL_BOARDS,
      periodType: 'quarter',
      selectedSprint: null,
      selectedQuarter: null,
    });
  });

  it('starts with all boards selected', () => {
    const { selectedBoards } = useFilterStore.getState();
    expect(selectedBoards).toEqual(ALL_BOARDS);
  });

  it('starts with quarter period type', () => {
    const { periodType } = useFilterStore.getState();
    expect(periodType).toBe('quarter');
  });

  it('sets selected boards', () => {
    useFilterStore.getState().setSelectedBoards(['ACC', 'BPT']);
    expect(useFilterStore.getState().selectedBoards).toEqual(['ACC', 'BPT']);
  });

  it('preserves period selections when changing period type', () => {
    useFilterStore.getState().setSelectedSprint('sprint-1');
    useFilterStore.getState().setSelectedQuarter('2025-Q1');

    useFilterStore.getState().setPeriodType('sprint');

    const state = useFilterStore.getState();
    expect(state.periodType).toBe('sprint');
    // Selections are preserved so dropdowns keep their auto-selected values
    expect(state.selectedSprint).toBe('sprint-1');
    expect(state.selectedQuarter).toBe('2025-Q1');
  });

  it('sets selected sprint', () => {
    useFilterStore.getState().setSelectedSprint('sprint-42');
    expect(useFilterStore.getState().selectedSprint).toBe('sprint-42');
  });

  it('sets selected quarter', () => {
    useFilterStore.getState().setSelectedQuarter('2025-Q2');
    expect(useFilterStore.getState().selectedQuarter).toBe('2025-Q2');
  });

  it('setAllBoards restores selectedBoards to ALL_BOARDS', () => {
    useFilterStore.getState().setSelectedBoards(['ACC']);
    useFilterStore.getState().setAllBoards();
    expect(useFilterStore.getState().selectedBoards).toEqual(ALL_BOARDS);
  });
});
