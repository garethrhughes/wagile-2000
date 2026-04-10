'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';
import {
  getRoadmapAccuracy,
  getRoadmapConfigs,
  type RoadmapSprintAccuracy,
} from '@/lib/api';
import { ALL_BOARDS } from '@/store/filter-store';
import { BoardChip } from '@/components/ui/board-chip';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KANBAN_BOARDS = new Set(['PLAT']);

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
  linkedCompletedIssues: number;
  roadmapCoverage: number;
  roadmapDeliveryRate: number;
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
    const linkedCompletedIssues = group.reduce(
      (acc, s) => acc + s.linkedCompletedIssues,
      0,
    );
    // Recompute from totals for consistency
    const roadmapCoverage =
      totalIssues > 0
        ? Math.round((coveredIssues / totalIssues) * 10000) / 100
        : 0;
    const roadmapDeliveryRate =
      coveredIssues > 0
        ? Math.round((linkedCompletedIssues / coveredIssues) * 10000) / 100
        : 0;
    rows.push({
      quarter,
      totalIssues,
      coveredIssues,
      uncoveredIssues,
      linkedCompletedIssues,
      roadmapCoverage,
      roadmapDeliveryRate,
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

// ---------------------------------------------------------------------------
// Abbreviated sprint/quarter label for chart x-axis
// ---------------------------------------------------------------------------

function abbreviateLabel(name: string): string {
  // e.g. "ACC Sprint 23 (Jan 2025)" → "SP 23" or quarter "2025-Q1" → "Q1 '25"
  const qMatch = name.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    return `Q${qMatch[2]} '${qMatch[1].slice(2)}`;
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
  const [selectedBoard, setSelectedBoard] = useState<string>('ACC');
  const [periodType, setPeriodType] = useState<'sprint' | 'quarter'>('sprint');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawData, setRawData] = useState<RoadmapSprintAccuracy[]>([]);
  const [hasConfigs, setHasConfigs] = useState<boolean | null>(null);

  const isKanban = KANBAN_BOARDS.has(selectedBoard);

  // Check if any roadmap configs exist on mount
  useEffect(() => {
    getRoadmapConfigs()
      .then((configs) => {
        setHasConfigs(configs.length > 0);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load roadmap configuration');
        setHasConfigs(false);
      });
  }, []);

  const handleSelectBoard = useCallback((boardId: string) => {
    setSelectedBoard(boardId);
    setRawData([]);
    setError(null);
    // Kanban boards have no sprints — switch to quarter view automatically
    if (KANBAN_BOARDS.has(boardId)) {
      setPeriodType('quarter');
    }
  }, []);

  // Fetch roadmap accuracy data whenever board changes
  useEffect(() => {
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
  }, [selectedBoard]);

  // Quarter rows derived client-side from raw sprint data
  const quarterRows = useMemo(() => groupByQuarter(rawData), [rawData]);

  // Summary stats across ALL displayed rows
  const { avgCoverage, avgDeliveryRate } = useMemo(() => {
    const rows = periodType === 'quarter' ? quarterRows : rawData;
    if (rows.length === 0) return { avgCoverage: 0, avgDeliveryRate: 0 };
    const totalCoverage = rows.reduce((s, r) => s + r.roadmapCoverage, 0);
    const totalDelivery = rows.reduce((s, r) => s + r.roadmapDeliveryRate, 0);
    return {
      avgCoverage: totalCoverage / rows.length,
      avgDeliveryRate: totalDelivery / rows.length,
    };
  }, [rawData, quarterRows, periodType]);

  // Chart data — oldest on left → newest on right
  const chartData = useMemo<[ChartDataPoint[], ChartDataPoint[]]>(() => {
    if (periodType === 'sprint') {
      const chronological = [...rawData].reverse();
      const coverage: ChartDataPoint[] = chronological.map((s) => ({
        label: abbreviateLabel(s.sprintName),
        value: s.roadmapCoverage,
      }));
      const delivery: ChartDataPoint[] = chronological.map((s) => ({
        label: abbreviateLabel(s.sprintName),
        value: s.roadmapDeliveryRate,
      }));
      return [coverage, delivery];
    } else {
      const chronological = [...quarterRows].reverse();
      const coverage: ChartDataPoint[] = chronological.map((q) => ({
        label: abbreviateLabel(q.quarter),
        value: q.roadmapCoverage,
      }));
      const delivery: ChartDataPoint[] = chronological.map((q) => ({
        label: abbreviateLabel(q.quarter),
        value: q.roadmapDeliveryRate,
      }));
      return [coverage, delivery];
    }
  }, [rawData, quarterRows, periodType]);

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
        key: 'roadmapDeliveryRate',
        label: 'Delivery Rate %',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [selectedBoard],
  );

  // Quarter-mode table columns
  const quarterColumns = useMemo<Column<QuarterRow>[]>(
    () => [
      { key: 'quarter', label: 'Quarter', sortable: true },
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
        key: 'roadmapDeliveryRate',
        label: 'Delivery Rate %',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [],
  );

  const hasData =
    periodType === 'sprint' ? rawData.length > 0 : quarterRows.length > 0;

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
                {ALL_BOARDS.map((boardId) => (
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
              <div className="inline-flex rounded-lg border border-border">
                <button
                  type="button"
                  disabled={isKanban}
                  onClick={() => setPeriodType('sprint')}
                  className={`rounded-l-lg px-4 py-2 text-sm font-medium transition-colors ${
                    isKanban
                      ? 'cursor-not-allowed text-muted/40'
                      : periodType === 'sprint'
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-muted hover:bg-gray-50'
                  }`}
                  title={isKanban ? 'Sprint view is not available for Kanban boards' : undefined}
                >
                  Sprint
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodType('quarter')}
                  className={`rounded-r-lg px-4 py-2 text-sm font-medium transition-colors ${
                    periodType === 'quarter'
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-muted hover:bg-gray-50'
                  }`}
                >
                  Quarter
                </button>
              </div>
              {isKanban && (
                <p className="mt-1 text-xs text-muted">
                  Kanban boards use quarter grouping based on when issues were pulled onto the board.
                </p>
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
                    across all{' '}
                    {periodType === 'sprint'
                      ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}`
                      : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">
                    Avg Delivery Rate
                  </h3>
                  <p className="mt-2 text-3xl font-bold">
                    {avgDeliveryRate.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    across all{' '}
                    {periodType === 'sprint'
                      ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}`
                      : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
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
              {periodType === 'sprint' ? (
                <DataTable<RoadmapSprintAccuracy>
                  columns={sprintColumns}
                  data={rawData}
                  rowClassName={sprintRowColor}
                />
              ) : (
                <DataTable<QuarterRow>
                  columns={quarterColumns}
                  data={quarterRows}
                  rowClassName={quarterRowColor}
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
