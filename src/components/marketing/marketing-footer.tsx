'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { MessageSquareText, Github, Scale } from 'lucide-react'

/**
 * Footer for all marketing pages. Renders nav link columns (Product,
 * Resources, Legal) + the AGPL notice + copyright.
 *
 * This is rendered INSIDE the page content area (above the AppShell's tiny
 * AGPL strip) on marketing routes. On non-marketing routes (e.g. the
 * dashboard), it is not rendered.
 */
export function MarketingFooter() {
  const t = useTranslations('marketing.footer')
  const tNav = useTranslations('marketing.nav')

  return (
    <footer className="mt-16 border-t border-border bg-card/30">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6 lg:grid-cols-4 lg:px-8">
        {/* Brand */}
        <div className="col-span-2 sm:col-span-3 lg:col-span-1">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-ink-foreground">
              <MessageSquareText className="h-4 w-4" />
            </div>
            <span className="font-display text-base font-semibold tracking-tight">
              Sukhan
            </span>
          </Link>
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">
            {t('tagline')}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t('license')}
            >
              <Scale className="h-3.5 w-3.5" />
              AGPL-3.0
            </a>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t('sourceCode')}
            >
              <Github className="h-3.5 w-3.5" />
              {t('sourceCode')}
            </a>
          </div>
        </div>

        {/* Product column */}
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('product')}
          </h3>
          <ul className="space-y-2 text-sm">
            <li>
              <Link
                href="/features"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {tNav('features')}
              </Link>
            </li>
            <li>
              <Link
                href="/pricing"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {tNav('pricing')}
              </Link>
            </li>
            <li>
              <Link
                href="/self-hosting"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {tNav('selfHost')}
              </Link>
            </li>
          </ul>
        </div>

        {/* Resources column */}
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('resources')}
          </h3>
          <ul className="space-y-2 text-sm">
            <li>
              <a
                href="/self-hosting"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('selfHostGuide')}
              </a>
            </li>
            <li>
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('sourceCode')}
              </a>
            </li>
          </ul>
        </div>

        {/* Legal column */}
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('legal')}
          </h3>
          <ul className="space-y-2 text-sm">
            <li>
              <a
                href="https://www.gnu.org/licenses/agpl-3.0.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('license')}
              </a>
            </li>
            <li>
              <Link
                href="/self-hosting"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('selfHostGuide')}
              </Link>
            </li>
          </ul>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <p>
            © {new Date().getFullYear()} Sukhan. {t('rights')}
          </p>
          <p className="text-center sm:text-end">{t('agplNotice')}</p>
        </div>
      </div>
    </footer>
  )
}
