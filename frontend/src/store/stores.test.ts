import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getBoards } from '@/lib/api'
import { useFilterStore } from './filter-store'
import { useBoardsStore } from './boards-store'

// ---------------------------------------------------------------------------
// Module-level mock — hoisted correctly by Vitest
// ---------------------------------------------------------------------------

vi.mock('@/lib/api', () => ({
  getBoards: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixed fixture — representative board list used across tests
// ---------------------------------------------------------------------------

const FIXTURE_BOARDS = [
  { boardId: 'ACC', boardType: 'scrum', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
  { boardId: 'BPT', boardType: 'scrum', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
  { boardId: 'SPS', boardType: 'scrum', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
  { boardId: 'OCS', boardType: 'scrum', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
  { boardId: 'DATA', boardType: 'scrum', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
  { boardId: 'PLAT', boardType: 'kanban', doneStatusNames: [], failureIssueTypes: [], failureLinkTypes: [], failureLabels: [], incidentIssueTypes: [], recoveryStatusNames: [], incidentLabels: [], backlogStatusIds: [], dataStartDate: null, inProgressStatusNames: [], cancelledStatusNames: [] },
]

const FIXTURE_BOARD_IDS = FIXTURE_BOARDS.map((b) => b.boardId)

// ---------------------------------------------------------------------------
// Filter Store
// ---------------------------------------------------------------------------

describe('useFilterStore', () => {
  beforeEach(() => {
    // Seed the boards store so setAllBoards() has something to read
    useBoardsStore.setState({
      allBoards: FIXTURE_BOARD_IDS,
      kanbanBoardIds: new Set(['PLAT']),
      status: 'ready',
    })
    // Reset filter store to a known baseline
    useFilterStore.setState({
      selectedBoards: FIXTURE_BOARD_IDS,
      periodType: 'quarter',
      selectedSprint: null,
      selectedQuarter: null,
    })
  })

  it('starts with all boards selected', () => {
    const { selectedBoards } = useFilterStore.getState()
    expect(selectedBoards).toEqual(FIXTURE_BOARD_IDS)
  })

  it('starts with quarter period type', () => {
    const { periodType } = useFilterStore.getState()
    expect(periodType).toBe('quarter')
  })

  it('sets selected boards', () => {
    useFilterStore.getState().setSelectedBoards(['ACC', 'BPT'])
    expect(useFilterStore.getState().selectedBoards).toEqual(['ACC', 'BPT'])
  })

  it('preserves period selections when changing period type', () => {
    useFilterStore.getState().setSelectedSprint('sprint-1')
    useFilterStore.getState().setSelectedQuarter('2025-Q1')

    useFilterStore.getState().setPeriodType('sprint')

    const state = useFilterStore.getState()
    expect(state.periodType).toBe('sprint')
    // Selections are preserved so dropdowns keep their auto-selected values
    expect(state.selectedSprint).toBe('sprint-1')
    expect(state.selectedQuarter).toBe('2025-Q1')
  })

  it('sets selected sprint', () => {
    useFilterStore.getState().setSelectedSprint('sprint-42')
    expect(useFilterStore.getState().selectedSprint).toBe('sprint-42')
  })

  it('sets selected quarter', () => {
    useFilterStore.getState().setSelectedQuarter('2025-Q2')
    expect(useFilterStore.getState().selectedQuarter).toBe('2025-Q2')
  })

  it('setAllBoards restores selectedBoards to the full list from the boards store', () => {
    useFilterStore.getState().setSelectedBoards(['ACC'])
    useFilterStore.getState().setAllBoards()
    expect(useFilterStore.getState().selectedBoards).toEqual(FIXTURE_BOARD_IDS)
  })
})

// ---------------------------------------------------------------------------
// Boards Store
// ---------------------------------------------------------------------------

describe('useBoardsStore', () => {
  beforeEach(() => {
    // Reset to idle before each test
    useBoardsStore.setState({
      allBoards: [],
      kanbanBoardIds: new Set(),
      status: 'idle',
    })
  })

  afterEach(() => {
    vi.mocked(getBoards).mockReset()
  })

  it('starts in idle state with empty board lists', () => {
    const state = useBoardsStore.getState()
    expect(state.status).toBe('idle')
    expect(state.allBoards).toEqual([])
    expect(state.kanbanBoardIds.size).toBe(0)
  })

  it('transitions idle → loading → ready on successful fetch', async () => {
    vi.mocked(getBoards).mockResolvedValueOnce(FIXTURE_BOARDS)

    const { fetchBoards } = useBoardsStore.getState()

    const fetchPromise = fetchBoards()
    // Immediately after calling, should be loading
    expect(useBoardsStore.getState().status).toBe('loading')

    await fetchPromise

    const state = useBoardsStore.getState()
    expect(state.status).toBe('ready')
    expect(state.allBoards).toEqual(FIXTURE_BOARD_IDS)
    expect(state.kanbanBoardIds).toEqual(new Set(['PLAT']))
  })

  it('correctly derives kanbanBoardIds from boardType', async () => {
    vi.mocked(getBoards).mockResolvedValueOnce(FIXTURE_BOARDS)

    await useBoardsStore.getState().fetchBoards()

    const { kanbanBoardIds } = useBoardsStore.getState()
    expect(kanbanBoardIds.has('PLAT')).toBe(true)
    expect(kanbanBoardIds.has('ACC')).toBe(false)
    expect(kanbanBoardIds.has('BPT')).toBe(false)
  })

  it('sets status to error and leaves lists empty when fetch throws', async () => {
    vi.mocked(getBoards).mockRejectedValueOnce(new Error('Network error'))

    await useBoardsStore.getState().fetchBoards()

    const state = useBoardsStore.getState()
    expect(state.status).toBe('error')
    expect(state.allBoards).toEqual([])
    expect(state.kanbanBoardIds.size).toBe(0)
  })

  it('is idempotent: calling fetchBoards twice does not fire the API twice', async () => {
    vi.mocked(getBoards).mockResolvedValue(FIXTURE_BOARDS)

    await useBoardsStore.getState().fetchBoards()
    await useBoardsStore.getState().fetchBoards()

    expect(vi.mocked(getBoards)).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: does not re-fetch when already in loading state', async () => {
    // Force loading state
    useBoardsStore.setState({ status: 'loading' })

    vi.mocked(getBoards).mockResolvedValue(FIXTURE_BOARDS)

    await useBoardsStore.getState().fetchBoards()

    // Should not have been called because status was already 'loading'
    expect(vi.mocked(getBoards)).not.toHaveBeenCalled()
  })

  it('refreshBoards re-fetches even when status is already ready', async () => {
    vi.mocked(getBoards).mockResolvedValue(FIXTURE_BOARDS)

    await useBoardsStore.getState().fetchBoards()
    expect(vi.mocked(getBoards)).toHaveBeenCalledTimes(1)
    expect(useBoardsStore.getState().status).toBe('ready')

    vi.mocked(getBoards).mockResolvedValue(FIXTURE_BOARDS)
    await useBoardsStore.getState().refreshBoards()
    expect(vi.mocked(getBoards)).toHaveBeenCalledTimes(2)
    expect(useBoardsStore.getState().status).toBe('ready')
  })
})
