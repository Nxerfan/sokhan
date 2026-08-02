'use client'

import { useEffect } from 'react'
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
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useDashboardStore, type DashboardView } from './nav-store'

const NAV_ITEMS: {
  view: DashboardView
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  group: 'nav' | 'settings'
}[] = [
  { view: 'inbox', icon: Inbox, labelKey: 'nav.inbox', group: 'nav' },
  { view: 'contacts', icon: Users, labelKey: 'nav.contacts', group: 'nav' },
  { view: 'analytics', icon: BarChart3, labelKey: 'nav.analytics', group: 'nav' },
  { view: 'automation', icon: Workflow, labelKey: 'nav.automation', group: 'nav' },
  { view: 'integrations', icon: Plug, labelKey: 'nav.integrations', group: 'nav' },
  { view: 'members', icon: UserCog, labelKey: 'nav.members', group: 'settings' },
  { view: 'departments', icon: Building2, labelKey: 'nav.departments', group: 'settings' },
  { view: 'widget', icon: Palette, labelKey: 'nav.widget', group: 'settings' },
  { view: 'general', icon: Settings, labelKey: 'nav.general', group: 'settings' },
  { view: 'billing', icon: CreditCard, labelKey: 'nav.billing', group: 'settings' },
]

export function CommandPalette() {
  const t = useTranslations()
  const { commandOpen, setCommandOpen, setView } = useDashboardStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandOpen(!commandOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commandOpen, setCommandOpen])

  function go(view: DashboardView) {
    setView(view)
    setCommandOpen(false)
  }

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder={t('command.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('command.noResults')}</CommandEmpty>
        <CommandGroup heading={t('command.groupNavigation')}>
          {NAV_ITEMS.filter((i) => i.group === 'nav').map((item) => (
            <CommandItem
              key={item.view}
              value={`${item.view} ${t(item.labelKey)}`}
              onSelect={() => go(item.view)}
              className="gap-2"
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {t(item.labelKey)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t('command.groupSettings')}>
          {NAV_ITEMS.filter((i) => i.group === 'settings').map((item) => (
            <CommandItem
              key={item.view}
              value={`${item.view} ${t(item.labelKey)}`}
              onSelect={() => go(item.view)}
              className="gap-2"
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {t(item.labelKey)}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
