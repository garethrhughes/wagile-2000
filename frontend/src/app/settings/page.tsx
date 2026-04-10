'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save, Eye, EyeOff, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import {
  getBoards,
  getBoardConfig,
  updateBoardConfig,
  type BoardConfig,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let toastId = 0;

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((type: ToastType, message: string) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return { toasts, show };
}

// ---------------------------------------------------------------------------
// Comma-separated field editor
// ---------------------------------------------------------------------------

interface CsvFieldProps {
  label: string;
  value: string[];
  onChange: (values: string[]) => void;
}

function CsvField({ label, value, onChange }: CsvFieldProps) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      <input
        type="text"
        value={value.join(', ')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder="Value1, Value2, Value3"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { apiKey, setApiKey, clearApiKey } = useAuthStore();
  const { toasts, show } = useToast();

  // API Key management
  const [showKey, setShowKey] = useState(false);
  const [newKey, setNewKey] = useState('');

  // Board config
  const [boardList, setBoardList] = useState<string[]>([]);
  const [activeBoard, setActiveBoard] = useState<string | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load board list
  useEffect(() => {
    getBoards()
      .then((res) => {
        const ids = (res ?? []).map((b) => b.boardId);
        setBoardList(ids);
        if (ids.length > 0 && !activeBoard) setActiveBoard(ids[0]);
      })
      .catch(() => {
        // Boards may not be available yet
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load config when active board changes
  useEffect(() => {
    if (!activeBoard) return;
    let cancelled = false;
    setConfigLoading(true);
    getBoardConfig(activeBoard)
      .then((res) => {
        if (!cancelled) setConfig(res);
      })
      .catch(() => {
        if (!cancelled) {
          setConfig(null);
          show('error', `Failed to load config for ${activeBoard}`);
        }
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeBoard, show]);

  // Save config
  const handleSaveConfig = useCallback(async () => {
    if (!activeBoard || !config) return;
    setSaving(true);
    try {
      const updated = await updateBoardConfig(activeBoard, config);
      setConfig(updated);
      show('success', `Configuration saved for ${activeBoard}`);
    } catch {
      show('error', 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }, [activeBoard, config, show]);

  // Update a config field
  function updateField<K extends keyof BoardConfig>(
    key: K,
    value: BoardConfig[K],
  ) {
    if (!config) return;
    setConfig({ ...config, [key]: value });
  }

  const maskedKey = apiKey
    ? `${'•'.repeat(Math.max(0, apiKey.length - 4))}${apiKey.slice(-4)}`
    : '';

  return (
    <div className="space-y-8">
      {/* Toast notifications */}
      <div className="fixed right-4 top-4 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-md ${
              t.type === 'success'
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {t.type === 'success' ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {t.message}
          </div>
        ))}
      </div>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Manage API key and board configurations
        </p>
      </div>

      {/* API Key section */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">API Key</h2>

        {apiKey ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <code className="rounded bg-gray-100 px-3 py-1.5 text-sm font-mono">
                {showKey ? apiKey : maskedKey}
              </code>
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="text-muted hover:text-foreground"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 gap-2">
                <input
                  type="password"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="Enter new API key"
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (newKey.trim()) {
                      setApiKey(newKey.trim());
                      setNewKey('');
                      show('success', 'API key updated');
                    }
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Update
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearApiKey();
                  show('success', 'API key removed');
                }}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">No API key set.</p>
        )}
      </section>

      {/* Board config section */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Board Configuration</h2>

        {/* Board tabs */}
        {boardList.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-1 border-b border-border">
            {boardList.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveBoard(id)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeBoard === id
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                {id}
              </button>
            ))}
          </div>
        )}

        {configLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted" />
          </div>
        )}

        {!configLoading && config && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Board Type
                </label>
                <input
                  type="text"
                  value={config.boardType}
                  disabled
                  className="w-full rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm text-muted"
                />
              </div>
              <CsvField
                label="Done Status Names"
                value={config.doneStatusNames}
                onChange={(v) => updateField('doneStatusNames', v)}
              />
              <CsvField
                label="Failure Issue Types"
                value={config.failureIssueTypes}
                onChange={(v) => updateField('failureIssueTypes', v)}
              />
              <CsvField
                label="Failure Labels"
                value={config.failureLabels}
                onChange={(v) => updateField('failureLabels', v)}
              />
              <CsvField
                label="Failure Link Types"
                value={config.failureLinkTypes}
                onChange={(v) => updateField('failureLinkTypes', v)}
              />
              <CsvField
                label="Incident Issue Types"
                value={config.incidentIssueTypes}
                onChange={(v) => updateField('incidentIssueTypes', v)}
              />
              <CsvField
                label="Recovery Status Names"
                value={config.recoveryStatusNames}
                onChange={(v) => updateField('recoveryStatusNames', v)}
              />
              <CsvField
                label="Incident Labels"
                value={config.incidentLabels}
                onChange={(v) => updateField('incidentLabels', v)}
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => void handleSaveConfig()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? 'Saving…' : 'Save Configuration'}
              </button>
            </div>
          </div>
        )}

        {!configLoading && !config && boardList.length > 0 && (
          <p className="text-sm text-muted">
            Select a board to edit its configuration.
          </p>
        )}

        {boardList.length === 0 && !configLoading && (
          <p className="text-sm text-muted">
            No boards available. Please sync data first.
          </p>
        )}
      </section>
    </div>
  );
}
