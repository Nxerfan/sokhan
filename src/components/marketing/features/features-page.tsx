'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import {
  Check,
  MessagesSquare,
  Bot,
  PackageSearch,
  Route,
  BarChart3,
  Star,
  Palette,
  CreditCard,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FeatureMockup } from '@/components/marketing/features/feature-mockup'
import { CtaCard } from '@/components/marketing/shared/cta-card'

interface FeatureDef {
  key:
    | 'realtime'
    | 'faq'
    | 'productQa'
    | 'routing'
    | 'analytics'
    | 'csat'
    | 'widget'
    | 'billing'
  icon: LucideIcon
  mockup:
    | 'chat'
    | 'faq'
    | 'product'
    | 'routing'
    | 'analytics'
    | 'csat'
    | 'widget'
    | 'billing'
  accent: 'saffron' | 'turquoise'
}

const FEATURES: FeatureDef[] = [
  { key: 'realtime', icon: MessagesSquare, mockup: 'chat', accent: 'saffron' },
  { key: 'faq', icon: Bot, mockup: 'faq', accent: 'turquoise' },
  { key: 'productQa', icon: PackageSearch, mockup: 'product', accent: 'saffron' },
  { key: 'routing', icon: Route, mockup: 'routing', accent: 'turquoise' },
  { key: 'analytics', icon: BarChart3, mockup: 'analytics', accent: 'saffron' },
  { key: 'csat', icon: Star, mockup: 'csat', accent: 'turquoise' },
  { key: 'widget', icon: Palette, mockup: 'widget', accent: 'saffron' },
  { key: 'billing', icon: CreditCard, mockup: 'billing', accent: 'turquoise' },
]

/**
 * Features page. Vertical narrative — each feature is a full-width section,
 * alternating left/right, with a stylized mockup + body copy + 3 bullets.
 */
export function FeaturesPage() {
  const t = useTranslations('marketing.features')

  return (
    <div className="flex flex-col">
      {/* Page header */}
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

      {/* Feature sections — alternating left/right */}
      {FEATURES.map((feature, i) => {
        const Icon = feature.icon
        const reversed = i % 2 === 1 // odd index → mockup on the END side
        return (
          <section
            key={feature.key}
            className={cn(
              'border-b border-border py-16 sm:py-20 lg:py-24',
              i % 2 === 0 ? 'bg-background' : 'bg-card/20',
            )}
          >
            <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-8 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-8">
              {/* Mockup side */}
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.4 }}
                className={cn(
                  'order-2 lg:order-1',
                  reversed && 'lg:order-2',
                )}
              >
                <FeatureMockup kind={feature.mockup} accent={feature.accent} />
              </motion.div>

              {/* Copy side */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className={cn(
                  'order-1 flex flex-col gap-4 lg:order-2',
                  reversed && 'lg:order-1',
                )}
              >
                <div
                  className={cn(
                    'flex h-12 w-12 items-center justify-center rounded-xl',
                    feature.accent === 'saffron'
                      ? 'bg-saffron/15 text-saffron'
                      : 'bg-turquoise/15 text-turquoise',
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                  {t(`items.${feature.key}.title` as const)}
                </h2>
                <p className="text-base leading-relaxed text-muted-foreground">
                  {t(`items.${feature.key}.body` as const)}
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {[1, 2, 3].map((n) => (
                    <li key={n} className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                          feature.accent === 'saffron'
                            ? 'bg-saffron/20 text-saffron'
                            : 'bg-turquoise/20 text-turquoise',
                        )}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      <span className="text-sm text-foreground/80">
                        {t(`items.${feature.key}.bullet${n}` as const)}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </div>
          </section>
        )
      })}

      {/* CTA */}
      <section className="py-16 sm:py-20 lg:py-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <CtaCard
            title={t('cta.title')}
            body={t('cta.body')}
            button={t('cta.button')}
          />
        </div>
      </section>
    </div>
  )
}
