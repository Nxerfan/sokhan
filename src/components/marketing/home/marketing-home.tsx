'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { ChatWidgetMockup } from '@/components/marketing/home/chat-widget-mockup'
import { Differentiators } from '@/components/marketing/home/differentiators'
import { CtaStrip } from '@/components/marketing/home/cta-strip'
import { useAuthModal } from '@/components/marketing/auth-modal-store'

/**
 * Marketing homepage. Asymmetric hero (60/40 split: animated chat widget on
 * the start side, narrow column with positioning + CTA on the end side),
 * followed by the differentiators section and a final CTA strip.
 *
 * The hero is NOT centered — that's the explicit creative direction.
 */
export function MarketingHome() {
  const t = useTranslations('marketing.home')
  const { open } = useAuthModal()

  return (
    <>
      {/* ============ HERO — asymmetric 60/40 split ============ */}
      <section className="relative overflow-hidden">
        {/* Ambient brand wash — saffron + turquoise blobs */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
        >
          <div className="absolute -top-32 start-[-10%] h-[28rem] w-[28rem] rounded-full bg-saffron/15 blur-3xl" />
          <div className="absolute -bottom-32 end-[-5%] h-[24rem] w-[24rem] rounded-full bg-turquoise/10 blur-3xl" />
        </div>

        <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[3fr_2fr] lg:gap-12 lg:px-8 lg:py-24">
          {/* Left (60%): the animated chat widget mockup */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="order-2 lg:order-1"
          >
            <ChatWidgetMockup />
          </motion.div>

          {/* Right (40%): narrow column with product name + positioning + CTA */}
          <motion.div
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
            className="order-1 flex flex-col gap-6 lg:order-2"
          >
            <div>
              {/* Kicker */}
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-saffron">
                {t('kicker')}
              </p>

              {/* Title — bilingual-aware typography */}
              <h1 className="font-display text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl lg:text-[2.75rem]">
                {t('title')}
              </h1>

              {/* Positioning subtitle */}
              <p className="mt-4 text-base text-muted-foreground sm:text-lg">
                {t('subtitle')}
              </p>
            </div>

            {/* CTA — anchored to the bottom of the column on lg */}
            <div className="mt-2 flex flex-col gap-3 lg:mt-auto">
              <Button
                onClick={() => open('signup')}
                size="lg"
                className="bg-saffron text-saffron-foreground hover:bg-saffron/90"
              >
                {t('cta')}
              </Button>
              <Button
                onClick={() => open('login')}
                size="sm"
                variant="link"
                className="text-muted-foreground hover:text-foreground"
              >
                {t('loginLink')}
              </Button>
            </div>
          </motion.div>
        </div>

        {/* Scroll hint */}
        <div className="mx-auto hidden max-w-7xl px-4 pb-8 sm:flex sm:px-6 lg:px-8">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            {t('scrollHint')}
          </p>
        </div>
      </section>

      {/* ============ BELOW THE FOLD ============ */}
      <Differentiators />

      <CtaStrip />
    </>
  )
}
