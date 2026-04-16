'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Loader2, CheckCircle, XCircle, Plus, Trash2, RefreshCw, X } from 'lucide-react';
import {
  getBoards,
  getBoardConfig,
  updateBoardConfig,
  createBoard,
  deleteBoard,
  getRoadmapConfigs,
  createRoadmapConfig,
  updateRoadmapConfig,
  deleteRoadmapConfig,
  triggerRoadmapSync,
  type BoardConfig,
  type RoadmapConfig,
  ApiError,
} from '@/lib/api'
import { useBoardsStore } from '@/store/boards-store'

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

/**
 * A controlled text input for comma-separated values.
 *
 * The core problem with the previous implementation was that `value` was
 * derived by joining the stored `string[]` and `onChange` parsed it back on
 * every keystroke.  This round-trip stripped trailing commas and spaces the
 * moment the user typed them, making it impossible to enter e.g.
 * "In Progress, Done".
 *
 * Fix: keep a local `draft` string that the user edits freely.  The array is
 * only parsed and committed to the parent via `onChange` when the field loses
 * focus (`onBlur`).  When the parent value changes from outside (e.g. a new
 * board is selected) the draft is re-initialised from the incoming array.
 */
function CsvField({ label, value, onChange }: CsvFieldProps) {
  // Local free-text draft — the user types into this without any mid-keystroke
  // parsing that would strip commas or spaces.
  const [draft, setDraft] = useState<string>(() => value.join(', '))

  // Keep track of the last committed array so we can detect external changes
  // (e.g. a different board being loaded) and re-initialise the draft.
  const committedRef = useRef<string[]>(value)

  useEffect(() => {
    // Only reset the draft when the array reference has genuinely changed from
    // outside — i.e. the parent pushed a new value rather than us calling
    // onChange ourselves.  Compare by serialised value to avoid reference churn.
    const incoming = value.join('\x00')
    const committed = committedRef.current.join('\x00')
    if (incoming !== committed) {
      committedRef.current = value
      setDraft(value.join(', '))
    }
  }, [value])

  // Parse the draft string into a trimmed, non-empty string array and commit
  // to the parent.  Called on blur and (indirectly) before save.
  const commit = useCallback(() => {
    const parsed = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    committedRef.current = parsed
    onChange(parsed)
  }, [draft, onChange])

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
        placeholder="Value1, Value2, Value3"
      />
    </div>
  )
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

  // Add board form state
  const [newBoardId, setNewBoardId] = useState('');
  const [newBoardType, setNewBoardType] = useState<'scrum' | 'kanban'>('scrum');
  const [boardAdding, setBoardAdding] = useState(false);

  // Two-step inline confirmation for board deletion
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Global store refresh
  const refreshBoards = useBoardsStore((s) => s.refreshBoards);

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

  // Add board
  const handleAddBoard = useCallback(async () => {
    const id = newBoardId.trim().toUpperCase();
    if (!id) return;
    setBoardAdding(true);
    try {
      const created = await createBoard({ boardId: id, boardType: newBoardType });
      setBoardList((prev) => [...prev, created.boardId]);
      setActiveBoard(created.boardId);
      setNewBoardId('');
      setNewBoardType('scrum');
      show('success', `Board "${created.boardId}" added`);
      void refreshBoards();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        show('error', `Board "${id}" already exists`);
      } else {
        show('error', 'Failed to add board');
      }
    } finally {
      setBoardAdding(false);
    }
  }, [newBoardId, newBoardType, show, refreshBoards]);

  // Delete board (two-step inline confirmation — no window.confirm)
  const handleDeleteBoard = useCallback(async (id: string) => {
    try {
      await deleteBoard(id);
      const remaining = boardList.filter((b) => b !== id);
      setBoardList(remaining);
      if (activeBoard === id) {
        setActiveBoard(remaining[0] ?? null);
        setConfig(null);
      }
      setConfirmDeleteId(null);
      show('success', `Board "${id}" removed`);
      void refreshBoards();
    } catch {
      show('error', `Failed to remove board "${id}"`);
    }
  }, [activeBoard, boardList, show, refreshBoards]);

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

        {/* Add a board */}
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium text-foreground">Add a board</p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={newBoardId}
              onChange={(e) => setNewBoardId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddBoard();
              }}
              placeholder="Board ID, e.g. ACC"
              className="w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <select
              value={newBoardType}
              onChange={(e) => setNewBoardType(e.target.value as 'scrum' | 'kanban')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              <option value="scrum">scrum</option>
              <option value="kanban">kanban</option>
            </select>
            <button
              type="button"
              disabled={boardAdding || !newBoardId.trim()}
              onClick={() => void handleAddBoard()}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {boardAdding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {boardAdding ? 'Adding…' : 'Add Board'}
            </button>
          </div>
        </div>

        {/* Board tabs */}
        {boardList.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-1 border-b border-border">
            {boardList.map((id) => (
              <div
                key={id}
                role="tab"
                aria-selected={activeBoard === id}
                className={`group relative flex cursor-pointer items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
                  activeBoard === id
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-muted hover:text-foreground'
                }`}
                onClick={() => setActiveBoard(id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveBoard(id) }}
                tabIndex={0}
              >
                {id}
                {confirmDeleteId === id ? (
                  /* Step 2: confirm inline */
                  <span
                    className="ml-1 inline-flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteBoard(id);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-600 text-white hover:bg-red-700"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(null);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs font-medium bg-card border border-border text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  /* Step 1: first click asks for confirmation */
                  <button
                    type="button"
                    aria-label={`Remove board ${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(id);
                    }}
                    className="ml-0.5 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-red-100 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {configLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted" />
          </div>
        )}

        {!configLoading && config && (
          <div className="space-y-6">
            {/* Board-level read-only fields */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Board Type
                </label>
                <input
                  type="text"
                  value={config.boardType}
                  disabled
                  className="w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-muted"
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
            </div>

            {/* ── Workflow Statuses ─────────────────────────────────────── */}
            <div className="rounded-lg border border-border bg-background p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Workflow Statuses</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Status names that map to each lifecycle stage, used to classify issues across all metrics.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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
                  label="Cancelled Status Names"
                  value={config.cancelledStatusNames}
                  onChange={(v) => updateField('cancelledStatusNames', v)}
                />
              </div>
            </div>

            {/* ── CFR Detection ─────────────────────────────────────────── */}
            <div className="rounded-lg border border-border bg-background p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">CFR Detection</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Criteria used to identify issues that represent failed deployments when calculating Change Failure Rate.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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
              </div>
            </div>

            {/* ── MTTR Detection ────────────────────────────────────────── */}
            <div className="rounded-lg border border-border bg-background p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">MTTR Detection</h3>
                <p className="mt-0.5 text-xs text-muted">
                  Criteria used to identify incidents and determine when they are resolved when calculating Mean Time to Recovery.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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

        {boardList.length === 0 && !configLoading && !boardAdding && (
          <p className="text-sm text-muted">
            No boards configured yet. Use the form above to add your first board.
          </p>
        )}
      </section>

      {/* Roadmap Config (Jira Product Discovery) section */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">Roadmap Config (Jira Product Discovery)</h2>
        <p className="mb-4 text-sm text-muted">
          Jira Product Discovery (JPD) boards hold your roadmap items. Configure them here to measure roadmap coverage accuracy.
        </p>

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
