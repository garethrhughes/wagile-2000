'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { getGaps, type GapIssue, type GapsResponse } from '@/lib/api'
import { useBoardsStore } from '@/store/boards-store'
import { BoardChip } from '@/components/ui/board-chip'
import { DataTable, type Column } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { NoBoardsConfigured } from '@/components/ui/no-boards-configured'
import { UnplannedDoneSection } from './unplanned-done-section'
import { MetricHelp, type MetricDefinition } from '@/components/ui/metric-help'

// ---------------------------------------------------------------------------
// Metric help definitions
// ---------------------------------------------------------------------------

const GAPS_HELP: MetricDefinition[] = [
  {
    name: 'No Epic Link',
    description: 'Open issues (non-Done status) that are not linked to a parent epic. These issues cannot be tracked against roadmap goals.',
  },
  {
    name: 'No Story Points',
    description: 'Open issues without a story point estimate. These issues cannot be included in velocity or capacity calculations.',
  },
  {
    name: 'Unplanned Done',
    description: 'Issues that were completed during the sprint but were not part of the sprint commitment at the start date. These indicate unplanned reactive work.',
  },
]

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

interface CollapsibleSectionProps {
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
}

function CollapsibleSection({ title, count, defaultOpen = true, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted" />
          )}
          <span className="text-base font-semibold text-foreground">{title}</span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {count}
          </span>
        </div>
      </button>
      {open && <div className="border-t border-border px-0 pb-0">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table column definitions
// ---------------------------------------------------------------------------

function buildColumns(): Column<GapIssue>[] {
  return [
    {
      key: 'key',
      label: 'Key',
      sortable: true,
      render: (value, row) => {
        if (!row.jiraUrl) return <span className="font-mono text-sm">{String(value)}</span>
        return (
          <a
            href={row.jiraUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm font-medium text-blue-600 hover:underline"
          >
            {String(value)}
          </a>
        )
      },
    },
    {
      key: 'summary',
      label: 'Summary',
      sortable: true,
      render: (value) => (
        <span className="max-w-xs truncate block text-sm" title={String(value)}>
          {String(value)}
        </span>
      ),
    },
    {
      key: 'issueType',
      label: 'Type',
      sortable: true,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
    },
    {
      key: 'boardId',
      label: 'Board',
      sortable: true,
    },
    {
      key: 'sprintName',
      label: 'Sprint',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="text-sm">{String(value)}</span>
        ) : (
          <span className="text-muted text-sm">Backlog</span>
        ),
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
        value ? (
          <span className="font-mono text-sm">{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ]
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GapsPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<GapsResponse | null>(null)
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const allBoards = useBoardsStore((s) => s.allBoards)
  const boardsStatus = useBoardsStore((s) => s.status)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getGaps()
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load gaps data')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [retryKey])

  // Client-side board filter
  const filteredNoEpic = useMemo<GapIssue[]>(() => {
    if (!data) return []
    if (!selectedBoard) return data.noEpic
    return data.noEpic.filter((i) => i.boardId === selectedBoard)
  }, [data, selectedBoard])

  const filteredNoEstimate = useMemo<GapIssue[]>(() => {
    if (!data) return []
    if (!selectedBoard) return data.noEstimate
    return data.noEstimate.filter((i) => i.boardId === selectedBoard)
  }, [data, selectedBoard])

  const columns = useMemo(() => buildColumns(), [])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          Issues Gaps
          <MetricHelp metrics={GAPS_HELP} />
        </h1>
        <p className="mt-1 text-sm text-muted">
          Open issues missing epic links or story point estimates
        </p>
      </div>

      {/* No boards configured */}
      {boardsStatus === 'ready' && allBoards.length === 0 && (
        <NoBoardsConfigured />
      )}

      {/* Board filter */}
      <div className="rounded-xl border border-border bg-card p-4">
        <label className="mb-2 block text-sm font-medium text-muted">Board</label>
        <div className="flex flex-wrap gap-2">
          <BoardChip
              boardId="All"
              selected={selectedBoard === null}
              onClick={() => setSelectedBoard(null)}
            />
          {allBoards.map((boardId) => (
            <BoardChip
              key={boardId}
              boardId={boardId}
              selected={selectedBoard === boardId}
              onClick={() => setSelectedBoard((prev) => (prev === boardId ? null : boardId))}
            />
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-600">{error}</p>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="mt-2 text-sm font-medium text-red-700 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && data && filteredNoEpic.length === 0 && filteredNoEstimate.length === 0 && (
        <EmptyState title="No gaps found" message="All issues in active sprints have an epic link and a story point estimate." />
      )}

      {!loading && !error && data && filteredNoEpic.length > 0 && (
        <CollapsibleSection
          title="Issues without an Epic"
          count={filteredNoEpic.length}
        >
          <DataTable<GapIssue> columns={columns} data={filteredNoEpic} />
        </CollapsibleSection>
      )}

      {!loading && !error && data && filteredNoEstimate.length > 0 && (
        <CollapsibleSection
          title="Issues without a story point estimate"
          count={filteredNoEstimate.length}
        >
          <DataTable<GapIssue> columns={columns} data={filteredNoEstimate} />
        </CollapsibleSection>
      )}

      <UnplannedDoneSection />
    </div>
  )
}
