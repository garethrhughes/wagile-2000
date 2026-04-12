'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart3, Target, Map, Settings, Timer, RefreshCw, AlertCircle } from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useSyncStore } from '@/store/sync-store'

interface NavItem {
  label: string
  href: string
  icon: ReactNode
}

const MAIN_NAV_ITEMS: NavItem[] = [
  { label: 'DORA', href: '/dora', icon: <BarChart3 className="h-5 w-5" /> },
  { label: 'Cycle Time', href: '/cycle-time', icon: <Timer className="h-5 w-5" /> },
  { label: 'Planning', href: '/planning', icon: <Target className="h-5 w-5" /> },
  { label: 'Gaps', href: '/gaps', icon: <AlertCircle className="h-5 w-5" /> },
  { label: 'Roadmap', href: '/roadmap', icon: <Map className="h-5 w-5" /> },
]

const SETTINGS_ITEM: NavItem = {
  label: 'Settings',
  href: '/settings',
  icon: <Settings className="h-5 w-5" />,
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const seconds = Math.floor(diff / 1000)

  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function latestSync(lastSynced: Record<string, string>): string | null {
  const dates = Object.values(lastSynced).filter(Boolean)
  if (dates.length === 0) return null
  return dates.reduce((a, b) => (a > b ? a : b))
}

export function Sidebar() {
  const pathname = usePathname()
  const { lastSynced, isSyncing, triggerSync, fetchStatus } = useSyncStore()

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const latest = latestSync(lastSynced)
  const settingsActive = pathname.startsWith(SETTINGS_ITEM.href)

  return (
    <aside className="flex h-screen w-60 flex-shrink-0 flex-col bg-surface-brand border-r border-border">
      {/* Brand */}
      <div className="flex items-center gap-2 px-5 py-6">
        <BarChart3 className="h-7 w-7 text-squirrel-500" />
        <span className="text-lg font-bold tracking-tight text-text-primary">Fragile</span>
      </div>

      {/* Main navigation — scrollable, takes remaining space */}
      <nav className="flex-1 overflow-y-auto space-y-1 px-3">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Navigation
        </p>
        {MAIN_NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-surface-active text-squirrel-700'
                  : 'text-text-secondary hover:bg-surface-raised'
              }`}
            >
              <span className={active ? 'text-squirrel-500' : 'text-text-muted'}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* Bottom pinned section — sync + settings */}
      <div className="border-t border-border px-3 pb-4 pt-3">
        {/* Last synced timestamp */}
        <p className="mb-2 px-3 text-xs text-text-muted">
          {latest ? <>Synced {formatRelativeTime(latest)}</> : 'Not yet synced'}
        </p>

        {/* Sync button */}
        <button
          type="button"
          onClick={() => void triggerSync()}
          disabled={isSyncing}
          className="mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
        >
          <span className="text-text-muted">
            <RefreshCw className={`h-5 w-5 ${isSyncing ? 'animate-spin' : ''}`} />
          </span>
          {isSyncing ? 'Syncing…' : 'Sync Now'}
        </button>

        {/* Settings link */}
        <Link
          href={SETTINGS_ITEM.href}
          className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
            settingsActive
              ? 'bg-surface-active text-squirrel-700'
              : 'text-text-secondary hover:bg-surface-raised'
          }`}
        >
          <span className={settingsActive ? 'text-squirrel-500' : 'text-text-muted'}>
            {SETTINGS_ITEM.icon}
          </span>
          {SETTINGS_ITEM.label}
        </Link>
      </div>
    </aside>
  )
}
