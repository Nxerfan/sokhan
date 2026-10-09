'use client'

import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Inbox, Users, BarChart3 } from 'lucide-react'

/** Placeholder view for Module-2 features. */
export function ComingSoonView({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  hint: string
}) {
  const t = useTranslations()
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md border-dashed">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-saffron/15 text-saffron">
            <Icon className="h-6 w-6" />
          </div>
          <CardTitle className="font-display">{title}</CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Badge variant="secondary" className="mx-auto block w-fit">
            {t('dashboard.comingSoon')}
          </Badge>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            {t('dashboard.comingSoonHint')}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export function InboxPlaceholder() {
  const t = useTranslations()
  return (
    <div className="flex flex-1 flex-col">
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4 sm:p-6">
        <StatCard label={t('dashboard.unread')} value="0" icon={Inbox} />
        <StatCard label={t('dashboard.openConversations')} value="0" icon={Users} />
        <StatCard label={t('dashboard.onlineAgents')} value="1" icon={Users} />
        <StatCard label={t('dashboard.avgResponse')} value="—" icon={BarChart3} />
      </div>
      <div className="mx-4 mb-4 flex-1 sm:mx-6 sm:mb-6">
        <ComingSoonView icon={Inbox} title={t('nav.inbox')} hint={t('dashboard.comingSoonHint')} />
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-display text-2xl font-semibold">{value}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  )
}

