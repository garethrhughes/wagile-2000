'use client'

import { useState, useMemo, useCallback } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { BandBadge } from './band-badge'
import type { DoraMetricsBoardBreakdown } from '@/lib/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BoardBreakdownTableProps {
  boardBreakdowns: DoraMetricsBoardBreakdown[] | undefined
  period: { start: string; end: string }
}

type SortKey =
  | 'boardId'
  | 'boardType'
  | 'deploymentsPerDay'
  | 'medianLeadTimeDays'
  | 'changeFailureRate'
  | 'mttrMedianHours'

type SortDir = 'asc' | 'desc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FlatRow {
  boardId: string
  boardType: 'scrum' | 'kanban'
  deploymentsPerDay: number
  totalDeployments: number
  dfBand: import('@/lib/dora-bands').DoraBand
  medianLeadTimeDays: number
  ltBand: import('@/lib/dora-bands').DoraBand
  changeFailureRate: number
  cfrBand: import('@/lib/dora-bands').DoraBand
  usingDefaultConfig: boolean
  mttrMedianHours: number
  mttrBand: import('@/lib/dora-bands').DoraBand
  incidentCount: number
}

function flattenBreakdown(b: DoraMetricsBoardBreakdown): FlatRow {
  return {
    boardId: b.boardId,
    boardType: b.boardType,
    deploymentsPerDay: b.deploymentFrequency.deploymentsPerDay,
    totalDeployments: b.deploymentFrequency.totalDeployments,
    dfBand: b.deploymentFrequency.band,
    medianLeadTimeDays: b.leadTime.medianDays,
    ltBand: b.leadTime.band,
    changeFailureRate: b.changeFailureRate.changeFailureRate,
    cfrBand: b.changeFailureRate.band,
    usingDefaultConfig: b.changeFailureRate.usingDefaultConfig,
    mttrMedianHours: b.mttr.medianHours,
    mttrBand: b.mttr.band,
    incidentCount: b.mttr.incidentCount,
  }
}

function SortIcon({
  columnKey,
  sortKey,
  sortDir,
}: {
  columnKey: SortKey
  sortKey: SortKey
  sortDir: SortDir
}) {
  if (sortKey !== columnKey) {
    return <ChevronsUpDown className="ml-1 inline h-3.5 w-3.5 text-muted" />
  }
  return sortDir === 'asc' ? (
    <ChevronUp className="ml-1 inline h-3.5 w-3.5" />
  ) : (
    <ChevronDown className="ml-1 inline h-3.5 w-3.5" />
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BoardBreakdownTable({
  boardBreakdowns,
  period,
}: BoardBreakdownTableProps) {
  // Default sort: lead time descending (worst first)
  const [sortKey, setSortKey] = useState<SortKey>('medianLeadTimeDays')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir('desc')
      }
    },
    [sortKey],
  )

  const rows = useMemo(() => {
    if (!boardBreakdowns) return []
    const flat = boardBreakdowns.map(flattenBreakdown)
    return [...flat].sort((a, b) => {
      const aVal = a[sortKey]
      const bVal = b[sortKey]
      let cmp = 0
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        cmp = aVal - bVal
      } else {
        cmp = String(aVal).localeCompare(String(bVal))
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [boardBreakdowns, sortKey, sortDir])

  const startLabel = new Date(period.start).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const endLabel = new Date(period.end).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  type ColDef = {
    key: SortKey
    label: string
  }

  const columns: ColDef[] = [
    { key: 'boardId', label: 'Board' },
    { key: 'boardType', label: 'Type' },
    { key: 'deploymentsPerDay', label: 'Depl/day' },
    { key: 'medianLeadTimeDays', label: 'Lead time (days)' },
    { key: 'changeFailureRate', label: 'CFR %' },
    { key: 'mttrMedianHours', label: 'MTTR (hrs)' },
  ]

  return (
    <div>
      <h2 className="mb-3 text-base font-semibold text-foreground">
        Board Breakdown —{' '}
        <span className="font-normal text-muted">
          {startLabel} – {endLabel}
        </span>
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-alt">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="cursor-pointer select-none px-4 py-3 text-left font-medium text-muted hover:text-foreground"
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  <SortIcon columnKey={col.key} sortKey={sortKey} sortDir={sortDir} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-muted"
                >
                  No board data available
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.boardId}
                  className="border-b border-border last:border-0 hover:bg-surface-alt/40"
                >
                  {/* Board ID */}
                  <td className="px-4 py-3 font-semibold text-foreground">
                    {row.boardId}
                  </td>

                  {/* Board type badge */}
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                        row.boardType === 'kanban'
                          ? 'border-purple-200 bg-purple-50 text-purple-700'
                          : 'border-blue-200 bg-blue-50 text-blue-700'
                      }`}
                    >
                      {row.boardType === 'kanban' ? 'Kanban' : 'Scrum'}
                    </span>
                  </td>

                  {/* Deployment frequency */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span>{row.deploymentsPerDay.toFixed(2)}</span>
                      <BandBadge band={row.dfBand} />
                    </div>
                  </td>

                  {/* Lead time */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span>{row.medianLeadTimeDays.toFixed(1)}</span>
                      <BandBadge band={row.ltBand} />
                    </div>
                  </td>

                  {/* CFR */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1">
                        {row.changeFailureRate.toFixed(1)}%
                        {row.usingDefaultConfig && (
                          <span
                            title="Using default failure detection config"
                            className="text-amber-500"
                          >
                            *
                          </span>
                        )}
                      </span>
                      <BandBadge band={row.cfrBand} />
                    </div>
                  </td>

                  {/* MTTR — show "—" when no incidents */}
                  <td className="px-4 py-3">
                    {row.incidentCount === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span>{row.mttrMedianHours.toFixed(1)}</span>
                        <BandBadge band={row.mttrBand} />
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
