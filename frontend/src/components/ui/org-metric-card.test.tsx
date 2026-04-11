import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrgMetricCard } from './org-metric-card'

describe('OrgMetricCard', () => {
  const baseProps = {
    title: 'Deployment Frequency',
    value: 3.25,
    unit: 'deploys/day',
    band: 'elite' as const,
    sparkline: [1, 2, 3, 4, 3, 5],
    contributingBoards: 6,
  }

  it('renders the metric title', () => {
    render(<OrgMetricCard {...baseProps} />)
    expect(screen.getByText('Deployment Frequency')).toBeInTheDocument()
  })

  it('renders the formatted value and unit', () => {
    render(<OrgMetricCard {...baseProps} />)
    expect(screen.getByText('3.25')).toBeInTheDocument()
    expect(screen.getByText('deploys/day')).toBeInTheDocument()
  })

  it('renders the BandBadge', () => {
    render(<OrgMetricCard {...baseProps} />)
    expect(screen.getByText('elite')).toBeInTheDocument()
  })

  it('renders sparkline SVG when data has 2+ points', () => {
    const { container } = render(<OrgMetricCard {...baseProps} />)
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('does not render sparkline when fewer than 2 points', () => {
    const { container } = render(
      <OrgMetricCard {...baseProps} sparkline={[1]} />,
    )
    expect(container.querySelector('svg')).toBeFalsy()
  })

  it('shows contributing boards count', () => {
    render(<OrgMetricCard {...baseProps} />)
    expect(screen.getByText('6 boards contributing')).toBeInTheDocument()
  })

  it('shows singular "board" when contributingBoards is 1', () => {
    render(<OrgMetricCard {...baseProps} contributingBoards={1} />)
    expect(screen.getByText('1 board contributing')).toBeInTheDocument()
  })

  it('shows partial data text when noDataBoards is provided', () => {
    render(
      <OrgMetricCard {...baseProps} contributingBoards={4} noDataBoards={2} />,
    )
    expect(screen.getByText('4 of 6 boards have data')).toBeInTheDocument()
  })

  it('formats percentage values correctly', () => {
    render(
      <OrgMetricCard {...baseProps} value={8.333} unit="%" band="high" />,
    )
    expect(screen.getByText('8.3%')).toBeInTheDocument()
  })

  it('formats days value with 1 decimal place', () => {
    render(
      <OrgMetricCard {...baseProps} value={4.1} unit="days" band="high" />,
    )
    expect(screen.getByText('4.1')).toBeInTheDocument()
  })
})
