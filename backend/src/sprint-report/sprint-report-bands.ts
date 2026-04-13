export type SprintReportBand = 'strong' | 'good' | 'fair' | 'needs-attention';

export function classifyComposite(score: number): SprintReportBand {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'needs-attention';
}
