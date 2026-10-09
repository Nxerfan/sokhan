'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, Copy, MessageSquareText, Globe, Plus, Trash2, Lock, Code2, Package, ShieldCheck, CheckCircle2, Circle, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'
import { cn } from '@/lib/utils'

type WidgetConfig = {
  accentColor: string
  launcherShape: string
  position: string
  avatarUrl: string | null
  logoUrl: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
}

type Domain = { id: string; domain: string; createdAt: string }
type ConvInfo = { hasConversations: boolean; hasAgentReply: boolean }

const SHAPES = ['tab', 'rounded', 'pill']
const POSITIONS = ['bottom-start', 'bottom-end']

const HOSTED_API_URL = 'https://app.sukhan.chat'

export function WidgetPanel({ slug, tenantId }: { slug: string; tenantId: string }) {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const locale = useLocale()
  const [config, setConfig] = useState<WidgetConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [copiedHtml, setCopiedHtml] = useState(false)
  const [copiedNpm, setCopiedNpm] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [tab, setTab] = useState<'installation' | 'customization'>('installation')
  const [domains, setDomains] = useState<Domain[]>([])
  const [domainLimit, setDomainLimit] = useState(0)
  const [newDomain, setNewDomain] = useState('')
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [convInfo, setConvInfo] = useState<ConvInfo>({ hasConversations: false, hasAgentReply: false })
  const [checklistDismissed, setChecklistDismissedDismissed] = useState(false)

  const apiUrl = typeof window !== 'undefined' ? window.location.origin : HOSTED_API_URL

  const load = useCallback(async () => {
    const [cfgRes, domRes, convRes] = await Promise.all([
      fetch('/api/widget-config'),
      fetch('/api/widget-domains'),
      fetch('/api/conversations?take=1').catch(() => null),
    ])
    const cfgData = await cfgRes.json()
    if (cfgData.config) setConfig(cfgData.config)
    const domData = await domRes.json()
    setDomains(domData.domains ?? [])
    setDomainLimit(domData.limit ?? 0)
    if (convRes && convRes.ok) {
      const convJson = await convRes.json()
      const convs = convJson.conversations ?? []
      const hasAgent = convs.some((c: any) => c.lastMessagePreview && c.lastMessagePreview.length > 0 && c.status !== 'closed')
      setConvInfo({ hasConversations: convs.length > 0, hasAgentReply: hasAgent })
    }
  }, [])

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function save() {
    if (!config) return
    setSaving(true)
    const res = await fetch('/api/widget-config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
    if (!res.ok) { toast.error('Failed to save'); setSaving(false); return }
    toast.success(t('saved'))
    setSaving(false)
  }

  function update<K extends keyof WidgetConfig>(key: K, value: WidgetConfig[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c))
  }
  function updateGreeting(lo: string, value: string) {
    setConfig((c) => (c ? { ...c, greetingTexts: { ...c.greetingTexts, [lo]: value } } : c))
  }

  const htmlSnippet = `<script async defer src="${apiUrl}/api/widget/${slug}/script"></script>`
  const npmInstall = `bun add sukhan-widget`
  const npmInit = `import { initSukhan } from 'sukhan-widget'

initSukhan({ apiKey: '${slug}' })`

  function copy(text: string, which: 'html' | 'npm' | 'key') {
    navigator.clipboard.writeText(text)
    if (which === 'html') {
      setCopiedHtml(true); toast.success(locale === 'fa' ? 'کپی شد' : 'Copied')
      localStorage.setItem('sukhan_widget_installed_' + slug, '1')
      setTimeout(() => setCopiedHtml(false), 2000)
    } else if (which === 'npm') {
      setCopiedNpm(true); toast.success(locale === 'fa' ? 'کپی شد' : 'Copied')
      setTimeout(() => setCopiedNpm(false), 2000)
    } else {
      setCopiedKey(true); toast.success(locale === 'fa' ? 'کپی شد' : 'Copied')
      setTimeout(() => setCopiedKey(false), 2000)
    }
  }

  async function addDomain(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/widget-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: newDomain }) })
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
    const domRes = await fetch('/api/widget-domains')
    const domData = await domRes.json()
    setDomains(domData.domains ?? [])
    setDomainLimit(domData.limit ?? 0)
  }

  async function deleteDomain(id: string) {
    await fetch(`/api/widget-domains?id=${id}`, { method: 'DELETE' })
    toast.success(locale === 'fa' ? 'حذف شد' : 'Deleted')
    const domRes = await fetch('/api/widget-domains')
    const domData = await domRes.json()
    setDomains(domData.domains ?? [])
    setDomainLimit(domData.limit ?? 0)
  }

  async function verifyWidget() {
    setVerifyStatus('checking')
    try {
      const res = await fetch(`/api/widget/${slug}/config`)
      if (res.ok) {
        const data = await res.json()
        if (data.slug) {
          setVerifyStatus('ok')
          localStorage.setItem('sukhan_widget_verified_' + slug, '1')
          toast.success(locale === 'fa' ? 'بک‌اند ویجت فعال است' : 'Widget backend is live')
        } else {
          setVerifyStatus('fail')
        }
      } else {
        setVerifyStatus('fail')
        toast.error(locale === 'fa' ? 'بک‌اند ویجت در دسترس نیست' : 'Widget backend not reachable')
      }
    } catch {
      setVerifyStatus('fail')
      toast.error(locale === 'fa' ? 'بک‌اند ویجت در دسترس نیست' : 'Widget backend not reachable')
    }
  }

  const isDomainLimitLocked = domainLimit === 0
  const domainCount = domains.length
  const hasWebsite = domainCount > 0
  const isInstalled = typeof window !== 'undefined' && localStorage.getItem('sukhan_widget_installed_' + slug) === '1'
  const isVerified = verifyStatus === 'ok' || (typeof window !== 'undefined' && localStorage.getItem('sukhan_widget_verified_' + slug) === '1')

  const fa = locale === 'fa'

  const checklistItems = [
    { done: true, label: fa ? 'فضای کاری ایجاد شد' : 'Workspace created' },
    { done: hasWebsite, label: fa ? 'وب‌سایت اضافه شد' : 'Add your website' },
    { done: isInstalled, label: fa ? 'ویجت نصب شد' : 'Install widget' },
    { done: isVerified, label: fa ? 'ویجت تایید شد' : 'Verify widget' },
    { done: convInfo.hasConversations, label: fa ? 'پیام تست دریافت شد' : 'Receive a test message' },
    { done: convInfo.hasAgentReply, label: fa ? 'از صندوق ورودی پاسخ دادید' : 'Reply from Inbox' },
  ]

  if (!config) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{tc('loading')}</div>
    )
  }

  const isRtl = config.defaultLocale === 'fa'

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={fa ? 'ویجت' : 'Widget'} hint={fa ? 'نصب، سفارشی‌سازی و تایید ویجت گفت‌وگو' : 'Install, customize, and verify your chat widget'} />

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
        <button
          onClick={() => setTab('installation')}
          className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', tab === 'installation' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {fa ? 'نصب' : 'Installation'}
        </button>
        <button
          onClick={() => setTab('customization')}
          className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', tab === 'customization' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {fa ? 'سفارشی‌سازی' : 'Customization'}
        </button>
      </div>

      {tab === 'installation' && (
        <div className="flex flex-col gap-4">
          {/* Onboarding checklist */}
          {!checklistDismissed && (
            <Card className="border-saffron/30 bg-saffron/5">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="font-display text-sm flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-saffron" />
                    {fa ? 'مراحل راه‌اندازی' : 'Setup Progress'}
                  </CardTitle>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setChecklistDismissedDismissed(true)}>
                    {fa ? 'بستن' : 'Dismiss'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {checklistItems.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {item.done ? (
                        <CheckCircle2 className="h-4 w-4 text-turquoise shrink-0" />
                      ) : (
                        <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className={item.done ? 'text-muted-foreground line-through' : 'text-foreground'}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Widget Key */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-turquoise" />
                  {fa ? 'کلید ویجت' : 'Widget Key'}
                </CardTitle>
                <CardDescription>
                  {fa
                    ? 'شناسه عمومی فضای کاری شما. امن برای استفاده در frontend. به داشبورد دسترسی ندارد.'
                    : 'Your public workspace identifier. Safe for frontend use. Does NOT grant dashboard access.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm font-mono" dir="ltr">{slug}</code>
                  <Button variant="outline" size="icon" onClick={() => copy(slug, 'key')}>
                    {copiedKey ? <Check className="h-4 w-4 text-turquoise" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {fa
                    ? 'این کلید عمومی است و در HTML/JavaScript قابل استفاده است. اعتبارنامه خصوصی در آینده جداگانه ارائه می‌شود.'
                    : 'This key is public and can be used in HTML/JavaScript. Private credentials, if implemented, will be separate.'}
                </p>
              </CardContent>
            </Card>

            {/* HTML Installation */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <Code2 className="h-4 w-4 text-saffron" />
                  {fa ? 'نصب با HTML' : 'HTML Installation'}
                </CardTitle>
                <CardDescription>
                  {fa ? 'این کد را قبل از تگ </body> در سایت خود قرار دهید' : 'Paste this before </body> on your website'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <pre className="max-h-32 overflow-auto rounded-lg border border-border bg-muted/50 p-3 pr-12 text-xs scroll-thin" dir="ltr">
                    <code className="font-mono">{htmlSnippet}</code>
                  </pre>
                  <Button variant="ghost" size="icon" className="absolute end-1 top-1 h-8 w-8" onClick={() => copy(htmlSnippet, 'html')}>
                    {copiedHtml ? <Check className="h-4 w-4 text-turquoise" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {fa ? 'نیازی به پیکربندی realtime URL، مسیر Socket.IO یا شناسه داخلی.' : 'No realtime URL, Socket.IO path, or internal IDs to configure.'}
                </p>
              </CardContent>
            </Card>

            {/* NPM Installation */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <Package className="h-4 w-4 text-turquoise" />
                  {fa ? 'نصب با NPM' : 'NPM Installation'}
                </CardTitle>
                <CardDescription>
                  {fa ? 'برای React/Next.js/Vue و سایر فریم‌ورک‌ها' : 'For React/Next.js/Vue and other frameworks'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{fa ? 'نصب پکیج:' : 'Install package:'}</p>
                  <div className="relative">
                    <pre className="overflow-auto rounded-lg border border-border bg-muted/50 p-3 pr-12 text-xs" dir="ltr">
                      <code className="font-mono">{npmInstall}</code>
                    </pre>
                    <Button variant="ghost" size="icon" className="absolute end-1 top-1 h-8 w-8" onClick={() => copy(npmInstall, 'npm')}>
                      {copiedNpm ? <Check className="h-4 w-4 text-turquoise" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{fa ? 'راه‌اندازی:' : 'Initialize:'}</p>
                  <pre className="overflow-auto rounded-lg border border-border bg-muted/50 p-3 text-xs" dir="ltr">
                    <code className="font-mono">{npmInit}</code>
                  </pre>
                </div>
                <p className="text-xs text-muted-foreground">
                  {fa
                    ? 'برای استقرار شخصی، apiUrl را مشخص کنید. برای نسخه ابری، پیش‌فرض https://app.sukhan.chat استفاده می‌شود.'
                    : 'For self-hosted, specify apiUrl. Hosted default: https://app.sukhan.chat'}
                </p>
              </CardContent>
            </Card>

            {/* Verification */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-saffron" />
                  {fa ? 'تایید نصب' : 'Verify Installation'}
                </CardTitle>
                <CardDescription>
                  {fa ? 'بررسی دسترس‌پذیری بک‌اند ویجت' : 'Check widget backend reachability'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={verifyWidget} disabled={verifyStatus === 'checking'} className="gap-2" variant="outline">
                  {verifyStatus === 'checking' ? (
                    <>{fa ? 'در حال بررسی...' : 'Checking...'}</>
                  ) : verifyStatus === 'ok' ? (
                    <><Check className="h-4 w-4 text-turquoise" /> {fa ? 'تایید شد' : 'Verified'}</>
                  ) : verifyStatus === 'fail' ? (
                    <><ExternalLink className="h-4 w-4 text-destructive" /> {fa ? 'دوباره بررسی کنید' : 'Retry'}</>
                  ) : (
                    <><ShieldCheck className="h-4 w-4" /> {fa ? 'بررسی نصب' : 'Check installation'}</>
                  )}
                </Button>
                {verifyStatus === 'ok' && (
                  <p className="mt-3 text-xs text-turquoise">
                    {fa ? 'بک‌اند ویجت فعال است. برای تایید کامل، اسکریپت را در سایت خود قرار دهید.' : 'Widget backend is live. To fully verify, ensure the script tag is on your website.'}
                  </p>
                )}
                {verifyStatus === 'fail' && (
                  <p className="mt-3 text-xs text-destructive">
                    {fa ? 'بک‌اند ویجت در دسترس نیست. کلید ویجت و دامنه‌های مجاز را بررسی کنید.' : 'Widget backend not reachable. Check your Widget Key and allowed domains.'}
                  </p>
                )}
                {verifyStatus === 'idle' && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {fa
                      ? 'این بررسی دسترس‌پذیری بک‌اند Sukhan را تایید می‌کند (بدون ریسک SSRF). برای تایید نصب کامل، اسکریپت را در سایت خود قرار دهید.'
                      : 'This verifies Sukhan backend reachability (no SSRF risk). To fully verify installation, place the script on your website.'}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Website/Domain Management */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <Globe className="h-4 w-4 text-saffron" />
                  {fa ? 'دامنه‌های مجاز' : 'Authorized Domains'}
                </CardTitle>
                {!isDomainLimitLocked && (
                  <Badge variant="outline">{domainCount} / {domainLimit === -1 ? '\u221E' : domainLimit}</Badge>
                )}
              </div>
              <CardDescription>
                {fa
                  ? 'دامنه‌هایی که ویجت در آن‌ها نمایش داده می‌شود. محدودیت: ' + (domainLimit === -1 ? 'نامحدود' : domainLimit) + ' دامنه'
                  : 'Domains where the widget is authorized. Limit: ' + (domainLimit === -1 ? 'unlimited' : domainLimit) + ' domain(s)'}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {isDomainLimitLocked ? (
                <div className="flex flex-col items-center gap-2 p-8 text-center">
                  <Lock className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {fa ? 'برای مدیریت دامنه‌ها به پلن Pro ارتقا دهید' : 'Upgrade to Pro to manage domains'}
                  </p>
                </div>
              ) : (
                <>
                  <form onSubmit={addDomain} className="flex gap-2 border-b border-border p-4">
                    <Input value={newDomain} onChange={e => setNewDomain(e.target.value)} placeholder="example.com" required dir="ltr" />
                    <Button type="submit" className="gap-2" disabled={domainLimit !== -1 && domainCount >= domainLimit}>
                      <Plus className="h-4 w-4" />
                      {fa ? 'افزودن' : 'Add'}
                    </Button>
                  </form>
                  {domainCount === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                      <Globe className="h-8 w-8 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">{fa ? 'هنوز دامنه‌ای ثبت نشده است' : 'No domains yet'}</p>
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
      )}

      {tab === 'customization' && (
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
                    <input type="color" value={config.accentColor} onChange={(e) => update('accentColor', e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent" />
                    <Input value={config.accentColor} onChange={(e) => update('accentColor', e.target.value)} dir="ltr" className="font-mono" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>{t('launcherShape')}</Label>
                    <Select value={config.launcherShape} onValueChange={(v) => update('launcherShape', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{SHAPES.map((s) => (<SelectItem key={s} value={s}>{t(`shapes.${s}` as any)}</SelectItem>))}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('position')}</Label>
                    <Select value={config.position} onValueChange={(v) => update('position', v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{POSITIONS.map((p) => (<SelectItem key={p} value={p}>{t(`positions.${p}` as any)}</SelectItem>))}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>{t('avatarUrl')}</Label>
                    <Input value={config.avatarUrl ?? ''} onChange={(e) => update('avatarUrl', e.target.value || null)} dir="ltr" placeholder="https://\u2026" />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('logoUrl')}</Label>
                    <Input value={config.logoUrl ?? ''} onChange={(e) => update('logoUrl', e.target.value || null)} dir="ltr" placeholder="https://\u2026" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>{t('greetingFa')}</Label>
                    <Input value={config.greetingTexts.fa ?? ''} onChange={(e) => updateGreeting('fa', e.target.value)} dir="rtl" />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('greetingEn')}</Label>
                    <Input value={config.greetingTexts.en ?? ''} onChange={(e) => updateGreeting('en', e.target.value)} dir="ltr" />
                  </div>
                </div>
                <Button onClick={save} disabled={saving} className="w-full gap-2">
                  {saving ? tc('loading') : tc('save')}
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="font-display text-base">{fa ? 'پیش‌نمایش' : 'Preview'}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative h-80 rounded-xl border border-border bg-gradient-to-br from-muted/40 to-background" dir={isRtl ? 'rtl' : 'ltr'}>
                <div className="absolute inset-0 p-4 opacity-40">
                  <div className="h-3 w-1/2 rounded bg-muted" />
                  <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
                  <div className="mt-4 h-20 w-full rounded bg-muted/60" />
                </div>
                <button type="button" className={cn('absolute', config.position === 'bottom-start' ? 'start-4' : 'end-4', 'bottom-4 flex items-center justify-center bg-ink text-ink-foreground shadow-lg transition-transform hover:scale-105', config.launcherShape === 'tab' ? 'h-12 w-16 rounded-lg rounded-be-none' : config.launcherShape === 'pill' ? 'h-12 w-16 rounded-full' : 'h-12 w-12 rounded-xl')} style={{ borderInlineStart: config.launcherShape === 'tab' ? `3px solid ${config.accentColor}` : undefined }} aria-label="Open chat">
                  <MessageSquareText className="h-5 w-5" />
                </button>
                <div className={cn('absolute', config.position === 'bottom-start' ? 'start-4' : 'end-4', 'bottom-20 w-56 rounded-xl border border-border bg-card shadow-xl')}>
                  <div className="flex items-center gap-2 border-b border-border p-3" style={{ backgroundColor: config.accentColor + '22' }}>
                    <div className="flex h-7 w-7 items-center justify-center rounded-full" style={{ backgroundColor: config.accentColor }}>
                      <MessageSquareText className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-xs font-medium">{tc('appName')}</span>
                  </div>
                  <div className="space-y-2 p-3">
                    <div className="max-w-[80%] rounded-lg rounded-bs-sm bg-muted p-2 text-xs">
                      {config.greetingTexts[config.defaultLocale] || '\uD83D\uDC4B'}
                    </div>
                    <div className="ms-auto max-w-[60%] rounded-lg rounded-be-sm p-2 text-xs text-white" style={{ backgroundColor: config.accentColor }}>=</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
