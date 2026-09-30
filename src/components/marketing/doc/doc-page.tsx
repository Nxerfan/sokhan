'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import {
  Terminal,
  Code2,
  FileCode2,
  Settings,
  Radio,
  Table2,
  HelpCircle,
  Check,
  Minus,
  Lock,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { CopyButton } from '@/components/marketing/shared/copy-button'
import { CtaCard } from '@/components/marketing/shared/cta-card'
import { PromptSection } from '@/components/marketing/doc/prompt-section'
import { cn } from '@/lib/utils'

// ---------- Code snippets (hardcoded — code is locale-independent) ----------
//
// These are NOT in src/messages/*.json because they contain characters that
// ICU MessageFormat would interpret as syntax (curly braces in `import { ... }`,
// single quotes in 'sukhan-widget', angle brackets in <slug>).
// Hardcoding keeps them byte-for-byte identical across locales — code is the
// same in fa and en.

const QUICK_START_CODES = [
  'bun add sukhan-widget',
  'SUKHAN_API_KEY=sk_your-workspace-slug',
  "import { initSukhan } from 'sukhan-widget'",
]

const REACT_CODE = `'use client'
import { useEffect } from 'react'
import { initSukhan } from 'sukhan-widget'

export function SukhanChat() {
  useEffect(() => {
    // initSukhan reads process.env.SUKHAN_API_KEY (or NEXT_PUBLIC_SUKHAN_API_KEY
    // when prefixed for client-side exposure in Next.js).
    // It is a no-op on the server — safe to import in any component.
    const instance = initSukhan({
      apiKey: process.env.NEXT_PUBLIC_SUKHAN_API_KEY,
    })
    return () => instance.destroy()
  }, [])
  return null
}`

const SCRIPT_TAG_CODE = `<script
  async
  defer
  src="https://app.sukhan.chat/api/widget/v1/sukhan.js"
  data-api-key="sk_your-workspace-slug"
></script>`

/**
 * REST endpoint definitions. `descriptionKey` points at the i18n key for the
 * localized description; the rest (method, path, auth) is locale-independent
 * and lives here as a constant to avoid ICU MessageFormat conflicts.
 */
const API_ENDPOINTS: Array<{
  method: 'GET' | 'POST'
  path: string
  auth: string
  descriptionKey: string
}> = [
  { method: 'GET', path: '/api/widget/<slug>/config', auth: 'none', descriptionKey: '0' },
  { method: 'POST', path: '/api/widget/<slug>/contact', auth: 'none', descriptionKey: '1' },
  { method: 'GET', path: '/api/widget/<slug>/messages', auth: 'Bearer <token>', descriptionKey: '2' },
  { method: 'POST', path: '/api/widget/<slug>/messages', auth: 'Bearer <token>', descriptionKey: '3' },
  { method: 'POST', path: '/api/widget/<slug>/csat', auth: 'Bearer <token>', descriptionKey: '4' },
]

/**
 * Realtime transport row. Locale-independent code values.
 *
 * NOTE: The URL `/?XTransformPort=3003` is the docker/dev default (routed
 * through Caddy). On Vercel, set `NEXT_PUBLIC_REALTIME_URL` to your external
 * realtime service URL and the dashboard + widget will use it instead.
 */
const SOCKET_TABLE = [
  {
    url: 'NEXT_PUBLIC_REALTIME_URL || "/?XTransformPort=3003"',
    auth: 'auth: { token }',
    events: 'message:new, conversation:updated, typing:start, typing:stop',
  },
]

/**
 * initSukhan() options. `descriptionKey` points at the i18n key for the
 * localized description; option/type/default are code values.
 */
const CONFIG_ROWS: Array<{
  option: string
  type: string
  default: string
  descriptionKey: string
}> = [
  {
    option: 'apiKey',
    type: 'string',
    default: 'env',
    descriptionKey: '0',
  },
  {
    option: 'apiUrl',
    type: 'string',
    default: 'origin',
    descriptionKey: '1',
  },
  {
    option: 'container',
    type: 'HTMLElement',
    default: 'body',
    descriptionKey: '2',
  },
  {
    option: 'locale',
    type: "'fa' | 'en'",
    default: 'tenant',
    descriptionKey: '3',
  },
  {
    option: 'direction',
    type: "'rtl' | 'ltr'",
    default: 'tenant',
    descriptionKey: '4',
  },
  {
    option: 'visitor',
    type: '{ name?, email?, visitorId? }',
    default: '—',
    descriptionKey: '5',
  },
  {
    option: 'disablePolling',
    type: 'boolean',
    default: 'false',
    descriptionKey: '6',
  },
]

// ---------- Section header helper ----------

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  accent,
}: {
  icon: LucideIcon
  title: string
  subtitle?: string
  accent?: 'saffron' | 'turquoise'
}) {
  return (
    <div className="mb-10 flex items-center gap-3">
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-xl',
          accent === 'turquoise'
            ? 'bg-turquoise/15 text-turquoise'
            : 'bg-ink text-ink-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  )
}

// ---------- Code block with copy button ----------

function CodeBlock({
  title,
  code,
  note,
}: {
  title?: string
  code: string
  note?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
    >
      {(title || note) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/40 px-5 py-3">
          {title && (
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-turquoise" />
              <span
                dir="ltr"
                className="font-mono text-xs font-medium text-foreground"
              >
                {title}
              </span>
            </div>
          )}
          <CopyButton text={code} />
        </div>
      )}
      {!title && !note && (
        <div className="flex items-center justify-end border-b border-border bg-muted/40 px-3 py-1.5">
          <CopyButton text={code} />
        </div>
      )}
      <pre
        dir="ltr"
        className="overflow-x-auto bg-ink p-4 font-mono text-xs leading-relaxed text-ink-foreground/90 scroll-thin"
      >
        <code>{code}</code>
      </pre>
      {note && (
        <p className="border-t border-border bg-card/50 px-5 py-3 text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </motion.div>
  )
}

// ---------- Main DocPage component ----------

/**
 * Documentation page. Seven sections:
 *  1. Quick start — 3 numbered cards (Install → Env → Import)
 *  2. React/Next.js integration — code example
 *  3. HTML/Script-tag method — code example
 *  4. Configuration — options table + free-plan locked notice
 *  5. API reference — REST endpoints + realtime + auth + rate limits
 *  6. Plan limits — comparison table
 *  7. Troubleshooting — accordion FAQ
 *
 * Reuses the existing ink/saffron/turquoise design system, Vazirmatn +
 * Space Grotesk fonts, RTL-aware layout. All copy is bilingual via
 * next-intl (see `marketing.doc.*` keys in src/messages/).
 */
export function DocPage() {
  const t = useTranslations('marketing.doc')

  return (
    <div className="flex flex-col">
      {/* ============ Page header ============ */}
      <section className="border-b border-border bg-card/30 py-16 sm:py-20 lg:py-24">
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

      {/* ============ Section 1: Quick start ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Terminal}
            title={t('quickStart.title')}
            subtitle={t('quickStart.subtitle')}
            accent="saffron"
          />

          {/* Horizontal timeline on lg, stacked on mobile */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.3, delay: i * 0.08 }}
              >
                <Card className="flex h-full flex-col gap-4 p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-saffron/15 font-display text-sm font-bold text-saffron">
                      {i + 1}
                    </span>
                    <h3 className="font-display text-lg font-semibold tracking-tight">
                      {t(`quickStart.steps.${i}.title` as const)}
                    </h3>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`quickStart.steps.${i}.body` as const)}
                  </p>
                  <div className="mt-auto overflow-hidden rounded-lg border border-border bg-ink">
                    <pre
                      dir="ltr"
                      className="overflow-x-auto p-3 font-mono text-xs text-ink-foreground/90 scroll-thin"
                    >
                      <code>{QUICK_START_CODES[i]}</code>
                    </pre>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ Section 2: React/Next.js integration ============ */}
      <section className="border-y border-border bg-card/20 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Code2}
            title={t('react.title')}
            subtitle={t('react.subtitle')}
            accent="turquoise"
          />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
            <CodeBlock
              title={t('react.codeTitle')}
              code={REACT_CODE}
              note={t('react.codeNote')}
            />
            <Card className="flex flex-col gap-3 p-6">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-turquoise" />
                <h4 className="font-display text-sm font-semibold">
                  SSR-safe
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Importing the package in a server component is a no-op.
                Initialization only runs in the browser.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Check className="h-4 w-4 text-turquoise" />
                <h4 className="font-display text-sm font-semibold">
                  Auto-cleanup
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">
                Return a destroy() callback from useEffect to remove the
                widget DOM + disconnect the socket on unmount.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* ============ Section 3: HTML/Script tag ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={FileCode2}
            title={t('scriptTag.title')}
            subtitle={t('scriptTag.subtitle')}
            accent="saffron"
          />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
            <CodeBlock
              title={t('scriptTag.codeTitle')}
              code={SCRIPT_TAG_CODE}
              note={t('scriptTag.codeNote')}
            />
            <Card className="flex flex-col gap-3 p-6">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-saffron" />
                <h4 className="font-display text-sm font-semibold">
                  data-api-key
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">
                The script reads the API key from its own
                <code
                  dir="ltr"
                  className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs"
                >
                  data-api-key
                </code>
                attribute at runtime — no build step needed.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Radio className="h-4 w-4 text-saffron" />
                <h4 className="font-display text-sm font-semibold">
                  Same origin
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">
                The src URL points at the Sukhan backend. The script
                resolves the origin from its own URL — no CORS config needed.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* ============ Section 4: Configuration ============ */}
      <section className="border-y border-border bg-card/20 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Settings}
            title={t('config.title')}
            subtitle={t('config.subtitle')}
            accent="turquoise"
          />

          {/* Free plan locked notice */}
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-saffron/30 bg-saffron/5 p-4">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-saffron" />
            <p className="text-sm text-foreground/80">
              {t('config.freeNote')}
            </p>
          </div>

          {/* Options table */}
          <ConfigTable />
        </div>
      </section>

      {/* ============ Section 5: API reference ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Radio}
            title={t('api.title')}
            subtitle={t('api.subtitle')}
            accent="saffron"
          />

          {/* REST endpoints */}
          <h3 className="mb-2 font-display text-lg font-semibold tracking-tight">
            {t('api.endpointsTitle')}
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            {t('api.endpointsSubtitle')}
          </p>
          <EndpointsTable />

          {/* Realtime transport */}
          <h3 className="mb-2 mt-12 font-display text-lg font-semibold tracking-tight">
            {t('api.socketTitle')}
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            {t('api.socketSubtitle')}
          </p>
          <div className="overflow-hidden rounded-2xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('api.socketUrl')}</TableHead>
                  <TableHead>{t('api.socketAuth')}</TableHead>
                  <TableHead>{t('api.socketEvents')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SOCKET_TABLE.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell
                      dir="ltr"
                      className="font-mono text-xs"
                    >
                      {row.url}
                    </TableCell>
                    <TableCell
                      dir="ltr"
                      className="font-mono text-xs"
                    >
                      {row.auth}
                    </TableCell>
                    <TableCell
                      dir="ltr"
                      className="font-mono text-xs text-muted-foreground"
                    >
                      {row.events}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Auth model */}
          <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <h3 className="mb-2 font-display text-lg font-semibold tracking-tight">
                {t('api.authTitle')}
              </h3>
              <p className="text-sm text-muted-foreground">{t('api.authBody')}</p>
            </Card>
            <Card className="p-6">
              <h3 className="mb-2 font-display text-lg font-semibold tracking-tight">
                {t('api.rateTitle')}
              </h3>
              <p className="text-sm text-muted-foreground">{t('api.rateBody')}</p>
            </Card>
          </div>
        </div>
      </section>

      {/* ============ Section 6: Plan limits ============ */}
      <section className="border-y border-border bg-card/20 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Table2}
            title={t('limits.title')}
            subtitle={t('limits.subtitle')}
            accent="turquoise"
          />

          {/* Free locked badge */}
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-saffron/30 bg-saffron/5 p-4">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-saffron" />
            <p className="text-sm text-foreground/80">
              {t('limits.freeLocked')}
            </p>
          </div>

          <PlanLimitsTable />
        </div>
      </section>

      {/* ============ Section 7: Troubleshooting ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={HelpCircle}
            title={t('troubleshooting.title')}
            subtitle={t('troubleshooting.subtitle')}
            accent="saffron"
          />

          <Accordion type="single" collapsible className="w-full">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <AccordionItem
                key={i}
                value={`item-${i}`}
                className="rounded-xl border border-border bg-card px-5 mb-3"
              >
                <AccordionTrigger className="text-start font-display text-base font-medium hover:no-underline">
                  {t(`troubleshooting.items.${i}.q` as const)}
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  {t(`troubleshooting.items.${i}.a` as const)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ============ Section 8: AI Prompts (Web + CLI) ============ */}
      <section className="border-y border-border bg-card/20 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeader
            icon={Sparkles}
            title={t('prompts.title')}
            subtitle={t('prompts.subtitle')}
            accent="saffron"
          />
          <PromptSection />
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="border-t border-border bg-card/30 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <CtaCard
            title={t('cta.title')}
            body={t('cta.body')}
            button={t('cta.button')}
            secondaryLabel={t('quickStart.title')}
            secondaryHref="#quick-start"
          />
        </div>
      </section>
    </div>
  )
}

// ============ Configuration table ============

function ConfigTable() {
  const t = useTranslations('marketing.doc.config')

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('cols.option')}</TableHead>
            <TableHead>{t('cols.type')}</TableHead>
            <TableHead>{t('cols.default')}</TableHead>
            <TableHead className="min-w-[280px]">
              {t('cols.description')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {CONFIG_ROWS.map((row, i) => (
            <TableRow key={i}>
              <TableCell
                dir="ltr"
                className="font-mono text-xs font-medium text-foreground"
              >
                {row.option}
              </TableCell>
              <TableCell
                dir="ltr"
                className="font-mono text-xs text-turquoise"
              >
                {row.type}
              </TableCell>
              <TableCell
                dir="ltr"
                className="font-mono text-xs text-muted-foreground"
              >
                {row.default}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {t(`rows.${row.descriptionKey}.description` as const)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ============ Endpoints table ============

function EndpointsTable() {
  const t = useTranslations('marketing.doc.api')

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[80px]">{t('cols.method')}</TableHead>
            <TableHead>{t('cols.path')}</TableHead>
            <TableHead className="w-[160px]">{t('cols.auth')}</TableHead>
            <TableHead className="min-w-[280px]">
              {t('cols.description')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {API_ENDPOINTS.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
                    'font-mono text-[10px] font-semibold',
                    row.method === 'GET' && 'border-turquoise/40 text-turquoise',
                    row.method === 'POST' && 'border-saffron/40 text-saffron',
                  )}
                >
                  {row.method}
                </Badge>
              </TableCell>
              <TableCell
                dir="ltr"
                className="font-mono text-xs text-foreground"
              >
                {row.path}
              </TableCell>
              <TableCell
                dir="ltr"
                className="font-mono text-xs text-muted-foreground"
              >
                {row.auth}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {t(`endpoints.${row.descriptionKey}.description` as const)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ============ Plan limits table ============

function PlanLimitsTable() {
  const t = useTranslations('marketing.doc.limits')
  const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

  /** Render a cell value: ✓ (check), — (minus), or a custom string. */
  function renderCell(value: string) {
    if (value === '✓') {
      return (
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-turquoise/15 text-turquoise">
          <Check className="h-3 w-3" />
        </span>
      )
    }
    if (value === '—') {
      return (
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Minus className="h-3 w-3" />
        </span>
      )
    }
    if (value === 'locked' || value === 'قفل') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-saffron/15 px-2 py-0.5 text-[10px] font-medium text-saffron">
          <Lock className="h-3 w-3" />
          {value}
        </span>
      )
    }
    return <span className="text-xs">{value}</span>
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-[220px]">{t('cols.feature')}</TableHead>
            <TableHead className="text-center">{t('cols.free')}</TableHead>
            <TableHead className="text-center">{t('cols.pro')}</TableHead>
            <TableHead className="text-center">{t('cols.business')}</TableHead>
            <TableHead className="text-center">
              {t('cols.enterprise')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((i) => (
            <TableRow key={i} className="text-center">
              <TableCell className="text-start text-xs font-medium text-foreground">
                {t(`rows.${i}.feature` as const)}
              </TableCell>
              <TableCell className="text-center">
                {renderCell(t(`rows.${i}.free` as const))}
              </TableCell>
              <TableCell className="text-center">
                {renderCell(t(`rows.${i}.pro` as const))}
              </TableCell>
              <TableCell className="text-center">
                {renderCell(t(`rows.${i}.business` as const))}
              </TableCell>
              <TableCell className="text-center">
                {renderCell(t(`rows.${i}.enterprise` as const))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
