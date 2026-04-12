'use client'

import { useEffect, useRef } from 'react'
import { useBoardsStore } from '@/store/boards-store'
import { useFilterStore } from '@/store/filter-store'

export function AppInitialiser() {
  const fetchBoards = useBoardsStore((s) => s.fetchBoards)
  const boardsStatus = useBoardsStore((s) => s.status)
  const setAllBoards = useFilterStore((s) => s.setAllBoards)
  const seededRef = useRef(false)

  // Trigger the board list fetch once on mount
  useEffect(() => {
    void fetchBoards()
  }, [fetchBoards])

  // Once boards are ready, seed the filter store's selectedBoards —
  // but only on the first ready transition, not on subsequent ones
  // (e.g. after refreshBoards() is called from Settings).
  useEffect(() => {
    if (boardsStatus === 'ready' && !seededRef.current) {
      seededRef.current = true
      const current = useFilterStore.getState().selectedBoards
      if (current.length === 0) {
        setAllBoards()
      }
    }
  }, [boardsStatus, setAllBoards])

  return null
}
