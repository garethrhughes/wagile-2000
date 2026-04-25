/**
 * snapshot.handler.spec.ts
 *
 * Unit tests for the Lambda snapshot handler.
 * DataSource, metric services, and TrendDataLoader are all mocked.
 */

import type { SnapshotHandlerEvent } from './snapshot.handler.js';

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that trigger module registration
// ---------------------------------------------------------------------------

const mockUpsert = jest.fn().mockResolvedValue(undefined);
const mockGetRepository = jest.fn();

const mockDataSourceInstance = {
  isInitialized: false,
  initialize: jest.fn().mockImplementation(function (this: { isInitialized: boolean }) {
    this.isInitialized = true;
    return Promise.resolve();
  }),
  getRepository: mockGetRepository,
};

jest.mock('typeorm', () => {
  const actual = jest.requireActual<typeof import('typeorm')>('typeorm');
  return {
    ...actual,
    DataSource: jest.fn().mockImplementation(() => mockDataSourceInstance),
  };
});

// Mock Secrets Manager so the handler can resolve a DB password
const mockGetSecretValueSend = jest.fn().mockResolvedValue({ SecretString: 'test-password' });
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockGetSecretValueSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((p: unknown) => p),
}));

// Stub the TrendDataLoader so it returns a minimal TrendDataSlice
const mockLoad = jest.fn();
jest.mock('../metrics/trend-data-loader.service.js', () => ({
  TrendDataLoader: jest.fn().mockImplementation(() => ({ load: mockLoad })),
}));

// Stub metric services
const mockDfCalc   = jest.fn().mockReturnValue({ deploymentsPerDay: 0.1, band: 'low' });
const mockLtCalc   = jest.fn().mockReturnValue({ observations: [], anomalyCount: 0 });
const mockCfrCalc  = jest.fn().mockReturnValue({ percentage: 0, band: 'elite' });
const mockMttrCalc = jest.fn().mockReturnValue({ recoveryHours: [], openIncidentCount: 0, anomalyCount: 0 });

jest.mock('../metrics/deployment-frequency.service.js', () => ({
  DeploymentFrequencyService: jest.fn().mockImplementation(() => ({
    calculateFromData: mockDfCalc,
  })),
}));
jest.mock('../metrics/lead-time.service.js', () => ({
  LeadTimeService: jest.fn().mockImplementation(() => ({
    getLeadTimeObservationsFromData: mockLtCalc,
  })),
}));
jest.mock('../metrics/cfr.service.js', () => ({
  CfrService: jest.fn().mockImplementation(() => ({
    calculateFromData: mockCfrCalc,
  })),
}));
jest.mock('../metrics/mttr.service.js', () => ({
  MttrService: jest.fn().mockImplementation(() => ({
    getMttrObservationsFromData: mockMttrCalc,
  })),
}));
jest.mock('../metrics/working-time.service.js', () => ({
  WorkingTimeService: jest.fn().mockImplementation(() => ({})),
}));

// Stub listRecentQuarters so ordering tests can inject a fixed newest-first list
// without depending on the current calendar date.
const mockListRecentQuarters = jest.fn();
jest.mock('../metrics/period-utils.js', () => ({
  listRecentQuarters: (...args: [number, string?]) => mockListRecentQuarters(...args),
}));

// Capture the real implementation once; used as the default in beforeEach so
// existing tests that don't override the mock still get a valid quarter list.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listRecentQuarters: realListRecentQuarters } = jest.requireActual('../metrics/period-utils.js') as {
  listRecentQuarters: (n: number, tz?: string) => Array<{ label: string; startDate: Date; endDate: Date }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySlice() {
  return {
    boardId: 'ACC',
    boardConfig: null,
    wtEntity: {},
    issues: [],
    changelogs: [],
    versions: [],
    issueLinks: [],
  };
}

// ---------------------------------------------------------------------------
// Import the handler after all mocks are registered
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('./snapshot.handler.js') as {
  handler: (event: SnapshotHandlerEvent) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('snapshot Lambda handler', () => {
  beforeEach(() => {
    mockUpsert.mockClear();
    mockLoad.mockClear();
    mockDfCalc.mockClear();
    mockLtCalc.mockClear();
    mockCfrCalc.mockClear();
    mockMttrCalc.mockClear();
    mockListRecentQuarters.mockClear();
    mockListRecentQuarters.mockImplementation(realListRecentQuarters);
    mockGetRepository.mockReturnValue({
      upsert: mockUpsert,
      find: jest.fn().mockResolvedValue([{ boardId: 'ACC' }]),
      findOne: jest.fn().mockResolvedValue(null),
    });
    mockLoad.mockResolvedValue(makeEmptySlice());

    // Reset the module-level DataSource singleton state
    mockDataSourceInstance.isInitialized = false;
    mockDataSourceInstance.initialize.mockClear();

    process.env['DB_PASSWORD_SECRET_ARN'] = 'arn:aws:secretsmanager:ap-southeast-2:123:secret:test';
  });

  afterEach(() => {
    delete process.env['DB_PASSWORD_SECRET_ARN'];
  });

  it('initialises the DataSource on first invocation', async () => {
    await handler({ boardId: 'ACC' });
    expect(mockDataSourceInstance.initialize).toHaveBeenCalledTimes(1);
  });

  it('calls TrendDataLoader.load with the board id', async () => {
    await handler({ boardId: 'ACC' });
    expect(mockLoad).toHaveBeenCalledWith(
      'ACC',
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('upserts two per-board snapshot rows (trend + aggregate) when boardId is a regular board', async () => {
    await handler({ boardId: 'BPT' });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [rows] = mockUpsert.mock.calls[0] as [
      Array<{ boardId: string; snapshotType: string }>,
      string[],
    ];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.boardId === 'BPT')).toBe(true);
    const types = rows.map((r) => r.snapshotType).sort();
    expect(types).toEqual(['aggregate', 'trend', 'trend-display']);
  });

  it('upserts two org-level snapshot rows when orgSnapshot=true', async () => {
    mockGetRepository.mockReturnValue({
      upsert: mockUpsert,
      find: jest.fn().mockResolvedValue([{ boardId: 'ACC' }, { boardId: 'BPT' }]),
      findOne: jest.fn().mockResolvedValue(null),
    });
    await handler({ boardId: '__org__', orgSnapshot: true });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [rows] = mockUpsert.mock.calls[0] as [
      Array<{ boardId: string; snapshotType: string }>,
      string[],
    ];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.boardId === '__org__')).toBe(true);
    const types = rows.map((r) => r.snapshotType).sort();
    expect(types).toEqual(['aggregate', 'trend']);
  });

  it('calls all four metric services with the loaded slice', async () => {
    await handler({ boardId: 'ACC' });
    expect(mockDfCalc).toHaveBeenCalled();
    expect(mockLtCalc).toHaveBeenCalled();
    expect(mockCfrCalc).toHaveBeenCalled();
    expect(mockMttrCalc).toHaveBeenCalled();
  });

  it('respects the quartersBack parameter', async () => {
    await handler({ boardId: 'ACC', quartersBack: 4 });
    const [rows] = mockUpsert.mock.calls[0] as [
      Array<{ boardId: string; snapshotType: string; payload: unknown[] }>,
      string[],
    ];
    const trendRow = rows.find((r) => r.snapshotType === 'trend' && r.boardId === 'ACC');
    expect(Array.isArray(trendRow?.payload)).toBe(true);
    expect((trendRow?.payload as unknown[]).length).toBe(4);
  });

  it('rethrows errors from TrendDataLoader so Lambda retries', async () => {
    mockLoad.mockRejectedValue(new Error('DB error'));
    await expect(handler({ boardId: 'ACC' })).rejects.toThrow('DB error');
  });

  // ── Ordering assertions ────────────────────────────────────────────────────
  // These tests freeze the quarter list (injecting a fixed newest-first array)
  // so the oldest→newest ordering guarantee is asserted deterministically,
  // independent of the calendar date when the tests run.

  describe('trend array ordering — oldest→newest (ADR-0042 §5)', () => {
    // A fixed set of 4 quarters in newest-first order, matching what
    // listRecentQuarters() returns at runtime.
    const fixedQuartersNewestFirst = [
      { label: '2025-Q4', startDate: new Date('2025-10-01T00:00:00Z'), endDate: new Date('2025-12-31T23:59:59.999Z') },
      { label: '2025-Q3', startDate: new Date('2025-07-01T00:00:00Z'), endDate: new Date('2025-09-30T23:59:59.999Z') },
      { label: '2025-Q2', startDate: new Date('2025-04-01T00:00:00Z'), endDate: new Date('2025-06-30T23:59:59.999Z') },
      { label: '2025-Q1', startDate: new Date('2025-01-01T00:00:00Z'), endDate: new Date('2025-03-31T23:59:59.999Z') },
    ];

    beforeEach(() => {
      mockListRecentQuarters.mockReturnValue(fixedQuartersNewestFirst);
    });

    it('persists per-board trend payload in oldest→newest order', async () => {
      await handler({ boardId: 'ACC' });

      const [rows] = mockUpsert.mock.calls[0] as [
        Array<{ boardId: string; snapshotType: string; payload: Array<{ period: string }> }>,
        string[],
      ];
      const trendRow = rows.find((r) => r.snapshotType === 'trend' && r.boardId === 'ACC');
      expect(trendRow?.payload).toHaveLength(4);
      // First entry must be the oldest quarter; last must be the newest.
      expect(trendRow?.payload[0].period).toBe('2025-Q1');
      expect(trendRow?.payload[3].period).toBe('2025-Q4');
    });

    it('persists per-board trend-display payload in oldest→newest order', async () => {
      await handler({ boardId: 'ACC' });

      const [rows] = mockUpsert.mock.calls[0] as [
        Array<{ boardId: string; snapshotType: string; payload: Array<{ period: { label: string } }> }>,
        string[],
      ];
      const displayRow = rows.find((r) => r.snapshotType === 'trend-display' && r.boardId === 'ACC');
      expect(displayRow?.payload).toHaveLength(4);
      // buildAggregatePayload wraps the label in period.label
      expect(displayRow?.payload[0].period.label).toBe('2025-Q1');
      expect(displayRow?.payload[3].period.label).toBe('2025-Q4');
    });

    it('persists org trend payload in oldest→newest order when board snapshots are unordered', async () => {
      // Helper to build a minimal raw trend entry for a given period
      const rawEntry = (period: string, startDate: string, endDate: string) => ({
        period,
        startDate,
        endDate,
        df:   { totalDeployments: 1, deploymentsPerDay: 0.01, periodDays: 91 },
        lt:   { observations: [], anomalyCount: 0 },
        cfr:  { totalDeployments: 1, failureCount: 0, changeFailureRate: 0, usingDefaultConfig: false },
        mttr: { recoveryHours: [], openIncidentCount: 0, anomalyCount: 0 },
      });

      // Simulate board trend snapshots with periods stored in an arbitrary order
      // (Q3 → Q1 → Q2), to verify the handler sorts them ascending before writing.
      const mockFind = jest.fn()
        .mockResolvedValueOnce([
          { boardId: 'ACC', boardType: 'scrum' },
          { boardId: 'BPT', boardType: 'scrum' },
        ])
        .mockResolvedValueOnce([
          {
            boardId: 'ACC',
            payload: [
              rawEntry('2025-Q3', '2025-07-01', '2025-09-30'),
              rawEntry('2025-Q1', '2025-01-01', '2025-03-31'),
              rawEntry('2025-Q2', '2025-04-01', '2025-06-30'),
            ],
          },
        ]);

      mockGetRepository.mockReturnValue({
        upsert: mockUpsert,
        find: mockFind,
        findOne: jest.fn().mockResolvedValue(null),
      });

      await handler({ boardId: '__org__', orgSnapshot: true });

      const [rows] = mockUpsert.mock.calls[0] as [
        Array<{ boardId: string; snapshotType: string; payload: Array<{ period: { label: string } }> }>,
        string[],
      ];
      const trendRow = rows.find((r) => r.snapshotType === 'trend' && r.boardId === '__org__');
      expect(trendRow?.payload).toHaveLength(3);
      // Regardless of the input order, the persisted array must be oldest→newest.
      expect(trendRow?.payload[0].period.label).toBe('2025-Q1');
      expect(trendRow?.payload[2].period.label).toBe('2025-Q3');
    });
  });
});
