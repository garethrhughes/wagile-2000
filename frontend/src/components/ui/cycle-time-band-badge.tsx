'use client'

import { type CycleTimeBand, cycleTimeBandColor } from '@/lib/cycle-time-bands'

interface CycleTimeBandBadgeProps {
  band: CycleTimeBand
}

export function CycleTimeBandBadge({ band }: CycleTimeBandBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${cycleTimeBandColor(band)}`}
    >
      {band}
    </span>
  )
}
