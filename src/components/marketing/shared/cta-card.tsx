'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthModal } from '@/components/marketing/auth-modal-store'

interface CtaCardProps {
  title: string
  body: string
  button: string
  /** Optional secondary button label. When omitted, only the primary button is shown. */
  secondaryLabel?: string
  /** Optional href for the secondary button (e.g. /self-hosting). */
  secondaryHref?: string
}

/**
 * Reusable CTA card used at the bottom of marketing sub-pages. Calls
 * useAuthModal().open('signup') on click.
 */
export function CtaCard({
  title,
  body,
  button,
  secondaryLabel,
  secondaryHref,
}: CtaCardProps) {
  const { open } = useAuthModal()
  const t = useTranslations('marketing.home')

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.4 }}
      className="relative overflow-hidden rounded-2xl border border-border bg-ink p-8 text-ink-foreground sm:p-12"
    >
      {/* Saffron glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0"
      >
        <div className="absolute -top-24 end-1/4 h-64 w-64 rounded-full bg-saffron/20 blur-3xl" />
        <div className="absolute -bottom-24 start-1/4 h-64 w-64 rounded-full bg-turquoise/10 blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h2>
          <p className="mt-2 text-sm text-ink-foreground/70 sm:text-base">
            {body}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {secondaryLabel && secondaryHref && (
            <Button
              asChild
              variant="outline"
              size="lg"
              className="border-ink-foreground/30 bg-transparent text-ink-foreground hover:bg-ink-foreground/10"
            >
              <a href={secondaryHref}>{secondaryLabel}</a>
            </Button>
          )}
          <Button
            onClick={() => open('signup')}
            size="lg"
            className="bg-saffron text-saffron-foreground hover:bg-saffron/90"
          >
            {button}
            <ArrowRight className="h-4 w-4 rtl:hidden" />
            <ArrowLeft className="h-4 w-4 ltr:hidden" />
          </Button>
        </div>
      </div>
      <span className="sr-only">{t('cta')}</span>
    </motion.div>
  )
}
