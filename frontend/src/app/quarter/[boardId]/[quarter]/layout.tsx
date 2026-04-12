import type { Metadata } from 'next'

interface Props {
  params: Promise<{ boardId: string; quarter: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { boardId, quarter } = await params
  return { title: `${quarter} — ${boardId}` }
}

export default function QuarterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
