'use client'

import { type DoraBand } from '@/lib/dora-bands'
import { BandBadge } from './band-badge'

// ---------------------------------------------------------------------------
// Sparkline – tiny SVG line chart (reused from metric-card)
// ---------------------------------------------------------------------------

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null

  const width = 80
  const height = 24
  const padding = 2

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data
    .map((v, i) => {
      const x = padding + (i / (data.length - 1)) * (width - padding * 2)
      const y = height - padding - ((v - min) / range) * (height - padding * 2)
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block"
      aria-label="Trend sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// OrgMetricCard
// ---------------------------------------------------------------------------

export interface OrgMetricCardProps {
  title: string
  value: number
  unit: string
  band: DoraBand
  /** Org-level values from TrendPoint[] – extracted per-metric (RC-5) */
  sparkline: number[]
  contributingBoards: number
  /** Number of boards that had no data (e.g. sampleSize === 0) */
  noDataBoards?: number
  /**
   * Optional footnote text displayed beneath the card footer.
   * Use to surface important caveats about the metric (e.g. cycle-time proxy
   * vs DORA lead time definition).  See Proposal 0030 Fix D-2.
   */
  footnote?: string
}

function formatValue(value: number, unit: string): string {
  if (unit === '%') return `${value.toFixed(1)}%`
  if (unit === 'deploys/day') return value.toFixed(2)
  if (unit === 'days' || unit === 'hours') return value.toFixed(1)
  return String(value)
}

export function OrgMetricCard({
  title,
  value,
  unit,
  band,
  sparkline,
  contributingBoards,
  noDataBoards,
  footnote,
}: OrgMetricCardProps) {
  const footerText =
    noDataBoards !== undefined && noDataBoards > 0
      ? `${contributingBoards} of ${contributingBoards + noDataBoards} boards have data`
      : `${contributingBoards} board${contributingBoards !== 1 ? 's' : ''} contributing`

  return (
    <div
      className={`rounded-xl border bg-card p-5 shadow-sm border-l-4 ${bandLeftBorder(band)}`}
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-medium text-muted">{title}</h3>
        <BandBadge band={band} />
      </div>

      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-bold tracking-tight">
          {formatValue(value, unit)}
        </span>
        {unit !== '%' && (
          <span className="mb-1 text-sm text-muted">{unit}</span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        {sparkline.length >= 2 ? (
          <Sparkline data={sparkline} />
        ) : (
          <span />
        )}
        <span className="text-xs text-muted">{footerText}</span>
      </div>

      {footnote && (
        <p className="mt-2 text-xs text-muted leading-snug border-t border-border pt-2">
          {footnote}
        </p>
      )}
    </div>
  )
}

function bandLeftBorder(band: DoraBand): string {
  switch (band) {
    case 'elite':  return 'border-l-green-400'
    case 'high':   return 'border-l-blue-400'
    case 'medium': return 'border-l-amber-400'
    case 'low':    return 'border-l-red-400'
  }
}
