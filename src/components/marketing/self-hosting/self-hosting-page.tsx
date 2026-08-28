'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import {
  Server,
  Terminal,
  Scale,
  FileText,
  ExternalLink,
  Check,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/marketing/shared/copy-button'
import { CtaCard } from '@/components/marketing/shared/cta-card'
import { useAuthModal } from '@/components/marketing/auth-modal-store'
import { cn } from '@/lib/utils'

const LITE_COMPOSE = `# Lite edition — SQLite + in-memory realtime.
# Best for small VPS or single-user deployments.
git clone https://github.com/sukhan/sukhan.git
cd sukhan

cp .env.docker.example .env
# Edit .env — set NEXTAUTH_SECRET (openssl rand -base64 32)

docker compose -f docker-compose.lite.yml up -d --build`

const FULL_COMPOSE = `# Full edition — Postgres + Redis + multi-instance realtime.
# Best for production.
git clone https://github.com/sukhan/sukhan.git
cd sukhan

cp .env.docker.example .env
# Edit .env — set NEXTAUTH_SECRET + POSTGRES_PASSWORD

docker compose up -d --build`

// Bilingual AGPL content (always shown side-by-side, regardless of UI locale).
// Hard-coded because legal text should be available in BOTH languages
// simultaneously, not just the current UI locale.
const AGPL_FA = {
  rightsTitle: 'حقوق شما',
  rights: [
    'استفاده — این نرم‌افزار را برای هر منظوری، حتی تجاری، اجرا کنید.',
    'مطالعه — کد منبع را بخوانید و تغییر دهید.',
    'اشتراک‌گذاری — نرم‌افزار را به شکل اصلی یا تغییر یافته بازتوزیع کنید.',
    'تغییر — آثار مشتق‌شده بسازید.',
  ],
  obligationsTitle: 'تعهدات شما',
  obligations: [
    'اشتراک‌گذاری تغییرات — اگر نسخه‌های تغییر یافته را توزیع می‌کنید، باید کد منبع مربوطه را تحت همان لایسنس AGPL-3.0 به اشتراک بگذارید.',
    'بند استفاده شبکه‌ای — اگر این نرم‌افزار را تغییر دهید و آن را به‌عنوان سرویس وب به دیگران (از طریق شبکه) ارائه دهید، باید کد منبع تغییر یافته خود را در دسترس کاربران قرار دهید.',
  ],
  scenariosTitle: 'این در عمل یعنی چه',
  scenarios: [
    {
      scenario: 'اجرای سُخن بدون تغییر برای سازمان خودتان',
      obligation: 'هیچ — هیچ تعهدی برای اشتراک‌گذاری وجود ندارد.',
    },
    {
      scenario: 'اجرای سُخن بدون تغییر به‌عنوان سرویس میزبانی‌شده برای مشتریان',
      obligation: 'هیچ — شما از کد اصلی استفاده می‌کنید که قبلاً عمومی است.',
    },
    {
      scenario: 'تغییر سُخن و استفاده داخلی',
      obligation: 'هیچ — استفاده داخلی «ارائه به دیگران» نیست.',
    },
    {
      scenario: 'تغییر سُخن و ارائه به‌عنوان سرویس وب',
      obligation: 'باید کد منبع تغییر یافته خود را در دسترس آن کاربران قرار دهید.',
    },
  ],
  note: 'این خلاصه به زبان ساده صرفاً برای درک است. متن قانونیِ الزام‌آور، خود لایسنس کامل AGPL-3.0 است.',
  readFull: 'مطالعه لایسنس کامل AGPL-3.0',
}

const AGPL_EN = {
  rightsTitle: 'Your rights',
  rights: [
    'Use — Run this software for any purpose, including commercially.',
    'Study — Read and modify the source code.',
    'Share — Redistribute the software, in original or modified form.',
    'Modify — Create derivative works.',
  ],
  obligationsTitle: 'Your obligations',
  obligations: [
    'Share modifications — If you distribute modified versions, you must share the corresponding source code under the same AGPL-3.0 license.',
    'Network use clause — If you modify this software and offer it as a web service to others (over a network), you must make your modified source code available to your users.',
  ],
  scenariosTitle: 'What this means in practice',
  scenarios: [
    {
      scenario: 'Running Sukhan unmodified for your own organization',
      obligation: 'None — no obligation to share anything.',
    },
    {
      scenario: 'Running Sukhan unmodified as a hosted service for customers',
      obligation: "None — you're using the original code, which is already public.",
    },
    {
      scenario: 'Modifying Sukhan and using it internally only',
      obligation: "None — internal use is not 'offering to others'.",
    },
    {
      scenario: 'Modifying Sukhan and offering it as a web service',
      obligation: 'You must make your modified source code available to those users.',
    },
  ],
  note: 'This plain-language summary is for understanding only. The legally binding text is the full AGPL-3.0 license.',
  readFull: 'Read the full AGPL-3.0 license',
}

const WHY_SELF_HOST = [
  {
    faTitle: 'حاکمیت داده',
    faBody: 'گفت‌وگوهای مشتری شما روی سرور شما می‌ماند. هیچ‌چیز زیرساخت شما را ترک نمی‌کند مگر اینکه بخواهید.',
    enTitle: 'Data sovereignty',
    enBody: 'Your customer conversations stay on your server. Nothing leaves your infrastructure unless you want it to.',
  },
  {
    faTitle: 'بدون سقف هزینه به ازای کارشناس',
    faBody: 'هر چند کارشناس که می‌خواهید اضافه کنید. هیچ هزینه لایسنس، هیچ صورتحساب به ازای کارشناس، هیچ مترای usage وجود ندارد.',
    enTitle: 'No per-seat cost ceiling',
    enBody: 'Add as many agents as you want. There is no license fee, no per-seat billing, no usage metering.',
  },
  {
    faTitle: 'حسابرسی کامل کد منبع',
    faBody: 'هر خط را بخوانید. هر چیزی را تغییر دهید. AGPL-3.0 تضمین می‌کند که همیشه حق بررسی و تغییر کد را دارید.',
    enTitle: 'Full source audit',
    enBody: 'Read every line. Modify anything. The AGPL-3.0 guarantees you always have the right to inspect and modify the code.',
  },
  {
    faTitle: 'ادغام‌های سفارشی',
    faBody: 'سُخن را به سیستم‌های داخلی خود وصل کنید. اتصال‌های سفارشی بسازید. پرامپت‌های هوش مصنوعی را برای دامنه خود تغییر دهید.',
    enTitle: 'Custom integrations',
    enBody: 'Hook Sukhan into your internal systems. Build custom connectors. Modify the AI prompts to fit your domain.',
  },
]

/**
 * Self-hosting page. Sections:
 *  1. Page header (kicker + title + subtitle)
 *  2. AGPL-3.0 plain-language (Persian + English side-by-side)
 *  3. Docker Compose code blocks (Lite + Full)
 *  4. Why self-host (4 reasons, bilingual)
 *  5. Link to SELF_HOSTING.md
 *  6. CTA
 */
export function SelfHostingPage() {
  const t = useTranslations('marketing.selfHosting')

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

      {/* ============ AGPL-3.0 plain language (bilingual) ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
              <Scale className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {t('agplTitle')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('agplSubtitle')}</p>
            </div>
          </div>

          {/* Bilingual columns */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AgplColumn lang="fa" content={AGPL_FA} />
            <AgplColumn lang="en" content={AGPL_EN} />
          </div>

          {/* Link to full license */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              <ExternalLink className="h-4 w-4" />
              <span dir="rtl">{AGPL_FA.readFull}</span>
              <span className="text-muted-foreground">·</span>
              <span dir="ltr">{AGPL_EN.readFull}</span>
            </a>
          </div>
        </div>
      </section>

      {/* ============ Docker Compose ============ */}
      <section className="border-y border-border bg-card/20 py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
              <Terminal className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {t('dockerTitle')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('dockerSubtitle')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <DockerCard
              title={t('dockerLiteTitle')}
              subtitle={t('dockerLiteSubtitle')}
              code={LITE_COMPOSE}
              accent="turquoise"
            />
            <DockerCard
              title={t('dockerFullTitle')}
              subtitle={t('dockerFullSubtitle')}
              code={FULL_COMPOSE}
              accent="saffron"
            />
          </div>
        </div>
      </section>

      {/* ============ Why self-host ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
              <Server className="h-5 w-5" />
            </div>
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('whySelfHostTitle')}
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {WHY_SELF_HOST.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
                className="rounded-2xl border border-border bg-card p-6"
              >
                <h3 className="flex items-baseline gap-2 font-display text-lg font-semibold tracking-tight">
                  <span dir="rtl">{item.faTitle}</span>
                  <span className="text-muted-foreground">·</span>
                  <span dir="ltr">{item.enTitle}</span>
                </h3>
                <div className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">
                  <p dir="rtl">{item.faBody}</p>
                  <p dir="ltr">{item.enBody}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ Link to SELF_HOSTING.md ============ */}
      <section className="border-t border-border bg-card/30 py-12">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-4 px-4 sm:px-6 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-turquoise" />
            <div>
              <h3 className="font-display text-base font-semibold tracking-tight">
                {t('readGuide')}
              </h3>
              <p className="text-xs text-muted-foreground">SELF_HOSTING.md</p>
            </div>
          </div>
          <Button asChild variant="outline">
            <a
              href="/SELF_HOSTING.md"
              target="_blank"
              rel="noopener noreferrer"
              className="gap-2"
            >
              {t('readGuide')}
              <ArrowRight className="h-4 w-4 rtl:hidden" />
              <ArrowLeft className="h-4 w-4 ltr:hidden" />
            </a>
          </Button>
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <CtaCard
            title={t('cta.title')}
            body={t('cta.body')}
            button={t('cta.button')}
            secondaryLabel={t('dockerTitle')}
            secondaryHref="#docker"
          />
        </div>
      </section>
    </div>
  )
}

// ============ AGPL bilingual column ============

function AgplColumn({
  lang,
  content,
}: {
  lang: 'fa' | 'en'
  content: typeof AGPL_EN
}) {
  const isFa = lang === 'fa'
  return (
    <div
      dir={isFa ? 'rtl' : 'ltr'}
      className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-6"
    >
      {/* Rights */}
      <div>
        <h3 className="mb-2 font-display text-base font-semibold tracking-tight">
          {content.rightsTitle}
        </h3>
        <ul className="flex flex-col gap-1.5">
          {content.rights.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Check
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  isFa ? 'text-turquoise' : 'text-saffron',
                )}
              />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Obligations */}
      <div>
        <h3 className="mb-2 font-display text-base font-semibold tracking-tight">
          {content.obligationsTitle}
        </h3>
        <ul className="flex flex-col gap-2">
          {content.obligations.map((o, i) => (
            <li
              key={i}
              className="rounded-lg border border-border bg-background p-3 text-sm"
            >
              {o}
            </li>
          ))}
        </ul>
      </div>

      {/* Scenarios */}
      <div>
        <h3 className="mb-2 font-display text-base font-semibold tracking-tight">
          {content.scenariosTitle}
        </h3>
        <div className="flex flex-col gap-2">
          {content.scenarios.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-background p-3"
            >
              <p className="text-sm font-medium">{s.scenario}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {s.obligation}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Note */}
      <p className="text-xs text-muted-foreground">{content.note}</p>
    </div>
  )
}

// ============ Docker code card ============

function DockerCard({
  title,
  subtitle,
  code,
  accent,
}: {
  title: string
  subtitle: string
  code: string
  accent: 'saffron' | 'turquoise'
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.4 }}
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/40 px-5 py-4">
        <div>
          <h3
            className={cn(
              'font-display text-base font-semibold tracking-tight',
              accent === 'saffron' ? 'text-saffron' : 'text-turquoise',
            )}
          >
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <CopyButton text={code} />
      </div>
      <pre
        dir="ltr"
        className="overflow-x-auto bg-ink p-4 font-mono text-xs leading-relaxed text-ink-foreground/90 scroll-thin"
      >
        <code>{code}</code>
      </pre>
    </motion.div>
  )
}
