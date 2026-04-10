'use client';

import { useEffect, useState } from 'react';
import { getSprints, type SprintInfo } from '@/lib/api';

interface SprintSelectProps {
  boardId?: string;
  value: string | null;
  onChange: (sprintId: string | null) => void;
}

export function SprintSelect({ boardId, value, onChange }: SprintSelectProps) {
  const [sprints, setSprints] = useState<SprintInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!boardId) {
      setSprints([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getSprints(boardId)
      .then((res) => {
        if (!cancelled) setSprints(res ?? []);
      })
      .catch(() => {
        if (!cancelled) setSprints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={loading || sprints.length === 0}
        className="w-full appearance-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground disabled:opacity-50"
      >
        <option value="">
          {loading ? 'Loading sprints…' : 'Select sprint'}
        </option>
        {sprints.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.state})
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
        <svg
          className="h-4 w-4 text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </div>
    </div>
  );
}
