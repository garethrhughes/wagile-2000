'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useReplaceParams } from '@/hooks/use-page-params'
import { useDebounce } from '@/hooks/use-debounce'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import type {
  ValueType,
  NameType,
} from 'recharts/types/component/DefaultTooltipContent'
import {
  getDoraAggregate,
  getDoraTrend,
  SnapshotPendingError,
  type OrgDoraResult,
  type TrendPoint,
} from '@/lib/api'
import { useBoardsStore } from '@/store/boards-store'
import { OrgMetricCard } from '@/components/ui/org-metric-card'
import { BoardBreakdownTable } from '@/components/ui/board-breakdown-table'
import { BoardChip } from '@/components/ui/board-chip'
import { ToggleChip } from '@/components/ui/toggle-chip'
import { EmptyState } from '@/components/ui/empty-state'
import { NoBoardsConfigured } from '@/components/ui/no-boards-configured'
import { MetricHelp, type MetricDefinition } from '@/components/ui/metric-help'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'ready'; aggregate: OrgDoraResult; trend: TrendPoint[] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abbreviateQuarter(label: string): string {
  // "2026-Q1" → "Q1 '26"
  const m = label.match(/^(\d{4})-Q([1-4])$/)
  if (m) return `Q${m[2]} '${m[1].slice(2)}`
  // Sprint names — truncate
  const numMatch = label.match(/(\d+)/)
  if (numMatch) return `SP ${numMatch[1]}`
  return label.length > 8 ? label.slice(0, 8) : label
}

// ---------------------------------------------------------------------------
// TrendChart component
// ---------------------------------------------------------------------------

interface TrendChartProps {
  title: string
  data: { label: string; value: number }[]
  unit: string
  color: string
}

function TrendChart({ title, data, unit, color }: TrendChartProps) {
  const chartData = data.map((p) => ({
    label: abbreviateQuarter(p.label),
    value: p.value,
  }))

  if (chartData.length < 2) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-xl border border-border bg-card p-4">
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-xs text-muted">Not enough data</p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart
          data={chartData}
          margin={{ top: 4, right: 12, left: -16, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}${unit}`}
          />
          <Tooltip
            formatter={(
              value: ValueType | undefined,
              name: NameType | undefined,
            ): [string, string] => [
              value !== undefined && !Array.isArray(value)
                ? `${Number(value).toFixed(2)}${unit}`
                : '',
              String(name ?? title),
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            name={title}
            stroke={color}
            strokeWidth={2}
            dot={{ r: 3, fill: color }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Metric help definitions
// ---------------------------------------------------------------------------

const DORA_HELP: MetricDefinition[] = [
  {
    name: 'Deployment Frequency',
    description: 'How often the team releases to production. Uses fix versions with a release date as the primary signal; falls back to transitions to a done status.',
    formula: 'deployments ÷ days in period',
    bands: [
      { label: 'Elite', threshold: 'Multiple deploys per day' },
      { label: 'High', threshold: 'Between once per day and once per week' },
      { label: 'Medium', threshold: 'Between once per week and once per month' },
      { label: 'Low', threshold: 'Less than once per month' },
    ],
  },
  {
    name: 'Lead Time for Changes',
    description: 'Median time from issue creation to first transition to a done/released status. When a fix version is present, the version release date is used as the endpoint. Weekends are excluded by default — values are in working days. Epics and Sub-tasks are excluded.',
    formula: 'median(doneDate − createdAt) across issues in period',
    bands: [
      { label: 'Elite', threshold: 'Less than 1 working day' },
      { label: 'High', threshold: '1 working day – 1 working week' },
      { label: 'Medium', threshold: '1 working week – 1 working month' },
      { label: 'Low', threshold: 'More than 1 working month' },
    ],
  },
  {
    name: 'Change Failure Rate',
    description: 'Percentage of deployments that result in a failure requiring remediation. Failure issues are identified by issue type, labels, or link type as configured per board.',
    formula: 'failure issues ÷ total deployments × 100',
    bands: [
      { label: 'Elite', threshold: '0 – 5%' },
      { label: 'High', threshold: '5 – 10%' },
      { label: 'Medium', threshold: '10 – 15%' },
      { label: 'Low', threshold: 'More than 15%' },
    ],
  },
  {
    name: 'Mean Time to Recovery',
    description: 'Median time to recover from a failure. Measured from incident creation to transition to the configured recovery status. Uses calendar hours (weekends are included) — production incidents are not bounded by working hours.',
    formula: 'median(recoveryDate − failureCreatedAt) across incidents',
    bands: [
      { label: 'Elite', threshold: 'Less than 1 hour' },
      { label: 'High', threshold: '1 hour – 1 day' },
      { label: 'Medium', threshold: '1 day – 1 week' },
      { label: 'Low', threshold: 'More than 1 week' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DoraPage() {
  return (
    <Suspense>
      <DoraPageInner />
    </Suspense>
  )
}

function DoraPageInner() {
  const searchParams = useSearchParams()
  const replaceParams = useReplaceParams()

  // Board catalogue from store (fetched once by AppInitialiser)
  const allBoards = useBoardsStore((s) => s.allBoards)
  const kanbanBoardIds = useBoardsStore((s) => s.kanbanBoardIds)
  const boardsStatus = useBoardsStore((s) => s.status)

  // Filter state lives in the URL — defaults applied when params are absent.
  // useMemo stabilises the array reference so it doesn't change on every render
  // and trigger the data-fetch useEffect in an infinite loop.
  const boardsParam = searchParams.get('boards')
  const selectedBoards = useMemo<string[]>(
    () => (boardsParam ? boardsParam.split(',').filter(Boolean) : allBoards),
    [boardsParam, allBoards],
  )
  const periodType = (searchParams.get('mode') ?? 'quarter') as 'sprint' | 'quarter'

  const [pageState, setPageState] = useState<PageState>({ status: 'idle' })
  const [retryKey, setRetryKey] = useState(0)

  // Debounce board selection so rapid multi-board toggles don't fire a fetch
  // for every intermediate state. Chips update immediately; fetch waits 400 ms.
  const debouncedBoards = useDebounce(selectedBoards, 400)

  const reload = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  // Sprint mode is only valid when exactly 1 non-Kanban board is selected.
  // Depends on boardsStatus so it re-evaluates once the store is ready.
  const sprintModeAvailable = useMemo(
    () =>
      boardsStatus === 'ready' &&
      selectedBoards.length === 1 &&
      !kanbanBoardIds.has(selectedBoards[0] ?? ''),
    [selectedBoards, kanbanBoardIds, boardsStatus],
  )

  // Auto-reset to quarter when sprint mode becomes unavailable
  useEffect(() => {
    if (!sprintModeAvailable && periodType === 'sprint') {
      replaceParams({ mode: 'quarter' })
    }
  }, [sprintModeAvailable, periodType, replaceParams])

  // Main data fetch — fires on filter change or retry
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      if (debouncedBoards.length === 0) {
        setPageState({ status: 'idle' })
        return
      }
      setPageState({ status: 'loading' })
      const boardId = debouncedBoards.join(',')
      try {
        // Fetch trend first so we can align the aggregate window to the rightmost
        // chart point using the server's timezone, not the browser's local date.
        const trend = await getDoraTrend({ boardId, limit: 8 })
        if (cancelled) return
        const aggregate = await getDoraAggregate({ boardId })
        if (!cancelled) {
          setPageState({ status: 'ready', aggregate, trend: [...trend].reverse() })
        }
      } catch (err: unknown) {
        if (!cancelled) {
          if (err instanceof SnapshotPendingError) {
            setPageState({ status: 'pending' })
          } else {
            setPageState({
              status: 'error',
              message: err instanceof Error ? err.message : 'Failed to load metrics',
            })
          }
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [debouncedBoards, retryKey])

  // RC-5: extract sparklines from TrendPoint[] per metric
  const dfSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.orgDeploymentFrequency.deploymentsPerDay)
        : [],
    [pageState],
  )
  const ltSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.orgLeadTime?.medianDays ?? 0)
        : [],
    [pageState],
  )
  const cfrSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.orgChangeFailureRate.changeFailureRate)
        : [],
    [pageState],
  )
  const mttrSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.orgMttr.medianHours)
        : [],
    [pageState],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          DORA Metrics
          <MetricHelp metrics={DORA_HELP} />
        </h1>
        <p className="mt-1 text-sm text-muted">
          Organisation-wide delivery performance
        </p>
      </div>

      {/* No boards configured */}
      {boardsStatus === 'ready' && allBoards.length === 0 && (
        <NoBoardsConfigured />
      )}

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {/* Board selector — single select with All option */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">Board</label>
          <div className="flex flex-wrap gap-2">
            {/* All option */}
            <BoardChip
              boardId="All"
              selected={selectedBoards.length === allBoards.length || selectedBoards.length === 0}
              onClick={() => replaceParams({ boards: '' })}
            />
            {/* Individual boards */}
            {allBoards.map((boardId) => {
              const isKanban = kanbanBoardIds.has(boardId)
              const disabledForSprint = periodType === 'sprint' && isKanban
              return (
                <BoardChip
                  key={boardId}
                  boardId={boardId}
                  selected={selectedBoards.length < allBoards.length && selectedBoards.includes(boardId)}
                  disabled={disabledForSprint}
                  onClick={() => {
                    if (!disabledForSprint) {
                      // Single select: clicking a board selects only that board
                      replaceParams({ boards: boardId })
                    }
                  }}
                />
              )
            })}
          </div>
        </div>

        {/* Period type toggle */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">
            Period
          </label>
          <div className="inline-flex gap-1">
            <ToggleChip
              label="Quarter"
              selected={periodType === 'quarter'}
              onClick={() => replaceParams({ mode: 'quarter' })}
            />
            <ToggleChip
              label="Sprint"
              selected={periodType === 'sprint'}
              disabled={!sprintModeAvailable}
              onClick={() => {
                if (sprintModeAvailable) replaceParams({ mode: 'sprint' })
              }}
            />
          </div>
          {!sprintModeAvailable && (
            <p className="mt-2 text-xs text-muted">Sprint mode requires a single Scrum board</p>
          )}
          {periodType === 'sprint' && selectedBoards.length === 1 && (
            <p className="mt-1 text-xs text-muted">
              Showing last 8 periods for {selectedBoards[0]}
            </p>
          )}
        </div>
      </div>

      {/* Amber banner for default CFR config */}
      {pageState.status === 'ready' &&
        pageState.aggregate.anyBoardUsingDefaultConfig && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-700">
              <span className="font-semibold">CFR may not be accurate</span> —
              the following boards are using default failure detection
              configuration:{' '}
              <span className="font-medium">
                {pageState.aggregate.boardsUsingDefaultConfig.join(', ')}
              </span>
              . Configure board settings to refine this metric.
            </p>
          </div>
        )}

      {/* Amber banner for lead time anomalies */}
      {pageState.status === 'ready' &&
        (pageState.aggregate.orgLeadTime?.anomalyCount ?? 0) > 0 && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-700">
              <span className="font-semibold">
                {pageState.aggregate.orgLeadTime?.anomalyCount} issue
                {pageState.aggregate.orgLeadTime?.anomalyCount !== 1 ? 's' : ''} excluded
              </span>{' '}
              from Lead Time — no &quot;In Progress&quot; transition found; these issues
              are omitted from percentile calculations.
            </p>
          </div>
        )}

      {/* Skeleton loading */}
      {pageState.status === 'loading' && (
        <div className="space-y-6">
          {/* Metric card skeletons */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-surface-alt" />
            ))}
          </div>
          {/* Trend chart skeletons */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[200px] animate-pulse rounded-xl bg-surface-alt" />
            ))}
          </div>
          {/* Table skeleton */}
          <div className="space-y-2 rounded-xl border border-border bg-card p-4">
            <div className="h-8 animate-pulse rounded bg-surface-alt" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-surface-alt opacity-70" />
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {pageState.status === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">{pageState.message}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-2 text-sm font-medium text-red-700 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Pending — snapshot not yet computed (first sync still running) */}
      {pageState.status === 'pending' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-6 py-8 text-center">
          <div className="flex justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
          <p className="mt-4 text-sm font-semibold text-blue-800">
            Computing DORA metrics&hellip;
          </p>
          <p className="mt-1 text-sm text-blue-700">
            DORA snapshots are being computed. This usually takes under a minute
            after the first sync.
          </p>
          <button
            type="button"
            onClick={reload}
            className="mt-4 rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
          >
            Check again
          </button>
        </div>
      )}

      {/* Empty state */}
      {pageState.status === 'idle' && (
        <EmptyState
          title="No boards selected"
          message="Select one or more boards above to view DORA metrics."
        />
      )}

      {/* Main content */}
      {pageState.status === 'ready' && (
        <>
          {/* Hero metric cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <OrgMetricCard
              title="Deployment Frequency"
              value={pageState.aggregate.orgDeploymentFrequency.deploymentsPerDay}
              unit="deploys/day"
              band={pageState.aggregate.orgDeploymentFrequency.band}
              sparkline={dfSparkline}
              contributingBoards={
                pageState.aggregate.orgDeploymentFrequency.contributingBoards
              }
              noDataBoards={
                selectedBoards.length -
                pageState.aggregate.orgDeploymentFrequency.contributingBoards
              }
            />
            <OrgMetricCard
              title="Lead Time for Changes"
              value={pageState.aggregate.orgLeadTime?.medianDays ?? 0}
              unit="days"
              band={pageState.aggregate.orgLeadTime?.band ?? 'low'}
              sparkline={ltSparkline}
              contributingBoards={
                pageState.aggregate.orgLeadTime?.contributingBoards ?? 0
              }
              noDataBoards={
                selectedBoards.length -
                (pageState.aggregate.orgLeadTime?.contributingBoards ?? 0)
              }
              footnote="Measures cycle time (first active-work status → done), not the DORA definition of lead time (commit → deploy). A proxy metric for teams without commit-level Jira integration."
            />
            <OrgMetricCard
              title="Change Failure Rate"
              value={pageState.aggregate.orgChangeFailureRate.changeFailureRate}
              unit="%"
              band={pageState.aggregate.orgChangeFailureRate.band}
              sparkline={cfrSparkline}
              contributingBoards={
                pageState.aggregate.orgChangeFailureRate.contributingBoards
              }
              noDataBoards={
                selectedBoards.length -
                pageState.aggregate.orgChangeFailureRate.contributingBoards
              }
            />
            <OrgMetricCard
              title="Mean Time to Recovery"
              value={pageState.aggregate.orgMttr.medianHours}
              unit="hours"
              band={pageState.aggregate.orgMttr.band}
              sparkline={mttrSparkline}
              contributingBoards={
                pageState.aggregate.orgMttr.contributingBoards
              }
              noDataBoards={
                selectedBoards.length -
                pageState.aggregate.orgMttr.contributingBoards
              }
            />
          </div>

          {/* Trend charts */}
          {pageState.trend.length >= 2 && (
            <div>
              <h2 className="mb-3 text-base font-semibold text-foreground">
                Trend (last {pageState.trend.length} periods)
              </h2>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <TrendChart
                  title="Deployment Frequency"
                  data={pageState.trend.map((p) => ({ label: p.period.label, value: p.orgDeploymentFrequency.deploymentsPerDay }))}
                  unit=" dep/d"
                  color="#3b82f6"
                />
                <TrendChart
                  title="Lead Time for Changes"
                  data={pageState.trend.map((p) => ({ label: p.period.label, value: p.orgLeadTime?.medianDays ?? 0 }))}
                  unit=" days"
                  color="#8b5cf6"
                />
                <TrendChart
                  title="Change Failure Rate"
                  data={pageState.trend.map((p) => ({ label: p.period.label, value: p.orgChangeFailureRate.changeFailureRate }))}
                  unit="%"
                  color="#ef4444"
                />
                <TrendChart
                  title="Mean Time to Recovery"
                  data={pageState.trend.map((p) => ({ label: p.period.label, value: p.orgMttr.medianHours }))}
                  unit=" hrs"
                  color="#f59e0b"
                />
              </div>
            </div>
          )}

          {/* Per-board breakdown table */}
          <BoardBreakdownTable
            boardBreakdowns={pageState.aggregate.boardBreakdowns}
            period={pageState.aggregate.period}
          />
        </>
      )}
    </div>
  )
}
