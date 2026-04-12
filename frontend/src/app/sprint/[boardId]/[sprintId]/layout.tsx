import type { Metadata } from 'next'

interface Props {
  params: Promise<{ boardId: string; sprintId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { boardId } = await params
  return { title: `Sprint — ${boardId}` }
}

export default function SprintLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
