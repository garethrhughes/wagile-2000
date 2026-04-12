'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useReplaceParams } from '@/hooks/use-page-params'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent'
import {
  getRoadmapAccuracy,
  getRoadmapConfigs,
  type RoadmapSprintAccuracy,
} from '@/lib/api'
import { useBoardsStore } from '@/store/boards-store'
import { BoardChip } from '@/components/ui/board-chip'
import { DataTable, type Column } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { NoBoardsConfigured } from '@/components/ui/no-boards-configured'

// ---------------------------------------------------------------------------
// Quarter helpers
// ---------------------------------------------------------------------------

function getQuarterKey(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function getCurrentQuarterKey(): string {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}-Q${q}`;
}

// ---------------------------------------------------------------------------
// Quarter row type (for quarter-mode table)
// ---------------------------------------------------------------------------

interface QuarterRow {
  quarter: string;
  totalIssues: number;
  coveredIssues: number;
  uncoveredIssues: number;
  roadmapCoverage: number;
  roadmapOnTimeRate: number;
}

function groupByQuarter(sprints: RoadmapSprintAccuracy[]): QuarterRow[] {
  const map = new Map<string, RoadmapSprintAccuracy[]>();

  for (const s of sprints) {
    const key = getQuarterKey(s.startDate);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }

  const currentKey = getCurrentQuarterKey();

  const rows: QuarterRow[] = [];
  for (const [quarter, group] of map.entries()) {
    const totalIssues = group.reduce((acc, s) => acc + s.totalIssues, 0);
    const coveredIssues = group.reduce((acc, s) => acc + s.coveredIssues, 0);
    const uncoveredIssues = group.reduce((acc, s) => acc + s.uncoveredIssues, 0);
    // Recompute from totals for consistency
    const roadmapCoverage =
      totalIssues > 0
        ? Math.round((coveredIssues / totalIssues) * 10000) / 100
        : 0;
    // roadmapOnTimeRate: weighted average of per-sprint on-time rates
    const totalOnTimeRateSum = group.reduce((acc, s) => acc + s.roadmapOnTimeRate, 0);
    const roadmapOnTimeRate =
      group.length > 0
        ? Math.round((totalOnTimeRateSum / group.length) * 100) / 100
        : 0;
    rows.push({
      quarter,
      totalIssues,
      coveredIssues,
      uncoveredIssues,
      roadmapCoverage,
      roadmapOnTimeRate,
    });
  }

  // Sort: current quarter first, then previous descending
  rows.sort((a, b) => {
    if (a.quarter === currentKey) return -1;
    if (b.quarter === currentKey) return 1;
    return b.quarter.localeCompare(a.quarter);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Helper: row colouring
// ---------------------------------------------------------------------------

function sprintRowColor(row: RoadmapSprintAccuracy): string {
  if (row.roadmapCoverage < 50) return 'bg-red-50';
  if (row.roadmapCoverage < 80) return 'bg-amber-50';
  return '';
}

function quarterRowColor(row: QuarterRow): string {
  if (row.roadmapCoverage < 50) return 'bg-red-50';
  if (row.roadmapCoverage < 80) return 'bg-amber-50';
  return '';
}

// weekRowColor uses the same logic as sprintRowColor (RoadmapSprintAccuracy is reused for weeks)
const weekRowColor = sprintRowColor;

// ---------------------------------------------------------------------------
// Abbreviated sprint/quarter/week label for chart x-axis
// ---------------------------------------------------------------------------

function abbreviateLabel(name: string): string {
  // e.g. "ACC Sprint 23 (Jan 2025)" → "SP 23" or quarter "2025-Q1" → "Q1 '25"
  const qMatch = name.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    return `Q${qMatch[2]} '${qMatch[1].slice(2)}`;
  }
  // Week key: "2026-W15" → "W15 '26"
  const wMatch = name.match(/^(\d{4})-W(\d+)$/);
  if (wMatch) {
    return `W${wMatch[2]} '${wMatch[1].slice(2)}`;
  }
  // Try to grab a number from the sprint name
  const numMatch = name.match(/(\d+)/);
  if (numMatch) {
    return `SP ${numMatch[1]}`;
  }
  return name.length > 8 ? name.slice(0, 8) : name;
}

// ---------------------------------------------------------------------------
// Line chart panel
// ---------------------------------------------------------------------------

interface ChartDataPoint {
  label: string;
  value: number;
}

interface TrendChartProps {
  title: string;
  data: ChartDataPoint[];
  color: string;
  unit?: string;
}

function TrendChart({ title, data, color, unit = '' }: TrendChartProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart
          data={data}
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
            tickFormatter={(v: number) => `${v}${unit}`}
          />
          <Tooltip
            formatter={(value: ValueType | undefined, name: NameType | undefined): [string, string] => [
              value !== undefined && !Array.isArray(value) ? `${value}${unit}` : '',
              String(name ?? title),
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 3, fill: color }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RoadmapPage() {
  const searchParams = useSearchParams()
  const replaceParams = useReplaceParams()

  // Board catalogue from store
  const allBoards = useBoardsStore((s) => s.allBoards)
  const kanbanBoardIds = useBoardsStore((s) => s.kanbanBoardIds)
  const boardsStatus = useBoardsStore((s) => s.status)

  // Filter state lives in the URL — defaults applied when params are absent
  const selectedBoard = searchParams.get('board') ?? (allBoards[0] ?? '')
  const periodType = (searchParams.get('mode') ?? 'sprint') as 'sprint' | 'quarter'
  const kanbanPeriod = (searchParams.get('kanban') ?? 'week') as 'quarter' | 'week'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawData, setRawData] = useState<RoadmapSprintAccuracy[]>([])
  const [kanbanWeekData, setKanbanWeekData] = useState<RoadmapSprintAccuracy[]>([])
  const [hasConfigs, setHasConfigs] = useState<boolean | null>(null)

  const isKanban = kanbanBoardIds.has(selectedBoard)

  // Check if any roadmap configs exist on mount
  useEffect(() => {
    getRoadmapConfigs()
      .then((configs) => {
        setHasConfigs(configs.length > 0)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load roadmap configuration')
        setHasConfigs(false)
      })
  }, [])

  const handleSelectBoard = useCallback((boardId: string) => {
    // Kanban boards have no sprints — switch to quarter view automatically
    if (kanbanBoardIds.has(boardId)) {
      replaceParams({ board: boardId, mode: 'quarter' })
    } else {
      replaceParams({ board: boardId })
    }
    setRawData([])
    setKanbanWeekData([])
    setError(null)
  }, [replaceParams, kanbanBoardIds])

  // Fetch roadmap accuracy data whenever board or kanbanPeriod changes
  useEffect(() => {
    if (boardsStatus !== 'ready') return;
    // For Kanban weekly mode, use separate fetch below
    if (isKanban && kanbanPeriod === 'week') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getRoadmapAccuracy({ boardId: selectedBoard })
      .then((res) => {
        if (!cancelled) setRawData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load roadmap data',
          );
          setRawData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban, kanbanPeriod, boardsStatus]);

  // Fetch weekly roadmap accuracy data for Kanban boards
  useEffect(() => {
    if (boardsStatus !== 'ready') return;
    if (!isKanban || kanbanPeriod !== 'week') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getRoadmapAccuracy({ boardId: selectedBoard, weekMode: true })
      .then((res) => {
        if (!cancelled) setKanbanWeekData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load weekly roadmap data',
          );
          setKanbanWeekData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban, kanbanPeriod, boardsStatus]);

  // Quarter rows derived client-side from raw sprint data
  const quarterRows = useMemo(() => groupByQuarter(rawData), [rawData]);

  // Summary stats across ALL displayed rows
  const { avgCoverage, avgOnTimeRate } = useMemo(() => {
    const rows: Array<{ roadmapCoverage: number; roadmapOnTimeRate: number }> =
      isKanban
        ? kanbanPeriod === 'week'
          ? kanbanWeekData
          : quarterRows
        : periodType === 'quarter'
          ? quarterRows
          : rawData;
    if (rows.length === 0) return { avgCoverage: 0, avgOnTimeRate: 0 };
    const totalCoverage = rows.reduce((s, r) => s + r.roadmapCoverage, 0);
    const totalOnTime = rows.reduce((s, r) => s + r.roadmapOnTimeRate, 0);
    return {
      avgCoverage: totalCoverage / rows.length,
      avgOnTimeRate: totalOnTime / rows.length,
    };
  }, [isKanban, kanbanPeriod, kanbanWeekData, rawData, quarterRows, periodType]);

  // True when at least one period has covered issues (i.e. ideas have dates)
  const roadmapHasDates = useMemo(() => {
    const rows: Array<{ coveredIssues: number }> =
      isKanban
        ? kanbanPeriod === 'week'
          ? kanbanWeekData
          : quarterRows
        : periodType === 'quarter'
          ? quarterRows
          : rawData;
    return rows.some((r) => r.coveredIssues > 0);
  }, [isKanban, kanbanPeriod, kanbanWeekData, rawData, quarterRows, periodType]);

  // Stat label describing the data range shown
  const statPeriodLabel = useMemo(() => {
    if (isKanban && kanbanPeriod === 'week') {
      return `${kanbanWeekData.length} week${kanbanWeekData.length !== 1 ? 's' : ''}`;
    }
    if (isKanban || periodType === 'quarter') {
      return `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`;
    }
    return `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}`;
  }, [isKanban, kanbanPeriod, kanbanWeekData, quarterRows, rawData, periodType]);

  // Chart data — oldest on left → newest on right
  const chartData = useMemo<[ChartDataPoint[], ChartDataPoint[]]>(() => {
    if (isKanban && kanbanPeriod === 'week') {
      const chronological = [...kanbanWeekData].reverse();
      return [
        chronological.map((w) => ({ label: abbreviateLabel(w.sprintName), value: w.roadmapCoverage })),
        chronological.map((w) => ({ label: abbreviateLabel(w.sprintName), value: w.roadmapOnTimeRate })),
      ];
    }
    if (isKanban || periodType === 'quarter') {
      const chronological = [...quarterRows].reverse();
      return [
        chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.roadmapCoverage })),
        chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.roadmapOnTimeRate })),
      ];
    }
    const chronological = [...rawData].reverse();
    return [
      chronological.map((s) => ({ label: abbreviateLabel(s.sprintName), value: s.roadmapCoverage })),
      chronological.map((s) => ({ label: abbreviateLabel(s.sprintName), value: s.roadmapOnTimeRate })),
    ];
  }, [isKanban, kanbanPeriod, kanbanWeekData, rawData, quarterRows, periodType]);

  // Sprint-mode table columns
  const sprintColumns = useMemo<Column<RoadmapSprintAccuracy>[]>(
    () => [
      {
        key: 'sprintName',
        label: 'Sprint',
        sortable: true,
        render: (value, row) => (
          <Link
            href={`/sprint/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(row.sprintId)}?from=roadmap`}
            className="font-medium text-blue-600 hover:underline"
          >
            {String(value)}
          </Link>
        ),
      },
      {
        key: 'state',
        label: 'State',
        sortable: true,
        render: (value) => {
          const state = String(value);
          const color =
            state === 'active'
              ? 'text-green-600 bg-green-50'
              : state === 'closed'
                ? 'text-gray-600 bg-gray-100'
                : 'text-blue-600 bg-blue-50';
          return (
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${color}`}
            >
              {state}
            </span>
          );
        },
      },
      { key: 'totalIssues', label: 'Total Issues', sortable: true },
      { key: 'coveredIssues', label: 'Covered', sortable: true },
      { key: 'uncoveredIssues', label: 'Uncovered', sortable: true },
      {
        key: 'roadmapCoverage',
        label: 'Coverage %',
        sortable: true,
        render: (value) => {
          const pct = Number(value);
          const color =
            pct < 50
              ? 'text-red-600 font-semibold'
              : pct < 80
                ? 'text-amber-600 font-semibold'
                : 'text-green-600 font-semibold';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'roadmapOnTimeRate',
        label: 'On-Time Rate %',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [selectedBoard],
  );

  // Quarter-mode table columns
  const quarterColumns = useMemo<Column<QuarterRow>[]>(
    () => [
      {
        key: 'quarter',
        label: 'Quarter',
        sortable: true,
        render: (value) => (
          <Link
            href={`/quarter/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(String(value))}?from=roadmap`}
            className="font-medium text-blue-600 hover:underline"
          >
            {String(value)}
          </Link>
        ),
      },
      { key: 'totalIssues', label: 'Total Issues', sortable: true },
      { key: 'coveredIssues', label: 'Covered', sortable: true },
      { key: 'uncoveredIssues', label: 'Uncovered', sortable: true },
      {
        key: 'roadmapCoverage',
        label: 'Coverage %',
        sortable: true,
        render: (value) => {
          const pct = Number(value);
          const color =
            pct < 50
              ? 'text-red-600 font-semibold'
              : pct < 80
                ? 'text-amber-600 font-semibold'
                : 'text-green-600 font-semibold';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'roadmapOnTimeRate',
        label: 'On-Time Rate %',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [selectedBoard],
  );

  // Week-mode table columns (Kanban only — sprintId = week key, sprintName = week key)
  const weekColumns = useMemo<Column<RoadmapSprintAccuracy>[]>(
    () => [
      {
        key: 'sprintName',
        label: 'Week',
        sortable: true,
        render: (value) => (
          <Link
            href={`/week/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(String(value))}?from=roadmap`}
            className="font-medium text-blue-600 hover:underline"
          >
            {String(value)}
          </Link>
        ),
      },
      {
        key: 'state',
        label: 'State',
        sortable: true,
        render: (value) => {
          const state = String(value);
          const color =
            state === 'active'
              ? 'text-green-600 bg-green-50'
              : 'text-gray-600 bg-gray-100';
          return (
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${color}`}
            >
              {state}
            </span>
          );
        },
      },
      { key: 'totalIssues', label: 'Total Issues', sortable: true },
      { key: 'coveredIssues', label: 'Covered', sortable: true },
      { key: 'uncoveredIssues', label: 'Uncovered', sortable: true },
      {
        key: 'roadmapCoverage',
        label: 'Coverage %',
        sortable: true,
        render: (value) => {
          const pct = Number(value);
          const color =
            pct < 50
              ? 'text-red-600 font-semibold'
              : pct < 80
                ? 'text-amber-600 font-semibold'
                : 'text-green-600 font-semibold';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'roadmapOnTimeRate',
        label: 'On-Time Rate %',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [selectedBoard],
  );

  const hasData = isKanban
    ? kanbanPeriod === 'week'
      ? kanbanWeekData.length > 0
      : quarterRows.length > 0
    : periodType === 'sprint'
      ? rawData.length > 0
      : quarterRows.length > 0;

  // Still loading config check
  if (hasConfigs === null) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Roadmap Accuracy</h1>
        <p className="mt-1 text-sm text-muted">
          Sprint work aligned to JPD roadmap items
        </p>
      </div>

      {/* No boards configured */}
      {boardsStatus === 'ready' && allBoards.length === 0 && (
        <NoBoardsConfigured />
      )}

      {/* No configs empty state */}
      {!hasConfigs && (
        <EmptyState
          title="No roadmap data"
          message="Add a JPD project key in Settings to track roadmap coverage."
        />
      )}

      {hasConfigs && (
        <>
          {/* Filters */}
          <div className="space-y-4 rounded-xl border border-border bg-card p-4">
            {/* Board selector (single-select) */}
            <div>
              <label className="mb-2 block text-sm font-medium text-muted">
                Board
              </label>
              <div className="flex flex-wrap gap-2">
                {allBoards.map((boardId) => (
                  <BoardChip
                    key={boardId}
                    boardId={boardId}
                    selected={selectedBoard === boardId}
                    onClick={() => handleSelectBoard(boardId)}
                  />
                ))}
              </div>
            </div>

            {/* Period type toggle */}
            <div>
              <label className="mb-2 block text-sm font-medium text-muted">
                Period
              </label>
              {isKanban ? (
                <div className="inline-flex rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => replaceParams({ kanban: 'week' })}
                    className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
                      kanbanPeriod === 'week'
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-muted hover:bg-gray-50'
                    }`}
                  >
                    Week
                  </button>
                  <button
                    type="button"
                    onClick={() => replaceParams({ kanban: 'quarter' })}
                    className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
                      kanbanPeriod === 'quarter'
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-muted hover:bg-gray-50'
                    }`}
                  >
                    Quarter
                  </button>
                </div>
              ) : (
                <div className="inline-flex rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => replaceParams({ mode: 'sprint' })}
                    className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
                      periodType === 'sprint'
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-muted hover:bg-gray-50'
                    }`}
                  >
                    Sprint
                  </button>
                  <button
                    type="button"
                    onClick={() => replaceParams({ mode: 'quarter' })}
                    className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
                      periodType === 'quarter'
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-muted hover:bg-gray-50'
                    }`}
                  >
                    Quarter
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted" />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          {!loading && !error && hasData && (
            <>
              {/* Warn when all ideas lack dates (coverage will be 0% everywhere) */}
              {!roadmapHasDates && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  <span className="font-semibold">Roadmap coverage shows 0%</span> — JPD ideas have no start/target
                  dates. Verify the date field IDs in{' '}
                  <a href="/settings" className="font-medium underline">
                    Settings
                  </a>{' '}
                  and trigger a sync.
                </div>
              )}

              {/* Summary stats */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">
                    Avg Roadmap Coverage
                  </h3>
                  <p className="mt-2 text-3xl font-bold">
                    {avgCoverage.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    across all {statPeriodLabel}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">
                    Avg On-Time Rate
                  </h3>
                  <p className="mt-2 text-3xl font-bold">
                    {avgOnTimeRate.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    across all {statPeriodLabel}
                  </p>
                </div>
              </div>

              {/* Trend charts */}
              <div className="grid gap-4 lg:grid-cols-2">
                <TrendChart
                  title="Roadmap Coverage %"
                  data={chartData[0]}
                  color="#3b82f6"
                  unit="%"
                />
                <TrendChart
                  title="Roadmap Delivery Rate %"
                  data={chartData[1]}
                  color="#22c55e"
                  unit="%"
                />
              </div>

              {/* Data table */}
              {isKanban && kanbanPeriod === 'week' ? (
                <DataTable<RoadmapSprintAccuracy>
                  columns={weekColumns}
                  data={kanbanWeekData}
                  rowClassName={weekRowColor}
                />
              ) : isKanban || periodType === 'quarter' ? (
                <DataTable<QuarterRow>
                  columns={quarterColumns}
                  data={quarterRows}
                  rowClassName={quarterRowColor}
                />
              ) : (
                <DataTable<RoadmapSprintAccuracy>
                  columns={sprintColumns}
                  data={rawData}
                  rowClassName={sprintRowColor}
                />
              )}
            </>
          )}

          {/* Empty state — data loaded but no rows */}
          {!loading && !error && !hasData && (
            <EmptyState
              title="No roadmap data"
              message="No data found for this board. Sync data or select a different board."
            />
          )}
        </>
      )}
    </div>
  );
}
