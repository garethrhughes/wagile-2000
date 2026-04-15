'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useReplaceParams } from '@/hooks/use-page-params'
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
  type OrgDoraResult,
  type TrendPoint,
} from '@/lib/api'
import { useBoardsStore } from '@/store/boards-store'
import { OrgMetricCard } from '@/components/ui/org-metric-card'
import { BoardBreakdownTable } from '@/components/ui/board-breakdown-table'
import { BoardChip } from '@/components/ui/board-chip'
import { EmptyState } from '@/components/ui/empty-state'
import { NoBoardsConfigured } from '@/components/ui/no-boards-configured'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
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

/**
 * Returns the current calendar quarter label in YYYY-QN format (e.g. "2026-Q2").
 * Used to align the headline aggregate with the rightmost trend chart point so
 * that both values are always computed over the same time window.
 * (Proposal 0031 — fix for MTTR headline / chart discrepancy.)
 */
function currentQuarterLabel(): string {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3) + 1
  return `${now.getFullYear()}-Q${q}`
}

// ---------------------------------------------------------------------------
// TrendChart component
// ---------------------------------------------------------------------------

interface TrendChartProps {
  title: string
  data: TrendPoint[]
  dataKey: keyof Pick<
    TrendPoint,
    'deploymentsPerDay' | 'medianLeadTimeDays' | 'changeFailureRate' | 'mttrMedianHours'
  >
  unit: string
  color: string
}

function TrendChart({ title, data, dataKey, unit, color }: TrendChartProps) {
  const chartData = data.map((p) => ({
    label: abbreviateQuarter(p.label),
    value: p[dataKey],
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

  const toggleBoard = useCallback(
    (boardId: string) => {
      const next = selectedBoards.includes(boardId)
        ? selectedBoards.filter((b) => b !== boardId)
        : [...selectedBoards, boardId]
      replaceParams({ boards: next.join(',') })
    },
    [selectedBoards, replaceParams],
  )

  // Main data fetch — fires on filter change (2 calls in parallel)
  useEffect(() => {
    if (selectedBoards.length === 0) {
      setPageState({ status: 'idle' })
      return
    }

    let cancelled = false
    setPageState({ status: 'loading' })

    const boardId = selectedBoards.join(',')

    const load = async (): Promise<void> => {
      // Fetch trend first so we can align the aggregate window to the rightmost
      // chart point using the server's timezone, not the browser's local date.
      // Around quarter boundaries, a browser in a different timezone than the
      // backend's TIMEZONE config can call the wrong quarter and cause the
      // headline aggregate to disagree with the rightmost chart bar.
      const trend = await getDoraTrend({
        boardId,
        mode: periodType === 'sprint' ? 'sprints' : 'quarters',
        limit: 8,
      })

      if (cancelled) return

      // Use the last trend label as the aggregate quarter when it is a
      // quarter label (server timezone aligned). Fall back to the
      // browser-derived label when trend data is empty or in sprint mode
      // (where labels are sprint names, not quarter strings).
      const lastLabel = trend.length > 0 ? trend[trend.length - 1].label : undefined
      const aggregateQuarter =
        lastLabel?.match(/^\d{4}-Q[1-4]$/) != null ? lastLabel : currentQuarterLabel()

      const aggregate = await getDoraAggregate({ boardId, quarter: aggregateQuarter })

      if (!cancelled) {
        setPageState({ status: 'ready', aggregate, trend })
      }
    }

    load().catch((err: unknown) => {
      if (!cancelled) {
        setPageState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load metrics',
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [selectedBoards, periodType])

  // RC-5: extract sparklines from TrendPoint[] per metric
  const dfSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.deploymentsPerDay)
        : [],
    [pageState],
  )
  const ltSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.medianLeadTimeDays)
        : [],
    [pageState],
  )
  const cfrSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.changeFailureRate)
        : [],
    [pageState],
  )
  const mttrSparkline = useMemo(
    () =>
      pageState.status === 'ready'
        ? pageState.trend.map((p) => p.mttrMedianHours)
        : [],
    [pageState],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">DORA Metrics</h1>
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
        {/* Board selector */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-muted">Boards</label>
            <button
              type="button"
              onClick={() => replaceParams({ boards: allBoards.join(',') })}
              className="text-xs text-blue-600 hover:underline"
            >
              Select all
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {allBoards.map((boardId) => {
              const isKanban = kanbanBoardIds.has(boardId)
              const disabledForSprint = periodType === 'sprint' && isKanban
              return (
                <BoardChip
                  key={boardId}
                  boardId={boardId}
                  selected={selectedBoards.includes(boardId)}
                  disabled={disabledForSprint}
                  onClick={() => {
                    if (!disabledForSprint) toggleBoard(boardId)
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
          <div className="inline-flex rounded-lg border border-border">
            <button
              type="button"
              onClick={() => replaceParams({ mode: 'quarter' })}
              className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
                periodType === 'quarter'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-muted hover:bg-gray-50'
              }`}
            >
              Quarter
            </button>
            <button
              type="button"
              onClick={() => {
                if (sprintModeAvailable) replaceParams({ mode: 'sprint' })
              }}
              disabled={!sprintModeAvailable}
              title={
                !sprintModeAvailable
                  ? 'Sprint mode requires exactly one Scrum board to be selected'
                  : undefined
              }
              className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
                periodType === 'sprint'
                  ? 'bg-blue-50 text-blue-700'
                  : !sprintModeAvailable
                    ? 'cursor-not-allowed text-muted opacity-50'
                    : 'text-muted hover:bg-gray-50'
              }`}
            >
              Sprint
            </button>
          </div>
          {periodType === 'sprint' && selectedBoards.length === 1 && (
            <p className="mt-1 text-xs text-muted">
              Showing last 8 sprints for {selectedBoards[0]}
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
        pageState.aggregate.orgLeadTime.anomalyCount > 0 && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-amber-700">
              <span className="font-semibold">
                {pageState.aggregate.orgLeadTime.anomalyCount} issue
                {pageState.aggregate.orgLeadTime.anomalyCount !== 1 ? 's' : ''} excluded
              </span>{' '}
              from Lead Time — no &quot;In Progress&quot; transition found; these issues
              are omitted from percentile calculations.
            </p>
          </div>
        )}

      {/* Loading */}
      {pageState.status === 'loading' && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted" />
        </div>
      )}

      {/* Error */}
      {pageState.status === 'error' && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {pageState.message}
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
              value={pageState.aggregate.orgLeadTime.medianDays}
              unit="days"
              band={pageState.aggregate.orgLeadTime.band}
              sparkline={ltSparkline}
              contributingBoards={
                pageState.aggregate.orgLeadTime.contributingBoards
              }
              noDataBoards={
                selectedBoards.length -
                pageState.aggregate.orgLeadTime.contributingBoards
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
                  data={pageState.trend}
                  dataKey="deploymentsPerDay"
                  unit=" dep/d"
                  color="#3b82f6"
                />
                <TrendChart
                  title="Lead Time for Changes"
                  data={pageState.trend}
                  dataKey="medianLeadTimeDays"
                  unit=" days"
                  color="#8b5cf6"
                />
                <TrendChart
                  title="Change Failure Rate"
                  data={pageState.trend}
                  dataKey="changeFailureRate"
                  unit="%"
                  color="#ef4444"
                />
                <TrendChart
                  title="Mean Time to Recovery"
                  data={pageState.trend}
                  dataKey="mttrMedianHours"
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
