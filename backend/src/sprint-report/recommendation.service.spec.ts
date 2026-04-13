import { RecommendationService, RecommendationContext } from './recommendation.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseCtx(overrides: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    deliveryRate: 1.0,
    inScopeCount: 10,
    committedCount: 10,
    addedMidSprintCount: 0,
    removedCount: 0,
    roadmapCoverage: 80,
    medianLeadTimeDays: 3,
    deploymentsPerDay: 1,
    changeFailureRate: 3,
    medianMttrHours: 0.5,
    incidentCount: 0,
    scores: {} as any,
    ...overrides,
  };
}

function ids(recs: ReturnType<RecommendationService['recommend']>): string[] {
  return recs.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecommendationService', () => {
  let service: RecommendationService;

  beforeEach(() => {
    service = new RecommendationService();
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  describe('severity ordering', () => {
    it('should sort critical before warning before info', () => {
      // Trigger DR-001 (critical), DR-002 (warning) is mutually exclusive,
      // so use a context that fires rules across multiple dimensions.
      const ctx = baseCtx({
        deliveryRate: 0.3,        // DR-001 critical
        inScopeCount: 10,
        committedCount: 10,
        addedMidSprintCount: 6,
        removedCount: 0,          // SS-001 critical (60 % scope change)
        medianLeadTimeDays: null, // LT-005 info
      });
      const recs = service.recommend(ctx);
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      for (let i = 1; i < recs.length; i++) {
        expect(severityOrder[recs[i].severity]).toBeGreaterThanOrEqual(
          severityOrder[recs[i - 1].severity],
        );
      }
    });

    it('should return id and dimension fields on every recommendation', () => {
      const ctx = baseCtx({ deliveryRate: 0.3, inScopeCount: 5 });
      const recs = service.recommend(ctx);
      for (const rec of recs) {
        expect(rec.id).toBeTruthy();
        expect(rec.dimension).toBeTruthy();
        expect(rec.severity).toMatch(/^(info|warning|critical)$/);
        expect(rec.message).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Delivery Rate
  // -------------------------------------------------------------------------

  describe('delivery rate rules', () => {
    it('DR-001: fires when deliveryRate < 0.5', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.4, inScopeCount: 5 }));
      expect(ids(recs)).toContain('DR-001');
      expect(recs.find((r) => r.id === 'DR-001')!.severity).toBe('critical');
    });

    it('DR-001: does NOT fire when deliveryRate >= 0.5', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.5, inScopeCount: 5 }));
      expect(ids(recs)).not.toContain('DR-001');
    });

    it('DR-002: fires when 0.5 <= deliveryRate < 0.8', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.65, inScopeCount: 5 }));
      expect(ids(recs)).toContain('DR-002');
      expect(recs.find((r) => r.id === 'DR-002')!.severity).toBe('warning');
    });

    it('DR-002: does NOT fire when deliveryRate >= 0.8', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.9, inScopeCount: 5 }));
      expect(ids(recs)).not.toContain('DR-002');
    });

    it('DR-003: fires when 0.8 <= deliveryRate < 1.0', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.9, inScopeCount: 5 }));
      expect(ids(recs)).toContain('DR-003');
      expect(recs.find((r) => r.id === 'DR-003')!.severity).toBe('info');
    });

    it('DR-004: fires when deliveryRate >= 1.0', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 1.0, inScopeCount: 5 }));
      expect(ids(recs)).toContain('DR-004');
      expect(recs.find((r) => r.id === 'DR-004')!.severity).toBe('info');
    });

    it('DR-005: fires when inScopeCount === 0', () => {
      const recs = service.recommend(baseCtx({ inScopeCount: 0 }));
      expect(ids(recs)).toContain('DR-005');
    });

    it('DR-005: does NOT fire when inScopeCount > 0', () => {
      const recs = service.recommend(baseCtx({ inScopeCount: 5 }));
      expect(ids(recs)).not.toContain('DR-005');
    });

    it('DR-001 message interpolates delivery rate percentage', () => {
      const recs = service.recommend(baseCtx({ deliveryRate: 0.3, inScopeCount: 5 }));
      const msg = recs.find((r) => r.id === 'DR-001')!.message;
      expect(msg).toContain('30');
    });
  });

  // -------------------------------------------------------------------------
  // Scope Stability
  // -------------------------------------------------------------------------

  describe('scope stability rules', () => {
    it('SS-001: fires when scope change > 50%', () => {
      // committedCount=10, added=6 => ratio=0.6 > 0.5
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 6, removedCount: 0 }),
      );
      expect(ids(recs)).toContain('SS-001');
      expect(recs.find((r) => r.id === 'SS-001')!.severity).toBe('critical');
    });

    it('SS-001: does NOT fire when scope change <= 50%', () => {
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 5, removedCount: 0 }),
      );
      expect(ids(recs)).not.toContain('SS-001');
    });

    it('SS-002: fires when 25% < scope change <= 50%', () => {
      // ratio = 4/10 = 0.4
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 4, removedCount: 0 }),
      );
      expect(ids(recs)).toContain('SS-002');
      expect(recs.find((r) => r.id === 'SS-002')!.severity).toBe('warning');
    });

    it('SS-003: fires when 10% < scope change <= 25%', () => {
      // ratio = 2/10 = 0.2
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 2, removedCount: 0 }),
      );
      expect(ids(recs)).toContain('SS-003');
    });

    it('SS-004: fires when scope change <= 10%', () => {
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 1, removedCount: 0 }),
      );
      expect(ids(recs)).toContain('SS-004');
    });

    it('SS-005: fires when committedCount === 0', () => {
      const recs = service.recommend(baseCtx({ committedCount: 0 }));
      expect(ids(recs)).toContain('SS-005');
    });

    it('SS-001 message interpolates added/removed counts', () => {
      const recs = service.recommend(
        baseCtx({ committedCount: 10, addedMidSprintCount: 6, removedCount: 2 }),
      );
      const msg = recs.find((r) => r.id === 'SS-001')!.message;
      expect(msg).toContain('6');
      expect(msg).toContain('2');
    });
  });

  // -------------------------------------------------------------------------
  // Roadmap Coverage
  // -------------------------------------------------------------------------

  describe('roadmap coverage rules', () => {
    it('RC-001: fires when roadmapCoverage < 20', () => {
      const recs = service.recommend(baseCtx({ roadmapCoverage: 10, inScopeCount: 5 }));
      expect(ids(recs)).toContain('RC-001');
      expect(recs.find((r) => r.id === 'RC-001')!.severity).toBe('critical');
    });

    it('RC-001: does NOT fire when roadmapCoverage >= 20', () => {
      const recs = service.recommend(baseCtx({ roadmapCoverage: 20, inScopeCount: 5 }));
      expect(ids(recs)).not.toContain('RC-001');
    });

    it('RC-002: fires when 20 <= roadmapCoverage < 50', () => {
      const recs = service.recommend(baseCtx({ roadmapCoverage: 35, inScopeCount: 5 }));
      expect(ids(recs)).toContain('RC-002');
      expect(recs.find((r) => r.id === 'RC-002')!.severity).toBe('warning');
    });

    it('RC-003: fires when 50 <= roadmapCoverage < 80', () => {
      const recs = service.recommend(baseCtx({ roadmapCoverage: 65, inScopeCount: 5 }));
      expect(ids(recs)).toContain('RC-003');
    });

    it('RC-004: fires when roadmapCoverage >= 80', () => {
      const recs = service.recommend(baseCtx({ roadmapCoverage: 90, inScopeCount: 5 }));
      expect(ids(recs)).toContain('RC-004');
    });

    it('RC-005: fires when inScopeCount === 0', () => {
      const recs = service.recommend(baseCtx({ inScopeCount: 0 }));
      expect(ids(recs)).toContain('RC-005');
    });
  });

  // -------------------------------------------------------------------------
  // Lead Time
  // -------------------------------------------------------------------------

  describe('lead time rules', () => {
    it('LT-001: fires when medianLeadTimeDays > 30', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 35 }));
      expect(ids(recs)).toContain('LT-001');
      expect(recs.find((r) => r.id === 'LT-001')!.severity).toBe('critical');
    });

    it('LT-001: does NOT fire when medianLeadTimeDays <= 30', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 30 }));
      expect(ids(recs)).not.toContain('LT-001');
    });

    it('LT-002: fires when 7 < medianLeadTimeDays <= 30', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 15 }));
      expect(ids(recs)).toContain('LT-002');
      expect(recs.find((r) => r.id === 'LT-002')!.severity).toBe('warning');
    });

    it('LT-003: fires when 1 < medianLeadTimeDays <= 7', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 3 }));
      expect(ids(recs)).toContain('LT-003');
    });

    it('LT-004: fires when medianLeadTimeDays <= 1', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 0.5 }));
      expect(ids(recs)).toContain('LT-004');
    });

    it('LT-005: fires when medianLeadTimeDays is null', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: null }));
      expect(ids(recs)).toContain('LT-005');
    });

    it('LT-001 message interpolates lead time days', () => {
      const recs = service.recommend(baseCtx({ medianLeadTimeDays: 45 }));
      const msg = recs.find((r) => r.id === 'LT-001')!.message;
      expect(msg).toContain('45');
    });
  });

  // -------------------------------------------------------------------------
  // Deployment Frequency
  // -------------------------------------------------------------------------

  describe('deployment frequency rules', () => {
    it('DF-001: fires when deploymentsPerDay < 1/30 (low band)', () => {
      const recs = service.recommend(baseCtx({ deploymentsPerDay: 1 / 60 }));
      expect(ids(recs)).toContain('DF-001');
      expect(recs.find((r) => r.id === 'DF-001')!.severity).toBe('critical');
    });

    it('DF-001: does NOT fire when deploymentsPerDay >= 1/30', () => {
      const recs = service.recommend(baseCtx({ deploymentsPerDay: 1 / 30 }));
      expect(ids(recs)).not.toContain('DF-001');
    });

    it('DF-002: fires when 1/30 <= deploymentsPerDay < 1/7', () => {
      const recs = service.recommend(baseCtx({ deploymentsPerDay: 1 / 14 }));
      expect(ids(recs)).toContain('DF-002');
      expect(recs.find((r) => r.id === 'DF-002')!.severity).toBe('warning');
    });

    it('DF-003: fires when 1/7 <= deploymentsPerDay < 1', () => {
      const recs = service.recommend(baseCtx({ deploymentsPerDay: 1 / 3 }));
      expect(ids(recs)).toContain('DF-003');
    });

    it('DF-004: fires when deploymentsPerDay >= 1', () => {
      const recs = service.recommend(baseCtx({ deploymentsPerDay: 2 }));
      expect(ids(recs)).toContain('DF-004');
    });
  });

  // -------------------------------------------------------------------------
  // Change Failure Rate
  // -------------------------------------------------------------------------

  describe('change failure rate rules', () => {
    it('CFR-001: fires when changeFailureRate > 15', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 20 }));
      expect(ids(recs)).toContain('CFR-001');
      expect(recs.find((r) => r.id === 'CFR-001')!.severity).toBe('critical');
    });

    it('CFR-001: does NOT fire when changeFailureRate <= 15', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 15 }));
      expect(ids(recs)).not.toContain('CFR-001');
    });

    it('CFR-002: fires when 10 < changeFailureRate <= 15', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 12 }));
      expect(ids(recs)).toContain('CFR-002');
      expect(recs.find((r) => r.id === 'CFR-002')!.severity).toBe('warning');
    });

    it('CFR-003: fires when 5 < changeFailureRate <= 10', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 7 }));
      expect(ids(recs)).toContain('CFR-003');
    });

    it('CFR-004: fires when changeFailureRate <= 5', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 3 }));
      expect(ids(recs)).toContain('CFR-004');
    });

    it('CFR-001 message interpolates failure rate percentage', () => {
      const recs = service.recommend(baseCtx({ changeFailureRate: 20 }));
      const msg = recs.find((r) => r.id === 'CFR-001')!.message;
      expect(msg).toContain('20');
    });
  });

  // -------------------------------------------------------------------------
  // MTTR
  // -------------------------------------------------------------------------

  describe('MTTR rules', () => {
    it('MT-001: fires when incidentCount > 0 and medianMttrHours >= 168', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 2, medianMttrHours: 200 }));
      expect(ids(recs)).toContain('MT-001');
      expect(recs.find((r) => r.id === 'MT-001')!.severity).toBe('critical');
    });

    it('MT-001: does NOT fire when incidentCount === 0', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 0, medianMttrHours: 200 }));
      expect(ids(recs)).not.toContain('MT-001');
    });

    it('MT-002: fires when incidentCount > 0 and 24 <= medianMttrHours < 168', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 1, medianMttrHours: 72 }));
      expect(ids(recs)).toContain('MT-002');
      expect(recs.find((r) => r.id === 'MT-002')!.severity).toBe('warning');
    });

    it('MT-003: fires when incidentCount > 0 and 1 <= medianMttrHours < 24', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 1, medianMttrHours: 5 }));
      expect(ids(recs)).toContain('MT-003');
    });

    it('MT-004: fires when incidentCount > 0 and medianMttrHours < 1', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 1, medianMttrHours: 0.5 }));
      expect(ids(recs)).toContain('MT-004');
    });

    it('MT-005: fires when incidentCount === 0', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 0 }));
      expect(ids(recs)).toContain('MT-005');
    });

    it('MT-005: does NOT fire when incidentCount > 0', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 1, medianMttrHours: 5 }));
      expect(ids(recs)).not.toContain('MT-005');
    });

    it('MT-001 message interpolates MTTR hours', () => {
      const recs = service.recommend(baseCtx({ incidentCount: 1, medianMttrHours: 200 }));
      const msg = recs.find((r) => r.id === 'MT-001')!.message;
      expect(msg).toContain('200');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases — mutual exclusivity within each dimension
  // -------------------------------------------------------------------------

  describe('mutual exclusivity', () => {
    it('only one DR rule fires per context (when inScopeCount > 0)', () => {
      const deliveryRates = [0.3, 0.6, 0.9, 1.0];
      for (const dr of deliveryRates) {
        const recs = service.recommend(baseCtx({ deliveryRate: dr, inScopeCount: 5 }));
        const drRecs = recs.filter((r) => r.id.startsWith('DR-') && r.id !== 'DR-005');
        expect(drRecs).toHaveLength(1);
      }
    });

    it('only one SS rule fires per context', () => {
      const scenarios = [
        { committedCount: 0, addedMidSprintCount: 0, removedCount: 0 },   // SS-005
        { committedCount: 10, addedMidSprintCount: 0, removedCount: 0 },  // SS-004
        { committedCount: 10, addedMidSprintCount: 2, removedCount: 0 },  // SS-003
        { committedCount: 10, addedMidSprintCount: 4, removedCount: 0 },  // SS-002
        { committedCount: 10, addedMidSprintCount: 6, removedCount: 0 },  // SS-001
      ];
      for (const s of scenarios) {
        const recs = service.recommend(baseCtx(s));
        const ssRecs = recs.filter((r) => r.id.startsWith('SS-'));
        expect(ssRecs).toHaveLength(1);
      }
    });

    it('only one LT rule fires per context', () => {
      const leadTimes = [null, 0.5, 3, 15, 45];
      for (const lt of leadTimes) {
        const recs = service.recommend(baseCtx({ medianLeadTimeDays: lt }));
        const ltRecs = recs.filter((r) => r.id.startsWith('LT-'));
        expect(ltRecs).toHaveLength(1);
      }
    });

    it('only one DF rule fires per context', () => {
      const deployRates = [1 / 60, 1 / 14, 1 / 3, 2];
      for (const dr of deployRates) {
        const recs = service.recommend(baseCtx({ deploymentsPerDay: dr }));
        const dfRecs = recs.filter((r) => r.id.startsWith('DF-'));
        expect(dfRecs).toHaveLength(1);
      }
    });

    it('only one CFR rule fires per context', () => {
      const cfrs = [3, 7, 12, 20];
      for (const cfr of cfrs) {
        const recs = service.recommend(baseCtx({ changeFailureRate: cfr }));
        const cfrRecs = recs.filter((r) => r.id.startsWith('CFR-'));
        expect(cfrRecs).toHaveLength(1);
      }
    });
  });
});
