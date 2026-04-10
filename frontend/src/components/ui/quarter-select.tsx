'use client';

import { useEffect, useState } from 'react';
import { getQuarters } from '@/lib/api';

interface QuarterSelectProps {
  value: string | null;
  onChange: (quarter: string | null) => void;
}

export function QuarterSelect({ value, onChange }: QuarterSelectProps) {
  const [quarters, setQuarters] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getQuarters()
      .then((res) => {
        if (!cancelled) setQuarters((res ?? []).map((q) => q.quarter));
      })
      .catch(() => {
        if (!cancelled) setQuarters([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={loading || quarters.length === 0}
        className="w-full appearance-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground disabled:opacity-50"
      >
        <option value="">
          {loading ? 'Loading quarters…' : 'Select quarter'}
        </option>
        {quarters.map((q) => (
          <option key={q} value={q}>
            {q}
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
