'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle } from 'lucide-react';
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
  getPlanningAccuracy,
  type SprintAccuracy,
  ApiError,
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
  commitment: number;
  added: number;
  removed: number;
  completed: number;
  scopeChangePercent: number;
  completionRate: number;
}

function groupByQuarter(sprints: SprintAccuracy[]): QuarterRow[] {
  const map = new Map<string, SprintAccuracy[]>();

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
    const commitment = group.reduce((acc, s) => acc + s.commitment, 0);
    const added = group.reduce((acc, s) => acc + s.added, 0);
    const removed = group.reduce((acc, s) => acc + s.removed, 0);
    const completed = group.reduce((acc, s) => acc + s.completed, 0);
    // Recalculate from totals for consistency
    const effectiveScope = commitment + added - removed;
    const scopeChangePercent =
      commitment > 0
        ? Math.round(((added + removed) / commitment) * 10000) / 100
        : 0;
    const completionRate =
      effectiveScope > 0
        ? Math.round((completed / effectiveScope) * 10000) / 100
        : 0;
    rows.push({
      quarter,
      commitment,
      added,
      removed,
      completed,
      scopeChangePercent,
      completionRate,
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

function sprintRowColor(row: SprintAccuracy): string {
  if (row.scopeChangePercent > 40) return 'bg-red-50';
  if (row.scopeChangePercent > 20) return 'bg-amber-50';
  return '';
}

function quarterRowColor(row: QuarterRow): string {
  if (row.scopeChangePercent > 40) return 'bg-red-50';
  if (row.scopeChangePercent > 20) return 'bg-amber-50';
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

export default function PlanningPage() {
  const [selectedBoard, setSelectedBoard] = useState<string>('ACC');
  const [periodType, setPeriodType] = useState<'sprint' | 'quarter'>('sprint');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kanbanError, setKanbanError] = useState(false);
  const [rawData, setRawData] = useState<SprintAccuracy[]>([]);

  const isKanban = KANBAN_BOARDS.has(selectedBoard);

  const handleSelectBoard = useCallback((boardId: string) => {
    if (KANBAN_BOARDS.has(boardId)) return;
    setSelectedBoard(boardId);
    setRawData([]);
    setError(null);
    setKanbanError(false);
  }, []);

  // Fetch all non-future sprints whenever board changes
  useEffect(() => {
    if (isKanban) {
      setKanbanError(true);
      setRawData([]);
      return;
    }

    setKanbanError(false);

    let cancelled = false;
    setLoading(true);
    setError(null);

    getPlanningAccuracy({ boardId: selectedBoard })
      .then((res) => {
        if (!cancelled) setRawData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 400) {
            setKanbanError(true)
          } else {
            setError(
              err instanceof Error ? err.message : 'Failed to load planning data',
            )
          }
          setRawData([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban]);

  // Quarter rows derived client-side from raw sprint data
  const quarterRows = useMemo(() => groupByQuarter(rawData), [rawData]);

  // Summary stats across ALL displayed rows
  const { avgScopeChange, avgCompletion } = useMemo(() => {
    const rows =
      periodType === 'quarter'
        ? quarterRows
        : rawData;
    if (rows.length === 0) return { avgScopeChange: 0, avgCompletion: 0 };
    const totalScope = rows.reduce((s, r) => s + r.scopeChangePercent, 0);
    const totalComp = rows.reduce((s, r) => s + r.completionRate, 0);
    return {
      avgScopeChange: totalScope / rows.length,
      avgCompletion: totalComp / rows.length,
    };
  }, [rawData, quarterRows, periodType]);

  // Chart data — oldest on left → newest on right (reverse the display order)
  const chartData = useMemo<ChartDataPoint[][]>(() => {
    if (periodType === 'sprint') {
      // rawData is active-first then closed-desc; reverse for chronological
      const chronological = [...rawData].reverse();
      const commitment: ChartDataPoint[] = chronological.map((s) => ({
        label: abbreviateLabel(s.sprintName),
        value: s.commitment,
      }));
      const completed: ChartDataPoint[] = chronological.map((s) => ({
        label: abbreviateLabel(s.sprintName),
        value: s.completed,
      }));
      const scopeChange: ChartDataPoint[] = chronological.map((s) => ({
        label: abbreviateLabel(s.sprintName),
        value: s.scopeChangePercent,
      }));
      return [commitment, completed, scopeChange];
    } else {
      // quarterRows is current-first then descending; reverse for chronological
      const chronological = [...quarterRows].reverse();
      const commitment: ChartDataPoint[] = chronological.map((q) => ({
        label: abbreviateLabel(q.quarter),
        value: q.commitment,
      }));
      const completed: ChartDataPoint[] = chronological.map((q) => ({
        label: abbreviateLabel(q.quarter),
        value: q.completed,
      }));
      const scopeChange: ChartDataPoint[] = chronological.map((q) => ({
        label: abbreviateLabel(q.quarter),
        value: q.scopeChangePercent,
      }));
      return [commitment, completed, scopeChange];
    }
  }, [rawData, quarterRows, periodType]);

  // Sprint-mode table columns
  const sprintColumns = useMemo<Column<SprintAccuracy>[]>(
    () => [
      {
        key: 'sprintName',
        label: 'Sprint',
        sortable: true,
        render: (value, row) => (
          <Link
            href={`/sprint/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(row.sprintId)}?from=planning`}
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
      { key: 'commitment', label: 'Commitment', sortable: true },
      { key: 'added', label: 'Added', sortable: true },
      { key: 'removed', label: 'Removed', sortable: true },
      { key: 'completed', label: 'Completed', sortable: true },
      {
        key: 'scopeChangePercent',
        label: 'Scope Change %',
        sortable: true,
        render: (value) => {
          const pct = Number(value);
          const color =
            pct > 40
              ? 'text-red-600 font-semibold'
              : pct > 20
                ? 'text-amber-600 font-semibold'
                : '';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'completionRate',
        label: 'Completion Rate',
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
            href={`/quarter/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(String(value))}?from=planning`}
            className="font-medium text-blue-600 hover:underline"
          >
            {String(value)}
          </Link>
        ),
      },
      { key: 'commitment', label: 'Commitment', sortable: true },
      { key: 'added', label: 'Added', sortable: true },
      { key: 'removed', label: 'Removed', sortable: true },
      { key: 'completed', label: 'Completed', sortable: true },
      {
        key: 'scopeChangePercent',
        label: 'Scope Change %',
        sortable: true,
        render: (value) => {
          const pct = Number(value);
          const color =
            pct > 40
              ? 'text-red-600 font-semibold'
              : pct > 20
                ? 'text-amber-600 font-semibold'
                : '';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'completionRate',
        label: 'Completion Rate',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
    ],
    [selectedBoard],
  );

  const hasData =
    periodType === 'sprint' ? rawData.length > 0 : quarterRows.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Planning Accuracy</h1>
        <p className="mt-1 text-sm text-muted">
          Sprint commitment vs delivery metrics
        </p>
      </div>

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
                disabled={KANBAN_BOARDS.has(boardId)}
                onClick={() => handleSelectBoard(boardId)}
              />
            ))}
          </div>
        </div>

        {/* Period type toggle — no selector dropdowns */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">
            Period
          </label>
          <div className="inline-flex rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setPeriodType('sprint')}
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
        </div>
      </div>

      {/* Kanban warning */}
      {kanbanError && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          Planning accuracy is not available for Kanban boards.
        </div>
      )}

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
                Avg Scope Change
              </h3>
              <p className="mt-2 text-3xl font-bold">
                {avgScopeChange.toFixed(1)}%
              </p>
              <p className="mt-1 text-xs text-muted">
                across all {periodType === 'sprint' ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}` : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-medium text-muted">
                Avg Completion Rate
              </h3>
              <p className="mt-2 text-3xl font-bold">
                {avgCompletion.toFixed(1)}%
              </p>
              <p className="mt-1 text-xs text-muted">
                across all {periodType === 'sprint' ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}` : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
              </p>
            </div>
          </div>

          {/* Trend charts */}
          <div className="grid gap-4 lg:grid-cols-3">
            <TrendChart
              title="Commitment"
              data={chartData[0]}
              color="#3b82f6"
            />
            <TrendChart
              title="Completed"
              data={chartData[1]}
              color="#22c55e"
            />
            <TrendChart
              title="Scope Change %"
              data={chartData[2]}
              color="#f59e0b"
              unit="%"
            />
          </div>

          {/* Data table */}
          {periodType === 'sprint' ? (
            <DataTable<SprintAccuracy>
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

      {/* Empty state */}
      {!loading && !error && !kanbanError && !hasData && (
        <EmptyState
          title="No planning data"
          message="Select a board to view sprint accuracy."
        />
      )}
    </div>
  );
}
