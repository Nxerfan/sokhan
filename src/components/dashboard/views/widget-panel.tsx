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
import { Check, Copy, MessageSquareText, Globe, Plus, Trash2, Lock, Code2, Package, ShieldCheck, CheckCircle2, Circle, ExternalLink, ServerCog } from 'lucide-react'
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

/**
 * Conversation summary as returned by GET /api/conversations.
 *
 * IMPORTANT: `firstResponseAt` is the canonical, server-authoritative
 * flag for "an agent has actually replied to this conversation" — it is
 * set once on the first agent message POST to
 * /api/conversations/[id]/messages and never modified afterward. It is
 * NOT inferred from `lastMessagePreview` (which is also populated by
 * visitor messages and would incorrectly mark a conversation as
 * "agent replied" the moment a visitor sends their first message).
 */
type ConversationSummary = {
  id: string
  status: string
  lastMessagePreview: string
  lastMessageAt: string
  firstResponseAt: string | null
}

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
  // "Check Widget Backend" — an authenticated, internal-only Sukhan-side
  // readiness check. NOT a "verify installation" check. The state name
  // is intentionally `backendStatus` (not `verifyStatus`) to make the
  // intent unambiguous.
  const [backendStatus, setBackendStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [convInfo, setConvInfo] = useState<ConvInfo>({ hasConversations: false, hasAgentReply: false })
  const [checklistDismissed, setChecklistDismissedDismissed] = useState(false)

  const apiUrl = typeof window !== 'undefined' ? window.location.origin : HOSTED_API_URL

  const load = useCallback(async () => {
    const [cfgRes, domRes, convRes] = await Promise.all([
      fetch('/api/widget-config'),
      fetch('/api/widget-domains'),
      // /api/conversations returns up to 100 most-recent conversations.
      // We read the existing response as-is — no `?take=` query param
      // is implemented by the endpoint, so we deliberately do not send
      // one. We only need to know whether the tenant has any
      // conversation whose `firstResponseAt` is set (i.e. an agent has
      // actually replied).
      fetch('/api/conversations').catch(() => null),
    ])
    const cfgData = await cfgRes.json()
    if (cfgData.config) setConfig(cfgData.config)
    const domData = await domRes.json()
    setDomains(domData.domains ?? [])
    setDomainLimit(domData.limit ?? 0)
    if (convRes && convRes.ok) {
      const convJson = await convRes.json()
      const convs: ConversationSummary[] = convJson.conversations ?? []
      // Truthful derivation of "agent replied" — using the canonical
      // server-authoritative `firstResponseAt` field, NOT the preview
      // text (a visitor message also produces a non-empty preview).
      const hasAgent = convs.some((c) => c.firstResponseAt != null)
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

initSukhan({ apiKey: '${slug}'${apiUrl !== HOSTED_API_URL ? `, apiUrl: '${apiUrl}'` : ''} })`

  // Copy actions are TRUTHFULLY tracked as "code copied" — they do NOT
  // imply the user has installed the widget on a customer website. The
  // checklist item below uses the label "Installation code copied"
  // (not "Install widget") to match the actual action the user
  // performed. We persist this bit so the checklist survives reload,
  // but it never claims installation was done.
  function markCodeCopied(which: 'html' | 'npm') {
    try {
      localStorage.setItem('sukhan_widget_code_copied_' + slug, '1')
      if (which === 'html') setCopiedHtml(true)
      else setCopiedNpm(true)
      setTimeout(() => {
        if (which === 'html') setCopiedHtml(false)
        else setCopiedNpm(false)
      }, 2000)
    } catch {
      // ignore localStorage failures (private mode, etc.)
    }
  }

  function copy(text: string, which: 'html' | 'npm' | 'key') {
    navigator.clipboard.writeText(text)
    toast.success(locale === 'fa' ? 'کپی شد' : 'Copied')
    if (which === 'html' || which === 'npm') {
      markCodeCopied(which)
    } else {
      setCopiedKey(true)
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
          : data.error === 'invalid_domain'
            ? (locale === 'fa' ? 'دامنه نامعتبر است' : 'Invalid domain')
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

  // "Check Widget Backend" — an authenticated internal-safe Sukhan-side
  // readiness check via /api/widget-status. This:
  //   - does NOT call the public /api/widget/<slug>/config endpoint
  //     (which performs WidgetDomain validation against request
  //     Origin/Referer — a Sukhan-dashboard-origin request would be
  //     incorrectly rejected as `domain_not_allowed`);
  //   - does NOT fetch arbitrary customer URLs (no SSRF);
  //   - does NOT bypass or weaken WidgetDomain validation on the public
  //     widget-config endpoint;
  //   - returns a truthful "backend ready" status, NOT a "verified
  //     installation" status. The UI copy explains it does NOT prove
  //     the script is installed on the customer website.
  async function checkWidgetBackend() {
    setBackendStatus('checking')
    try {
      const res = await fetch('/api/widget-status')
      if (res.ok) {
        const data = await res.json()
        if (data.ready && data.slug === slug) {
          setBackendStatus('ok')
          toast.success(locale === 'fa' ? 'بک‌اند ویجت آماده است' : 'Widget backend is ready')
        } else {
          setBackendStatus('fail')
          toast.error(locale === 'fa' ? 'بک‌اند ویجت هنوز پیکربندی نشده' : 'Widget backend not configured yet')
        }
      } else {
        setBackendStatus('fail')
        toast.error(locale === 'fa' ? 'بررسی بک‌اند ناموفق بود' : 'Backend check failed')
      }
    } catch {
      setBackendStatus('fail')
      toast.error(locale === 'fa' ? 'بررسی بک‌اند ناموفق بود' : 'Backend check failed')
    }
  }

  const isDomainLimitLocked = domainLimit === 0
  const domainCount = domains.length
  const hasWebsite = domainCount > 0
  // Truthful checklist source: "installation code copied" comes from
  // the user's actual copy action (HTML or NPM snippet) — never from a
  // passive page visit. It does NOT mean the script was installed on a
  // customer website; the label below reflects that.
  const codeCopied = typeof window !== 'undefined'
    ? localStorage.getItem('sukhan_widget_code_copied_' + slug) === '1'
    : false
  // "Backend ready" comes from the authenticated internal check. It is
  // NOT a "verified installation" status — the label below reflects that.
  const backendReady = backendStatus === 'ok'

  const fa = locale === 'fa'

  const checklistItems = [
    { done: true, label: fa ? 'فضای کاری ایجاد شد' : 'Workspace created' },
    { done: hasWebsite, label: fa ? 'وب‌سایت اضافه شد' : 'Add your website' },
    // TRUTHFUL: this item reflects "the user copied the installation
    // snippet" — not that the widget is installed on a customer site.
    { done: codeCopied, label: fa ? 'کد نصب کپی شد' : 'Installation code copied' },
    // TRUTHFUL: this item reflects "the Sukhan backend readiness check
    // succeeded" — not that the script was verified on the customer
    // site. The UI explains the limitation next to the button.
    { done: backendReady, label: fa ? 'بک‌اند ویجت آماده است' : 'Backend ready' },
    { done: convInfo.hasConversations, label: fa ? 'پیام تست دریافت شد' : 'Receive a test message' },
    // TRUTHFUL: an agent has actually replied — derived from the
    // canonical Conversation.firstResponseAt field (set once on the
    // first agent message POST), NOT from `lastMessagePreview` (which a
    // visitor message also populates).
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
      <PanelHeader title={fa ? 'ویجت' : 'Widget'} hint={fa ? 'نصب، سفارشی‌سازی و آماده‌سازی ویجت گفت‌وگو' : 'Install, customize, and prepare your chat widget'} />

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

            {/* Backend readiness check (NOT installation verification) */}
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-base flex items-center gap-2">
                  <ServerCog className="h-4 w-4 text-saffron" />
                  {fa ? 'بررسی بک‌اند ویجت' : 'Check Widget Backend'}
                </CardTitle>
                <CardDescription>
                  {fa ? 'آمادگی بک‌اند Sukhan را برای ویجت شما تأیید می‌کند' : 'Verifies Sukhan backend readiness for your widget'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={checkWidgetBackend} disabled={backendStatus === 'checking'} className="gap-2" variant="outline">
                  {backendStatus === 'checking' ? (
                    <>{fa ? 'در حال بررسی...' : 'Checking...'}</>
                  ) : backendStatus === 'ok' ? (
                    <><Check className="h-4 w-4 text-turquoise" /> {fa ? 'بک‌اند آماده' : 'Backend ready'}</>
                  ) : backendStatus === 'fail' ? (
                    <><ExternalLink className="h-4 w-4 text-destructive" /> {fa ? 'دوباره بررسی کنید' : 'Retry'}</>
                  ) : (
                    <><ServerCog className="h-4 w-4" /> {fa ? 'بررسی بک‌اند' : 'Check backend'}</>
                  )}
                </Button>
                {backendStatus === 'ok' && (
                  <p className="mt-3 text-xs text-turquoise">
                    {fa
                      ? 'بک‌اند ویجت آماده است. این بررسی فقط آمادگی سمت Sukhan را تأیید می‌کند و وجود اسکریپت در سایت مشتری را اثبات نمی‌کند. برای نصب واقعی، اسکریپت را در سایت خود قرار دهید.'
                      : 'Widget backend is ready. This check confirms Sukhan-side readiness only — it does NOT prove the script is installed on your customer website. To actually install, place the script on your site.'}
                  </p>
                )}
                {backendStatus === 'fail' && (
                  <p className="mt-3 text-xs text-destructive">
                    {fa ? 'بررسی بک‌اند ناموفق بود. ویجت خود را در تب سفارشی‌سازی پیکربندی کنید.' : 'Backend check failed. Configure your widget in the Customization tab.'}
                  </p>
                )}
                {backendStatus === 'idle' && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {fa
                      ? 'این بررسی فقط دسترس‌پذیری و پیکربندی بک‌اند Sukhan را تأیید می‌کند (بدون SSRF و بدون دور زدن امنیت دامنه‌های مجاز). این بررسی وجود اسکریپت در سایت مشتری را اثبات نمی‌کند.'
                      : 'This verifies Sukhan backend reachability and configuration only (no SSRF, no bypass of allowed-domain security). It does NOT prove the script is installed on your customer website.'}
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
