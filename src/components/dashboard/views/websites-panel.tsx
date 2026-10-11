'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Globe, Plus, Trash2, Lock } from 'lucide-react'
import { toast } from 'sonner'

type Domain = { id: string; domain: string; createdAt: string }

export function WebsitesPanel() {
  const locale = useLocale()
  const [domains, setDomains] = useState<Domain[]>([])
  const [limit, setLimit] = useState(0)
  const [loading, setLoading] = useState(true)
  const [newDomain, setNewDomain] = useState('')

  async function load() {
    const res = await fetch('/api/widget-domains')
    const data = await res.json()
    setDomains(data.domains ?? [])
    setLimit(data.limit ?? 0)
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function addDomain(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/widget-domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: newDomain }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error === 'limit_reached'
        ? (locale === 'fa' ? 'حداکثر دامنه‌های مجاز استفاده شده' : 'Domain limit reached')
        : data.error === 'already_exists'
          ? (locale === 'fa' ? 'این دامنه قبلاً اضافه شده' : 'Domain already exists')
          : data.error)
      return
    }
    toast.success(locale === 'fa' ? 'ذخیره شد' : 'Saved')
    setNewDomain('')
    load()
  }

  async function deleteDomain(id: string) {
    await fetch(`/api/widget-domains?id=${id}`, { method: 'DELETE' })
    toast.success(locale === 'fa' ? 'حذف شد' : 'Deleted')
    load()
  }

  const isLocked = limit === 0

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {locale === 'fa' ? 'وب‌سایت‌ها' : 'Websites'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === 'fa'
            ? `دامنه‌های مجاز برای نمایش ویجت. محدودیت پلن شما: ${limit === -1 ? 'نامحدود' : limit} دامنه`
            : `Allowed domains for widget embedding. Your plan limit: ${limit === -1 ? 'unlimited' : limit} domain(s)`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-base">{locale === 'fa' ? 'دامنه‌های ثبت‌شده' : 'Registered Domains'}</CardTitle>
            {!loading && !isLocked && (
              <Badge variant="outline">{domains.length} / {limit === -1 ? '∞' : limit}</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLocked && !loading ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Lock className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {locale === 'fa' ? 'برای مدیریت دامنه‌ها به پلن Pro ارتقا دهید' : 'Upgrade to Pro to manage domains'}
              </p>
            </div>
          ) : (
            <>
              <form onSubmit={addDomain} className="flex gap-2 border-b border-border p-4">
                <Input
                  value={newDomain}
                  onChange={e => setNewDomain(e.target.value)}
                  placeholder="example.com"
                  required
                  dir="ltr"
                />
                <Button type="submit" className="gap-2" disabled={limit !== -1 && domains.length >= limit}>
                  <Plus className="h-4 w-4" />
                  {locale === 'fa' ? 'افزودن' : 'Add'}
                </Button>
              </form>
              {loading ? (
                <div className="p-6 text-sm text-muted-foreground">{locale === 'fa' ? 'در حال بارگذاری...' : 'Loading...'}</div>
              ) : domains.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-8 text-center">
                  <Globe className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">{locale === 'fa' ? 'هنوز دامنه‌ای ثبت نشده است' : 'No domains yet'}</p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {domains.map(d => (
                    <li key={d.id} className="flex items-center justify-between gap-3 p-4">
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium" dir="ltr">{d.domain}</span>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteDomain(d.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
