'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { Receipt, Server, Languages } from 'lucide-react'

interface Diff {
  key: 'transparent' | 'selfHost' | 'bilingual'
  icon: typeof Receipt
}

const ITEMS: Diff[] = [
  { key: 'transparent', icon: Receipt },
  { key: 'selfHost', icon: Server },
  { key: 'bilingual', icon: Languages },
]

/**
 * Below-the-fold section with the 3 differentiators. Horizontally scrollable
 * on small screens (overflow-x-auto), grid on lg+.
 */
export function Differentiators() {
  const t = useTranslations('marketing.home.differentiators')

  return (
    <section className="border-y border-border bg-card/30 py-16 sm:py-20 lg:py-24">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <div className="mb-10 max-w-2xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-saffron">
            {t('sectionKicker')}
          </p>
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {t('sectionTitle')}
          </h2>
          <p className="mt-3 text-base text-muted-foreground sm:text-lg">
            {t('sectionSubtitle')}
          </p>
        </div>

        {/* Cards: horizontal scroll on mobile, grid on lg */}
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 scroll-thin lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
          {ITEMS.map((item, i) => {
            const Icon = item.icon
            return (
              <motion.div
                key={item.key}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
                className="flex snap-center flex-col gap-3 rounded-2xl border border-border bg-background p-6 min-w-[280px] lg:min-w-0"
              >
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="rounded-full bg-saffron/15 px-2.5 py-0.5 text-xs font-medium text-saffron">
                    {t(`${item.key}.tag` as const)}
                  </span>
                </div>
                <h3 className="font-display text-lg font-semibold tracking-tight">
                  {t(`${item.key}.title` as const)}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t(`${item.key}.body` as const)}
                </p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
