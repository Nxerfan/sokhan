'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, Copy, MessageSquareText } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'

type WidgetConfig = {
  accentColor: string
  launcherShape: string
  position: string
  avatarUrl: string | null
  logoUrl: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
}

const SHAPES = ['tab', 'rounded', 'pill']
const POSITIONS = ['bottom-start', 'bottom-end']

export function WidgetPanel({ slug }: { slug: string }) {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const { data: session } = useSession()
  const [config, setConfig] = useState<WidgetConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  async function load() {
    const res = await fetch('/api/widget-config')
    const data = await res.json()
    if (data.config) setConfig(data.config)
  }

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function save() {
    if (!config) return
    setSaving(true)
    const res = await fetch('/api/widget-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      toast.error('Failed to save')
      setSaving(false)
      return
    }
    toast.success(t('saved'))
    setSaving(false)
  }

  function update<K extends keyof WidgetConfig>(key: K, value: WidgetConfig[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c))
  }

  function updateGreeting(locale: string, value: string) {
    setConfig((c) =>
      c ? { ...c, greetingTexts: { ...c.greetingTexts, [locale]: value } } : c,
    )
  }

  const embedSnippet = `<script async defer src="${typeof window !== 'undefined' ? window.location.origin : 'https://your-domain'}/api/widget/${slug}/script"></script>`

  function copySnippet() {
    navigator.clipboard.writeText(embedSnippet)
    setCopied(true)
    toast.success(t('copied'))
    setTimeout(() => setCopied(false), 2000)
  }

  void session

  if (!config) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {tc('loading')}
      </div>
    )
  }

  const isRtl = config.defaultLocale === 'fa'

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('widgetTitle')} hint={t('widgetHint')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base">{t('widgetTitle')}</CardTitle>
              <CardDescription>{t('widgetHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t('accentColor')}</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={config.accentColor}
                    onChange={(e) => update('accentColor', e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
                  />
                  <Input
                    value={config.accentColor}
                    onChange={(e) => update('accentColor', e.target.value)}
                    dir="ltr"
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('launcherShape')}</Label>
                  <Select value={config.launcherShape} onValueChange={(v) => update('launcherShape', v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SHAPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(`shapes.${s}` as any)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('position')}</Label>
                  <Select value={config.position} onValueChange={(v) => update('position', v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POSITIONS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {t(`positions.${p}` as any)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('avatarUrl')}</Label>
                  <Input
                    value={config.avatarUrl ?? ''}
                    onChange={(e) => update('avatarUrl', e.target.value || null)}
                    dir="ltr"
                    placeholder="https://…"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('logoUrl')}</Label>
                  <Input
                    value={config.logoUrl ?? ''}
                    onChange={(e) => update('logoUrl', e.target.value || null)}
                    dir="ltr"
                    placeholder="https://…"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('greetingFa')}</Label>
                  <Input
                    value={config.greetingTexts.fa ?? ''}
                    onChange={(e) => updateGreeting('fa', e.target.value)}
                    dir="rtl"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('greetingEn')}</Label>
                  <Input
                    value={config.greetingTexts.en ?? ''}
                    onChange={(e) => updateGreeting('en', e.target.value)}
                    dir="ltr"
                  />
                </div>
              </div>

              <Button onClick={save} disabled={saving} className="w-full gap-2">
                {saving ? tc('loading') : tc('save')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base">{t('embedSnippet')}</CardTitle>
              <CardDescription>{t('embedHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <pre className="max-h-32 overflow-auto rounded-lg border border-border bg-muted/50 p-3 pr-12 text-xs scroll-thin" dir="ltr">
                  <code className="font-mono">{embedSnippet}</code>
                </pre>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute end-1 top-1 h-8 w-8"
                  onClick={copySnippet}
                >
                  {copied ? <Check className="h-4 w-4 text-turquoise" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Live preview — mirrors RTL automatically from defaultLocale */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="font-display text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="relative h-80 rounded-xl border border-border bg-gradient-to-br from-muted/40 to-background"
              dir={isRtl ? 'rtl' : 'ltr'}
            >
              {/* mock host site */}
              <div className="absolute inset-0 p-4 opacity-40">
                <div className="h-3 w-1/2 rounded bg-muted" />
                <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
                <div className="mt-4 h-20 w-full rounded bg-muted/60" />
              </div>

              {/* launcher */}
              <button
                type="button"
                className={`absolute ${config.position === 'bottom-start' ? 'start-4' : 'end-4'} bottom-4 flex items-center justify-center bg-ink text-ink-foreground shadow-lg transition-transform hover:scale-105 ${
                  config.launcherShape === 'tab'
                    ? 'h-12 w-16 rounded-lg rounded-be-none'
                    : config.launcherShape === 'pill'
                      ? 'h-12 w-16 rounded-full'
                      : 'h-12 w-12 rounded-xl'
                }`}
                style={{ borderInlineStart: config.launcherShape === 'tab' ? `3px solid ${config.accentColor}` : undefined }}
                aria-label="Open chat"
              >
                <MessageSquareText className="h-5 w-5" />
              </button>

              {/* mini panel preview */}
              <div
                className={`absolute ${config.position === 'bottom-start' ? 'start-4' : 'end-4'} bottom-20 w-56 rounded-xl border border-border bg-card shadow-xl`}
              >
                <div className="flex items-center gap-2 border-b border-border p-3" style={{ backgroundColor: config.accentColor + '22' }}>
                  <div className="flex h-7 w-7 items-center justify-center rounded-full" style={{ backgroundColor: config.accentColor }}>
                    <MessageSquareText className="h-4 w-4 text-white" />
                  </div>
                  <span className="text-xs font-medium">{tc('appName')}</span>
                </div>
                <div className="space-y-2 p-3">
                  <div className="max-w-[80%] rounded-lg rounded-bs-sm bg-muted p-2 text-xs">
                    {config.greetingTexts[config.defaultLocale] || '👋'}
                  </div>
                  <div className="ms-auto max-w-[60%] rounded-lg rounded-be-sm p-2 text-xs text-white" style={{ backgroundColor: config.accentColor }}>
                    …
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
