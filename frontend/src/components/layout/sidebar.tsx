'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Target, Map, Settings, Timer } from 'lucide-react';
import type { ReactNode } from 'react';

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'DORA', href: '/dora', icon: <BarChart3 className="h-5 w-5" /> },
  { label: 'Cycle Time', href: '/cycle-time', icon: <Timer className="h-5 w-5" /> },
  { label: 'Planning', href: '/planning', icon: <Target className="h-5 w-5" /> },
  { label: 'Roadmap', href: '/roadmap', icon: <Map className="h-5 w-5" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="h-5 w-5" /> },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 flex-shrink-0 flex-col bg-surface-brand border-r border-border">
      {/* Brand */}
      <div className="flex items-center gap-2 px-5 py-6">
        <BarChart3 className="h-7 w-7 text-squirrel-500" />
        <span className="text-lg font-bold tracking-tight text-text-primary">Fragile</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Navigation
        </p>
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-surface-active text-squirrel-700'
                  : 'text-text-secondary hover:bg-surface-raised'
              }`}
            >
              <span className={active ? 'text-squirrel-500' : 'text-text-muted'}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 text-xs text-text-muted">
        v0.1.0
      </div>
    </aside>
  );
}
