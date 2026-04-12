import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Cycle Time',
}

export default function CycleTimeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
