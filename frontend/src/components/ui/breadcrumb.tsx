import Link from 'next/link'

export interface BreadcrumbSegment {
  label: string
  href?: string
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[]
}

export function Breadcrumb({ segments }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {segments.map((seg, i) => (
        <span key={`${seg.href ?? 'current'}:${seg.label}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="select-none text-muted">/</span>}
          {seg.href ? (
            <Link
              href={seg.href}
              className="transition-colors hover:text-foreground"
            >
              {seg.label}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{seg.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
