import { create } from 'zustand';
import { triggerSync, getSyncStatus } from '@/lib/api';

export interface SyncState {
  lastSynced: Record<string, string>;
  isSyncing: boolean;
  triggerSync: () => Promise<void>;
  fetchStatus: () => Promise<void>;
}

export const useSyncStore = create<SyncState>((set) => ({
  lastSynced: {},
  isSyncing: false,

  triggerSync: async () => {
    set({ isSyncing: true });
    try {
      await triggerSync();
      const status = await getSyncStatus();
      const mapped: Record<string, string> = {};
      for (const b of status ?? []) {
        if (b.lastSync) mapped[b.boardId] = b.lastSync;
      }
      set({ lastSynced: mapped });
    } finally {
      set({ isSyncing: false });
    }
  },

  fetchStatus: async () => {
    try {
      const status = await getSyncStatus();
      const mapped: Record<string, string> = {};
      for (const b of status ?? []) {
        if (b.lastSync) mapped[b.boardId] = b.lastSync;
      }
      set({ lastSynced: mapped });
    } catch {
      // Silently fail on status fetch
    }
  },
}));
