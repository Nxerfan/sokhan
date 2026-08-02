'use client'

import { SessionProviderWrap } from '@/components/session-provider'
import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'

/**
 * AppShell: structural wrapper that provides the session context and enforces
 * the sticky-footer layout contract (min-h-screen flex col, footer mt-auto).
 * The auth-vs-dashboard decision is made inside `app/page.tsx` via useSession.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProviderWrap>
      <div className="flex min-h-screen flex-col">
        <div className="flex-1 flex flex-col">{children}</div>
        <AppFooter />
      </div>
    </SessionProviderWrap>
  )
}

function AppFooter() {
  const t = useTranslations('footer')
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
