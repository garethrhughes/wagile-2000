'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getDoraMetrics, type MetricResult, type DoraBand } from '@/lib/api';
import { useFilterStore, ALL_BOARDS } from '@/store/filter-store';
import { MetricCard } from '@/components/ui/metric-card';
import { BoardChip } from '@/components/ui/board-chip';
import { SprintSelect } from '@/components/ui/sprint-select';
import { QuarterSelect } from '@/components/ui/quarter-select';
import { EmptyState } from '@/components/ui/empty-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AggregatedMetrics {
  deploymentFrequency: MetricResult;
  leadTime: MetricResult;
  cfr: MetricResult;
  mttr: MetricResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Map raw backend DORA response to MetricResult for each board
interface BoardMetrics {
  boardId: string;
  deploymentFrequency: MetricResult;
  leadTime: MetricResult;
  cfr: MetricResult;
  mttr: MetricResult;
}

function mapBoardMetrics(board: {
  boardId: string;
  deploymentFrequency: { deploymentsPerDay: number; band: DoraBand };
  leadTime: { medianDays: number; p95Days: number; band: DoraBand };
  changeFailureRate: { changeFailureRate: number; band: DoraBand };
  mttr: { medianHours: number; band: DoraBand };
}): BoardMetrics {
  return {
    boardId: board.boardId,
    deploymentFrequency: {
      value: board.deploymentFrequency.deploymentsPerDay,
      unit: 'deploys/day',
      band: board.deploymentFrequency.band,
    },
    leadTime: {
      value: board.leadTime.medianDays,
      unit: 'days',
      band: board.leadTime.band,
    },
    cfr: {
      value: board.changeFailureRate.changeFailureRate,
      unit: '%',
      band: board.changeFailureRate.band,
    },
    mttr: {
      value: board.mttr.medianHours,
      unit: 'hours',
      band: board.mttr.band,
    },
  };
}

function aggregateMetrics(
  boards: BoardMetrics[],
): AggregatedMetrics | null {
  if (boards.length === 0) return null;

  if (boards.length === 1) {
    return {
      deploymentFrequency: boards[0].deploymentFrequency,
      leadTime: boards[0].leadTime,
      cfr: boards[0].cfr,
      mttr: boards[0].mttr,
    };
  }

  // Average across boards for the aggregate view
  const count = boards.length;
  const sum = (extractor: (b: BoardMetrics) => MetricResult): MetricResult => {
    const values = boards.map((b) => extractor(b));
    const avgValue = values.reduce((s, v) => s + v.value, 0) / count;

    // Take the worst band
    const bandOrder: Record<string, number> = { elite: 3, high: 2, medium: 1, low: 0 };
    const worstBand = values.reduce(
      (worst, v) => (bandOrder[v.band] < bandOrder[worst.band] ? v : worst),
      values[0],
    );

    // Merge trends – average per period
    const trendLengths = values.map((v) => v.trend?.length ?? 0);
    const maxTrendLen = Math.max(...trendLengths);
    let trend: number[] | undefined;
    if (maxTrendLen > 0) {
      trend = Array.from({ length: maxTrendLen }, (_, i) => {
        const validValues = values
          .map((v) => v.trend?.[i])
          .filter((t): t is number => t !== undefined);
        return validValues.length > 0
          ? validValues.reduce((s, v) => s + v, 0) / validValues.length
          : 0;
      });
    }

    return {
      value: avgValue,
      unit: values[0].unit,
      band: worstBand.band,
      trend,
    };
  };

  return {
    deploymentFrequency: sum((m) => m.deploymentFrequency),
    leadTime: sum((m) => m.leadTime),
    cfr: sum((m) => m.cfr),
    mttr: sum((m) => m.mttr),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DoraPage() {
  const {
    selectedBoards,
    periodType,
    selectedSprint,
    selectedQuarter,
    setSelectedBoards,
    setPeriodType,
    setSelectedSprint,
    setSelectedQuarter,
  } = useFilterStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<AggregatedMetrics | null>(null);

  const toggleBoard = useCallback(
    (boardId: string) => {
      setSelectedBoards(
        selectedBoards.includes(boardId)
          ? selectedBoards.filter((b) => b !== boardId)
          : [...selectedBoards, boardId],
      );
    },
    [selectedBoards, setSelectedBoards],
  );

  // Fetch metrics whenever filters change
  useEffect(() => {
    if (selectedBoards.length === 0) {
      setMetrics(null);
      return;
    }

    const periodValue =
      periodType === 'sprint' ? selectedSprint : selectedQuarter;
    // Don't fetch until a period is chosen
    if (!periodValue) {
      setMetrics(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getDoraMetrics({
      boardId: selectedBoards.join(','),
      period: periodType,
      sprintId: periodType === 'sprint' ? selectedSprint ?? undefined : undefined,
      quarter: periodType === 'quarter' ? selectedQuarter ?? undefined : undefined,
    })
      .then((res) => {
        if (!cancelled) {
          const mapped = (res ?? []).map(mapBoardMetrics);
          setMetrics(aggregateMetrics(mapped));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load metrics');
          setMetrics(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoards, periodType, selectedSprint, selectedQuarter]);

  const firstSelectedBoard = useMemo(
    () => (selectedBoards.length > 0 ? selectedBoards[0] : undefined),
    [selectedBoards],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">DORA Metrics</h1>
        <p className="mt-1 text-sm text-muted">
          Four key metrics for software delivery performance
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {/* Board selector */}
        <div>
          <label className="mb-2 block text-sm font-medium text-muted">
            Boards
          </label>
          <div className="flex flex-wrap gap-2">
            {ALL_BOARDS.map((boardId) => (
              <BoardChip
                key={boardId}
                boardId={boardId}
                selected={selectedBoards.includes(boardId)}
                onClick={() => toggleBoard(boardId)}
              />
            ))}
          </div>
        </div>

        {/* Period type + period selector */}
        <div className="flex flex-wrap items-end gap-4">
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

          <div className="w-64">
            {periodType === 'sprint' ? (
              <SprintSelect
                boardId={firstSelectedBoard}
                value={selectedSprint}
                onChange={setSelectedSprint}
              />
            ) : (
              <QuarterSelect
                value={selectedQuarter}
                onChange={setSelectedQuarter}
              />
            )}
          </div>
        </div>
      </div>

      {/* Metric cards */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted" />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {!loading && !error && !metrics && (
        <EmptyState
          title="No metrics yet"
          message="Select boards and a time period to view DORA metrics."
        />
      )}

      {!loading && metrics && (
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricCard
            title="Deployment Frequency"
            value={metrics.deploymentFrequency.value}
            unit={metrics.deploymentFrequency.unit}
            band={metrics.deploymentFrequency.band}
            trend={metrics.deploymentFrequency.trend}
          />
          <MetricCard
            title="Lead Time for Changes"
            value={metrics.leadTime.value}
            unit={metrics.leadTime.unit}
            band={metrics.leadTime.band}
            trend={metrics.leadTime.trend}
          />
          <MetricCard
            title="Change Failure Rate"
            value={metrics.cfr.value}
            unit={metrics.cfr.unit}
            band={metrics.cfr.band}
            trend={metrics.cfr.trend}
          />
          <MetricCard
            title="Mean Time to Recovery"
            value={metrics.mttr.value}
            unit={metrics.mttr.unit}
            band={metrics.mttr.band}
            trend={metrics.mttr.trend}
          />
        </div>
      )}
    </div>
  );
}
