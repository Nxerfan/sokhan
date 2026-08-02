'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { NavRail } from './nav-rail'
import { TopBar } from './top-bar'
import { CommandPalette } from './command-palette'
import { useDashboardStore } from './nav-store'
import { InboxPlaceholder, ComingSoonView } from './views/placeholders'
import { InboxView } from './views/inbox-view'
import { MembersPanel } from './views/members-panel'
import { DepartmentsPanel } from './views/departments-panel'
import { WidgetPanel } from './views/widget-panel'
import { GeneralPanel } from './views/general-panel'
import { RoutingRulesPanel } from './views/routing-rules-panel'
import { Users, BarChart3, Workflow, Plug, CreditCard } from 'lucide-react'

type TenantInfo = { id: string; name: string; slug: string }

export function DashboardShell() {
  const t = useTranslations()
  const { view } = useDashboardStore()
  const [tenant, setTenant] = useState<TenantInfo | null>(null)
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    fetch('/api/tenants/me')
      .then((r) => r.json())
      .then((d) => d.tenant && setTenant(d.tenant))
    fetch('/api/departments')
      .then((r) => r.json())
      .then((d) => setDepartments(d.departments ?? []))
  }, [])

  const workspaceName = tenant?.name ?? '—'

  return (
    <div className="flex flex-1 overflow-hidden">
      <NavRail />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar workspaceName={workspaceName} />
        <main className="flex flex-1 flex-col overflow-y-auto scroll-thin">
          {view === 'inbox' && <InboxView />}
          {view === 'contacts' && (
            <ComingSoonView icon={Users} title={t('nav.contacts')} hint={t('dashboard.comingSoonHint')} />
          )}
          {view === 'analytics' && (
            <ComingSoonView icon={BarChart3} title={t('nav.analytics')} hint={t('dashboard.comingSoonHint')} />
          )}
          {view === 'automation' && <RoutingRulesPanel departments={departments} />}
          {view === 'integrations' && (
            <ComingSoonView icon={Plug} title={t('nav.integrations')} hint={t('dashboard.comingSoonHint')} />
          )}
          {view === 'members' && <MembersPanel />}
          {view === 'departments' && <DepartmentsPanel />}
          {view === 'widget' && tenant && <WidgetPanel slug={tenant.slug} />}
          {view === 'general' && <GeneralPanel />}
          {view === 'billing' && (
            <ComingSoonView icon={CreditCard} title={t('nav.billing')} hint={t('dashboard.comingSoonHint')} />
          )}
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}
