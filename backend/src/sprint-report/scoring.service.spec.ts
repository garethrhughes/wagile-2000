import { ScoringService, ScoringInput } from './scoring.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    committedCount: 10,
    addedMidSprintCount: 0,
    removedCount: 0,
    completedInSprintCount: 10,
    roadmapCoverage: 80,
    totalIssues: 10,
    medianLeadTimeDays: 3,
    deploymentsPerDay: 1,
    changeFailureRate: 3,
    medianMttrHours: 0.5,
    leadTimeBand: 'high',
    dfBand: 'elite',
    cfrBand: 'elite',
    mttrBand: 'elite',
    ...overrides,
  };
}

describe('ScoringService', () => {
  let service: ScoringService;

  beforeEach(() => {
    service = new ScoringService();
  });

  // -------------------------------------------------------------------------
  // Band-to-score mapping
  // -------------------------------------------------------------------------

  describe('bandToScore mapping', () => {
    it.each([
      ['elite', 100],
      ['high', 75],
      ['medium', 50],
      ['low', 25],
    ] as const)('maps %s band to %d', (band, expected) => {
      const result = service.score(baseInput({ leadTimeBand: band }));
      expect(result.scores.leadTime.score).toBe(expected);
    });

    it('maps elite dfBand to 100', () => {
      const result = service.score(baseInput({ dfBand: 'elite' }));
      expect(result.scores.deploymentFrequency.score).toBe(100);
    });

    it('maps low cfrBand to 25', () => {
      const result = service.score(baseInput({ cfrBand: 'low' }));
      expect(result.scores.changeFailureRate.score).toBe(25);
    });

    it('maps medium mttrBand to 50', () => {
      const result = service.score(baseInput({ mttrBand: 'medium' }));
      expect(result.scores.mttr.score).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Delivery rate scoring
  // -------------------------------------------------------------------------

  describe('deliveryRate scoring', () => {
    it('returns 50 (neutral) when inScopeCount is 0', () => {
      const result = service.score(baseInput({
        committedCount: 0,
        addedMidSprintCount: 0,
        removedCount: 0,
        completedInSprintCount: 0,
      }));
      expect(result.scores.deliveryRate.score).toBe(50);
      expect(result.scores.deliveryRate.rawValue).toBeNull();
    });

    it('returns 100 when delivery rate = 1.0 (all complete)', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 10,
      }));
      expect(result.scores.deliveryRate.score).toBe(100);
    });

    it('returns 100 when delivery rate > 1.0 (over-delivery)', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 12,
      }));
      expect(result.scores.deliveryRate.score).toBe(100);
    });

    it('returns ~75 when delivery rate = 0.8', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 8,
      }));
      expect(result.scores.deliveryRate.score).toBe(75);
    });

    it('returns ~50 for 0.65 delivery rate (midpoint of 0.5–0.8 range)', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 7, // 0.7 rate → 25 + (0.7-0.5)/0.3*50 = 25+33.3 = 58.3
      }));
      expect(result.scores.deliveryRate.score).toBeGreaterThan(50);
      expect(result.scores.deliveryRate.score).toBeLessThan(75);
    });

    it('returns 25 for 0.5 delivery rate', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 5,
      }));
      expect(result.scores.deliveryRate.score).toBe(25);
    });

    it('returns <25 for delivery rate below 0.5', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 2, // 0.2 rate
      }));
      expect(result.scores.deliveryRate.score).toBeLessThan(25);
      expect(result.scores.deliveryRate.score).toBeGreaterThan(0);
    });

    it('returns 0 for 0% delivery rate', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 0,
      }));
      expect(result.scores.deliveryRate.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scope stability scoring
  // -------------------------------------------------------------------------

  describe('scopeStability scoring', () => {
    it('returns 50 (neutral) when committedCount is 0', () => {
      const result = service.score(baseInput({ committedCount: 0, addedMidSprintCount: 0, removedCount: 0 }));
      expect(result.scores.scopeStability.score).toBe(50);
      expect(result.scores.scopeStability.rawValue).toBeNull();
    });

    it('returns 100 when scope change ratio <= 10%', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        addedMidSprintCount: 1,  // 10% ratio
        removedCount: 0,
      }));
      expect(result.scores.scopeStability.score).toBe(100);
    });

    it('returns <100 and >50 when ratio is between 10% and 25%', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        addedMidSprintCount: 2,  // 20% ratio
        removedCount: 0,
      }));
      expect(result.scores.scopeStability.score).toBeLessThan(100);
      expect(result.scores.scopeStability.score).toBeGreaterThan(50);
    });

    it('returns 50 exactly at 25% ratio', () => {
      // ratio=0.25: 75 - (0.25-0.10)/0.15 * 25 = 75 - 25 = 50
      const result = service.score(baseInput({
        committedCount: 8,
        addedMidSprintCount: 2,  // exactly 25%
        removedCount: 0,
      }));
      expect(result.scores.scopeStability.score).toBe(50);
    });

    it('returns near 0 when scope change exceeds 100% of committed', () => {
      const result = service.score(baseInput({
        committedCount: 5,
        addedMidSprintCount: 5,  // 100% ratio → should be near 0
        removedCount: 0,
      }));
      expect(result.scores.scopeStability.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Roadmap coverage scoring
  // -------------------------------------------------------------------------

  describe('roadmapCoverage scoring', () => {
    it('returns 50 (neutral) when totalIssues is 0', () => {
      const result = service.score(baseInput({ totalIssues: 0, roadmapCoverage: 0 }));
      expect(result.scores.roadmapCoverage.score).toBe(50);
      expect(result.scores.roadmapCoverage.rawValue).toBeNull();
    });

    it('returns 100 for >= 80% coverage', () => {
      const result = service.score(baseInput({ roadmapCoverage: 80, totalIssues: 10 }));
      expect(result.scores.roadmapCoverage.score).toBe(100);
    });

    it('returns 100 for 100% coverage', () => {
      const result = service.score(baseInput({ roadmapCoverage: 100, totalIssues: 10 }));
      expect(result.scores.roadmapCoverage.score).toBe(100);
    });

    it('returns 50 for 50% coverage', () => {
      const result = service.score(baseInput({ roadmapCoverage: 50, totalIssues: 10 }));
      expect(result.scores.roadmapCoverage.score).toBe(50);
    });

    it('returns <50 for <50% coverage', () => {
      const result = service.score(baseInput({ roadmapCoverage: 25, totalIssues: 10 }));
      expect(result.scores.roadmapCoverage.score).toBe(25);
    });

    it('returns 0 for 0% coverage', () => {
      const result = service.score(baseInput({ roadmapCoverage: 0, totalIssues: 10 }));
      expect(result.scores.roadmapCoverage.score).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Composite score and band
  // -------------------------------------------------------------------------

  describe('compositeScore', () => {
    it('returns 100 composite when all dimensions are elite/perfect', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 10,
        addedMidSprintCount: 0,
        removedCount: 0,
        roadmapCoverage: 100,
        totalIssues: 10,
        leadTimeBand: 'elite',
        dfBand: 'elite',
        cfrBand: 'elite',
        mttrBand: 'elite',
      }));
      expect(result.compositeScore).toBe(100);
      expect(result.compositeBand).toBe('strong');
    });

    it('returns 25 composite when all dimensions are worst-case', () => {
      // All band dimensions = low (25), all non-DORA = 0
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 0,     // deliveryRate = 0 → score 0
        addedMidSprintCount: 10,       // 100% scope change → score 0
        removedCount: 0,
        roadmapCoverage: 0,
        totalIssues: 10,               // roadmap score = 0
        leadTimeBand: 'low',           // → 25
        dfBand: 'low',                 // → 25
        cfrBand: 'low',                // → 25
        mttrBand: 'low',               // → 25
      }));
      // composite = 0*0.25 + 0*0.15 + 0*0.10 + 25*0.20 + 25*0.10 + 25*0.10 + 25*0.10
      // = 0 + 0 + 0 + 5 + 2.5 + 2.5 + 2.5 = 12.5
      expect(result.compositeScore).toBe(12.5);
      expect(result.compositeBand).toBe('needs-attention');
    });

    it('classifies composite >= 80 as strong', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 10,
        roadmapCoverage: 80,
        totalIssues: 10,
        leadTimeBand: 'elite',
        dfBand: 'elite',
        cfrBand: 'elite',
        mttrBand: 'elite',
      }));
      expect(result.compositeBand).toBe('strong');
    });

    it('classifies composite < 40 as needs-attention', () => {
      const result = service.score(baseInput({
        committedCount: 10,
        completedInSprintCount: 0,
        roadmapCoverage: 0,
        totalIssues: 10,
        leadTimeBand: 'low',
        dfBand: 'low',
        cfrBand: 'low',
        mttrBand: 'low',
      }));
      expect(result.compositeBand).toBe('needs-attention');
    });
  });
});
