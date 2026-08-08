'use client'

import { useTranslations } from 'next-intl'
import {
  Inbox,
  Users,
  BarChart3,
  Workflow,
  Plug,
  UserCog,
  Building2,
  Palette,
  Settings,
  CreditCard,
  Command,
  MessageSquareText,
  Bot,
  Package,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDashboardStore, type DashboardView } from './nav-store'

const NAV_ITEMS: { view: DashboardView; icon: React.ComponentType<{ className?: string }>; labelKey: string }[] = [
  { view: 'inbox', icon: Inbox, labelKey: 'nav.inbox' },
  { view: 'contacts', icon: Users, labelKey: 'nav.contacts' },
  { view: 'analytics', icon: BarChart3, labelKey: 'nav.analytics' },
  { view: 'automation', icon: Workflow, labelKey: 'nav.automation' },
  { view: 'integrations', icon: Plug, labelKey: 'nav.integrations' },
]

const SETTINGS_ITEMS: { view: DashboardView; icon: React.ComponentType<{ className?: string }>; labelKey: string }[] = [
  { view: 'faq', icon: Bot, labelKey: 'nav.faq' },
  { view: 'products', icon: Package, labelKey: 'nav.products' },
  { view: 'members', icon: UserCog, labelKey: 'nav.members' },
  { view: 'departments', icon: Building2, labelKey: 'nav.departments' },
  { view: 'widget', icon: Palette, labelKey: 'nav.widget' },
  { view: 'general', icon: Settings, labelKey: 'nav.general' },
  { view: 'billing', icon: CreditCard, labelKey: 'nav.billing' },
]

export function NavRail() {
  const t = useTranslations()
  const { view, setView, setCommandOpen } = useDashboardStore()

  return (
    <nav
      className="flex h-full w-16 shrink-0 flex-col items-center justify-between border-e border-border bg-sidebar py-3"
      aria-label="primary"
    >
      <div className="flex flex-col items-center gap-1">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
          <MessageSquareText className="h-5 w-5" />
        </div>
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            active={view === item.view}
            label={t(item.labelKey)}
            onClick={() => setView(item.view)}
          >
            <item.icon className="h-5 w-5" />
          </NavButton>
        ))}
      </div>

      <div className="flex flex-col items-center gap-1">
        <NavButton
          active={false}
          label={t('command.placeholder')}
          onClick={() => setCommandOpen(true)}
          accent
        >
          <Command className="h-5 w-5" />
        </NavButton>
        <div className="my-1 h-px w-8 bg-border" />
        {SETTINGS_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            active={view === item.view}
            label={t(item.labelKey)}
            onClick={() => setView(item.view)}
          >
            <item.icon className="h-5 w-5" />
          </NavButton>
        ))}
      </div>
    </nav>
  )
}

function NavButton({
  children,
  active,
  label,
  onClick,
  accent,
}: {
  children: React.ReactNode
  active: boolean
  label: string
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
        active
          ? 'bg-saffron/15 text-saffron'
          : accent
            ? 'text-turquoise hover:bg-turquoise/10'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      )}
    >
      {children}
      {active && (
        <span className="absolute -start-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-saffron" />
      )}
    </button>
  )
}
