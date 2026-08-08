'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart3, Clock, Star, MessageSquare, TrendingUp } from 'lucide-react'

type Analytics = {
  volumeByDay: { date: string; count: number }[]
  avgResponseMs: number | null
  avgResolutionMs: number | null
  csatAvg: number | null
  csatCount: number
  csatDistribution: { rating: number; count: number }[]
  totalConversations: number
  openConversations: number
  closedConversations: number
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function fmtDate(iso: string, locale: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(locale === 'fa' ? 'fa-IR' : 'en-US', { weekday: 'short', day: 'numeric' })
}

export function AnalyticsPanel() {
  const locale = useLocale()
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/analytics')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
  }, [])

  if (loading || !data) {
    return <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Loading…</div>
  }

  const maxVolume = Math.max(...data.volumeByDay.map(d => d.count), 1)

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {locale === 'fa' ? 'تحلیل‌ها' : 'Analytics'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === 'fa' ? 'نمای کلی از عملکرد گفت‌وگوها در ۷ روز گذشته.' : 'Overview of conversation performance over the last 7 days.'}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={MessageSquare}
          label={locale === 'fa' ? 'کل گفت‌وگوها' : 'Total Conversations'}
          value={String(data.totalConversations)}
          sub={`${data.openConversations} ${locale === 'fa' ? 'باز' : 'open'} · ${data.closedConversations} ${locale === 'fa' ? 'بسته' : 'closed'}`}
        />
        <StatCard
          icon={Clock}
          label={locale === 'fa' ? 'میانگین اولین پاسخ' : 'Avg First Response'}
          value={fmtDuration(data.avgResponseMs)}
          sub={locale === 'fa' ? 'از زمان شروع گفت‌وگو' : 'from conversation start'}
        />
        <StatCard
          icon={TrendingUp}
          label={locale === 'fa' ? 'میانگین زمان حل' : 'Avg Resolution Time'}
          value={fmtDuration(data.avgResolutionMs)}
          sub={locale === 'fa' ? 'تا بسته شدن' : 'until closed'}
        />
        <StatCard
          icon={Star}
          label={locale === 'fa' ? 'رضایت مشتری (CSAT)' : 'CSAT Score'}
          value={data.csatAvg ? `${data.csatAvg.toFixed(1)}/5` : '—'}
          sub={`${data.csatCount} ${locale === 'fa' ? 'امتیاز' : 'ratings'}`}
        />
      </div>

      {/* Volume chart */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            {locale === 'fa' ? 'حجم گفت‌وگو (۷ روز)' : 'Conversation Volume (7 days)'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-48 items-end justify-between gap-2">
            {data.volumeByDay.map(day => (
              <div key={day.date} className="flex flex-1 flex-col items-center gap-2">
                <div className="text-xs font-medium text-muted-foreground">{day.count}</div>
                <div
                  className="w-full rounded-t-lg bg-saffron/80 transition-all hover:bg-saffron"
                  style={{ height: `${(day.count / maxVolume) * 100}%`, minHeight: day.count > 0 ? '8px' : '2px' }}
                />
                <div className="text-[10px] text-muted-foreground">{fmtDate(day.date, locale)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* CSAT distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base flex items-center gap-2">
            <Star className="h-4 w-4" />
            {locale === 'fa' ? 'توزیع امتیازات CSAT' : 'CSAT Rating Distribution'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.csatCount === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {locale === 'fa' ? 'هنوز امتیازی ثبت نشده است' : 'No CSAT ratings yet'}
            </p>
          ) : (
            <div className="space-y-2">
              {data.csatDistribution.slice().reverse().map(d => {
                const pct = data.csatCount > 0 ? (d.count / data.csatCount) * 100 : 0
                return (
                  <div key={d.rating} className="flex items-center gap-3">
                    <div className="flex w-12 items-center gap-1 text-sm">
                      {d.rating} <Star className="h-3 w-3 fill-saffron text-saffron" />
                    </div>
                    <div className="h-6 flex-1 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-saffron/70 rounded transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="w-12 text-right text-xs text-muted-foreground">{d.count}</div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  )
}
