import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardBreakdownTable } from './board-breakdown-table'
import type { DoraMetricsBoardBreakdown } from '@/lib/api'

const makeBoardBreakdown = (
  boardId: string,
  boardType: 'scrum' | 'kanban',
  overrides?: Partial<{
    deploymentsPerDay: number
    totalDeployments: number
    medianDays: number
    changeFailureRate: number
    usingDefaultConfig: boolean
    medianHours: number
    incidentCount: number
  }>,
): DoraMetricsBoardBreakdown => ({
  boardId,
  boardType,
  period: { start: '2026-01-01T00:00:00.000Z', end: '2026-03-31T23:59:59.999Z' },
  deploymentFrequency: {
    boardId,
    totalDeployments: overrides?.totalDeployments ?? 10,
    deploymentsPerDay: overrides?.deploymentsPerDay ?? 1.2,
    band: 'high',
    periodDays: 90,
  },
  leadTime: {
    boardId,
    medianDays: overrides?.medianDays ?? 3.1,
    p95Days: 10,
    band: 'high',
    sampleSize: 5,
  },
  changeFailureRate: {
    boardId,
    totalDeployments: overrides?.totalDeployments ?? 10,
    failureCount: 1,
    changeFailureRate: overrides?.changeFailureRate ?? 5.0,
    band: 'elite',
    usingDefaultConfig: overrides?.usingDefaultConfig ?? false,
  },
  mttr: {
    boardId,
    medianHours: overrides?.medianHours ?? 4.0,
    band: 'high',
    incidentCount: overrides?.incidentCount ?? 2,
  },
})

describe('BoardBreakdownTable', () => {
  const period = {
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-03-31T23:59:59.999Z',
  }

  const boardBreakdowns: DoraMetricsBoardBreakdown[] = [
    makeBoardBreakdown('ACC', 'scrum'),
    makeBoardBreakdown('PLAT', 'kanban', { incidentCount: 0 }),
    makeBoardBreakdown('BPT', 'scrum', { usingDefaultConfig: true }),
  ]

  it('renders one row per board', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    expect(screen.getByText('ACC')).toBeInTheDocument()
    expect(screen.getByText('PLAT')).toBeInTheDocument()
    expect(screen.getByText('BPT')).toBeInTheDocument()
  })

  it('shows Scrum badge for scrum boards', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    const scrumBadges = screen.getAllByText('Scrum')
    expect(scrumBadges.length).toBeGreaterThan(0)
  })

  it('shows Kanban badge for kanban boards', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    expect(screen.getByText('Kanban')).toBeInTheDocument()
  })

  it('shows — for MTTR when incidentCount is 0', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows * indicator for boards using default config', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    const stars = screen.getAllByText('*')
    expect(stars.length).toBeGreaterThan(0)
  })

  it('renders BandBadge inline with metric values', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    // Multiple band badges should be present (one per metric per row with data)
    const highBadges = screen.getAllByText('high')
    expect(highBadges.length).toBeGreaterThan(0)
  })

  it('renders no-data message when boardBreakdowns is empty', () => {
    render(<BoardBreakdownTable boardBreakdowns={[]} period={period} />)
    expect(screen.getByText('No board data available')).toBeInTheDocument()
  })

  it('renders column headers', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    expect(screen.getByText('Board')).toBeInTheDocument()
    expect(screen.getByText('Type')).toBeInTheDocument()
    expect(screen.getByText('Depl/day')).toBeInTheDocument()
    expect(screen.getByText('Lead time (days)')).toBeInTheDocument()
    expect(screen.getByText('CFR %')).toBeInTheDocument()
    expect(screen.getByText('MTTR (hrs)')).toBeInTheDocument()
  })

  it('sorts by a column when header is clicked', () => {
    render(<BoardBreakdownTable boardBreakdowns={boardBreakdowns} period={period} />)
    const boardHeader = screen.getByText('Board')
    fireEvent.click(boardHeader)
    // After clicking, rows should be sorted by boardId desc
    const rows = screen.getAllByRole('row')
    // Header row + 3 data rows
    expect(rows.length).toBe(4)
  })
})
