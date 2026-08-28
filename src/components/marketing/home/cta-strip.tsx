'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthModal } from '@/components/marketing/auth-modal-store'

/**
 * The CTA strip at the bottom of the marketing homepage. Re-emphasizes the
 * "signup to live widget in five minutes" pitch and offers a single button.
 */
export function CtaStrip() {
  const t = useTranslations('marketing.home.ctaStrip')
  const { open } = useAuthModal()

  return (
    <section className="bg-ink py-16 text-ink-foreground sm:py-20">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-6 px-4 sm:px-6 lg:flex-row lg:items-center lg:px-8"
      >
        <div className="max-w-2xl">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('title')}
          </h2>
          <p className="mt-2 text-sm text-ink-foreground/70 sm:text-base">
            {t('body')}
          </p>
        </div>
        <Button
          onClick={() => open('signup')}
          size="lg"
          className="bg-saffron text-saffron-foreground hover:bg-saffron/90"
        >
          {t('cta')}
          {/* RTL: arrow points left; LTR: arrow points right. Tailwind logical
              properties don't flip the icon direction automatically, so we
              conditionally pick one. */}
          <ArrowRight className="h-4 w-4 rtl:hidden" />
          <ArrowLeft className="h-4 w-4 ltr:hidden" />
        </Button>
      </motion.div>
    </section>
  )
}
