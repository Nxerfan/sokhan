'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { MessageSquareText, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { useAuthModal } from '@/components/marketing/auth-modal-store'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { href: '/features', key: 'features' },
  { href: '/pricing', key: 'pricing' },
  { href: '/self-hosting', key: 'selfHost' },
] as const

/**
 * Top navigation bar for all marketing pages. Includes:
 * - Brand mark + name (links to /)
 * - Primary nav links (Features, Pricing, Self-hosting)
 * - Locale switcher + theme toggle
 * - CTA: "Log in" / "Sign up" (or "Go to dashboard" when authenticated)
 *
 * The marketing nav lives at the top of every marketing page. The dashboard
 * has its own NavRail (see src/components/dashboard/nav-rail.tsx).
 */
export function MarketingNav() {
  const t = useTranslations('marketing.nav')
  const pathname = usePathname()
  const { data: session } = useSession()
  const { open } = useAuthModal()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Left: brand + nav */}
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            aria-label={t('dashboard')}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-ink-foreground">
              <MessageSquareText className="h-4 w-4" />
            </div>
            <span className="font-display text-base font-semibold tracking-tight">
              Sukhan
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {t(link.key)}
                </Link>
              )
            })}
          </nav>
        </div>

        {/* Right: locale/theme + CTAs */}
        <div className="flex items-center gap-1.5">
          <div className="hidden items-center gap-1 sm:flex">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>

          {session ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/">{t('dashboard')}</Link>
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => open('login')}
                className="hidden sm:inline-flex"
              >
                {t('login')}
              </Button>
              <Button
                size="sm"
                onClick={() => open('signup')}
                className="bg-saffron text-saffron-foreground hover:bg-saffron/90"
              >
                {t('signup')}
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? t('closeMenu') : t('openMenu')}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="border-t border-border bg-background md:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3 sm:px-6">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {t(link.key)}
                </Link>
              )
            })}
            <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
              <div className="flex items-center gap-1">
                <LocaleSwitcher />
                <ThemeToggle />
              </div>
              {session ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href="/" onClick={() => setMobileOpen(false)}>
                    {t('dashboard')}
                  </Link>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setMobileOpen(false)
                    open('login')
                  }}
                >
                  {t('login')}
                </Button>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}
