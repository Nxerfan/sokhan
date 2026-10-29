'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  Eye,
  EyeOff,
  ServerCog,
  Info,
  Circle,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * Dashboard → Widget → Access & Identity tab.
 *
 * Configures the visitor access policy (anonymous / verified_visitor /
 * site_user_only) for the tenant via the EXISTING APIs:
 *   GET    /api/widget-config/access
 *   PATCH  /api/widget-config/access
 *   GET    /api/widget-config/integration-secret
 *   POST   /api/widget-config/integration-secret   (generate/rotate)
 *   DELETE /api/widget-config/integration-secret   (revoke)
 *
 * CRITICAL INDEPENDENCE CONTRACT:
 *   Visitor Access & Identity is a SECURITY policy, INDEPENDENT of the
 *   customization plan-lock. The dashboard NEVER disables access controls
 *   merely because customization is locked, NEVER derives accessMode from
 *   plan, NEVER forces anonymous on Free. The public backend intentionally
 *   treats visual plan-lock + identity policy as independent concerns.
 *
 * SECURITY CONTRACT:
 *   - The raw integration secret is returned EXACTLY ONCE on POST
 *     (generate/rotate). It is stored ONLY in React/component memory for
 *     the one-time reveal, NEVER in localStorage/sessionStorage/IndexedDB/
 *     cookies/URL. After reload, only "Secret configured" is shown.
 *   - The integration readiness check does NOT fetch arbitrary customer
 *     URLs (no SSRF) + does NOT send the secret anywhere — it only re-reads
 *     the trusted Sukhan-side access state.
 */

type AccessMode = 'anonymous' | 'verified_visitor' | 'site_user_only'

interface AccessConfig {
  accessMode: AccessMode
  policyVersion: number
  integrationSecret: { hasSecret: boolean; rotatedAt: string | null }
  loginUrl: string | null
  loginButtonLabel: string | null
  loginReturnUrlParam: string | null
  identityEndpointPath: string | null
}

interface Draft {
  accessMode: AccessMode
  loginUrl: string
  loginButtonLabel: string
  loginReturnUrlParam: string
  identityEndpointPath: string
}

/**
 * The PATCH /api/widget-config/access response. This is NOT a full AccessConfig
 * — the PATCH returns ONLY {accessMode, policyVersion, accessModeChanged}.
 * Casting it to AccessConfig would DROP integrationSecret / loginUrl /
 * loginButtonLabel / loginReturnUrlParam / identityEndpointPath, corrupting
 * the local state (the site-user UI could crash or render stale/missing
 * fields after Save). After a successful PATCH we MUST re-fetch
 * GET /api/widget-config/access for the authoritative full AccessConfig.
 */
interface AccessPatchResponse {
  accessMode: AccessMode
  policyVersion: number
  accessModeChanged: boolean
}

/** Build a draft from the loaded access config (empty-string for null fields). */
function toDraft(c: AccessConfig): Draft {
  return {
    accessMode: c.accessMode,
    loginUrl: c.loginUrl ?? '',
    loginButtonLabel: c.loginButtonLabel ?? '',
    loginReturnUrlParam: c.loginReturnUrlParam ?? '',
    identityEndpointPath: c.identityEndpointPath ?? '',
  }
}

/** PATCH body: an empty optional field is sent as `null` (NOT empty string). */
function toPatchBody(d: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { accessMode: d.accessMode }
  body.loginUrl = d.loginUrl.trim() === '' ? null : d.loginUrl
  body.loginButtonLabel = d.loginButtonLabel.trim() === '' ? null : d.loginButtonLabel
  body.loginReturnUrlParam = d.loginReturnUrlParam.trim() === '' ? null : d.loginReturnUrlParam
  body.identityEndpointPath = d.identityEndpointPath.trim() === '' ? null : d.identityEndpointPath
  return body
}

const ERROR_MESSAGES: Record<string, { fa: string; en: string }> = {
  invalid_access_mode: { fa: 'حالت دسترسی نامعتبر است', en: 'Invalid access mode' },
  invalid_login_url: { fa: 'آدرس ورود نامعتبر است', en: 'Invalid login URL' },
  invalid_login_button_label: { fa: 'برچسب دکمه ورود نامعتبر است', en: 'Invalid login button label' },
  invalid_login_return_url_param: { fa: 'پارامتر بازگشت نامعتبر است', en: 'Invalid return-URL parameter' },
  invalid_identity_endpoint_path: { fa: 'مسیر endpoint هویت نامعتبر است', en: 'Invalid identity endpoint path' },
  unknown_field: { fa: 'فیلد ناشناخته', en: 'Unknown field' },
  policy_unavailable: { fa: 'سیاست دسترسی هم‌اکنون در دسترس نیست', en: 'Access policy unavailable' },
  forbidden: { fa: 'شما اجازه تغییر تنظیمات دسترسی و هویت را ندارید', en: 'You do not have permission to change Access & Identity settings' },
  unauthorized: { fa: 'ابتدا وارد شوید', en: 'Sign in first' },
}

function errMsg(code: string, fa: boolean): string {
  const e = ERROR_MESSAGES[code]
  if (e) return fa ? e.fa : e.en
  return fa ? 'ذخیره ناموفق بود' : 'Save failed'
}

export function WidgetAccessIdentity({ slug }: { slug: string; tenantId: string }) {
  const locale = useLocale()
  const fa = locale === 'fa'

  const [config, setConfig] = useState<AccessConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showModeChangeConfirm, setShowModeChangeConfirm] = useState(false)
  const [pendingSave, setPendingSave] = useState<Draft | null>(null)

  // Integration secret — raw secret is MEMORY-ONLY (one-time reveal).
  const [rawSecret, setRawSecret] = useState<string | null>(null)
  const [secretBusy, setSecretBusy] = useState(false)
  const [copiedSecret, setCopiedSecret] = useState(false)
  const [showRotateConfirm, setShowRotateConfirm] = useState(false)
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false)

  // Integration readiness check (NO SSRF — re-reads Sukhan-side state only).
  const [checkStatus, setCheckStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')

  const apiUrl = typeof window !== 'undefined' ? window.location.origin : 'https://app.sukhan.chat'

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/widget-config/access')
      if (res.status === 503) {
        const body = await res.json().catch(() => ({}))
        setLoadError(body.error === 'policy_unavailable' ? 'policy_unavailable' : 'policy_unavailable')
        setConfig(null)
        setDraft(null)
        return
      }
      if (res.status === 401) { setLoadError('unauthorized'); setConfig(null); setDraft(null); return }
      if (res.status === 403) { setLoadError('forbidden'); setConfig(null); setDraft(null); return }
      if (!res.ok) { setLoadError('policy_unavailable'); setConfig(null); setDraft(null); return }
      const data = (await res.json()) as AccessConfig
      setConfig(data)
      setDraft(toDraft(data))
    } catch {
      setLoadError('policy_unavailable')
      setConfig(null)
      setDraft(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const draftChanged = draft && config ? (
    draft.accessMode !== config.accessMode ||
    (draft.loginUrl || '') !== (config.loginUrl || '') ||
    (draft.loginButtonLabel || '') !== (config.loginButtonLabel || '') ||
    (draft.loginReturnUrlParam || '') !== (config.loginReturnUrlParam || '') ||
    (draft.identityEndpointPath || '') !== (config.identityEndpointPath || '')
  ) : false

  const performSave = useCallback(async (d: Draft) => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/widget-config/access', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPatchBody(d)),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const code = (body && typeof body.error === 'string') ? body.error : 'unknown'
        setSaveError(errMsg(code, fa))
        toast.error(errMsg(code, fa))
        return
      }
      // The PATCH response is ONLY {accessMode, policyVersion, accessModeChanged}
      // — NOT a full AccessConfig. Consume + discard it (do NOT cast to
      // AccessConfig — that would drop integrationSecret / loginUrl / etc. and
      // corrupt the local state). Then re-fetch GET /api/widget-config/access
      // for the AUTHORITATIVE full config (the source of truth for policyVersion,
      // integrationSecret status, login fields, identity endpoint).
      await res.json()
      const reloadRes = await fetch('/api/widget-config/access')
      if (!reloadRes.ok) {
        // PATCH succeeded but the authoritative GET failed — surface a safe
        // error + reload the component state on next mount. Do NOT synthesize.
        setSaveError(errMsg('policy_unavailable', fa))
        toast.error(errMsg('policy_unavailable', fa))
        return
      }
      const data = (await reloadRes.json()) as AccessConfig
      setConfig(data)
      setDraft(toDraft(data))
      toast.success(fa ? 'تنظیمات دسترسی ذخیره شد' : 'Access settings saved')
    } catch {
      setSaveError(fa ? 'ذخیره ناموفق بود' : 'Save failed')
      toast.error(fa ? 'ذخیره ناموفق بود' : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [fa])

  const onSaveClick = useCallback(() => {
    if (!draft) return
    if (draft.accessMode !== config?.accessMode) {
      // Mode change → require explicit confirmation (immediate effect + invalidation).
      setPendingSave(draft)
      setShowModeChangeConfirm(true)
      return
    }
    performSave(draft)
  }, [draft, config, performSave])

  const onConfirmModeChange = useCallback(() => {
    setShowModeChangeConfirm(false)
    if (pendingSave) performSave(pendingSave)
    setPendingSave(null)
  }, [pendingSave, performSave])

  // ── Integration secret ──────────────────────────────────────────────
  const generateSecret = useCallback(async () => {
    setSecretBusy(true)
    try {
      const res = await fetch('/api/widget-config/integration-secret', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error(errMsg((body && body.error) || 'unknown', fa))
        return
      }
      const data = (await res.json()) as { rawSecret?: string; hasSecret: boolean; rotatedAt: string | null }
      if (data.rawSecret) {
        setRawSecret(data.rawSecret) // MEMORY-ONLY one-time reveal
      }
      // Reload access to reflect the new policyVersion + secret status.
      await load()
      toast.success(fa ? 'راز اتصال تولید شد' : 'Integration secret generated')
    } catch {
      toast.error(fa ? 'تولید ناموفق بود' : 'Generation failed')
    } finally {
      setSecretBusy(false)
    }
  }, [fa, load])

  const revokeSecret = useCallback(async () => {
    setShowRevokeConfirm(false)
    setSecretBusy(true)
    setRawSecret(null)
    try {
      const res = await fetch('/api/widget-config/integration-secret', { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error(errMsg((body && body.error) || 'unknown', fa))
        return
      }
      await load()
      toast.success(fa ? 'راز اتصال لغو شد' : 'Integration secret revoked')
    } catch {
      toast.error(fa ? 'لغو ناموفق بود' : 'Revoke failed')
    } finally {
      setSecretBusy(false)
    }
  }, [fa, load])

  const runReadinessCheck = useCallback(async () => {
    setCheckStatus('checking')
    try {
      // TRUTHFUL check: re-read the trusted Sukhan-side access state. NO
      // customer-URL fetch (no SSRF), NO secret sent anywhere.
      const res = await fetch('/api/widget-config/access')
      if (!res.ok) { setCheckStatus('fail'); return }
      const data = (await res.json()) as AccessConfig
      if (data.accessMode === 'site_user_only' && data.integrationSecret.hasSecret && data.identityEndpointPath) {
        setCheckStatus('ok')
      } else {
        setCheckStatus('fail')
      }
    } catch {
      setCheckStatus('fail')
    }
  }, [])

  const copySecret = useCallback(async () => {
    if (!rawSecret) return
    try {
      await navigator.clipboard.writeText(rawSecret)
      setCopiedSecret(true)
      setTimeout(() => setCopiedSecret(false), 2000)
    } catch {
      toast.error(fa ? 'کپی ناموفق بود' : 'Copy failed')
    }
  }, [rawSecret, fa])

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col gap-4" data-testid="access-identity-loading">
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">{fa ? 'در حال بارگذاری تنظیمات دسترسی…' : 'Loading access settings…'}</span>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4" data-testid="access-identity-error">
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <CardTitle className="text-sm">{fa ? 'خطای بارگذاری سیاست دسترسی' : 'Access policy load error'}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{errMsg(loadError, fa)}</p>
            <Button variant="outline" size="sm" className="w-fit" onClick={load} data-testid="access-retry">
              {fa ? 'تلاش مجدد' : 'Retry'}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!config || !draft) return <div />

  const modeChanged = draft.accessMode !== config.accessMode
  const showSiteUserSection = draft.accessMode === 'site_user_only' || config.accessMode === 'site_user_only'

  return (
    <div className="flex flex-col gap-4">
      {/* policyVersion read-only status */}
      <Card data-testid="access-policy-version">
        <CardContent className="flex items-center justify-between p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            <span>{fa ? `نسخه سیاست ${config.policyVersion}` : `Policy version ${config.policyVersion}`}</span>
          </div>
          <Badge variant="secondary" className="text-xs">{config.accessMode}</Badge>
        </CardContent>
      </Card>

      {/* Mode cards */}
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={fa ? 'حالت دسترسی' : 'Access mode'}>
        {/* Verified visitor (recommended) */}
        <button
          type="button"
          role="radio"
          aria-checked={draft.accessMode === 'verified_visitor'}
          data-testid="access-mode-verified"
          onClick={() => setDraft({ ...draft, accessMode: 'verified_visitor' })}
          className={cn(
            'flex flex-col gap-2 rounded-lg border p-4 text-start transition-colors',
            draft.accessMode === 'verified_visitor' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/40',
          )}
        >
          <div className="flex items-center justify-between">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <Badge className="text-[10px]" data-testid="access-verified-recommended">{fa ? 'پیشنهادی' : 'Recommended'}</Badge>
          </div>
          <div className="font-display text-sm font-medium">{fa ? 'بازدیدکننده تأییدشده' : 'Verified visitor'}</div>
          <div className="text-xs text-muted-foreground">
            {fa ? 'تأیید هویت با ایمیل OTP؛ بازدیدکننده یک Contact می‌ماند (نه کاربر داشبورد)؛ بازگشت امن با اعتبارنامه resume.' : 'Email OTP verification; visitor stays a Contact (not a dashboard User); secure resume with a resume credential.'}
          </div>
        </button>

        {/* Site user only */}
        <button
          type="button"
          role="radio"
          aria-checked={draft.accessMode === 'site_user_only'}
          data-testid="access-mode-site-user"
          onClick={() => setDraft({ ...draft, accessMode: 'site_user_only' })}
          className={cn(
            'flex flex-col gap-2 rounded-lg border p-4 text-start transition-colors',
            draft.accessMode === 'site_user_only' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/40',
          )}
        >
          <div className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" />
          </div>
          <div className="font-display text-sm font-medium">{fa ? 'فقط کاربران واردشده سایت' : 'Signed-in website users only'}</div>
          <div className="text-xs text-muted-foreground">
            {fa ? 'سایت میزبان کاربر خود را احراز هویت می‌کند؛ بک‌اند مشتری توکن هویت کوتاه‌مدت سُخان را می‌سازد؛ مرورگر هرگز externalUserId مورد اعتماد مستقیم نمی‌فرستد.' : 'Host website authenticates its own user; customer backend mints a short-lived Sukhan identity token; browser never sends a trusted externalUserId directly.'}
          </div>
        </button>

        {/* Anonymous (warning) */}
        <button
          type="button"
          role="radio"
          aria-checked={draft.accessMode === 'anonymous'}
          data-testid="access-mode-anonymous"
          onClick={() => setDraft({ ...draft, accessMode: 'anonymous' })}
          className={cn(
            'flex flex-col gap-2 rounded-lg border p-4 text-start transition-colors',
            draft.accessMode === 'anonymous' ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500 dark:bg-amber-950/30' : 'border-border hover:border-amber-500/40',
          )}
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
          </div>
          <div className="font-display text-sm font-medium">{fa ? 'ناشناس' : 'Anonymous'}</div>
          <div className="text-xs text-muted-foreground">
            {fa ? 'بدون تأیید ایمیل یا اثبات ورود به سایت؛ weakest identity assurance.' : 'No email verification or website-login proof; the weakest identity assurance.'}
          </div>
        </button>
      </div>

      {/* Anonymous warning */}
      {draft.accessMode === 'anonymous' && (
        <Card className="border-amber-500/40 bg-amber-50 dark:bg-amber-950/20" data-testid="anonymous-warning">
          <CardContent className="flex items-start gap-2 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800 dark:text-amber-200">
              {fa
                ? 'حالت ناشناس کمترین اطمینان هویت را ارائه می‌دهد. هر کسی که به ویجت دسترسی داشته باشد می‌تواند بدون تأیید ایمیل یا ورود به سایت گفت‌وگو را آغاز کند. این حالت برای مواردی که هویت عمداً لازم نیست حفظ شده است.'
                : 'Anonymous mode provides the lowest identity assurance. Anyone who can access the widget may start a conversation without email verification or website login. It is retained for use cases where identity is intentionally unnecessary.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Mode-change warning + Save */}
      {modeChanged && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-2 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs text-muted-foreground">
              {fa
                ? 'تغییر حالت دسترسی بلافاصله اعمال می‌شود. بازدیدکنندگانی که اعتبارنامه آن‌ها دیگر سیاست جدید را برآورده نمی‌کند باید دوباره تأیید شوند یا وارد سایت شوند.'
                : 'Changing access mode takes effect immediately. Visitors using credentials that no longer satisfy the new policy will need to verify or sign in again.'}
            </p>
          </CardContent>
        </Card>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={onSaveClick} disabled={saving || !draftChanged} data-testid="access-save">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {fa ? 'ذخیره تنظیمات دسترسی' : 'Save access settings'}
        </Button>
        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>

      {/* Verified-visitor explanation */}
      {draft.accessMode === 'verified_visitor' && (
        <Card>
          <CardHeader><CardTitle className="text-sm">{fa ? 'جریان بازدیدکننده تأییدشده' : 'Verified visitor flow'}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>1. {fa ? 'بازدیدکننده نام/ایمیل را وارد می‌کند' : 'Visitor enters name/email'}</span>
            <span>2. {fa ? 'تأیید هویت با ایمیل OTP' : 'Email OTP verifies identity'}</span>
            <span>3. {fa ? 'سُخان یک اعتبارنامه resume نامشخص صادر می‌کند' : 'Sukhan issues an opaque resume credential'}</span>
            <span>4. {fa ? 'بازدیدکننده بازگشتی به‌صورت امن resume می‌شود' : 'Returning visitor resumes securely'}</span>
          </CardContent>
        </Card>
      )}

      {/* Site-user configuration section */}
      {showSiteUserSection && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{fa ? 'پیکربندی کاربر سایت' : 'Site user configuration'}</CardTitle>
            <CardDescription className="text-xs">
              {fa ? 'این endpoint روی وب‌سایت مشتری قرار دارد؛ مرورگر همان-مبدأ آن را صدا می‌زند.' : 'This endpoint lives on the CUSTOMER website; the browser calls it same-origin.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-identity-endpoint" className="text-xs">{fa ? 'مسیر endpoint هویت مشتری' : 'Customer identity endpoint path'}</Label>
              <Input id="site-identity-endpoint" dir="ltr" placeholder="/api/sukhan-identity" value={draft.identityEndpointPath} onChange={(e) => setDraft({ ...draft, identityEndpointPath: e.target.value })} data-testid="site-identity-endpoint" />
              <p className="text-[11px] text-muted-foreground">{fa ? 'هیچ‌گاه راز اتصال سُخان را در اینجا قرار ندهید.' : 'Never place the Sukhan integration secret here.'}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-login-url" className="text-xs">{fa ? 'آدرس ورود' : 'Login URL'}</Label>
              <Input id="site-login-url" dir="ltr" placeholder="/login" value={draft.loginUrl} onChange={(e) => setDraft({ ...draft, loginUrl: e.target.value })} data-testid="site-login-url" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-login-label" className="text-xs">{fa ? 'برچسب دکمه ورود' : 'Login button label'}</Label>
              <Input id="site-login-label" placeholder={fa ? 'ورود' : 'Sign in'} value={draft.loginButtonLabel} onChange={(e) => setDraft({ ...draft, loginButtonLabel: e.target.value })} data-testid="site-login-label" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="site-return-param" className="text-xs">{fa ? 'پارامتر بازگشت URL' : 'Return URL parameter'}</Label>
              <Input id="site-return-param" dir="ltr" placeholder="returnUrl" value={draft.loginReturnUrlParam} onChange={(e) => setDraft({ ...draft, loginReturnUrlParam: e.target.value })} data-testid="site-return-param" />
              <p className="text-[11px] text-muted-foreground">{fa ? 'ویجت URL صفحه فعلی را با URL API اضافه می‌کند.' : 'The widget appends the current page URL via the URL API.'}</p>
            </div>

            {/* Setup status */}
            <Separator />
            <div className="flex flex-col gap-1.5 text-xs" data-testid="site-setup-status">
              <div className="flex items-center gap-2">
                {config.accessMode === 'site_user_only' ? <Check className="h-3 w-3 text-green-600" /> : <Circle className="h-3 w-3 text-muted-foreground" />}
                <span>{fa ? `حالت: ${config.accessMode === 'site_user_only' ? 'فقط کاربر سایت' : 'انتخاب‌نشده'}` : `Mode: ${config.accessMode === 'site_user_only' ? 'Site user only' : 'not selected'}`}</span>
              </div>
              <div className="flex items-center gap-2">
                {config.integrationSecret.hasSecret ? <Check className="h-3 w-3 text-green-600" /> : <AlertTriangle className="h-3 w-3 text-amber-600" />}
                <span>{fa ? `راز اتصال: ${config.integrationSecret.hasSecret ? 'پیکربندی‌شده' : 'نبوده'}` : `Integration secret: ${config.integrationSecret.hasSecret ? 'configured' : 'missing'}`}</span>
              </div>
              <div className="flex items-center gap-2">
                {config.identityEndpointPath ? <Check className="h-3 w-3 text-green-600" /> : <AlertTriangle className="h-3 w-3 text-amber-600" />}
                <span>{fa ? `endpoint هویت: ${config.identityEndpointPath ? 'پیکربندی‌شده' : 'نبوده'}` : `Identity endpoint: ${config.identityEndpointPath ? 'configured' : 'missing'}`}</span>
              </div>
              <div className="flex items-center gap-2">
                {config.loginUrl ? <Check className="h-3 w-3 text-green-600" /> : <Circle className="h-3 w-3 text-muted-foreground" />}
                <span>{fa ? `امکان ورود: ${config.loginUrl ? 'آدرس پیکربندی‌شده' : 'یکپارچه‌سازی SPA می‌تواند از sukhan:login-required بدون URL استفاده کند'}` : `Login affordance: ${config.loginUrl ? 'URL configured' : 'SPA integrations can use sukhan:login-required without a URL'}`}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Integration secret management (only relevant for site_user_only) */}
      {showSiteUserSection && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              <CardTitle className="text-sm">{fa ? 'راز اتصال' : 'Integration secret'}</CardTitle>
            </div>
            <CardDescription className="text-xs" data-testid="integration-secret-status">
              {config.integrationSecret.hasSecret
                ? (fa ? `پیکربندی‌شده${config.integrationSecret.rotatedAt ? ` • ${fa ? 'چرخش در' : 'rotated'} ${new Date(config.integrationSecret.rotatedAt).toLocaleString()}` : ''}` : `Secret configured${config.integrationSecret.rotatedAt ? ` • rotated ${new Date(config.integrationSecret.rotatedAt).toLocaleString()}` : ''}`)
                : (fa ? 'نبوده' : 'Not configured')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* One-time raw secret reveal (MEMORY-ONLY) */}
            {rawSecret && (
              <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="integration-secret-reveal">
                <div className="flex items-center gap-2 text-xs font-medium text-primary">
                  <Info className="h-3.5 w-3.5" />
                  {fa ? 'این راز فقط یک‌بار نمایش داده می‌شود' : 'This secret is shown only once'}
                </div>
                <code dir="ltr" className="block break-all rounded bg-background p-2 text-xs font-mono">{rawSecret}</code>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={copySecret} data-testid="integration-secret-copy">
                    {copiedSecret ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {fa ? 'کپی' : 'Copy'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRawSecret(null)} data-testid="integration-secret-dismiss">
                    <EyeOff className="h-3.5 w-3.5" />
                    {fa ? 'پنهان کن' : 'Dismiss'}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {!config.integrationSecret.hasSecret ? (
                <Button onClick={generateSecret} disabled={secretBusy} data-testid="integration-secret-generate">
                  {secretBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {fa ? 'تولید راز اتصال' : 'Generate integration secret'}
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => setShowRotateConfirm(true)} disabled={secretBusy} data-testid="integration-secret-rotate">
                    <RefreshCw className="h-3.5 w-3.5" />
                    {fa ? 'چرخش راز' : 'Rotate secret'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowRevokeConfirm(true)} disabled={secretBusy} data-testid="integration-secret-revoke">
                    <Trash2 className="h-3.5 w-3.5" />
                    {fa ? 'لغو راز' : 'Revoke secret'}
                  </Button>
                </>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {fa ? 'این راز فقط روی سرور مشتری استفاده می‌شود؛ هرگز در مرورگر قرار نگیرد.' : 'This secret is used only on the customer server; never place it in the browser.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Integration readiness check (TRUTHFUL — NO SSRF) */}
      {showSiteUserSection && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{fa ? 'بررسی راه‌اندازی اتصال' : 'Check integration setup'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button variant="outline" size="sm" onClick={runReadinessCheck} disabled={checkStatus === 'checking'} data-testid="integration-check">
              {checkStatus === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
              {fa ? 'بررسی راه‌اندازی اتصال' : 'Check integration setup'}
            </Button>
            {checkStatus === 'ok' && (
              <div className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-50 p-3 text-xs dark:bg-green-950/20">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                <span className="text-green-800 dark:text-green-200">
                  {fa
                    ? 'راه‌اندازی هویت سمت سُخان پیکربندی شده است. جریان واقعی ورود به سایت را از وب‌سایت مشتری تست کنید. این بررسی وجود endpoint مشتری یا احراز هویت آن را اثبات نمی‌کند.'
                    : 'Sukhan-side identity setup is configured. Test the actual signed-in flow from your customer website. This check does NOT prove the customer endpoint exists, the customer auth works, or a particular user can log in.'}
                </span>
              </div>
            )}
            {checkStatus === 'fail' && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50 p-3 text-xs dark:bg-amber-950/20">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="text-amber-800 dark:text-amber-200">
                  {fa ? 'راه‌اندازی ناقص است: حالت، راز یا endpoint هویت پیکربندی‌نشده.' : 'Setup incomplete: mode, secret, or identity endpoint not configured.'}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Customer integration examples */}
      {showSiteUserSection && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{fa ? 'نمونه‌های یکپارچه‌سازی مشتری' : 'Customer integration examples'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-xs">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{fa ? 'اسکریپت (v1)' : 'Script (v1)'}</Label>
              <code dir="ltr" className="block whitespace-pre-wrap break-words rounded bg-muted p-2 text-[11px]">{`<script async defer
  src="${apiUrl}/api/widget/v1/sukhan.js"
  data-api-key="${slug}"
  data-identity-endpoint="/api/sukhan-identity">
</script>`}</code>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{fa ? 'NPM' : 'NPM'} <Badge variant="secondary" className="ml-1 text-[10px]">{fa ? 'به‌زودی' : 'Coming Soon'}</Badge></Label>
              <code dir="ltr" className="block whitespace-pre-wrap break-words rounded bg-muted p-2 text-[11px]">{`initSukhan({
  apiKey: '${slug}',
  identityEndpoint: '/api/sukhan-identity',
})`}</code>
              <p className="text-[11px] text-muted-foreground">{fa ? 'انتشار پکیج NPM هنوز در حال انجام است.' : 'NPM package publication is still pending.'}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{fa ? 'قرارداد endpoint مشتری' : 'Customer endpoint contract'}</Label>
              <code dir="ltr" className="block whitespace-pre-wrap break-words rounded bg-muted p-2 text-[11px]">{`// logged out
{ "authenticated": false }
// logged in
{ "authenticated": true, "token": "<short-lived Sukhan identity token>" }`}</code>
              <p className="text-[11px] text-muted-foreground">{fa ? 'مرورگر فقط توکن کوتاه‌مدت را دریافت می‌کند؛ راز اتصال سمت سرور باقی می‌ماند.' : 'The browser receives only the short-lived token; the integration secret stays server-side.'}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{fa ? 'ساخت توکن سمت سرور (server-to-server)' : 'Server-to-server mint'}</Label>
              <code dir="ltr" className="block whitespace-pre-wrap break-words rounded bg-muted p-2 text-[11px]">{`// runs on the CUSTOMER server — never in the browser
await fetch('${apiUrl}/api/widget/identity/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: \`Bearer \${process.env.SUKHAN_INTEGRATION_SECRET}\`,
  },
  body: JSON.stringify({
    externalUserId: stableUserId, // from the customer's server-side auth
    name, username, email, avatarUrl,
  }),
})`}</code>
              <p className="text-[11px] text-muted-foreground">{fa ? 'externalUserId از کاربر احراز‌هویت‌شده سمت سرور مشتری می‌آید؛ ورودی مرورگر هرگز مورد اعتماد نیست.' : 'externalUserId comes from the customer\'s server-side authenticated user; browser input must not be trusted.'}</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{fa ? 'نگاشت پروفایل نمایشی' : 'Display profile fallback'}</Label>
              <p className="text-[11px] text-muted-foreground" dir="ltr">name -&gt; username -&gt; email -&gt; Authenticated user</p>
              <p className="text-[11px] text-muted-foreground">{fa ? 'هویت پایدار externalUserId است، نه ایمیل.' : 'Stable identity is externalUserId, not email.'}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Mode-change confirmation dialog */}
      <AlertDialog open={showModeChangeConfirm} onOpenChange={setShowModeChangeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{fa ? 'تغییر حالت دسترسی' : 'Change access mode'}</AlertDialogTitle>
            <AlertDialogDescription>
              {fa
                ? 'تغییر حالت دسترسی بلافاصله اعمال می‌شود. بازدیدکنندگانی که اعتبارنامه آن‌ها دیگر سیاست جدید را برآورده نمی‌کند باید دوباره تأیید شوند یا وارد سایت شوند.'
                : 'Changing access mode takes effect immediately. Visitors using credentials that no longer satisfy the new policy will need to verify or sign in again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{fa ? 'لغو' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmModeChange} data-testid="access-mode-change-confirm">{fa ? 'ذخیره' : 'Save'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotate confirmation */}
      <AlertDialog open={showRotateConfirm} onOpenChange={setShowRotateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{fa ? 'چرخش راز اتصال' : 'Rotate integration secret'}</AlertDialogTitle>
            <AlertDialogDescription>
              {fa
                ? 'راز قبلی بلافاصله از کار می‌افتد. پیکربندی بک‌اند مشتری باید به‌روز شود. توکن‌های هویت موجود بر اساس رفتار پذیرفته‌شده بک‌اند با تغییر policyVersion نامعتبر می‌شوند.'
                : 'The previous secret stops working immediately. Customer backend configuration must be updated. Existing external identity tokens are invalidated by the policy-version change according to the accepted backend behavior.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{fa ? 'لغو' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { setShowRotateConfirm(false); await generateSecret(); }} data-testid="integration-secret-rotate-confirm">{fa ? 'چرخش' : 'Rotate'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke confirmation */}
      <AlertDialog open={showRevokeConfirm} onOpenChange={setShowRevokeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{fa ? 'لغو راز اتصال' : 'Revoke integration secret'}</AlertDialogTitle>
            <AlertDialogDescription>
              {fa
                ? 'بک‌اند مشتری دیگر نمی‌تواند توکن هویت کاربر سایت جدیدی بسازد. اگر حالت site_user_only باقی بماند، runtime تا بازگردانی اتصال fail-closed می‌شود. حالت دسترسی به‌طور خودکار anonymous نمی‌شود.'
                : 'The customer backend can no longer mint new site-user identity tokens. If mode remains site_user_only, runtime correctly fails closed until integration is restored. Access mode is NOT automatically switched to anonymous.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{fa ? 'لغو' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={revokeSecret} data-testid="integration-secret-revoke-confirm">{fa ? 'لغو راز' : 'Revoke secret'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
