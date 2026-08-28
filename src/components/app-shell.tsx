'use client'

import { SessionProviderWrap } from '@/components/session-provider'
import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'

/**
 * AppShell: structural wrapper that provides the session context and enforces
 * the sticky-footer layout contract (min-h-screen flex col, footer mt-auto).
 *
 * The AppShell footer (AGPL notice strip) is rendered ONLY when:
 *  - the user is on `/` AND authenticated (dashboard context)
 * Marketing routes (`/features`, `/pricing`, `/self-hosting`) and the
 * unauthenticated `/` (marketing homepage) provide their own richer
 * MarketingFooter.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProviderWrap>
      <div className="flex min-h-screen flex-col">
        <div className="flex flex-1 flex-col">{children}</div>
        <AppShellFooter />
      </div>
    </SessionProviderWrap>
  )
}

function AppShellFooter() {
  const t = useTranslations('footer')
  const pathname = usePathname() ?? '/'
  const { status } = useSession()

  const isMarketingSubPage =
    pathname === '/features' ||
    pathname === '/pricing' ||
    pathname === '/self-hosting'
  const isMarketingHome = pathname === '/' && status !== 'authenticated'

  if (isMarketingSubPage || isMarketingHome) return null

  return (
    <footer className="mt-auto border-t border-border bg-card/40 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
        <p>
          © {new Date().getFullYear()} {t('rights')}
        </p>
        <p className="text-center sm:text-end">{t('agplNotice')}</p>
      </div>
    </footer>
  )
}
