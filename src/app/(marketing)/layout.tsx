import type { Metadata } from 'next'
import { MarketingNav } from '@/components/marketing/marketing-nav'
import { MarketingFooter } from '@/components/marketing/marketing-footer'
import { AuthModal } from '@/components/marketing/auth-modal'

export const metadata: Metadata = {
  title: 'Sukhan — Live chat, built for two markets',
  description:
    'Bilingual live chat and customer messaging platform. Persian-first, English-ready, open-core under AGPL-3.0.',
}

/**
 * Shared layout for the marketing route group: /features, /pricing,
 * /self-hosting. Provides nav + footer + auth modal.
 *
 * NOTE: the marketing homepage lives at / (not in this group), so it
 * renders its own copy of the nav + footer. The (marketing) group only
 * contains the sub-pages.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <MarketingNav />
      <main className="flex flex-1 flex-col">{children}</main>
      <MarketingFooter />
      <AuthModal />
    </>
  )
}
