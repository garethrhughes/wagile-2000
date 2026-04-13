import { Injectable } from '@nestjs/common';
import { DoraBand } from '../metrics/dora-bands.js';
import { classifyComposite, SprintReportBand } from './sprint-report-bands.js';

export interface SprintDimensionScore {
  score: number;
  band?: DoraBand;
  rawValue: number | null;
  rawUnit: string;
}

export interface SprintDimensionScores {
  deliveryRate: SprintDimensionScore;
  scopeStability: SprintDimensionScore;
  roadmapCoverage: SprintDimensionScore;
  leadTime: SprintDimensionScore;
  deploymentFrequency: SprintDimensionScore;
  changeFailureRate: SprintDimensionScore;
  mttr: SprintDimensionScore;
}

export interface ScoringInput {
  // Planning
  committedCount: number;
  addedMidSprintCount: number;
  removedCount: number;
  completedInSprintCount: number;
  // Roadmap
  roadmapCoverage: number;   // 0-100 %
  totalIssues: number;       // denominator for roadmap neutrality check
  // DORA
  medianLeadTimeDays: number | null;
  deploymentsPerDay: number;
  changeFailureRate: number; // 0-100 %
  medianMttrHours: number;
  // DORA bands (pre-classified by MetricsService)
  leadTimeBand: DoraBand;
  dfBand: DoraBand;
  cfrBand: DoraBand;
  mttrBand: DoraBand;
}

export interface CompositeResult {
  scores: SprintDimensionScores;
  compositeScore: number;
  compositeBand: SprintReportBand;
}

@Injectable()
export class ScoringService {
  score(input: ScoringInput): CompositeResult {
    const inScopeCount = input.committedCount + input.addedMidSprintCount - input.removedCount;
    const deliveryRate = inScopeCount > 0 ? input.completedInSprintCount / inScopeCount : 0;

    const deliveryScore = this.scoreDeliveryRate(deliveryRate, inScopeCount);
    const stabilityScore = this.scoreScopeStability(input.addedMidSprintCount, input.removedCount, input.committedCount);
    const roadmapScore = this.scoreRoadmapCoverage(input.roadmapCoverage, input.totalIssues);
    const leadTimeScore = this.bandToScore(input.leadTimeBand);
    const dfScore = this.bandToScore(input.dfBand);
    const cfrScore = this.bandToScore(input.cfrBand);
    const mttrScore = this.bandToScore(input.mttrBand);

    const compositeScore = Math.round(
      (deliveryScore * 0.25 +
        stabilityScore * 0.15 +
        roadmapScore * 0.10 +
        leadTimeScore * 0.20 +
        dfScore * 0.10 +
        cfrScore * 0.10 +
        mttrScore * 0.10) * 10
    ) / 10;

    const scores: SprintDimensionScores = {
      deliveryRate: {
        score: Math.round(deliveryScore * 10) / 10,
        rawValue: inScopeCount > 0 ? Math.round(deliveryRate * 1000) / 10 : null,
        rawUnit: '%',
      },
      scopeStability: {
        score: Math.round(stabilityScore * 10) / 10,
        rawValue: input.committedCount > 0
          ? Math.round(((input.addedMidSprintCount + input.removedCount) / input.committedCount) * 1000) / 10
          : null,
        rawUnit: '% change',
      },
      roadmapCoverage: {
        score: Math.round(roadmapScore * 10) / 10,
        rawValue: input.totalIssues > 0 ? Math.round(input.roadmapCoverage * 10) / 10 : null,
        rawUnit: '%',
      },
      leadTime: {
        score: leadTimeScore,
        band: input.leadTimeBand,
        rawValue: input.medianLeadTimeDays,
        rawUnit: 'days',
      },
      deploymentFrequency: {
        score: dfScore,
        band: input.dfBand,
        rawValue: Math.round(input.deploymentsPerDay * 10000) / 10000,
        rawUnit: 'per day',
      },
      changeFailureRate: {
        score: cfrScore,
        band: input.cfrBand,
        rawValue: Math.round(input.changeFailureRate * 100) / 100,
        rawUnit: '%',
      },
      mttr: {
        score: mttrScore,
        band: input.mttrBand,
        rawValue: Math.round(input.medianMttrHours * 100) / 100,
        rawUnit: 'hours',
      },
    };

    return { scores, compositeScore, compositeBand: classifyComposite(compositeScore) };
  }

  private bandToScore(band: DoraBand): number {
    switch (band) {
      case 'elite':  return 100;
      case 'high':   return 75;
      case 'medium': return 50;
      case 'low':    return 25;
    }
  }

  private scoreDeliveryRate(rate: number, inScopeCount: number): number {
    if (inScopeCount === 0) return 50;
    const r = Math.max(0, Math.min(1, rate));
    if (r >= 1.0) return 100;
    if (r >= 0.8) return 75 + ((r - 0.8) / 0.2) * 25;
    if (r >= 0.5) return 25 + ((r - 0.5) / 0.3) * 50;
    return (r / 0.5) * 25;
  }

  private scoreScopeStability(added: number, removed: number, committed: number): number {
    if (committed === 0) return 50;
    const ratio = (added + removed) / committed;
    if (ratio <= 0.10) return 100;
    if (ratio <= 0.25) return 75 - ((ratio - 0.10) / 0.15) * 25;
    if (ratio <= 0.50) return 50 - ((ratio - 0.25) / 0.25) * 25;
    return Math.max(0, 25 - ((ratio - 0.50) / 0.50) * 25);
  }

  private scoreRoadmapCoverage(coverage: number, totalIssues: number): number {
    if (totalIssues === 0) return 50;
    const c = Math.max(0, Math.min(100, coverage));
    if (c >= 80) return 100;
    if (c >= 50) return 50 + ((c - 50) / 30) * 50;
    return (c / 50) * 50;
  }
}
