'use client';

import { type ReactNode, useState, useEffect, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { apiKey, setApiKey } = useAuthStore();
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Render nothing until mounted to avoid hydration mismatch
  // (server has no localStorage, so apiKey differs between server and client)
  if (!mounted) {
    return null;
  }

  if (apiKey) {
    return <>{children}</>;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      setError('Please enter an API key');
      return;
    }
    setApiKey(trimmed);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
            <KeyRound className="h-6 w-6 text-blue-600" />
          </div>
          <h1 className="text-xl font-bold">DORA Metrics Dashboard</h1>
          <p className="text-center text-sm text-muted">
            Enter your API key to access the dashboard.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="api-key"
              className="mb-1.5 block text-sm font-medium"
            >
              API Key
            </label>
            <input
              id="api-key"
              type="password"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError('');
              }}
              placeholder="Enter your API key"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            {error && (
              <p className="mt-1 text-xs text-red-500">{error}</p>
            )}
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
