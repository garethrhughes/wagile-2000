'use client'

import type { ReactNode } from 'react'
import { Sidebar } from '@/components/layout/sidebar'
import { AppInitialiser } from '@/components/layout/app-initialiser'

interface ClientShellProps {
  children: ReactNode
}

export function ClientShell({ children }: ClientShellProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      <AppInitialiser />
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden bg-surface">
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
