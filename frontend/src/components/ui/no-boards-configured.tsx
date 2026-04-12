'use client'

import Link from 'next/link'

export function NoBoardsConfigured() {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <p className="text-sm font-medium text-foreground">No boards configured</p>
      <p className="mt-1 text-sm text-muted">Add a board in Settings to get started.</p>
      <Link href="/settings" className="mt-3 inline-block text-sm font-medium text-blue-600 hover:underline">
        Go to Settings →
      </Link>
    </div>
  )
}
