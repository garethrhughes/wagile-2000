'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save, Loader2, CheckCircle, XCircle, Plus, Trash2, RefreshCw } from 'lucide-react';
import {
  getBoards,
  getBoardConfig,
  updateBoardConfig,
  getRoadmapConfigs,
  createRoadmapConfig,
  updateRoadmapConfig,
  deleteRoadmapConfig,
  triggerRoadmapSync,
  type BoardConfig,
  type RoadmapConfig,
} from '@/lib/api'

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
  const { toasts, show } = useToast();

  // Board config
  const [boardList, setBoardList] = useState<string[]>([]);
  const [activeBoard, setActiveBoard] = useState<string | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // JPD / Roadmap config
  const [jpdConfigs, setJpdConfigs] = useState<RoadmapConfig[]>([]);
  const [jpdConfigsLoading, setJpdConfigsLoading] = useState(false);
  const [newJpdKey, setNewJpdKey] = useState('');
  const [jpdSyncing, setJpdSyncing] = useState(false);
  const [jpdAdding, setJpdAdding] = useState(false);
  // Per-config field-ID draft values: configId → { startDateFieldId, targetDateFieldId }
  const [fieldIdDrafts, setFieldIdDrafts] = useState<
    Record<number, { startDateFieldId: string; targetDateFieldId: string }>
  >({});
  const [fieldIdSaving, setFieldIdSaving] = useState<Record<number, boolean>>({});

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
    setJpdConfigsLoading(true);
    getRoadmapConfigs()
      .then((configs) => {
        setJpdConfigs(configs)
        // Initialise draft values from loaded configs
        const drafts: Record<number, { startDateFieldId: string; targetDateFieldId: string }> = {}
        for (const cfg of configs) {
          drafts[cfg.id] = {
            startDateFieldId: cfg.startDateFieldId ?? '',
            targetDateFieldId: cfg.targetDateFieldId ?? '',
          }
        }
        setFieldIdDrafts(drafts)
      })
      .catch(() => {})
      .finally(() => setJpdConfigsLoading(false));
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
          Manage board configurations
        </p>
      </div>

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
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Data Start Date
                </label>
                <input
                  type="date"
                  value={config.dataStartDate ?? ''}
                  onChange={(e) =>
                    updateField('dataStartDate', e.target.value || null)
                  }
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted">
                  Issues with a board-entry date before this date are excluded from all Kanban metrics. Leave blank for no lower bound.
                </p>
              </div>
              <CsvField
                label="Done Status Names"
                value={config.doneStatusNames}
                onChange={(v) => updateField('doneStatusNames', v)}
              />
              <CsvField
                label="In-Progress Status Names"
                value={config.inProgressStatusNames}
                onChange={(v) => updateField('inProgressStatusNames', v)}
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

      {/* Roadmap Config (JPD) section */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Roadmap Config (JPD)</h2>

        {jpdConfigsLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted" />
          </div>
        )}

        {!jpdConfigsLoading && (
          <div className="space-y-4">
            {/* Existing configs list */}
            {jpdConfigs.length > 0 && (
              <div className="space-y-4">
                {jpdConfigs.map((cfg) => (
                  <div
                    key={cfg.id}
                    className="rounded-lg border border-border bg-background p-4 space-y-3"
                  >
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <code className="rounded bg-gray-100 px-2 py-0.5 text-sm font-mono">
                          {cfg.jpdKey}
                        </code>
                        {cfg.description && (
                          <span className="text-sm text-muted">{cfg.description}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          deleteRoadmapConfig(cfg.id)
                            .then(() => {
                              setJpdConfigs((prev) => prev.filter((c) => c.id !== cfg.id))
                              setFieldIdDrafts((prev) => {
                                const next = { ...prev }
                                delete next[cfg.id]
                                return next
                              })
                              show('success', `Removed JPD config for ${cfg.jpdKey}`)
                            })
                            .catch(() => {
                              show('error', `Failed to delete config for ${cfg.jpdKey}`)
                            })
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>

                    {/* Date field ID inputs */}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-muted">
                          Start Date Field ID
                        </label>
                        <input
                          type="text"
                          value={fieldIdDrafts[cfg.id]?.startDateFieldId ?? ''}
                          onChange={(e) =>
                            setFieldIdDrafts((prev) => ({
                              ...prev,
                              [cfg.id]: {
                                ...prev[cfg.id],
                                startDateFieldId: e.target.value,
                              },
                            }))
                          }
                          placeholder="e.g. customfield_10015"
                          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-medium text-muted">
                          Target Date Field ID
                        </label>
                        <input
                          type="text"
                          value={fieldIdDrafts[cfg.id]?.targetDateFieldId ?? ''}
                          onChange={(e) =>
                            setFieldIdDrafts((prev) => ({
                              ...prev,
                              [cfg.id]: {
                                ...prev[cfg.id],
                                targetDateFieldId: e.target.value,
                              },
                            }))
                          }
                          placeholder="e.g. customfield_10021"
                          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted">
                      Jira custom field IDs for date-filtered roadmap accuracy. Find these in your Jira admin under Project → Fields. Trigger a Roadmap Sync after saving.
                    </p>

                    {/* Save field IDs button */}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={fieldIdSaving[cfg.id] === true}
                        onClick={() => {
                          const draft = fieldIdDrafts[cfg.id]
                          if (!draft) return
                          setFieldIdSaving((prev) => ({ ...prev, [cfg.id]: true }))
                          updateRoadmapConfig(cfg.id, {
                            startDateFieldId: draft.startDateFieldId.trim() || null,
                            targetDateFieldId: draft.targetDateFieldId.trim() || null,
                          })
                            .then((updated) => {
                              setJpdConfigs((prev) =>
                                prev.map((c) => (c.id === updated.id ? updated : c)),
                              )
                              show('success', `Saved field IDs for ${cfg.jpdKey}`)
                            })
                            .catch(() => {
                              show('error', `Failed to save field IDs for ${cfg.jpdKey}`)
                            })
                            .finally(() => {
                              setFieldIdSaving((prev) => ({ ...prev, [cfg.id]: false }))
                            })
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {fieldIdSaving[cfg.id] === true ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        {fieldIdSaving[cfg.id] === true ? 'Saving…' : 'Save Field IDs'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {jpdConfigs.length === 0 && (
              <p className="text-sm text-muted">No JPD project keys configured.</p>
            )}

            {/* Add new config */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newJpdKey}
                onChange={(e) => setNewJpdKey(e.target.value)}
                placeholder="JPD project key, e.g. DISC"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <button
                type="button"
                disabled={jpdAdding || !newJpdKey.trim()}
                onClick={() => {
                  const key = newJpdKey.trim();
                  if (!key) return;
                  setJpdAdding(true);
                  createRoadmapConfig({ jpdKey: key })
                    .then((cfg) => {
                      setJpdConfigs((prev) => [...prev, cfg])
                      setFieldIdDrafts((prev) => ({
                        ...prev,
                        [cfg.id]: { startDateFieldId: '', targetDateFieldId: '' },
                      }))
                      setNewJpdKey('')
                      show('success', `Added JPD config for ${cfg.jpdKey}`)
                    })
                    .catch(() => {
                      show('error', 'Failed to add JPD config');
                    })
                    .finally(() => setJpdAdding(false));
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {jpdAdding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {jpdAdding ? 'Adding…' : 'Add'}
              </button>
            </div>

            {/* Sync button */}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                disabled={jpdSyncing}
                onClick={() => {
                  setJpdSyncing(true);
                  triggerRoadmapSync()
                    .then((res) => {
                      show('success', res.message ?? 'Roadmap sync triggered');
                    })
                    .catch(() => {
                      show('error', 'Failed to trigger roadmap sync');
                    })
                    .finally(() => setJpdSyncing(false));
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                {jpdSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {jpdSyncing ? 'Syncing…' : 'Sync Roadmaps'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
