'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { Loader2, AlertCircle, RefreshCw, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Breadcrumb } from '@/components/ui/breadcrumb'
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
  getSprintReport,
  type SprintReportResponse,
  type SprintReportBand,
  type SprintDimensionScore,
  type SprintRecommendation,
  type DoraBand,
  type UnplannedDoneIssue,
} from '@/lib/api'
import { BandBadge } from '@/components/ui/band-badge'
import { DataTable, type Column } from '@/components/ui/data-table'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIMENSION_LABELS: Record<string, string> = {
  deliveryRate: 'Delivery Rate',
  scopeStability: 'Scope Stability',
  roadmapCoverage: 'Roadmap Coverage',
  leadTime: 'Lead Time',
  deploymentFrequency: 'Deployment Frequency',
  changeFailureRate: 'Change Failure Rate',
  mttr: 'MTTR',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Tailwind color classes for sprint report band */
function reportBandColor(band: SprintReportBand): string {
  switch (band) {
    case 'strong':
      return 'text-green-600'
    case 'good':
      return 'text-blue-600'
    case 'fair':
      return 'text-amber-600'
    case 'needs-attention':
      return 'text-red-600'
  }
}

function reportBandLabel(band: SprintReportBand): string {
  switch (band) {
    case 'strong':
      return 'Strong'
    case 'good':
      return 'Good'
    case 'fair':
      return 'Fair'
    case 'needs-attention':
      return 'Needs Attention'
  }
}

/** Tailwind color class for a 0-100 dimension score */
function scoreColor(score: number): string {
  if (score >= 75) return 'text-green-600'
  if (score >= 50) return 'text-blue-600'
  if (score >= 25) return 'text-amber-600'
  return 'text-red-600'
}

/** Abbreviate a sprint name for chart x-axis */
function abbreviateSprint(name: string): string {
  const numMatch = name.match(/(\d+)/)
  if (numMatch) return `SP ${numMatch[1]}`
  return name.length > 10 ? name.slice(0, 10) : name
}

function formatRawValue(score: SprintDimensionScore): string {
  if (score.rawValue === null) return '—'
  return `${score.rawValue.toFixed(1)} ${score.rawUnit}`
}

// ---------------------------------------------------------------------------
// DimensionCard
// ---------------------------------------------------------------------------

interface DimensionCardProps {
  dimensionKey: string
  score: SprintDimensionScore
}

function DimensionCard({ dimensionKey, score }: DimensionCardProps) {
  const label = DIMENSION_LABELS[dimensionKey] ?? dimensionKey
  const raw = formatRawValue(score)

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${scoreColor(score.score)}`}>
        {score.score.toFixed(1)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {score.band && <BandBadge band={score.band as DoraBand} />}
      </div>
      <p className="mt-2 text-xs text-muted">{raw}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TrendChart
// ---------------------------------------------------------------------------

interface TrendChartProps {
  data: Array<{ label: string; value: number }>
}

function TrendChart({ data }: TrendChartProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Composite Score Trend</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => String(v)}
          />
          <Tooltip
            formatter={(
              value: ValueType | undefined,
              name: NameType | undefined,
            ): [string, string] => [
              value !== undefined && !Array.isArray(value)
                ? Number(value).toFixed(1)
                : '',
              String(name ?? 'Score'),
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            name="Composite Score"
            stroke="#6366f1"
            strokeWidth={2}
            dot={{ r: 3, fill: '#6366f1' }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RecommendationsList
// ---------------------------------------------------------------------------

type Severity = SprintRecommendation['severity']

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info']

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warnings',
  info: 'Suggestions',
}

function SeverityDot({ severity }: { severity: Severity }) {
  const color =
    severity === 'critical'
      ? 'bg-red-500'
      : severity === 'warning'
        ? 'bg-amber-500'
        : 'bg-blue-500'
  return <span className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${color}`} />
}

interface RecommendationsListProps {
  recommendations: SprintRecommendation[]
}

function RecommendationsList({ recommendations }: RecommendationsListProps) {
  if (recommendations.length === 0) {
    return (
      <p className="text-sm text-muted">No recommendations — sprint looks healthy 🎉</p>
    )
  }

  const grouped = SEVERITY_ORDER.reduce<Record<Severity, SprintRecommendation[]>>(
    (acc, sev) => {
      acc[sev] = recommendations.filter((r) => r.severity === sev)
      return acc
    },
    { critical: [], warning: [], info: [] },
  )

  return (
    <div className="space-y-5">
      {SEVERITY_ORDER.map((sev) => {
        const items = grouped[sev]
        if (items.length === 0) return null
        return (
          <div key={sev}>
            <h4
              className={`mb-2 text-xs font-semibold uppercase tracking-wider ${
                sev === 'critical'
                  ? 'text-red-600'
                  : sev === 'warning'
                    ? 'text-amber-600'
                    : 'text-blue-600'
              }`}
            >
              {SEVERITY_LABELS[sev]}
            </h4>
            <ul className="space-y-2">
              {items.map((rec) => (
                <li key={rec.id} className="flex items-start gap-2.5">
                  <SeverityDot severity={rec.severity} />
                  <div className="min-w-0">
                    <span className="mr-2 font-mono text-xs text-muted">{rec.id}</span>
                    <span className="text-sm text-foreground">{rec.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers (shared across sprint report sections)
// ---------------------------------------------------------------------------

/** Format an ISO date string as "dd Mon yyyy" */
function formatResolvedDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// StatChip — inline summary chip (mirrors unplanned-done-section.tsx)
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
// Column definitions for UnplannedDoneIssue table
// ---------------------------------------------------------------------------

function buildUnplannedColumns(): Column<UnplannedDoneIssue>[] {
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
        <span className="whitespace-nowrap text-sm">{formatResolvedDate(String(value))}</span>
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
// UnplannedDoneSection — inline collapsible section for the sprint report
// ---------------------------------------------------------------------------

interface UnplannedDoneSectionProps {
  unplannedDone: NonNullable<SprintReportResponse['unplannedDone']>
}

function UnplannedDoneSection({ unplannedDone }: UnplannedDoneSectionProps) {
  const [open, setOpen] = useState(false)

  const typeBreakdownChips = useMemo<{ label: string; value: number }[]>(
    () =>
      Object.entries(unplannedDone.byIssueType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ label: type, value: count })),
    [unplannedDone.byIssueType],
  )

  const columns = useMemo(() => buildUnplannedColumns(), [])

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
            Never-Boarded Completions ({unplannedDone.total})
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-border">
          {unplannedDone.total === 0 ? (
            <div className="px-5 py-4 text-sm text-muted">
              No unplanned completions for this sprint.
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {/* Summary stat chips */}
              <div className="grid grid-cols-2 gap-3 px-5 pt-4 sm:flex sm:flex-wrap">
                <StatChip label="Unplanned tickets" value={unplannedDone.total} />
                <StatChip
                  label="Unplanned points"
                  value={unplannedDone.totalPoints > 0 ? unplannedDone.totalPoints : '—'}
                />
                {typeBreakdownChips.map(({ label, value }) => (
                  <StatChip key={label} label={label} value={value} />
                ))}
              </div>

              {/* Issues table */}
              <div className="px-5">
                <DataTable<UnplannedDoneIssue>
                  columns={columns}
                  data={unplannedDone.issues}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SprintReportResponse }

export default function SprintReportPage() {
  const params = useParams()
  const boardId = typeof params.boardId === 'string' ? params.boardId : ''
  const sprintId = typeof params.sprintId === 'string' ? params.sprintId : ''

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    (refresh = false) => {
      if (!boardId || !sprintId) return

      if (refresh) {
        setRefreshing(true)
      } else {
        setPageState({ status: 'loading' })
      }

      getSprintReport(boardId, sprintId, refresh)
        .then((data) => {
          setPageState({ status: 'ready', data })
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : 'Failed to load sprint report'
          setPageState({ status: 'error', message })
        })
        .finally(() => {
          setRefreshing(false)
        })
    },
    [boardId, sprintId],
  )

  useEffect(() => {
    load(false)
  }, [load])

  // ── Loading ──────────────────────────────────────────────────────────────
  if (pageState.status === 'loading') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (pageState.status === 'error') {
    return (
      <div className="space-y-4">
        <Breadcrumb segments={[{ label: 'Sprint', href: `/sprint/${boardId}/${sprintId}` }, { label: 'Report' }]} />
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-500" />
            <p className="text-sm text-red-600">{pageState.message}</p>
          </div>
          <button
            type="button"
            onClick={() => load(false)}
            className="mt-2 text-sm font-medium text-red-700 underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { data } = pageState

  // Build dimension entry list in a stable display order
  const dimensionEntries: Array<[string, SprintDimensionScore]> = [
    ['deliveryRate', data.scores.deliveryRate],
    ['scopeStability', data.scores.scopeStability],
    ['roadmapCoverage', data.scores.roadmapCoverage],
    ['leadTime', data.scores.leadTime],
    ['deploymentFrequency', data.scores.deploymentFrequency],
    ['changeFailureRate', data.scores.changeFailureRate],
    ['mttr', data.scores.mttr],
  ]

  // Build chart data from trend
  const chartData = data.trend.map((p) => ({
    label: abbreviateSprint(p.sprintName),
    value: p.compositeScore,
  }))

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-3">
          <Breadcrumb segments={[{ label: 'Sprint', href: `/sprint/${boardId}/${sprintId}` }, { label: 'Report' }]} />
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{data.sprintName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted">
              <span>{boardId}</span>
              {(data.startDate ?? data.endDate) && (
                <span>
                  {formatDate(data.startDate)}
                  {' – '}
                  {data.endDate ? formatDate(data.endDate) : 'ongoing'}
                </span>
              )}
              <span>Generated: {formatDateTime(data.generatedAt)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Composite score ────────────────────────────────────────────── */}
      <div className="flex flex-col items-center rounded-xl border border-border bg-card py-8 shadow-sm">
        <p className="text-sm font-medium text-muted">Composite Score</p>
        <p
          className={`mt-2 text-6xl font-bold tabular-nums leading-none ${reportBandColor(data.compositeBand)}`}
        >
          {data.compositeScore.toFixed(1)}
        </p>
        <p className={`mt-3 text-lg font-semibold ${reportBandColor(data.compositeBand)}`}>
          {reportBandLabel(data.compositeBand)}
        </p>
      </div>

      {/* ── Dimension scores grid ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-base font-semibold text-foreground">Dimension Scores</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {dimensionEntries.map(([key, score]) => (
            <DimensionCard key={key} dimensionKey={key} score={score} />
          ))}
        </div>
      </section>

      {/* ── Trend chart ──────────────────────────────────────────────────── */}
      {chartData.length > 1 && (
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Score Trend</h2>
          <TrendChart data={chartData} />
        </section>
      )}

      {/* ── Recommendations ───────────────────────────────────────────── */}
      <section>
        <h2 className="mb-4 text-base font-semibold text-foreground">Recommendations</h2>
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <RecommendationsList recommendations={data.recommendations} />
        </div>
      </section>

      {/* ── Never-Boarded Completions ──────────────────────────────────── */}
      {data.unplannedDone && (
        <section>
          <h2 className="mb-4 text-base font-semibold text-foreground">Never-Boarded Completions</h2>
          <UnplannedDoneSection unplannedDone={data.unplannedDone} />
        </section>
      )}

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <p className="text-xs text-muted">Data as of: {formatDateTime(data.dataAsOf)}</p>
    </div>
  )
}
