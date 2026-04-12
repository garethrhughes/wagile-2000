import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DORA',
}

export default function DoraLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
