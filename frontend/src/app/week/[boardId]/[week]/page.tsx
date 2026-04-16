'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Loader2, ExternalLink, AlertCircle } from 'lucide-react'
import {
  getWeekDetail,
  type WeekDetailResponse,
  type WeekDetailIssue,
  ApiError,
} from '@/lib/api'
import { DataTable, type Column } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Breadcrumb } from '@/components/ui/breadcrumb'

// ---------------------------------------------------------------------------
// Summary stat chip
// ---------------------------------------------------------------------------

interface StatChipProps {
  label: string
  value: string | number
  highlight?: 'none' | 'warn' | 'danger' | 'good'
}

function StatChip({ label, value, highlight = 'none' }: StatChipProps) {
  const colorClass =
    highlight === 'danger'
      ? 'border-red-200 bg-red-50 text-red-700'
      : highlight === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : highlight === 'good'
          ? 'border-green-200 bg-green-50 text-green-700'
          : 'border-border bg-card text-foreground'

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border px-4 py-3 text-center ${colorClass}`}
    >
      <span className="text-xl font-bold">{value}</span>
      <span className="mt-0.5 text-xs text-muted">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Date formatting helper
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

function buildColumns(): Column<WeekDetailIssue>[] {
  return [
    {
      key: 'key',
      label: 'Key',
      sortable: true,
      render: (value, row) => {
        const key = String(value)
        if (row.jiraUrl) {
          return (
            <a
              href={row.jiraUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-blue-600 hover:underline"
            >
              {key}
              <ExternalLink className="h-3 w-3" />
            </a>
          )
        }
        return <span className="font-mono">{key}</span>
      },
    },
    {
      key: 'summary',
      label: 'Summary',
      sortable: true,
      render: (value) => {
        const text = String(value)
        const truncated = text.length > 60 ? text.slice(0, 60) + '…' : text
        return (
          <span title={text} className="block max-w-xs truncate">
            {truncated}
          </span>
        )
      },
    },
    {
      key: 'issueType',
      label: 'Type',
      sortable: true,
    },
    {
      key: 'priority',
      label: 'Priority',
      sortable: true,
      render: (value) =>
        value !== null && value !== undefined && String(value) !== 'null' ? (
          <span>{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (value) => {
        const status = String(value)
        return (
          <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {status}
          </span>
        )
      },
    },
    {
      key: 'points',
      label: 'Points',
      sortable: true,
      render: (value) =>
        value !== null && value !== undefined ? (
          <span>{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'epicKey',
      label: 'Epic',
      sortable: true,
      render: (value) =>
        value !== null && value !== undefined && String(value) !== 'null' ? (
          <span className="font-mono text-xs">{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'boardEntryDate',
      label: 'Board Entry',
      sortable: true,
      render: (value) => (
        <span className="text-xs">{formatDate(String(value))}</span>
      ),
    },
    {
      key: 'completedInWeek',
      label: 'Completed',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="font-semibold text-green-600">✓</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'addedMidWeek',
      label: 'Mid-Week',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="font-semibold text-amber-600">+</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'linkedToRoadmap',
      label: 'Roadmap',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="font-semibold text-green-600">✓</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'isIncident',
      label: 'Incident',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            🔴 Incident
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'isFailure',
      label: 'Failure',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
            🟠 Failure
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ]
}

function rowClassName(row: WeekDetailIssue): string {
  if (row.completedInWeek) return 'bg-green-50 dark:bg-green-950/20'
  if (row.isIncident) return 'bg-red-50 dark:bg-red-950/20'
  if (row.isFailure) return 'bg-orange-50 dark:bg-orange-950/20'
  return ''
}

// ---------------------------------------------------------------------------
// Back navigation helpers
// ---------------------------------------------------------------------------

function getBackFallback(from: string | null): string {
  if (from === 'roadmap') return '/roadmap'
  return '/planning'
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WeekDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()

  const boardId = typeof params.boardId === 'string' ? params.boardId : ''
  const week = typeof params.week === 'string' ? params.week : ''
  const from = searchParams.get('from')

  const [data, setData] = useState<WeekDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  const reload = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  useEffect(() => {
    if (!boardId || !week) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)

    getWeekDetail(boardId, week)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError) {
          if (err.status === 404) {
            setNotFound(true)
          } else {
            setError(err.message)
          }
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load week detail')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [boardId, week, retryKey])

  const columns = useMemo(() => buildColumns(), [])

  const backFallback = getBackFallback(from)

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    )
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="space-y-4">
        <Breadcrumb segments={[{ label: from === 'roadmap' ? 'Roadmap' : 'Planning', href: backFallback }, { label: boardId }]} />
        <EmptyState
          title="Week not found"
          message={`No data found for week "${week}" on board "${boardId}".`}
        />
      </div>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="space-y-4">
        <Breadcrumb segments={[{ label: from === 'roadmap' ? 'Roadmap' : 'Planning', href: backFallback }, { label: boardId }]} />
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
          <button
            type="button"
            onClick={reload}
            className="mt-2 text-sm font-medium text-red-700 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  // ── No data ───────────────────────────────────────────────────────────────
  if (!data) {
    return (
      <div className="space-y-4">
        <Breadcrumb segments={[{ label: from === 'roadmap' ? 'Roadmap' : 'Planning', href: backFallback }, { label: boardId }]} />
        <EmptyState title="No data" message="No week data available." />
      </div>
    )
  }

  const { summary } = data

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="mb-2">
          <Breadcrumb
            segments={[
              { label: from === 'roadmap' ? 'Roadmap' : 'Planning', href: backFallback },
              { label: boardId },
              { label: week },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{week}</h1>
          <span className="text-sm text-muted">{boardId}</span>
          <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 capitalize">
            {data.boardConfig.boardType}
          </span>
          <span className="text-sm text-muted">
            {formatDate(data.weekStart)}
            {' – '}
            {formatDate(data.weekEnd)}
          </span>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatChip label="Total" value={summary.totalIssues} />
        <StatChip
          label="Completed"
          value={summary.completedIssues}
          highlight={summary.completedIssues > 0 ? 'good' : 'none'}
        />
        <StatChip
          label="Added Mid-Week"
          value={summary.addedMidWeek}
          highlight={summary.addedMidWeek > 0 ? 'warn' : 'none'}
        />
        <StatChip
          label="Roadmap-Linked"
          value={summary.linkedToRoadmap}
          highlight={summary.linkedToRoadmap > 0 ? 'good' : 'none'}
        />
        <StatChip label="Total Points" value={summary.totalPoints} />
        <StatChip
          label="Completed Points"
          value={summary.completedPoints}
          highlight={summary.completedPoints > 0 ? 'good' : 'none'}
        />
      </div>

      {/* Issues table */}
      {data.issues.length === 0 ? (
        <EmptyState
          title="No issues"
          message="No issues were found in this week."
        />
      ) : (
        <DataTable<WeekDetailIssue>
          columns={columns}
          data={data.issues}
          rowClassName={rowClassName}
        />
      )}
    </div>
  )
}
