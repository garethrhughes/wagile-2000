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
  getPlanningAccuracy,
  getKanbanQuarters,
  getKanbanWeeks,
  getRoadmapAccuracy,
  getRoadmapConfigs,
  type SprintAccuracy,
  type KanbanQuarterSummary,
  type KanbanWeekSummary,
  type RoadmapSprintAccuracy,
} from '@/lib/api'
import { ALL_BOARDS } from '@/store/filter-store'
import { BoardChip } from '@/components/ui/board-chip'
import { DataTable, type Column } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'

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
// Quarter row type (for quarter-mode table on Scrum boards)
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

function kanbanRowColor(row: KanbanQuarterSummary): string {
  if (row.deliveryRate < 50) return 'bg-red-50';
  if (row.deliveryRate < 80) return 'bg-amber-50';
  return '';
}

function kanbanWeekRowColor(row: KanbanWeekSummary): string {
  if (row.deliveryRate < 50) return 'bg-red-50';
  if (row.deliveryRate < 80) return 'bg-amber-50';
  return '';
}

// ---------------------------------------------------------------------------
// Abbreviated sprint/quarter/week label for chart x-axis
// ---------------------------------------------------------------------------

function abbreviateLabel(name: string): string {
  const qMatch = name.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    return `Q${qMatch[2]} '${qMatch[1].slice(2)}`;
  }
  const wMatch = name.match(/^(\d{4})-W(\d+)$/);
  if (wMatch) {
    return `W${wMatch[2]} '${wMatch[1].slice(2)}`;
  }
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
// State chip renderer (shared)
// ---------------------------------------------------------------------------

function renderStateChip(value: unknown) {
  const state = String(value);
  const color =
    state === 'active'
      ? 'text-green-600 bg-green-50'
      : 'text-gray-600 bg-gray-100';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${color}`}>
      {state}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Delivery rate renderer (shared)
// ---------------------------------------------------------------------------

function renderDeliveryRate(value: unknown) {
  const pct = Number(value);
  const color = pct < 50 ? 'text-red-600 font-semibold' : pct < 80 ? 'text-amber-600 font-semibold' : 'text-green-700 font-semibold';
  return <span className={color}>{pct.toFixed(1)}%</span>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PlanningPage() {
  const searchParams = useSearchParams()
  const replaceParams = useReplaceParams()

  // Filter state lives in the URL — defaults applied when params are absent
  const selectedBoard = searchParams.get('board') ?? 'ACC'
  const periodType = (searchParams.get('mode') ?? 'sprint') as 'sprint' | 'quarter'
  const kanbanPeriod = (searchParams.get('kanban') ?? 'week') as 'quarter' | 'week'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawData, setRawData] = useState<SprintAccuracy[]>([])
  const [kanbanData, setKanbanData] = useState<KanbanQuarterSummary[]>([])
  const [kanbanWeekData, setKanbanWeekData] = useState<KanbanWeekSummary[]>([])

  // Roadmap accuracy summary (board-scoped)
  const [roadmapData, setRoadmapData] = useState<RoadmapSprintAccuracy[]>([])
  const [roadmapConfigured, setRoadmapConfigured] = useState(false)
  const [roadmapLoading, setRoadmapLoading] = useState(false)

  const isKanban = KANBAN_BOARDS.has(selectedBoard)

  const handleSelectBoard = useCallback((boardId: string) => {
    replaceParams({ board: boardId })
    setRawData([])
    setKanbanData([])
    setKanbanWeekData([])
    setError(null)
  }, [replaceParams])

  // Fetch sprint data for Scrum boards
  useEffect(() => {
    if (isKanban) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getPlanningAccuracy({ boardId: selectedBoard })
      .then((res) => {
        if (!cancelled) setRawData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load planning data');
          setRawData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban]);

  // Fetch quarterly flow data for Kanban boards
  useEffect(() => {
    if (!isKanban || kanbanPeriod !== 'quarter') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getKanbanQuarters(selectedBoard)
      .then((res) => {
        if (!cancelled) setKanbanData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load Kanban flow data');
          setKanbanData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban, kanbanPeriod]);

  // Fetch weekly flow data for Kanban boards
  useEffect(() => {
    if (!isKanban || kanbanPeriod !== 'week') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    getKanbanWeeks(selectedBoard)
      .then((res) => {
        if (!cancelled) setKanbanWeekData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load Kanban weekly data');
          setKanbanWeekData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, isKanban, kanbanPeriod]);

  // Fetch roadmap accuracy summary for the selected board
  useEffect(() => {
    let cancelled = false
    setRoadmapLoading(true)
    setRoadmapData([])

    // First check if any roadmap configs exist; if not, skip the accuracy fetch
    getRoadmapConfigs()
      .then((configs) => {
        if (!cancelled) setRoadmapConfigured(configs.length > 0)
        if (configs.length === 0) {
          return Promise.resolve([] as RoadmapSprintAccuracy[])
        }
        const params = isKanban
          ? { boardId: selectedBoard, weekMode: true }
          : { boardId: selectedBoard }
        return getRoadmapAccuracy(params)
      })
      .then((res) => {
        if (!cancelled) setRoadmapData(res ?? [])
      })
      .catch(() => {
        if (!cancelled) setRoadmapData([])
      })
      .finally(() => {
        if (!cancelled) setRoadmapLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedBoard, isKanban])

  // Quarter rows derived client-side from raw sprint data (Scrum)
  const quarterRows = useMemo(() => groupByQuarter(rawData), [rawData]);

  // ---------------------------------------------------------------------------
  // Scrum summary stats
  // ---------------------------------------------------------------------------
  const { avgScopeChange, avgCompletion, avgPlanningAccuracy, accuracyCount } = useMemo(() => {
    const rows = periodType === 'quarter' ? quarterRows : rawData
    if (rows.length === 0) return { avgScopeChange: 0, avgCompletion: 0, avgPlanningAccuracy: null, accuracyCount: 0 }
    const totalScope = rows.reduce((s, r) => s + r.scopeChangePercent, 0)
    const totalComp = rows.reduce((s, r) => s + r.completionRate, 0)

    const nonNullAccuracies = rawData
      .map(r => r.planningAccuracy)
      .filter((v): v is number => v !== null)

    const avgPlanningAccuracy = nonNullAccuracies.length > 0
      ? nonNullAccuracies.reduce((s, v) => s + v, 0) / nonNullAccuracies.length
      : null

    const accuracyCount = nonNullAccuracies.length

    return {
      avgScopeChange: totalScope / rows.length,
      avgCompletion: totalComp / rows.length,
      avgPlanningAccuracy,
      accuracyCount,
    }
  }, [rawData, quarterRows, periodType])

  // ---------------------------------------------------------------------------
  // Kanban summary stats
  // ---------------------------------------------------------------------------
  const { avgDeliveryRate, totalDelivered, periodLabel } = useMemo(() => {
    if (isKanban && kanbanPeriod === 'week') {
      if (kanbanWeekData.length === 0) return { avgDeliveryRate: 0, totalDelivered: 0, periodLabel: 'weeks' };
      const rate = kanbanWeekData.reduce((s, r) => s + r.deliveryRate, 0) / kanbanWeekData.length;
      const delivered = kanbanWeekData.reduce((s, r) => s + r.completed, 0);
      return {
        avgDeliveryRate: rate,
        totalDelivered: delivered,
        periodLabel: `week${kanbanWeekData.length !== 1 ? 's' : ''}`,
      };
    }
    if (kanbanData.length === 0) return { avgDeliveryRate: 0, totalDelivered: 0, periodLabel: 'quarters' };
    const rate = kanbanData.reduce((s, r) => s + r.deliveryRate, 0) / kanbanData.length;
    const delivered = kanbanData.reduce((s, r) => s + r.completed, 0);
    return {
      avgDeliveryRate: rate,
      totalDelivered: delivered,
      periodLabel: `quarter${kanbanData.length !== 1 ? 's' : ''}`,
    };
  }, [isKanban, kanbanPeriod, kanbanData, kanbanWeekData]);

  // ---------------------------------------------------------------------------
  // Roadmap accuracy summary stats
  // ---------------------------------------------------------------------------
  const { roadmapAvgCoverage, roadmapAvgOnTimeRate, roadmapHasDates } = useMemo(() => {
    if (roadmapData.length === 0) {
      return { roadmapAvgCoverage: 0, roadmapAvgOnTimeRate: 0, roadmapHasDates: false }
    }
    const hasDates = roadmapData.some((r) => r.coveredIssues > 0)
    const totalCoverage = roadmapData.reduce((s, r) => s + r.roadmapCoverage, 0)
    const totalOnTime = roadmapData.reduce((s, r) => s + r.roadmapOnTimeRate, 0)
    return {
      roadmapAvgCoverage: totalCoverage / roadmapData.length,
      roadmapAvgOnTimeRate: totalOnTime / roadmapData.length,
      roadmapHasDates: hasDates,
    }
  }, [roadmapData])

  // ---------------------------------------------------------------------------
  // Chart data
  // ---------------------------------------------------------------------------
  const chartData = useMemo<ChartDataPoint[][]>(() => {
    if (isKanban && kanbanPeriod === 'week') {
      const chronological = [...kanbanWeekData].reverse();
      return [
        chronological.map((w) => ({ label: abbreviateLabel(w.week), value: w.issuesPulledIn })),
        chronological.map((w) => ({ label: abbreviateLabel(w.week), value: w.completed })),
        chronological.map((w) => ({ label: abbreviateLabel(w.week), value: w.deliveryRate })),
      ];
    }
    if (isKanban) {
      // Kanban quarter: chronological order (oldest first)
      const chronological = [...kanbanData].reverse();
      return [
        chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.issuesPulledIn })),
        chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.completed })),
        chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.deliveryRate })),
      ];
    }
    if (periodType === 'sprint') {
      const chronological = [...rawData].reverse();
      return [
        chronological.map((s) => ({ label: abbreviateLabel(s.sprintName), value: s.commitment })),
        chronological.map((s) => ({ label: abbreviateLabel(s.sprintName), value: s.completed })),
        chronological.map((s) => ({ label: abbreviateLabel(s.sprintName), value: s.scopeChangePercent })),
      ];
    }
    const chronological = [...quarterRows].reverse();
    return [
      chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.commitment })),
      chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.completed })),
      chronological.map((q) => ({ label: abbreviateLabel(q.quarter), value: q.scopeChangePercent })),
    ];
  }, [isKanban, kanbanPeriod, kanbanData, kanbanWeekData, rawData, quarterRows, periodType]);

  // ---------------------------------------------------------------------------
  // Table columns
  // ---------------------------------------------------------------------------

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
        render: renderStateChip,
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
          const color = pct > 40 ? 'text-red-600 font-semibold' : pct > 20 ? 'text-amber-600 font-semibold' : '';
          return <span className={color}>{pct.toFixed(1)}%</span>;
        },
      },
      {
        key: 'completionRate',
        label: 'Completion Rate',
        sortable: true,
        render: (value) => `${Number(value).toFixed(1)}%`,
      },
      {
        key: 'planningAccuracy',
        label: 'Planning Accuracy',
        sortable: true,
        render: (value, row) => {
          if (value === null || value === undefined) return <span className="text-muted">—</span>
          const pct = Number(value)
          const color = pct >= 90 ? 'text-green-700 font-semibold' : pct >= 70 ? 'text-amber-600 font-semibold' : 'text-red-600 font-semibold'
          const tooltip =
            row.committedPoints !== null && row.completedPoints !== null
              ? `${row.completedPoints} of ${row.committedPoints} committed points`
              : undefined
          return (
            <span className={color} title={tooltip}>
              {pct.toFixed(1)}%
            </span>
          )
        },
      },
    ],
    [selectedBoard],
  );

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
          const color = pct > 40 ? 'text-red-600 font-semibold' : pct > 20 ? 'text-amber-600 font-semibold' : '';
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

  const kanbanColumns = useMemo<Column<KanbanQuarterSummary>[]>(
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
      {
        key: 'state',
        label: 'State',
        sortable: true,
        render: renderStateChip,
      },
      { key: 'issuesPulledIn', label: 'Pulled In', sortable: true },
      { key: 'completed', label: 'Completed', sortable: true },
      { key: 'addedMidQuarter', label: 'Mid-Quarter', sortable: true },
      { key: 'pointsIn', label: 'Points In', sortable: true },
      { key: 'pointsDone', label: 'Points Done', sortable: true },
      {
        key: 'deliveryRate',
        label: 'Delivery Rate',
        sortable: true,
        render: renderDeliveryRate,
      },
    ],
    [selectedBoard],
  );

  const kanbanWeekColumns = useMemo<Column<KanbanWeekSummary>[]>(
    () => [
      {
        key: 'week',
        label: 'Week',
        sortable: true,
        render: (value) => (
          <Link
            href={`/week/${encodeURIComponent(selectedBoard)}/${encodeURIComponent(String(value))}?from=planning`}
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
        render: renderStateChip,
      },
      { key: 'issuesPulledIn', label: 'Pulled In', sortable: true },
      { key: 'completed', label: 'Completed', sortable: true },
      { key: 'addedMidWeek', label: 'Mid-Week', sortable: true },
      { key: 'pointsIn', label: 'Points In', sortable: true },
      { key: 'pointsDone', label: 'Points Done', sortable: true },
      {
        key: 'deliveryRate',
        label: 'Delivery Rate',
        sortable: true,
        render: renderDeliveryRate,
      },
    ],
    [selectedBoard],
  );

  // ---------------------------------------------------------------------------
  // Derived flags
  // ---------------------------------------------------------------------------
  const hasData = isKanban
    ? kanbanPeriod === 'week'
      ? kanbanWeekData.length > 0
      : kanbanData.length > 0
    : periodType === 'sprint'
      ? rawData.length > 0
      : quarterRows.length > 0;

  const rowCount = isKanban
    ? kanbanPeriod === 'week'
      ? kanbanWeekData.length
      : kanbanData.length
    : periodType === 'sprint'
      ? rawData.length
      : quarterRows.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Planning Accuracy</h1>
        <p className="mt-1 text-sm text-muted">
          {isKanban
            ? kanbanPeriod === 'week'
              ? 'Weekly flow metrics — issues pulled in vs delivered'
              : 'Quarterly flow metrics — issues pulled in vs delivered'
            : 'Sprint commitment vs delivery metrics'}
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {/* Board selector */}
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
          {/* Summary stats */}
          <div className={`grid gap-4 ${!isKanban && periodType === 'sprint' ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            {isKanban ? (
              <>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">Avg Delivery Rate</h3>
                  <p className="mt-2 text-3xl font-bold">{avgDeliveryRate.toFixed(1)}%</p>
                  <p className="mt-1 text-xs text-muted">
                    across {rowCount} {periodLabel}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">Total Issues Delivered</h3>
                  <p className="mt-2 text-3xl font-bold">{totalDelivered}</p>
                  <p className="mt-1 text-xs text-muted">
                    across {rowCount} {periodLabel}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">Avg Scope Change</h3>
                  <p className="mt-2 text-3xl font-bold">{avgScopeChange.toFixed(1)}%</p>
                  <p className="mt-1 text-xs text-muted">
                    across all {periodType === 'sprint' ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}` : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-medium text-muted">Avg Completion Rate</h3>
                  <p className="mt-2 text-3xl font-bold">{avgCompletion.toFixed(1)}%</p>
                  <p className="mt-1 text-xs text-muted">
                    across all {periodType === 'sprint' ? `${rawData.length} sprint${rawData.length !== 1 ? 's' : ''}` : `${quarterRows.length} quarter${quarterRows.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
                {periodType === 'sprint' && (
                  <div className="rounded-xl border border-border bg-card p-5">
                    <h3 className="text-sm font-medium text-muted">Avg Planning Accuracy</h3>
                    <p className={`mt-2 text-3xl font-bold ${
                      avgPlanningAccuracy === null
                        ? ''
                        : avgPlanningAccuracy >= 90
                          ? 'text-green-700'
                          : avgPlanningAccuracy >= 70
                            ? 'text-amber-600'
                            : 'text-red-600'
                    }`}>
                      {avgPlanningAccuracy !== null ? `${avgPlanningAccuracy.toFixed(1)}%` : '—'}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {accuracyCount > 0
                        ? `across ${accuracyCount} sprint${accuracyCount !== 1 ? 's' : ''} with estimates`
                        : 'no sprints with estimates'}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Trend charts */}
          <div className="grid gap-4 lg:grid-cols-3">
            {isKanban ? (
              <>
                <TrendChart title="Issues Pulled In" data={chartData[0]} color="#3b82f6" />
                <TrendChart title="Issues Completed" data={chartData[1]} color="#22c55e" />
                <TrendChart title="Delivery Rate %" data={chartData[2]} color="#f59e0b" unit="%" />
              </>
            ) : (
              <>
                <TrendChart title="Commitment" data={chartData[0]} color="#3b82f6" />
                <TrendChart title="Completed" data={chartData[1]} color="#22c55e" />
                <TrendChart title="Scope Change %" data={chartData[2]} color="#f59e0b" unit="%" />
              </>
            )}
          </div>

          {/* Data table */}
          {isKanban ? (
            kanbanPeriod === 'week' ? (
              <DataTable<KanbanWeekSummary>
                columns={kanbanWeekColumns}
                data={kanbanWeekData}
                rowClassName={kanbanWeekRowColor}
              />
            ) : (
              <DataTable<KanbanQuarterSummary>
                columns={kanbanColumns}
                data={kanbanData}
                rowClassName={kanbanRowColor}
              />
            )
          ) : periodType === 'sprint' ? (
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
      {!loading && !error && !hasData && (
        <EmptyState
          title="No planning data"
          message={
            isKanban
              ? kanbanPeriod === 'week'
                ? 'No weekly flow data found for this board.'
                : 'No quarterly flow data found for this board.'
              : 'Select a board to view sprint accuracy.'
          }
        />
      )}

      {/* Roadmap Accuracy summary — shown always (independent of planning data state) */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Roadmap Accuracy</h2>
            <p className="mt-0.5 text-sm text-muted">
              Sprint work aligned to JPD roadmap items
            </p>
          </div>
          <Link
            href={`/roadmap?board=${encodeURIComponent(selectedBoard)}`}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            View full report →
          </Link>
        </div>

        {roadmapLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        )}

        {!roadmapLoading && !roadmapConfigured && (
          <p className="text-sm text-muted">
            No JPD roadmap configured.{' '}
            <Link href="/settings" className="text-blue-600 hover:underline">
              Add a JPD project key in Settings
            </Link>{' '}
            to track roadmap coverage.
          </p>
        )}

        {!roadmapLoading && roadmapConfigured && roadmapData.length === 0 && (
          <p className="text-sm text-muted">No roadmap data found for this board.</p>
        )}

        {!roadmapLoading && roadmapConfigured && roadmapData.length > 0 && (
          <>
            {!roadmapHasDates && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                Roadmap ideas have no start/target dates — coverage shows 0%.
                Trigger a sync after verifying the date field IDs in{' '}
                <Link href="/settings" className="font-medium underline">
                  Settings
                </Link>
                .
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Avg Roadmap Coverage</p>
                <p className="mt-1 text-2xl font-bold">
                  {roadmapAvgCoverage.toFixed(1)}%
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  across {roadmapData.length} {roadmapData.length !== 1 ? 'periods' : 'period'}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Avg On-Time Rate</p>
                <p className="mt-1 text-2xl font-bold">
                  {roadmapAvgOnTimeRate.toFixed(1)}%
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  of roadmap-linked issues delivered on time
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
