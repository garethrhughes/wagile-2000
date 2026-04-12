import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Planning',
}

export default function PlanningLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
