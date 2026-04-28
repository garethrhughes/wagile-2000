import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApiGet, mockSuccess } from '../client.mock.js';

vi.mock('../../src/client.js', () => ({
  apiGet: mockApiGet,
}));

import {
  buildDoraHealthReport,
  buildSprintRetrospective,
  buildReleaseReadiness,
  buildQuarterlyPlanningReview,
} from '../../src/prompts/index.js';

const BOARDS = [
  { boardId: 'ACC', boardType: 'scrum' },
  { boardId: 'PLAT', boardType: 'kanban' },
];

const SYNC_STATUS = [
  { boardId: 'ACC', syncedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), status: 'success' },
];

const DORA_METRICS = { period: '2026-Q1', deploymentFrequency: { band: 'elite' } };
const DORA_TREND = [{ period: '2026-Q1' }, { period: '2025-Q4' }];

describe('Prompt templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildDoraHealthReport', () => {
    it('includes period label, boards table, and sync freshness', async () => {
      mockApiGet
        .mockResolvedValueOnce(mockSuccess(BOARDS))           // list_boards
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS))     // dora metrics
        .mockResolvedValueOnce(mockSuccess(DORA_TREND))       // dora trend
        .mockResolvedValueOnce(mockSuccess(SYNC_STATUS));     // sync status

      const report = await buildDoraHealthReport('2026-Q1');

      expect(report).toContain('2026-Q1');
      expect(report).toContain('ACC');
      expect(report).toContain('PLAT');
      expect(report).toContain('Data Freshness');
    });

    it('surfaces pending 202 snapshot gracefully', async () => {
      mockApiGet
        .mockResolvedValueOnce(mockSuccess(BOARDS))
        .mockResolvedValueOnce({ status: 202, data: { status: 'pending' } })
        .mockResolvedValueOnce(mockSuccess(DORA_TREND))
        .mockResolvedValueOnce(mockSuccess(SYNC_STATUS));

      const report = await buildDoraHealthReport();

      expect(report).toContain('still being computed');
    });

    it('marks stale boards with a warning', async () => {
      const staleSync = [
        { boardId: 'ACC', syncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), status: 'success' },
      ];
      mockApiGet
        .mockResolvedValueOnce(mockSuccess(BOARDS))
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS))
        .mockResolvedValueOnce(mockSuccess(DORA_TREND))
        .mockResolvedValueOnce(mockSuccess(staleSync));

      const report = await buildDoraHealthReport('2026-Q1');

      expect(report).toContain('STALE');
    });
  });

  describe('buildSprintRetrospective', () => {
    it('includes sprint report, planning accuracy, and ticket detail sections', async () => {
      const sprintReport = { score: 80, band: 'high' };
      const sprintDetail = [{ key: 'ACC-1', classification: 'committed' }];
      const planningAccuracy = { completionRate: 90 };

      mockApiGet
        .mockResolvedValueOnce(mockSuccess(sprintReport))
        .mockResolvedValueOnce(mockSuccess(sprintDetail))
        .mockResolvedValueOnce(mockSuccess(planningAccuracy));

      const report = await buildSprintRetrospective('ACC', '42');

      expect(report).toContain('ACC');
      expect(report).toContain('42');
      expect(report).toContain('Planning Accuracy');
      expect(report).toContain('Ticket Breakdown');
    });

    it('handles unavailable data gracefully', async () => {
      mockApiGet
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'));

      const report = await buildSprintRetrospective('ACC', '99');

      expect(report).toContain('unavailable');
    });
  });

  describe('buildReleaseReadiness', () => {
    it('includes all readiness sections', async () => {
      const sprints = [
        { id: 42, name: 'Sprint 42', state: 'closed', startDate: '2026-03-01', endDate: '2026-03-14' },
      ];

      mockApiGet
        .mockResolvedValueOnce(mockSuccess(sprints))           // list_sprints
        .mockResolvedValueOnce(mockSuccess({ score: 90 }))    // sprint report
        .mockResolvedValueOnce(mockSuccess({ completionRate: 88 }))  // planning accuracy
        .mockResolvedValueOnce(mockSuccess([]))                // hygiene gaps
        .mockResolvedValueOnce(mockSuccess([]))                // unplanned done
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS));    // dora metrics

      const report = await buildReleaseReadiness('ACC');

      expect(report).toContain('Release Readiness');
      expect(report).toContain('Hygiene Gaps');
      expect(report).toContain('Unplanned Work');
    });

    it('uses provided sprintId without fetching sprints', async () => {
      mockApiGet
        .mockResolvedValueOnce(mockSuccess({ score: 85 }))
        .mockResolvedValueOnce(mockSuccess({}))
        .mockResolvedValueOnce(mockSuccess([]))
        .mockResolvedValueOnce(mockSuccess([]))
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS));

      const report = await buildReleaseReadiness('ACC', '55');

      expect(report).toContain('55');
      // Should not have called list_sprints
      expect(mockApiGet).not.toHaveBeenCalledWith('/api/planning/sprints', expect.anything());
    });
  });

  describe('buildQuarterlyPlanningReview', () => {
    it('skips kanban boards for planning accuracy', async () => {
      const quarters = ['2025-Q4', '2026-Q1'];

      mockApiGet
        .mockResolvedValueOnce(mockSuccess(BOARDS))            // list_boards
        .mockResolvedValueOnce(mockSuccess(quarters))          // list_quarters
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS))      // dora metrics
        .mockResolvedValueOnce(mockSuccess({ coverage: 80 })) // roadmap
        .mockResolvedValueOnce(mockSuccess([]))                // unplanned done
        .mockResolvedValueOnce(mockSuccess({ completionRate: 85 })); // ACC planning

      const report = await buildQuarterlyPlanningReview('2026-Q1');

      expect(report).toContain('2026-Q1');
      expect(report).toContain('ACC');
      // Kanban board noted as excluded
      expect(report).toContain('Kanban');
    });

    it('includes DORA and roadmap sections', async () => {
      mockApiGet
        .mockResolvedValueOnce(mockSuccess([{ boardId: 'ACC', boardType: 'scrum' }]))
        .mockResolvedValueOnce(mockSuccess(['2026-Q1']))
        .mockResolvedValueOnce(mockSuccess(DORA_METRICS))
        .mockResolvedValueOnce(mockSuccess({ coverage: 75 }))
        .mockResolvedValueOnce(mockSuccess([]))
        .mockResolvedValueOnce(mockSuccess({ completionRate: 90 }));

      const report = await buildQuarterlyPlanningReview('2026-Q1');

      expect(report).toContain('Org Delivery Health');
      expect(report).toContain('Roadmap Coverage');
      expect(report).toContain('Unplanned Work');
    });
  });
});
