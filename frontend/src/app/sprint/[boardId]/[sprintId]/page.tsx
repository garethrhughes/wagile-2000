'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, ChevronLeft, ExternalLink, AlertCircle } from 'lucide-react'
import {
  getSprintDetail,
  type SprintDetailResponse,
  type SprintDetailIssue,
  ApiError,
} from '@/lib/api'
import { DataTable, type Column } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'

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
// Table columns
// ---------------------------------------------------------------------------

function buildColumns(): Column<SprintDetailIssue>[] {
  return [
    {
      key: 'key',
      label: 'Issue',
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
      key: 'currentStatus',
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
      key: 'addedMidSprint',
      label: 'Scope creep',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            ⚠ Mid-sprint
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'roadmapLinked',
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
    {
      key: 'completedInSprint',
      label: 'Done in sprint',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="font-semibold text-green-600">✓</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'leadTimeDays',
      label: 'Lead time',
      sortable: true,
      render: (value) =>
        value !== null && value !== undefined ? (
          <span>{Number(value).toFixed(1)}d</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ]
}

function rowClassName(row: SprintDetailIssue): string {
  if (row.isIncident || row.isFailure) return 'bg-red-50'
  if (row.addedMidSprint) return 'bg-amber-50'
  if (row.completedInSprint) return 'bg-green-50/30'
  return ''
}

// ---------------------------------------------------------------------------
// Back label helper
// ---------------------------------------------------------------------------

function getBackHref(from: string | null): string {
  if (from === 'planning') return '/planning'
  if (from === 'roadmap') return '/roadmap'
  return '/planning'
}

function getBackLabel(from: string | null): string {
  if (from === 'planning') return '← Planning'
  if (from === 'roadmap') return '← Roadmap'
  return '← Planning'
}

// ---------------------------------------------------------------------------
// Date formatting helper
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SprintDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()

  const boardId = typeof params.boardId === 'string' ? params.boardId : ''
  const sprintId = typeof params.sprintId === 'string' ? params.sprintId : ''
  const from = searchParams.get('from')

  const [data, setData] = useState<SprintDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [isKanban, setIsKanban] = useState(false)

  useEffect(() => {
    if (!boardId || !sprintId) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setNotFound(false)
    setIsKanban(false)

    getSprintDetail(boardId, sprintId)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError) {
          if (err.status === 404) {
            setNotFound(true)
          } else if (err.status === 400) {
            setIsKanban(true)
          } else {
            setError(err.message)
          }
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load sprint detail')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [boardId, sprintId])

  const columns = useMemo(() => buildColumns(), [])

  const backHref = getBackHref(from)
  const backLabel = getBackLabel(from)

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
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Link>
        <EmptyState
          title="Sprint not found"
          message={`Sprint "${sprintId}" was not found on board "${boardId}".`}
        />
      </div>
    )
  }

  // ── Kanban board ──────────────────────────────────────────────────────────
  if (isKanban) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Link>
        <EmptyState
          title="Kanban board"
          message="Sprint detail view is not available for Kanban boards."
        />
      </div>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Link>
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {error}
        </div>
      </div>
    )
  }

  // ── No data (shouldn't happen unless server returns empty sprint) ──────────
  if (!data) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Link>
        <EmptyState title="No data" message="No sprint data available." />
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
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          >
            <ChevronLeft className="h-4 w-4" />
            {backLabel}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{data.sprintName}</h1>
          <span className="text-sm text-muted">{boardId}</span>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
              data.state === 'active'
                ? 'bg-green-50 text-green-600'
                : data.state === 'closed'
                  ? 'bg-gray-100 text-gray-600'
                  : 'bg-blue-50 text-blue-600'
            }`}
          >
            {data.state}
          </span>
          {(data.startDate ?? data.endDate) && (
            <span className="text-sm text-muted">
              {formatDate(data.startDate)}
              {' – '}
              {data.endDate ? formatDate(data.endDate) : 'ongoing'}
            </span>
          )}
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatChip label="Committed" value={summary.committedCount} />
        <StatChip
          label="Added mid-sprint"
          value={summary.addedMidSprintCount}
          highlight={summary.addedMidSprintCount > 0 ? 'warn' : 'none'}
        />
        <StatChip label="Removed" value={summary.removedCount} />
        <StatChip
          label="Completed"
          value={summary.completedInSprintCount}
          highlight={summary.completedInSprintCount > 0 ? 'good' : 'none'}
        />
        <StatChip
          label="Roadmap-linked"
          value={summary.roadmapLinkedCount}
          highlight={summary.roadmapLinkedCount > 0 ? 'good' : 'none'}
        />
        <StatChip
          label="Incidents"
          value={summary.incidentCount}
          highlight={summary.incidentCount > 0 ? 'danger' : 'none'}
        />
        <StatChip
          label="Failures"
          value={summary.failureCount}
          highlight={summary.failureCount > 0 ? 'danger' : 'none'}
        />
        <StatChip
          label="Median lead time"
          value={
            summary.medianLeadTimeDays !== null
              ? `${summary.medianLeadTimeDays.toFixed(1)}d`
              : '—'
          }
        />
      </div>

      {/* Issues table */}
      {data.issues.length === 0 ? (
        <EmptyState
          title="No issues"
          message="No issues were found in this sprint."
        />
      ) : (
        <DataTable<SprintDetailIssue>
          columns={columns}
          data={data.issues}
          rowClassName={rowClassName}
        />
      )}
    </div>
  )
}
