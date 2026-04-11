'use client'

import { type CycleTimeBand } from '@/lib/cycle-time-bands'
import { CycleTimeBandBadge } from './cycle-time-band-badge'

interface CycleTimePercentileCardProps {
  percentile: 'p50' | 'p75' | 'p85' | 'p95'
  days: number
  sampleSize: number
  band: CycleTimeBand
}

const PERCENTILE_LABELS: Record<string, string> = {
  p50: 'Median (p50)',
  p75: 'p75',
  p85: 'p85',
  p95: 'p95',
}

function bandLeftBorder(band: CycleTimeBand): string {
  switch (band) {
    case 'excellent': return 'border-l-green-400'
    case 'good':      return 'border-l-blue-400'
    case 'fair':      return 'border-l-amber-400'
    case 'poor':      return 'border-l-red-400'
  }
}

export function CycleTimePercentileCard({
  percentile: pct,
  days,
  sampleSize,
  band,
}: CycleTimePercentileCardProps) {
  return (
    <div
      className={`rounded-xl border bg-card p-5 shadow-sm border-l-4 ${bandLeftBorder(band)}`}
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-medium text-muted">
          {PERCENTILE_LABELS[pct]} Cycle Time
        </h3>
        <CycleTimeBandBadge band={band} />
      </div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-3xl font-bold tracking-tight">
          {days.toFixed(1)}
        </span>
        <span className="mb-1 text-sm text-muted">days</span>
      </div>
      <div className="mt-3 text-xs text-muted">
        n={sampleSize}
      </div>
    </div>
  )
}
