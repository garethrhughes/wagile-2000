'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import type {
  ValueType,
  NameType,
} from 'recharts/types/component/DefaultTooltipContent'
import type { CycleTimeTrendPoint } from '@/lib/api'

interface CycleTimeTrendChartProps {
  data: CycleTimeTrendPoint[]
}

function abbreviatePeriod(label: string): string {
  // "2026-Q1" → "Q1 '26"
  const m = label.match(/^(\d{4})-Q([1-4])$/)
  if (m) return `Q${m[2]} '${m[1].slice(2)}`
  // Sprint names — truncate
  const numMatch = label.match(/(\d+)/)
  if (numMatch) return `SP ${numMatch[1]}`
  return label.length > 8 ? label.slice(0, 8) : label
}

export function CycleTimeTrendChart({ data }: CycleTimeTrendChartProps) {
  if (data.length < 2) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-xl border border-border bg-card p-4">
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">Cycle Time Trend</p>
          <p className="mt-1 text-xs text-muted">Not enough data</p>
        </div>
      </div>
    )
  }

  const chartData = data.map((p) => ({
    label: abbreviatePeriod(p.label),
    median: p.medianCycleTimeDays,
    p85: p.p85CycleTimeDays,
  }))

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        Cycle Time Trend (last {data.length} periods)
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart
          data={chartData}
          margin={{ top: 4, right: 12, left: -16, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}d`}
          />
          <Tooltip
            formatter={(
              value: ValueType | undefined,
              name: NameType | undefined,
            ): [string, string] => [
              value !== undefined && !Array.isArray(value)
                ? `${Number(value).toFixed(1)} days`
                : '',
              name === 'median' ? 'Median (p50)' : 'p85',
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend
            formatter={(value: string) =>
              value === 'median' ? 'Median (p50)' : 'p85'
            }
          />
          <Line
            type="monotone"
            dataKey="median"
            name="median"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ r: 3, fill: '#3b82f6' }}
            activeDot={{ r: 5 }}
          />
          <Line
            type="monotone"
            dataKey="p85"
            name="p85"
            stroke="#8b5cf6"
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={{ r: 3, fill: '#8b5cf6' }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
