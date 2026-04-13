import { Injectable } from '@nestjs/common';
import { SprintDimensionScores } from './scoring.service.js';

export interface RecommendationContext {
  deliveryRate: number;
  inScopeCount: number;
  committedCount: number;
  addedMidSprintCount: number;
  removedCount: number;
  roadmapCoverage: number;
  medianLeadTimeDays: number | null;
  deploymentsPerDay: number;
  changeFailureRate: number;
  medianMttrHours: number;
  incidentCount: number;
  scores: SprintDimensionScores;
}

export interface SprintRecommendation {
  id: string;
  dimension: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

type RuleDefinition = {
  id: string;
  dimension: string;
  severity: 'info' | 'warning' | 'critical';
  condition: (ctx: RecommendationContext) => boolean;
  messageTemplate: string;
};

@Injectable()
export class RecommendationService {
  private readonly rules: RuleDefinition[] = [
    // -------------------------------------------------------------------------
    // Delivery Rate (DR-001 … DR-005)
    // -------------------------------------------------------------------------
    {
      id: 'DR-001',
      dimension: 'deliveryRate',
      severity: 'critical',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.deliveryRate < 0.5,
      messageTemplate: 'Team delivered only {pct}% of in-scope work. Investigate blockers and reduce WIP.',
    },
    {
      id: 'DR-002',
      dimension: 'deliveryRate',
      severity: 'warning',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.deliveryRate >= 0.5 && ctx.deliveryRate < 0.8,
      messageTemplate: 'Delivery rate of {pct}% is below the 80% target. Consider reducing scope or identifying recurring impediments.',
    },
    {
      id: 'DR-003',
      dimension: 'deliveryRate',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.deliveryRate >= 0.8 && ctx.deliveryRate < 1.0,
      messageTemplate: 'Good delivery rate of {pct}%. Fine-tune estimation to push toward 100%.',
    },
    {
      id: 'DR-004',
      dimension: 'deliveryRate',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.deliveryRate >= 1.0,
      messageTemplate: 'Sprint fully delivered ({pct}%). Confirm no carry-over from a previous sprint inflated completion.',
    },
    {
      id: 'DR-005',
      dimension: 'deliveryRate',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount === 0,
      messageTemplate: 'No in-scope work detected for this sprint. Verify sprint data is synced correctly.',
    },

    // -------------------------------------------------------------------------
    // Scope Stability (SS-001 … SS-005)
    // -------------------------------------------------------------------------
    {
      id: 'SS-001',
      dimension: 'scopeStability',
      severity: 'critical',
      condition: (ctx) =>
        ctx.committedCount > 0 &&
        (ctx.addedMidSprintCount + ctx.removedCount) / ctx.committedCount > 0.5,
      messageTemplate: 'Scope changed by {n}% ({added} added, {removed} removed) — more than 50% of committed work. Sprint planning needs significant improvement.',
    },
    {
      id: 'SS-002',
      dimension: 'scopeStability',
      severity: 'warning',
      condition: (ctx) => {
        if (ctx.committedCount === 0) return false;
        const ratio = (ctx.addedMidSprintCount + ctx.removedCount) / ctx.committedCount;
        return ratio > 0.25 && ratio <= 0.5;
      },
      messageTemplate: 'Scope changed by {n}% ({added} added, {removed} removed). Aim to keep mid-sprint changes below 25%.',
    },
    {
      id: 'SS-003',
      dimension: 'scopeStability',
      severity: 'info',
      condition: (ctx) => {
        if (ctx.committedCount === 0) return false;
        const ratio = (ctx.addedMidSprintCount + ctx.removedCount) / ctx.committedCount;
        return ratio > 0.1 && ratio <= 0.25;
      },
      messageTemplate: 'Minor scope change of {n}% ({added} added, {removed} removed). Monitor for repeat patterns.',
    },
    {
      id: 'SS-004',
      dimension: 'scopeStability',
      severity: 'info',
      condition: (ctx) =>
        ctx.committedCount > 0 &&
        (ctx.addedMidSprintCount + ctx.removedCount) / ctx.committedCount <= 0.1,
      messageTemplate: 'Excellent scope stability — less than 10% change from committed work.',
    },
    {
      id: 'SS-005',
      dimension: 'scopeStability',
      severity: 'info',
      condition: (ctx) => ctx.committedCount === 0,
      messageTemplate: 'No committed work at sprint start. Ensure backlog grooming happens before sprint planning.',
    },

    // -------------------------------------------------------------------------
    // Roadmap Coverage (RC-001 … RC-005)
    // -------------------------------------------------------------------------
    {
      id: 'RC-001',
      dimension: 'roadmapCoverage',
      severity: 'critical',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.roadmapCoverage < 20,
      messageTemplate: 'Only {pct}% of sprint work is tied to roadmap items. Most effort is unplanned or untracked.',
    },
    {
      id: 'RC-002',
      dimension: 'roadmapCoverage',
      severity: 'warning',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.roadmapCoverage >= 20 && ctx.roadmapCoverage < 50,
      messageTemplate: '{pct}% roadmap coverage. Aim for at least 50% of sprint work aligned to product roadmap.',
    },
    {
      id: 'RC-003',
      dimension: 'roadmapCoverage',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.roadmapCoverage >= 50 && ctx.roadmapCoverage < 80,
      messageTemplate: '{pct}% roadmap coverage — good alignment. Consider whether the remaining work is strategic debt reduction.',
    },
    {
      id: 'RC-004',
      dimension: 'roadmapCoverage',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount > 0 && ctx.roadmapCoverage >= 80,
      messageTemplate: 'Strong roadmap alignment at {pct}%. Ensure capacity is preserved for urgent bug-fixes and technical debt.',
    },
    {
      id: 'RC-005',
      dimension: 'roadmapCoverage',
      severity: 'info',
      condition: (ctx) => ctx.inScopeCount === 0,
      messageTemplate: 'Roadmap coverage cannot be calculated with no in-scope issues.',
    },

    // -------------------------------------------------------------------------
    // Lead Time (LT-001 … LT-005)
    // -------------------------------------------------------------------------
    {
      id: 'LT-001',
      dimension: 'leadTime',
      severity: 'critical',
      condition: (ctx) => ctx.medianLeadTimeDays !== null && ctx.medianLeadTimeDays > 30,
      messageTemplate: 'Median lead time of {n} days exceeds 30 days. Identify and remove bottlenecks in the delivery pipeline.',
    },
    {
      id: 'LT-002',
      dimension: 'leadTime',
      severity: 'warning',
      condition: (ctx) =>
        ctx.medianLeadTimeDays !== null &&
        ctx.medianLeadTimeDays > 7 &&
        ctx.medianLeadTimeDays <= 30,
      messageTemplate: 'Median lead time of {n} days is in the medium band. Target less than 7 days.',
    },
    {
      id: 'LT-003',
      dimension: 'leadTime',
      severity: 'info',
      condition: (ctx) =>
        ctx.medianLeadTimeDays !== null &&
        ctx.medianLeadTimeDays > 1 &&
        ctx.medianLeadTimeDays <= 7,
      messageTemplate: 'Median lead time of {n} days is good. Focus on reducing handoff delays to reach sub-day delivery.',
    },
    {
      id: 'LT-004',
      dimension: 'leadTime',
      severity: 'info',
      condition: (ctx) => ctx.medianLeadTimeDays !== null && ctx.medianLeadTimeDays <= 1,
      messageTemplate: 'Elite lead time of {n} days. Maintain this through continued CI/CD investment.',
    },
    {
      id: 'LT-005',
      dimension: 'leadTime',
      severity: 'info',
      condition: (ctx) => ctx.medianLeadTimeDays === null,
      messageTemplate: 'No lead time data available for this sprint. Ensure issue changelog data is synced.',
    },

    // -------------------------------------------------------------------------
    // Deployment Frequency (DF-001 … DF-004)
    // -------------------------------------------------------------------------
    {
      id: 'DF-001',
      dimension: 'deploymentFrequency',
      severity: 'critical',
      condition: (ctx) => ctx.deploymentsPerDay < 1 / 30,
      messageTemplate: 'Deployment frequency is below monthly. Invest in CI/CD automation and reduce batch sizes.',
    },
    {
      id: 'DF-002',
      dimension: 'deploymentFrequency',
      severity: 'warning',
      condition: (ctx) => ctx.deploymentsPerDay >= 1 / 30 && ctx.deploymentsPerDay < 1 / 7,
      messageTemplate: 'Deploying less than weekly. Break down changes into smaller releasable increments.',
    },
    {
      id: 'DF-003',
      dimension: 'deploymentFrequency',
      severity: 'info',
      condition: (ctx) => ctx.deploymentsPerDay >= 1 / 7 && ctx.deploymentsPerDay < 1,
      messageTemplate: 'Deploying at least weekly — high band. Work toward daily deployment cadence.',
    },
    {
      id: 'DF-004',
      dimension: 'deploymentFrequency',
      severity: 'info',
      condition: (ctx) => ctx.deploymentsPerDay >= 1,
      messageTemplate: 'Elite deployment frequency (daily or better). Maintain with robust automated testing.',
    },

    // -------------------------------------------------------------------------
    // Change Failure Rate (CFR-001 … CFR-004)
    // -------------------------------------------------------------------------
    {
      id: 'CFR-001',
      dimension: 'changeFailureRate',
      severity: 'critical',
      condition: (ctx) => ctx.changeFailureRate > 15,
      messageTemplate: 'Change failure rate of {pct}% is critical. Strengthen pre-deployment testing and rollback procedures.',
    },
    {
      id: 'CFR-002',
      dimension: 'changeFailureRate',
      severity: 'warning',
      condition: (ctx) => ctx.changeFailureRate > 10 && ctx.changeFailureRate <= 15,
      messageTemplate: 'Change failure rate of {pct}% exceeds the 10% threshold. Review test coverage and deployment quality gates.',
    },
    {
      id: 'CFR-003',
      dimension: 'changeFailureRate',
      severity: 'info',
      condition: (ctx) => ctx.changeFailureRate > 5 && ctx.changeFailureRate <= 10,
      messageTemplate: 'Change failure rate of {pct}% is in the high band. Consider additional integration or smoke tests.',
    },
    {
      id: 'CFR-004',
      dimension: 'changeFailureRate',
      severity: 'info',
      condition: (ctx) => ctx.changeFailureRate <= 5,
      messageTemplate: 'Elite change failure rate of {pct}%. Continue current quality practices.',
    },

    // -------------------------------------------------------------------------
    // MTTR (MT-001 … MT-005)
    // -------------------------------------------------------------------------
    {
      id: 'MT-001',
      dimension: 'mttr',
      severity: 'critical',
      condition: (ctx) => ctx.incidentCount > 0 && ctx.medianMttrHours >= 168,
      messageTemplate: 'Median MTTR of {n} hours exceeds 7 days. Establish an on-call rotation and incident runbooks immediately.',
    },
    {
      id: 'MT-002',
      dimension: 'mttr',
      severity: 'warning',
      condition: (ctx) =>
        ctx.incidentCount > 0 &&
        ctx.medianMttrHours >= 24 &&
        ctx.medianMttrHours < 168,
      messageTemplate: 'Median MTTR of {n} hours is in the medium band. Define SLOs and automate alerting to reduce recovery time.',
    },
    {
      id: 'MT-003',
      dimension: 'mttr',
      severity: 'info',
      condition: (ctx) =>
        ctx.incidentCount > 0 &&
        ctx.medianMttrHours >= 1 &&
        ctx.medianMttrHours < 24,
      messageTemplate: 'Median MTTR of {n} hours is good. Invest in observability to achieve sub-hour recovery.',
    },
    {
      id: 'MT-004',
      dimension: 'mttr',
      severity: 'info',
      condition: (ctx) => ctx.incidentCount > 0 && ctx.medianMttrHours < 1,
      messageTemplate: 'Elite MTTR of {n} hours. Ensure incident post-mortems are conducted to sustain this performance.',
    },
    {
      id: 'MT-005',
      dimension: 'mttr',
      severity: 'info',
      condition: (ctx) => ctx.incidentCount === 0,
      messageTemplate: 'No incidents recorded this sprint. Verify incident tracking is correctly configured.',
    },
  ];

  recommend(ctx: RecommendationContext): SprintRecommendation[] {
    const matched: SprintRecommendation[] = [];

    for (const rule of this.rules) {
      if (rule.condition(ctx)) {
        matched.push({
          id: rule.id,
          dimension: rule.dimension,
          severity: rule.severity,
          message: this.interpolate(rule.messageTemplate, ctx),
        });
      }
    }

    // Sort: critical first, then warning, then info
    const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    matched.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    return matched;
  }

  private interpolate(template: string, ctx: RecommendationContext): string {
    return template
      .replace('{pct}', () => {
        // For delivery rate rules, pct = deliveryRate * 100; for others determined by template context
        if (template.includes('delivered only') || template.includes('Delivery rate') || template.includes('delivery rate') && template.includes('%')) {
          return String(Math.round(ctx.deliveryRate * 1000) / 10);
        }
        if (template.includes('roadmap') || template.includes('roadmap coverage') || template.includes('Roadmap') || template.includes('coverage')) {
          return String(Math.round(ctx.roadmapCoverage * 10) / 10);
        }
        if (template.includes('failure rate') || template.includes('CFR') || template.includes('Change failure')) {
          return String(Math.round(ctx.changeFailureRate * 10) / 10);
        }
        return '0';
      })
      .replace('{n}', () => {
        if (template.includes('lead time') || template.includes('Lead time')) {
          return String(Math.round((ctx.medianLeadTimeDays ?? 0) * 10) / 10);
        }
        if (template.includes('MTTR') || template.includes('Median MTTR')) {
          return String(Math.round(ctx.medianMttrHours * 10) / 10);
        }
        if (template.includes('Scope changed') || template.includes('scope changed')) {
          const n = ctx.committedCount > 0
            ? (ctx.addedMidSprintCount + ctx.removedCount) / ctx.committedCount * 100
            : 0;
          return String(Math.round(n * 10) / 10);
        }
        return '0';
      })
      .replace('{added}', String(ctx.addedMidSprintCount))
      .replace('{removed}', String(ctx.removedCount));
  }
}
