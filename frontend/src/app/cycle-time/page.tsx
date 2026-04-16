'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { useReplaceParams } from '@/hooks/use-page-params'
import {
  getCycleTime,
  getCycleTimeTrend,
  getQuarters,
  getAppConfig,
  type CycleTimeResult,
  type CycleTimeTrendPoint,
  type CycleTimeObservation,
  type QuarterInfo,
} from '@/lib/api'
import { classifyCycleTime } from '@/lib/cycle-time-bands'
import { useBoardsStore } from '@/store/boards-store'
import { BoardChip } from '@/components/ui/board-chip'
import { ToggleChip } from '@/components/ui/toggle-chip'
import { EmptyState } from '@/components/ui/empty-state'
import { NoBoardsConfigured } from '@/components/ui/no-boards-configured'
import { CycleTimePercentileCard } from '@/components/ui/cycle-time-percentile-card'
import { CycleTimeTrendChart } from '@/components/ui/cycle-time-trend-chart'
import { CycleTimeScatter } from '@/components/ui/cycle-time-scatter'
import { CycleTimeBandBadge } from '@/components/ui/cycle-time-band-badge'

const PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      results: CycleTimeResult[]
      trend: CycleTimeTrendPoint[]
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pooledPercentiles(results: CycleTimeResult[]) {
  const allObs = results.flatMap((r) => r.observations)
  if (allObs.length === 0) {
    return { p50: 0, p75: 0, p85: 0, p95: 0, count: 0, anomalyCount: 0 }
  }
  const sorted = allObs.map((o) => o.cycleTimeDays).sort((a, b) => a - b)
  const pct = (p: number): number => {
    const idx = (p / 100) * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    if (lo === hi) return sorted[lo]
    return sorted[lo] + (idx - lo) * ((sorted[hi] ?? 0) - (sorted[lo] ?? 0))
  }
  const anomalyCount = results.reduce((s, r) => s + r.anomalyCount, 0)
  return {
    p50: Math.round(pct(50) * 10) / 10,
    p75: Math.round(pct(75) * 10) / 10,
    p85: Math.round(pct(85) * 10) / 10,
    p95: Math.round(pct(95) * 10) / 10,
    count: sorted.length,
    anomalyCount,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CycleTimePage() {
  return (
    <Suspense>
      <CycleTimePageInner />
    </Suspense>
  )
}

function CycleTimePageInner() {
  const searchParams = useSearchParams()
  const replaceParams = useReplaceParams()

  // Board catalogue from store
  const allBoards = useBoardsStore((s) => s.allBoards)
  const boardsStatus = useBoardsStore((s) => s.status)

  // Filter state lives in the URL — defaults applied when params are absent
  const selectedBoard = searchParams.get('board') ?? (allBoards[0] ?? '')
  const selectedQuarter = searchParams.get('quarter') ?? ''
  const issueTypeFilter = searchParams.get('type') ?? ''

  const [quarters, setQuarters] = useState<QuarterInfo[]>([])
  const [pageState, setPageState] = useState<PageState>({ status: 'idle' })
  const [retryKey, setRetryKey] = useState(0)
  const [excludeWeekends, setExcludeWeekends] = useState(true)

  const reload = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])
  const [tablePage, setTablePage] = useState(0)

  // Fetch app config (timezone, excludeWeekends) once on mount
  useEffect(() => {
    getAppConfig()
      .then((cfg) => setExcludeWeekends(cfg.excludeWeekends))
      .catch(() => { /* keep default */ })
  }, [])

  // Load quarter list once on mount; auto-select first quarter if none in URL
  useEffect(() => {
    let cancelled = false
    getQuarters()
      .then((res) => {
        if (!cancelled) {
          setQuarters(res)
          if (res.length > 0 && !searchParams.get('quarter')) {
            replaceParams({ quarter: res[0].quarter })
          }
        }
      })
      .catch(() => {
        // leave quarters empty — UI will remain idle
      })
    return () => {
      cancelled = true
    }
  // replaceParams and searchParams intentionally omitted — runs once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Main data fetch — fires on filter change or retry
  useEffect(() => {
    let cancelled = false
    if (boardsStatus !== 'ready' || !selectedQuarter) return
    setPageState({ status: 'loading' })

    const run = async (): Promise<void> => {
      try {
        const [results, trend] = await Promise.all([
          getCycleTime({
            boardId: selectedBoard,
            quarter: selectedQuarter,
            issueType: issueTypeFilter || undefined,
          }),
          getCycleTimeTrend({
            boardId: selectedBoard,
            mode: 'quarters',
            limit: 8,
            issueType: issueTypeFilter || undefined,
          }),
        ])
        if (!cancelled) {
          setPageState({ status: 'ready', results, trend })
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setPageState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load cycle time data',
          })
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [selectedBoard, selectedQuarter, issueTypeFilter, boardsStatus, retryKey])

  // Compute pooled percentiles across all boards' results
  const pooled = useMemo(() => {
    if (pageState.status !== 'ready') return null
    return pooledPercentiles(pageState.results)
  }, [pageState])

  // All observations pooled across boards (for scatter + table)
  const allObservations = useMemo((): CycleTimeObservation[] => {
    if (pageState.status !== 'ready') return []
    return pageState.results.flatMap((r) => r.observations)
  }, [pageState])

  // Reset table page when observations change
  useEffect(() => {
    setTablePage(0)
  }, [allObservations])

  // Paginated observations
  const pagedObservations = useMemo(
    () => allObservations.slice(tablePage * PAGE_SIZE, (tablePage + 1) * PAGE_SIZE),
    [allObservations, tablePage],
  )

  // Derive available issue types from observations
  const availableIssueTypes = useMemo((): string[] => {
    const types = new Set(allObservations.map((o) => o.issueType))
    return Array.from(types).sort()
  }, [allObservations])

  const handleBoardSelect = useCallback((boardId: string) => {
    replaceParams({ board: boardId })
  }, [replaceParams])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Cycle Time</h1>
        <p className="mt-1 text-sm text-muted">
          Time from work started to done — excluding pre-work queue
        </p>
      </div>

      {/* No boards configured */}
      {boardsStatus === 'ready' && allBoards.length === 0 && (
        <NoBoardsConfigured />
      )}

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {/* Board selector — single select */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">Board</label>
          <div className="flex flex-wrap gap-2">
            {allBoards.map((boardId) => (
              <BoardChip
                key={boardId}
                boardId={boardId}
                selected={selectedBoard === boardId}
                onClick={() => handleBoardSelect(boardId)}
              />
            ))}
          </div>
        </div>

        {/* Quarter selector */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">Quarter</label>
          <div className="inline-flex flex-wrap gap-1">
            {quarters.map((q) => (
              <ToggleChip
                key={q.quarter}
                label={q.quarter}
                selected={selectedQuarter === q.quarter}
                onClick={() => replaceParams({ quarter: q.quarter })}
              />
            ))}
          </div>
        </div>

        {/* Issue type filter */}
        {availableIssueTypes.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted">Issue Type</label>
            <div className="flex flex-wrap gap-2">
              <ToggleChip
                label="All"
                selected={issueTypeFilter === ''}
                onClick={() => replaceParams({ type: null })}
              />
              {availableIssueTypes.map((t) => (
                <ToggleChip
                  key={t}
                  label={t}
                  selected={issueTypeFilter === t}
                  onClick={() => replaceParams({ type: t })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Skeleton loading */}
      {pageState.status === 'loading' && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-surface-alt" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-[200px] animate-pulse rounded-xl bg-surface-alt" />
            ))}
          </div>
          <div className="space-y-2 rounded-xl border border-border bg-card p-4">
            <div className="h-8 animate-pulse rounded bg-surface-alt" />
            {Array.from({ length: 5 }).map((_, i) => (
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

      {/* Empty state */}
      {pageState.status === 'idle' && (
        <EmptyState
          title="No data"
          message="Select a board and quarter to view cycle time metrics."
        />
      )}

      {/* Main content */}
      {pageState.status === 'ready' && pooled && (
        <>
          {/* Anomaly banner */}
          {pooled.anomalyCount > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-sm text-amber-700">
                <span className="font-semibold">
                  {pooled.anomalyCount} issue{pooled.anomalyCount !== 1 ? 's' : ''} excluded
                </span>{' '}
                — no &quot;In Progress&quot; transition found; these issues are omitted from
                percentile calculations.
              </p>
            </div>
          )}

          {/* No data state for period */}
          {pooled.count === 0 && (
            <EmptyState
              title="No completed issues"
              message={`No issues completed in ${selectedQuarter} for board ${selectedBoard}.`}
            />
          )}

          {pooled.count > 0 && (
            <>
              {/* Percentile summary cards */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <CycleTimePercentileCard
                  percentile="p50"
                  days={pooled.p50}
                  sampleSize={pooled.count}
                  band={classifyCycleTime(pooled.p50)}
                  excludeWeekends={excludeWeekends}
                />
                <CycleTimePercentileCard
                  percentile="p75"
                  days={pooled.p75}
                  sampleSize={pooled.count}
                  band={classifyCycleTime(pooled.p75)}
                  excludeWeekends={excludeWeekends}
                />
                <CycleTimePercentileCard
                  percentile="p85"
                  days={pooled.p85}
                  sampleSize={pooled.count}
                  band={classifyCycleTime(pooled.p85)}
                  excludeWeekends={excludeWeekends}
                />
                <CycleTimePercentileCard
                  percentile="p95"
                  days={pooled.p95}
                  sampleSize={pooled.count}
                  band={classifyCycleTime(pooled.p95)}
                  excludeWeekends={excludeWeekends}
                />
              </div>

              {/* Charts */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <CycleTimeScatter observations={allObservations} />
                <CycleTimeTrendChart data={pageState.trend} />
              </div>

              {/* Per-issue table */}
              <div className="rounded-xl border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">
                    Issues ({allObservations.length})
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-table-header-bg">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                          Issue
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                          Summary
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                          Type
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                          Cycle (d)
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                          Completed
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                          Band
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pagedObservations.map((obs) => (
                        <tr
                          key={obs.issueKey}
                          className="hover:bg-interactive-hover-bg"
                        >
                          <td className="px-4 py-2.5 font-mono text-xs">
                            {obs.jiraUrl ? (
                              <a
                                href={obs.jiraUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {obs.issueKey}
                              </a>
                            ) : (
                              <span className="text-blue-600">{obs.issueKey}</span>
                            )}
                          </td>
                          <td className="max-w-xs truncate px-4 py-2.5 text-foreground">
                            {obs.summary}
                          </td>
                          <td className="px-4 py-2.5 text-muted">{obs.issueType}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-foreground">
                            {obs.cycleTimeDays.toFixed(1)}
                          </td>
                          <td className="px-4 py-2.5 text-muted">
                            {new Date(obs.completedAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-2.5">
                            <CycleTimeBandBadge
                              band={classifyCycleTime(obs.cycleTimeDays)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {allObservations.length > PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-border px-4 py-3">
                    <p className="text-xs text-muted">
                      Showing {tablePage * PAGE_SIZE + 1}–{Math.min((tablePage + 1) * PAGE_SIZE, allObservations.length)} of {allObservations.length}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setTablePage((p) => p - 1)}
                        disabled={tablePage === 0}
                        className="rounded border border-border px-2 py-1 text-xs transition-colors hover:bg-interactive-hover-bg disabled:opacity-50"
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => setTablePage((p) => p + 1)}
                        disabled={(tablePage + 1) * PAGE_SIZE >= allObservations.length}
                        className="rounded border border-border px-2 py-1 text-xs transition-colors hover:bg-interactive-hover-bg disabled:opacity-50"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
