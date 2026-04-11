export type CycleTimeBand = 'excellent' | 'good' | 'fair' | 'poor';

export function classifyCycleTime(
  medianDays: number,
  thresholds = [2, 5, 10],
): CycleTimeBand {
  if (medianDays <= thresholds[0]) return 'excellent';
  if (medianDays <= thresholds[1]) return 'good';
  if (medianDays <= thresholds[2]) return 'fair';
  return 'poor';
}

export function cycleTimeBandColor(band: CycleTimeBand): string {
  switch (band) {
    case 'excellent': return 'text-green-600 bg-green-50 border-green-200';
    case 'good':      return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'fair':      return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'poor':      return 'text-red-600 bg-red-50 border-red-200';
  }
}
