'use client'

import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import type { CycleTimeObservation, CycleTimeBand } from '@/lib/api'

interface CycleTimeScatterProps {
  observations: CycleTimeObservation[]
}

interface ScatterPoint {
  x: number
  y: number
  issueKey: string
  band: CycleTimeBand
  completedAt: string
}

function bandToColor(band: CycleTimeBand): string {
  switch (band) {
    case 'excellent': return '#16a34a'
    case 'good':      return '#2563eb'
    case 'fair':      return '#d97706'
    case 'poor':      return '#dc2626'
  }
}

// Classify the individual observation for scatter colouring
function classifyObservation(days: number): CycleTimeBand {
  if (days <= 2) return 'excellent'
  if (days <= 5) return 'good'
  if (days <= 10) return 'fair'
  return 'poor'
}

interface TooltipPayloadEntry {
  payload?: ScatterPoint
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayloadEntry[]
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="rounded border border-border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-semibold">{d.issueKey}</p>
      <p className="text-muted">{new Date(d.completedAt).toLocaleDateString()}</p>
      <p>{d.y.toFixed(1)} days</p>
    </div>
  )
}

export function CycleTimeScatter({ observations }: CycleTimeScatterProps) {
  if (observations.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-muted">No observations in selected period</p>
      </div>
    )
  }

  // Split observations into 4 band groups so Recharts can colour each group
  const groups: Record<CycleTimeBand, ScatterPoint[]> = {
    excellent: [],
    good: [],
    fair: [],
    poor: [],
  }

  for (const obs of observations) {
    const band = classifyObservation(obs.cycleTimeDays)
    groups[band].push({
      x: new Date(obs.completedAt).getTime(),
      y: obs.cycleTimeDays,
      issueKey: obs.issueKey,
      band,
      completedAt: obs.completedAt,
    })
  }

  const bandLabels: Record<CycleTimeBand, string> = {
    excellent: 'Excellent (≤2d)',
    good: 'Good (≤5d)',
    fair: 'Fair (≤10d)',
    poor: 'Poor (>10d)',
  }

  const activeBands = (Object.keys(groups) as CycleTimeBand[]).filter(
    (b) => groups[b].length > 0,
  )

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        Distribution — {observations.length} issues
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={['auto', 'auto']}
            name="Completed"
            tickFormatter={(v: number) =>
              new Date(v).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })
            }
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            dataKey="y"
            type="number"
            name="Cycle time"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}d`}
          />
          <Tooltip content={<CustomTooltip />} />
          {activeBands.map((band) => (
            <Scatter
              key={band}
              name={bandLabels[band]}
              data={groups[band]}
              fill={bandToColor(band)}
              opacity={0.75}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3">
        {activeBands.map((band) => (
          <span key={band} className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: bandToColor(band) }}
            />
            {bandLabels[band]}
          </span>
        ))}
      </div>
    </div>
  )
}
