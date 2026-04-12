import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Gaps',
}

export default function GapsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
