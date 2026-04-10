'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import {
  getPlanningAccuracy,
  type SprintAccuracy,
  type ApiError,
} from '@/lib/api';
import { ALL_BOARDS } from '@/store/filter-store';
import { BoardChip } from '@/components/ui/board-chip';
import { SprintSelect } from '@/components/ui/sprint-select';
import { QuarterSelect } from '@/components/ui/quarter-select';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KANBAN_BOARDS = new Set(['PLAT']);

// ---------------------------------------------------------------------------
// Helper: row colouring
// ---------------------------------------------------------------------------

function rowColor(row: SprintAccuracy): string {
  if (row.scopeChangePct > 40) return 'bg-red-50';
  if (row.scopeChangePct > 20) return 'bg-amber-50';
  return '';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PlanningPage() {
  const [selectedBoard, setSelectedBoard] = useState<string>('ACC');
  const [periodType, setPeriodType] = useState<'sprint' | 'quarter'>('quarter');
  const [selectedSprint, setSelectedSprint] = useState<string | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kanbanError, setKanbanError] = useState(false);
  const [data, setData] = useState<SprintAccuracy[]>([]);

  const isKanban = KANBAN_BOARDS.has(selectedBoard);

  const handleSelectBoard = useCallback((boardId: string) => {
    if (KANBAN_BOARDS.has(boardId)) return;
    setSelectedBoard(boardId);
    setData([]);
    setError(null);
    setKanbanError(false);
  }, []);

  // Fetch planning data
  useEffect(() => {
    if (isKanban) {
      setKanbanError(true);
      setData([]);
      return;
    }

    setKanbanError(false);

    const periodValue =
      periodType === 'sprint' ? selectedSprint : selectedQuarter;
    if (!periodValue) {
      setData([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getPlanningAccuracy({
      boardId: selectedBoard,
      sprintId: periodType === 'sprint' ? selectedSprint ?? undefined : undefined,
      quarter: periodType === 'quarter' ? selectedQuarter ?? undefined : undefined,
    })
      .then((res) => {
        if (!cancelled) setData(res ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const apiErr = err as { status?: number; message?: string };
          if (apiErr.status === 400) {
            setKanbanError(true);
          } else {
            setError(
              err instanceof Error ? err.message : 'Failed to load planning data',
            );
          }
          setData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBoard, periodType, selectedSprint, selectedQuarter, isKanban]);

  // Summary stats
  const { avgScopeChange, avgCompletion } = useMemo(() => {
    if (data.length === 0) return { avgScopeChange: 0, avgCompletion: 0 };
    const totalScope = data.reduce((s, r) => s + r.scopeChangePct, 0);
    const totalComp = data.reduce((s, r) => s + r.completionRate, 0);
    return {
      avgScopeChange: totalScope / data.length,
      avgCompletion: totalComp / data.length,
    };
  }, [data]);

  // Table columns
  const columns = useMemo<Column<SprintAccuracy>[]>(
    () => [
      { key: 'sprintName', label: 'Sprint', sortable: true },
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
        key: 'scopeChangePct',
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
    [],
  );

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

        {/* Period type + period selector */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted">
              Period
            </label>
            <div className="inline-flex rounded-lg border border-border">
              <button
                type="button"
                onClick={() => {
                  setPeriodType('sprint');
                  setSelectedQuarter(null);
                }}
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
                onClick={() => {
                  setPeriodType('quarter');
                  setSelectedSprint(null);
                }}
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
                boardId={selectedBoard}
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

      {/* Summary stats */}
      {!loading && !error && data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-medium text-muted">
              Avg Scope Change
            </h3>
            <p className="mt-2 text-3xl font-bold">
              {avgScopeChange.toFixed(1)}%
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-medium text-muted">
              Avg Completion Rate
            </h3>
            <p className="mt-2 text-3xl font-bold">
              {avgCompletion.toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {/* Data table */}
      {!loading && !error && !kanbanError && data.length > 0 && (
        <DataTable<SprintAccuracy>
          columns={columns}
          data={data}
          rowClassName={rowColor}
        />
      )}

      {/* Empty state */}
      {!loading && !error && !kanbanError && data.length === 0 && (
        <EmptyState
          title="No planning data"
          message="Select a board and time period to view sprint accuracy."
        />
      )}
    </div>
  );
}
