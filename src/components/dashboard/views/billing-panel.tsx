'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Check, CreditCard, Zap, Building2, Crown, Sparkles, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'
import { cn } from '@/lib/utils'

type PlanInfo = {
  slug: string
  name: string
  priceToman: number
  interval: string
  contactSales: boolean
  limits: { agents: number; conversations: number; departments: number }
}

type UsageInfo = {
  planSlug: string
  usage: {
    agents: { current: number; limit: number }
    conversations: { current: number; limit: number }
    departments: { current: number; limit: number }
  }
}

type SubscriptionInfo = {
  id: string
  status: string
  gateway: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
} | null

type InvoiceInfo = {
  id: string
  amountToman: number
  gateway: string
  status: string
  refId: string | null
  createdAt: string
  paidAt: string | null
}

type BillingData = {
  plan: PlanInfo | null
  subscription: SubscriptionInfo
  invoices: InvoiceInfo[]
  usage: UsageInfo['usage'] | null
  planSlug?: string
}

const GATEWAYS = [
  { id: 'zarinpal', name: 'ZarinPal', description: 'زرین‌پال — درگاه اصلی' },
  { id: 'idpay', name: 'IDPay', description: 'آیدی‌پی — درگاه جایگزین' },
  { id: 'zarinlink', name: 'ZarinLink', description: 'زرین‌لینک — لینک پرداخت' },
] as const

const PLAN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Zap,
  business: Building2,
  enterprise: Crown,
}

function formatToman(n: number): string {
  if (n === 0) return '۰'
  return n.toLocaleString('fa-IR')
}

function formatLimit(n: number, t: (k: string) => string): string {
  if (n === -1) return t('billing.unlimited')
  return formatToman(n)
}

function pct(current: number, limit: number): number {
  if (limit === -1) return 0
  if (limit === 0) return 100
  return Math.min(100, Math.round((current / limit) * 100))
}

/** Reads the billing callback query params and shows a toast. */
function CallbackHandler() {
  const t = useTranslations('billing')
  const searchParams = useSearchParams()

  useEffect(() => {
    const status = searchParams?.get('billing')
    const message = searchParams?.get('message')
    if (!status) return
    if (status === 'success') {
      toast.success(t('paymentSuccess'))
    } else if (status === 'canceled') {
      toast.error(t('paymentCanceled'))
    } else if (status === 'error') {
      toast.error(message ? `${t('paymentFailed')}: ${message}` : t('paymentFailed'))
    }
    // Clean the URL so a refresh doesn't re-fire the toast.
    if (typeof window !== 'undefined' && window.history) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [searchParams])

  return null
}

export function BillingPanel() {
  const t = useTranslations('billing')
  const tc = useTranslations('common')
  const [data, setData] = useState<BillingData | null>(null)
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [selectedGateway, setSelectedGateway] = useState<string>('zarinpal')
  const [subscribing, setSubscribing] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [planRes, subRes] = await Promise.all([
      fetch('/api/billing/plans'),
      fetch('/api/billing/subscription'),
    ])
    const planData = await planRes.json()
    const subData = await subRes.json()
    setPlans(planData.plans ?? [])
    setData(subData)
    setLoading(false)
  }

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function onSubscribe() {
    if (!selectedPlan) {
      toast.error(t('selectPlan'))
      return
    }
    setSubscribing(true)
    const res = await fetch('/api/billing/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planSlug: selectedPlan, gateway: selectedGateway }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error(json.error ?? t('subscribeFailed'))
      setSubscribing(false)
      return
    }

    // Free plan: no redirect needed.
    if (json.free) {
      toast.success(t('planActivated'))
      setSubscribing(false)
      setSelectedPlan(null)
      load()
      return
    }

    // Paid plan: redirect to gateway.
    if (json.testMode) {
      toast.info(t('testModeRedirect'))
    } else {
      toast.info(t('redirectingToGateway'))
    }
    // Small delay so the toast can render before the page navigates away.
    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.location.href = json.gatewayUrl
      }
    }, 400)
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {tc('loading')}
      </div>
    )
  }

  const currentPlanSlug = data?.plan?.slug ?? data?.planSlug ?? 'free'
  const usage = data?.usage

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <Suspense fallback={null}>
        <CallbackHandler />
      </Suspense>
      <PanelHeader title={t('title')} hint={t('subtitle')} />

      {/* Current plan + usage */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="font-display text-base">{t('currentPlan')}</CardTitle>
              <CardDescription>{t('currentPlanHint')}</CardDescription>
            </div>
            {data?.plan && (
              <Badge className="bg-saffron/20 text-saffron-foreground">
                {data.plan.name}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {usage ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <UsageBar
                label={t('usage.agents')}
                current={usage.agents.current}
                limit={usage.agents.limit}
                t={t}
              />
              <UsageBar
                label={t('usage.conversations')}
                current={usage.conversations.current}
                limit={usage.conversations.limit}
                t={t}
              />
              <UsageBar
                label={t('usage.departments')}
                current={usage.departments.current}
                limit={usage.departments.limit}
                t={t}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noUsageData')}</p>
          )}
          {data?.subscription && (
            <div className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-foreground/70">{t('subscriptionStatus')}:</span>{' '}
                  {t(`status.${data.subscription.status}` as any)}
                </span>
                {data.subscription.gateway && (
                  <span>
                    <span className="text-foreground/70">{t('gateway')}:</span>{' '}
                    {data.subscription.gateway}
                  </span>
                )}
                {data.subscription.currentPeriodEnd && (
                  <span>
                    <span className="text-foreground/70">{t('renewsOn')}:</span>{' '}
                    {new Date(data.subscription.currentPeriodEnd).toLocaleDateString('fa-IR')}
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Plan cards */}
      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{t('choosePlan')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans
            .filter((p) => !p.contactSales)
            .map((plan) => {
              const Icon = PLAN_ICONS[plan.slug] ?? CreditCard
              const isCurrent = plan.slug === currentPlanSlug
              const isSelected = selectedPlan === plan.slug
              return (
                <Card
                  key={plan.slug}
                  className={cn(
                    'relative cursor-pointer transition-all hover:border-saffron/50',
                    isSelected && 'border-saffron ring-2 ring-saffron/20',
                    isCurrent && 'opacity-70',
                  )}
                  onClick={() => !isCurrent && setSelectedPlan(plan.slug)}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-saffron/15 text-saffron">
                        <Icon className="h-5 w-5" />
                      </div>
                      {isCurrent && (
                        <Badge variant="secondary" className="text-xs">
                          {t('current')}
                        </Badge>
                      )}
                    </div>
                    <CardTitle className="font-display text-base">{plan.name}</CardTitle>
                    <CardDescription>
                      {plan.priceToman === 0 ? (
                        <span className="text-lg font-semibold text-foreground">
                          {t('free')}
                        </span>
                      ) : (
                        <span className="text-lg font-semibold text-foreground">
                          {formatToman(plan.priceToman)}{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            {t('tomanPerMonth')}
                          </span>
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <PlanFeature
                      ok
                      text={`${t('limits.agents')}: ${formatLimit(plan.limits.agents, t)}`}
                    />
                    <PlanFeature
                      ok
                      text={`${t('limits.conversations')}: ${formatLimit(plan.limits.conversations, t)}`}
                    />
                    <PlanFeature
                      ok
                      text={`${t('limits.departments')}: ${formatLimit(plan.limits.departments, t)}`}
                    />
                  </CardContent>
                </Card>
              )
            })}
        </div>
      </div>

      {/* Enterprise CTA */}
      <Card className="border-dashed">
        <CardContent className="flex items-center gap-4 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-turquoise/15 text-turquoise">
            <Crown className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="font-medium">{t('enterprise.name')}</p>
            <p className="text-sm text-muted-foreground">{t('enterprise.hint')}</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href="mailto:sales@sukhan.ir">{t('enterprise.contactSales')}</a>
          </Button>
        </CardContent>
      </Card>

      {/* Gateway chooser + subscribe */}
      {selectedPlan && (
        <Card className="border-saffron/40">
          <CardHeader>
            <CardTitle className="font-display text-base">{t('chooseGateway')}</CardTitle>
            <CardDescription>{t('chooseGatewayHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {GATEWAYS.map((gw) => (
                <button
                  key={gw.id}
                  type="button"
                  onClick={() => setSelectedGateway(gw.id)}
                  className={cn(
                    'rounded-lg border p-3 text-start transition-all hover:border-saffron/50',
                    selectedGateway === gw.id
                      ? 'border-saffron bg-saffron/5'
                      : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{gw.name}</span>
                    {selectedGateway === gw.id && (
                      <Check className="h-4 w-4 text-saffron" />
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{gw.description}</p>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={onSubscribe}
                disabled={subscribing}
                className="gap-2"
              >
                <CreditCard className="h-4 w-4" />
                {subscribing ? tc('loading') : t('subscribe')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSelectedPlan(null)}
              >
                {tc('cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent invoices */}
      {data?.invoices && data.invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">{t('invoices')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {data.invoices.slice(0, 5).map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {formatToman(inv.amountToman)} {t('toman')}
                    </p>
                    <p className="text-xs text-muted-foreground" dir="ltr">
                      {inv.gateway} · {new Date(inv.createdAt).toLocaleDateString('fa-IR')}
                      {inv.refId && ` · ref: ${inv.refId}`}
                    </p>
                  </div>
                  <Badge
                    variant={inv.status === 'paid' ? 'default' : 'secondary'}
                    className={cn(
                      inv.status === 'paid' && 'bg-turquoise/20 text-turquoise-foreground',
                      inv.status === 'failed' && 'bg-destructive/15 text-destructive',
                    )}
                  >
                    {t(`invoiceStatus.${inv.status}` as any)}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Test mode notice */}
      <div className="flex items-start gap-2 rounded-lg border border-saffron/30 bg-saffron/5 p-3 text-xs text-muted-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-saffron" />
        <p>{t('testModeNotice')}</p>
      </div>
    </div>
  )
}

function UsageBar({
  label,
  current,
  limit,
  t,
}: {
  label: string
  current: number
  limit: number
  t: (k: string) => string
}) {
  const value = pct(current, limit)
  const isUnlimited = limit === -1
  const isWarning = !isUnlimited && value >= 80
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium', isWarning && 'text-saffron')}>
          {isUnlimited
            ? `${formatToman(current)} / ${t('unlimited')}`
            : `${formatToman(current)} / ${formatToman(limit)}`}
        </span>
      </div>
      <Progress value={isUnlimited ? 0 : value} className={cn(isWarning && 'bg-saffron/20')} />
    </div>
  )
}

function PlanFeature({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <Check className={cn('h-4 w-4', ok ? 'text-turquoise' : 'text-muted-foreground')} />
      <span className="text-muted-foreground">{text}</span>
    </div>
  )
}
