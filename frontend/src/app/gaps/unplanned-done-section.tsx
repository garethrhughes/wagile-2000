'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import {
  getUnplannedDone,
  ApiError,
  type UnplannedDoneIssue,
  type UnplannedDoneResponse,
} from '@/lib/api'
import { SprintSelect } from '@/components/ui/sprint-select'
import { QuarterSelect } from '@/components/ui/quarter-select'
import { DataTable, type Column } from '@/components/ui/data-table'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PeriodMode = 'last90' | 'sprint' | 'quarter'

// ---------------------------------------------------------------------------
// StatChip — mirrors the sprint-detail page pattern exactly
// ---------------------------------------------------------------------------

interface StatChipProps {
  label: string
  value: string | number
}

function StatChip({ label, value }: StatChipProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-4 py-3 text-center">
      <span className="text-xl font-bold">{value}</span>
      <span className="mt-0.5 text-xs text-muted">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Date formatting helper — dd Mon yyyy
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Table column definitions
// ---------------------------------------------------------------------------

function buildColumns(): Column<UnplannedDoneIssue>[] {
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
              className="inline-flex items-center gap-1 font-mono text-sm font-medium text-blue-600 hover:underline"
            >
              {key}
              <ExternalLink className="h-3 w-3" />
            </a>
          )
        }
        return <span className="font-mono text-sm">{key}</span>
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
          <span title={text} className="block max-w-xs truncate text-sm">
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
      key: 'resolvedStatus',
      label: 'Resolved Status',
      sortable: true,
      render: (value) => (
        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
          {String(value)}
        </span>
      ),
    },
    {
      key: 'resolvedAt',
      label: 'Resolved',
      sortable: true,
      render: (value) => (
        <span className="whitespace-nowrap text-sm">{formatDate(String(value))}</span>
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
    {
      key: 'priority',
      label: 'Priority',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="text-sm">{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'assignee',
      label: 'Assignee',
      sortable: true,
      render: (value) =>
        value ? (
          <span className="text-sm">{String(value)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ]
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UnplannedDoneSectionProps {
  /** The currently selected board ID from the gaps page filter (null = none selected). */
  selectedBoard: string | null
  /** Whether the selected board is a Kanban board. */
  isKanban: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnplannedDoneSection({
  selectedBoard,
  isKanban,
}: UnplannedDoneSectionProps) {
  const [open, setOpen] = useState(false)

  // Period selector state
  const [periodMode, setPeriodMode] = useState<PeriodMode>('last90')
  const [selectedSprint, setSelectedSprint] = useState<string | null>(null)
  const [selectedQuarter, setSelectedQuarter] = useState<string | null>(null)

  // Fetch state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<UnplannedDoneResponse | null>(null)

  // Reset period + data when board changes
  useEffect(() => {
    setPeriodMode('last90')
    setSelectedSprint(null)
    setSelectedQuarter(null)
    setData(null)
    setError(null)
  }, [selectedBoard])

  // Derive the effective params for the API call
  const fetchParams = useMemo(() => {
    if (!selectedBoard || isKanban) return null
    if (periodMode === 'sprint' && selectedSprint) {
      return { boardId: selectedBoard, sprintId: selectedSprint }
    }
    if (periodMode === 'quarter' && selectedQuarter) {
      return { boardId: selectedBoard, quarter: selectedQuarter }
    }
    if (periodMode === 'last90') {
      return { boardId: selectedBoard }
    }
    return null
  }, [selectedBoard, isKanban, periodMode, selectedSprint, selectedQuarter])

  // Fetch when params become available / change
  useEffect(() => {
    if (!fetchParams) {
      setData(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    getUnplannedDone(fetchParams)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 400) {
          // 400 means Kanban — should be prevented by isKanban guard above,
          // but handle defensively.
          setError('Not available for Kanban boards.')
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load unplanned done data')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [fetchParams])

  // Summary stats: type breakdown chips
  const typeBreakdownChips = useMemo<{ label: string; value: number }[]>(() => {
    if (!data) return []
    return Object.entries(data.summary.byIssueType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ label: type, value: count }))
  }, [data])

  const columns = useMemo(() => buildColumns(), [])

  // Count shown in the section header badge
  const issueCount = data?.summary.total ?? 0

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Collapsible header */}
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
          <span className="text-base font-semibold text-foreground">
            Unplanned Done Tickets
          </span>
          {data && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {issueCount}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border">
          {/* Period selector */}
          <div className="space-y-3 px-5 py-4">
            {/* Period mode tabs */}
            <div>
              <label className="mb-2 block text-sm font-medium text-muted">Period</label>
              <div className="inline-flex rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => setPeriodMode('last90')}
                  className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
                    periodMode === 'last90'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-muted hover:bg-gray-50'
                  }`}
                >
                  Last 90 days
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodMode('sprint')}
                  disabled={isKanban}
                  className={`px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    periodMode === 'sprint'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-muted hover:bg-gray-50'
                  }`}
                >
                  Sprint
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodMode('quarter')}
                  className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
                    periodMode === 'quarter'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-muted hover:bg-gray-50'
                  }`}
                >
                  Quarter
                </button>
              </div>
            </div>

            {/* Sprint selector */}
            {periodMode === 'sprint' && (
              <div className="max-w-xs">
                <SprintSelect
                  boardId={selectedBoard ?? undefined}
                  value={selectedSprint}
                  onChange={setSelectedSprint}
                />
              </div>
            )}

            {/* Quarter selector */}
            {periodMode === 'quarter' && (
              <div className="max-w-xs">
                <QuarterSelect
                  value={selectedQuarter}
                  onChange={setSelectedQuarter}
                />
              </div>
            )}
          </div>

          {/* Kanban not-available message */}
          {isKanban && (
            <div className="px-5 pb-5">
              <p className="text-sm text-muted">
                Not available for Kanban boards. This report requires sprint membership
                data, which is only available for Scrum boards.
              </p>
            </div>
          )}

          {/* Prompt state — no board selected */}
          {!isKanban && !selectedBoard && (
            <div className="px-5 pb-5">
              <p className="text-sm text-muted">
                Select a board and period to view results.
              </p>
            </div>
          )}

          {/* Loading */}
          {!isKanban && selectedBoard && loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted" />
            </div>
          )}

          {/* Error */}
          {!isKanban && selectedBoard && !loading && error && (
            <div className="mx-5 mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Results */}
          {!isKanban && selectedBoard && !loading && !error && data && (
            <div className="space-y-4 pb-4">
              {/* Summary bar */}
              <div className="grid grid-cols-2 gap-3 px-5 sm:flex sm:flex-wrap">
                <StatChip label="Unplanned tickets" value={data.summary.total} />
                <StatChip
                  label="Unplanned points"
                  value={data.summary.totalPoints > 0 ? data.summary.totalPoints : '—'}
                />
                {typeBreakdownChips.map(({ label, value }) => (
                  <StatChip key={label} label={label} value={value} />
                ))}
              </div>

              {/* Issues table */}
              {data.issues.length === 0 ? (
                <div className="px-5 pb-2 text-sm text-muted">
                  No unplanned done tickets found for the selected period.
                </div>
              ) : (
                <div className="px-5">
                  <DataTable<UnplannedDoneIssue>
                    columns={columns}
                    data={data.issues}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
