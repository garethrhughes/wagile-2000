import type { Metadata } from 'next'

interface Props {
  params: Promise<{ boardId: string; week: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { boardId, week } = await params
  return { title: `${week} — ${boardId}` }
}

export default function WeekLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
