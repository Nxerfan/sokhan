'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { Check, Minus, ShieldCheck } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { useAuthModal } from '@/components/marketing/auth-modal-store'
import { CtaCard } from '@/components/marketing/shared/cta-card'
import { cn } from '@/lib/utils'

type PlanKey = 'free' | 'pro' | 'business' | 'enterprise'
type RowKey =
  | 'agents'
  | 'conversations'
  | 'departments'
  | 'realtime'
  | 'widget'
  | 'csat'
  | 'analytics'
  | 'connectors'
  | 'aiActions'
  | 'productQa'
  | 'faqMatcher'
  | 'routingRules'
  | 'fileAttachments'
  | 'selfHost'
  | 'whiteLabel'
  | 'sla'

interface RowDef {
  key: RowKey
  group: 'core' | 'ai' | 'automation' | 'support'
}

const ROWS: RowDef[] = [
  { key: 'agents', group: 'core' },
  { key: 'conversations', group: 'core' },
  { key: 'departments', group: 'core' },
  { key: 'realtime', group: 'core' },
  { key: 'widget', group: 'core' },
  { key: 'csat', group: 'core' },
  { key: 'analytics', group: 'core' },
  { key: 'connectors', group: 'core' },
  { key: 'aiActions', group: 'ai' },
  { key: 'productQa', group: 'ai' },
  { key: 'faqMatcher', group: 'ai' },
  { key: 'routingRules', group: 'automation' },
  { key: 'fileAttachments', group: 'automation' },
  { key: 'selfHost', group: 'support' },
  { key: 'whiteLabel', group: 'support' },
  { key: 'sla', group: 'support' },
]

// Boolean / value matrix for the comparison table.
// ✓ = included, — = not included, otherwise a short string.
const COMPARE: Record<PlanKey, Record<RowKey, string | boolean>> = {
  free: {
    agents: '2',
    conversations: '100',
    departments: '1',
    realtime: true,
    widget: true,
    csat: true,
    analytics: false,
    connectors: false,
    aiActions: '0',
    productQa: false,
    faqMatcher: false,
    routingRules: false,
    fileAttachments: false,
    selfHost: false,
    whiteLabel: false,
    sla: false,
  },
  pro: {
    agents: '5',
    conversations: '1,000',
    departments: '5',
    realtime: true,
    widget: true,
    csat: true,
    analytics: true,
    connectors: true,
    aiActions: '500',
    productQa: true,
    faqMatcher: true,
    routingRules: true,
    fileAttachments: true,
    selfHost: false,
    whiteLabel: false,
    sla: false,
  },
  business: {
    agents: '20',
    conversations: '5,000',
    departments: '∞',
    realtime: true,
    widget: true,
    csat: true,
    analytics: true,
    connectors: true,
    aiActions: '2,000',
    productQa: true,
    faqMatcher: true,
    routingRules: true,
    fileAttachments: true,
    selfHost: false,
    whiteLabel: false,
    sla: false,
  },
  enterprise: {
    agents: '∞',
    conversations: '∞',
    departments: '∞',
    realtime: true,
    widget: true,
    csat: true,
    analytics: true,
    connectors: true,
    aiActions: '∞',
    productQa: true,
    faqMatcher: true,
    routingRules: true,
    fileAttachments: true,
    selfHost: true,
    whiteLabel: true,
    sla: true,
  },
}

const PLANS: PlanKey[] = ['free', 'pro', 'business', 'enterprise']

/**
 * Pricing page. Toggle between:
 *  - "Narrative" mode: each plan as a tall card stacked vertically with
 *    feature list + CTA.
 *  - "Compare" mode: a compact comparison table.
 *
 * Both modes show the gateways row + the "no metered AI" fine-print.
 */
export function PricingPage() {
  const t = useTranslations('marketing.pricing')
  const [tab, setTab] = useState<'narrative' | 'compare'>('narrative')

  return (
    <div className="flex flex-col">
      {/* Page header */}
      <section className="border-b border-border bg-card/30 py-16 sm:py-20">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-saffron">
            {t('kicker')}
          </p>
          <h1 className="max-w-3xl font-display text-4xl font-bold tracking-tight sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">
            {t('subtitle')}
          </p>
        </div>
      </section>

      {/* Toggle + content */}
      <section className="py-12 sm:py-16 lg:py-20">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-8 flex justify-center">
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as 'narrative' | 'compare')}
            >
              <TabsList>
                <TabsTrigger value="narrative">
                  {t('viewNarrative')}
                </TabsTrigger>
                <TabsTrigger value="compare">{t('viewCompare')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <Tabs value={tab}>
            <TabsContent value="narrative">
              <NarrativeView />
            </TabsContent>
            <TabsContent value="compare">
              <CompareView />
            </TabsContent>
          </Tabs>

          {/* Gateways */}
          <Gateways />

          {/* Fine print */}
          <div className="mt-8 flex items-start gap-3 rounded-xl border border-border bg-card/50 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-turquoise" />
            <p className="text-sm text-muted-foreground">{t('finePrint')}</p>
          </div>
        </div>
      </section>
    </div>
  )
}

// ============ Narrative view ============

function NarrativeView() {
  const t = useTranslations('marketing.pricing')
  const { open } = useAuthModal()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h2 className="text-center font-display text-2xl font-semibold tracking-tight sm:text-3xl">
        {t('narrativeTitle')}
      </h2>
      {PLANS.map((plan, i) => (
        <motion.div
          key={plan}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.3, delay: i * 0.05 }}
        >
          <Card
            className={cn(
              'p-6 sm:p-8',
              plan === 'business' && 'border-saffron/40 ring-1 ring-saffron/20',
            )}
          >
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="font-display text-2xl font-semibold tracking-tight">
                    {t(`plans.${plan}.name` as const)}
                  </h3>
                  {plan === 'business' && (
                    <span className="rounded-full bg-saffron/15 px-2.5 py-0.5 text-xs font-medium text-saffron">
                      Popular
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(`plans.${plan}.tagline` as const)}
                </p>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="font-display text-3xl font-bold">
                    {t(`plans.${plan}.price` as const)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`plans.${plan}.period` as const)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:items-end">
                <Button
                  onClick={() =>
                    plan === 'enterprise' ? null : open('signup')
                  }
                  asChild={plan === 'enterprise'}
                  size="lg"
                  className={cn(
                    plan === 'free' && 'bg-ink text-ink-foreground hover:bg-ink/90',
                    plan === 'pro' &&
                      'bg-turquoise text-turquoise-foreground hover:bg-turquoise/90',
                    plan === 'business' &&
                      'bg-saffron text-saffron-foreground hover:bg-saffron/90',
                    plan === 'enterprise' &&
                      'bg-ink text-ink-foreground hover:bg-ink/90',
                  )}
                >
                  {plan === 'enterprise' ? (
                    <a href="mailto:sales@sukhan.chat">
                      {t(`plans.${plan}.cta` as const)}
                    </a>
                  ) : (
                    t(`plans.${plan}.cta` as const)
                  )}
                </Button>
              </div>
            </div>

            {/* Feature list */}
            <ul className="mt-6 grid grid-cols-1 gap-2 border-t border-border pt-6 sm:grid-cols-2">
              {Object.keys(planFeatures(plan)).map((featureKey) => (
                <li key={featureKey} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-turquoise/20 text-turquoise">
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="text-sm text-foreground/80">
                    {t(`plans.${plan}.features.${featureKey}` as const)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </motion.div>
      ))}
    </div>
  )
}

// Returns the i18n feature keys available per plan (preserves order).
function planFeatures(plan: PlanKey): Record<string, string> {
  const keys: Record<PlanKey, string[]> = {
    free: ['agents', 'conversations', 'departments', 'ai', 'realtime', 'widget', 'csat'],
    pro: [
      'agents',
      'conversations',
      'departments',
      'ai',
      'realtime',
      'widget',
      'csat',
      'connectors',
    ],
    business: [
      'agents',
      'conversations',
      'departments',
      'ai',
      'realtime',
      'widget',
      'csat',
      'connectors',
      'routing',
    ],
    enterprise: [
      'agents',
      'conversations',
      'departments',
      'ai',
      'realtime',
      'widget',
      'csat',
      'connectors',
      'routing',
      'selfHost',
    ],
  }
  return Object.fromEntries(keys[plan].map((k) => [k, k]))
}

// ============ Compare view ============

function CompareView() {
  const t = useTranslations('marketing.pricing')

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-center font-display text-2xl font-semibold tracking-tight sm:text-3xl">
        {t('compareTitle')}
      </h2>
      <div className="overflow-x-auto scroll-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[180px]">
                {t('compare.feature')}
              </TableHead>
              {PLANS.map((p) => (
                <TableHead key={p} className="text-center min-w-[120px]">
                  <div className="flex flex-col items-center">
                    <span className="font-display text-base font-semibold">
                      {t(`compare.${p}` as const)}
                    </span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {t(`plans.${p}.price` as const)}
                    </span>
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Group headers + rows */}
            {(['core', 'ai', 'automation', 'support'] as const).map((group) => (
              <GroupRows key={group} group={group} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function GroupRows({
  group,
}: {
  group: 'core' | 'ai' | 'automation' | 'support'
}) {
  const t = useTranslations('marketing.pricing')
  const rowsInGroup = ROWS.filter((r) => r.group === group)

  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={5} className="py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t(`compare.groups.${group}` as const)}
          </span>
        </TableCell>
      </TableRow>
      {rowsInGroup.map((row) => (
        <TableRow key={row.key}>
          <TableCell className="font-medium">
            {t(`compare.rows.${row.key}` as const)}
          </TableCell>
          {PLANS.map((plan) => {
            const value = COMPARE[plan][row.key]
            return (
              <TableCell key={plan} className="text-center">
                <CompareCell value={value} />
              </TableCell>
            )
          })}
        </TableRow>
      ))}
    </>
  )
}

function CompareCell({ value }: { value: string | boolean }) {
  if (value === true)
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-turquoise/15 text-turquoise">
        <Check className="h-3 w-3" />
      </span>
    )
  if (value === false)
    return (
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Minus className="h-3 w-3" />
      </span>
    )
  return <span className="text-sm font-medium">{value}</span>
}

// ============ Gateways ============

function Gateways() {
  const t = useTranslations('marketing.pricing')
  return (
    <div className="mt-12 rounded-2xl border border-border bg-card/40 p-6 sm:p-8">
      <h3 className="font-display text-lg font-semibold tracking-tight">
        {t('gateways.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('gateways.subtitle')}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {(['zarinpal', 'idpay', 'zarinlink'] as const).map((g) => (
          <div
            key={g}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5"
          >
            <span className="h-2 w-2 rounded-full bg-saffron" />
            <span className="font-display text-sm font-semibold">
              {t(`gateways.${g}` as const)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
