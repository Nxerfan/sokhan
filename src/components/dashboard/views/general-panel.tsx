'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'

type TenantInfo = {
  id: string
  name: string
  slug: string
  defaultLocale: string
  defaultDirection: string
}

export function GeneralPanel() {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const [tenant, setTenant] = useState<TenantInfo | null>(null)
  const [saving, setSaving] = useState(false)

  async function load() {
    const res = await fetch('/api/tenants/me')
    const data = await res.json()
    if (data.tenant) setTenant(data.tenant)
  }

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function save() {
    if (!tenant) return
    setSaving(true)
    const res = await fetch('/api/tenants/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tenant.name,
        defaultLocale: tenant.defaultLocale,
        defaultDirection: tenant.defaultDirection,
      }),
    })
    if (!res.ok) {
      toast.error('Failed to save')
      setSaving(false)
      return
    }
    toast.success(t('saved'))
    setSaving(false)
  }

  if (!tenant) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {tc('loading')}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('generalTitle')} hint={t('generalHint')} />

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="font-display text-base">{t('generalTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">{t('workspaceName')}</Label>
            <Input
              id="ws-name"
              value={tenant.name}
              onChange={(e) => setTenant({ ...tenant, name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('defaultLocale')}</Label>
            <Select
              value={tenant.defaultLocale}
              onValueChange={(v) => setTenant({ ...tenant, defaultLocale: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fa">فارسی (RTL)</SelectItem>
                <SelectItem value="en">English (LTR)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t('defaultDirection')}</Label>
            <Select
              value={tenant.defaultDirection}
              onValueChange={(v) => setTenant({ ...tenant, defaultDirection: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rtl">RTL</SelectItem>
                <SelectItem value="ltr">LTR</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Workspace URL</Label>
            <Input value={tenant.slug} disabled dir="ltr" className="font-mono" />
          </div>

          <Button onClick={save} disabled={saving} className="gap-2">
            {saving ? tc('loading') : t('save')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
