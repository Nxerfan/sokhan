'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MessageSquareText } from 'lucide-react'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { AuthForm } from '@/components/auth/auth-form'

type Mode = 'login' | 'signup'

/**
 * Full-page auth screen. Kept for backwards compatibility (e.g. existing
 * tests that reference <AuthScreen/>). The marketing site renders the
 * AuthForm inside a Dialog instead — see src/components/marketing/auth-modal.tsx.
 */
export function AuthScreen() {
  const t = useTranslations()
  const [mode, setMode] = useState<Mode>('signup')

  return (
    <div className="relative flex flex-1 items-center justify-center px-4 py-10">
      {/* ambient brand wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-24 start-1/4 h-72 w-72 rounded-full bg-saffron/20 blur-3xl" />
        <div className="absolute -bottom-24 end-1/4 h-72 w-72 rounded-full bg-turquoise/20 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-ink-foreground">
              <MessageSquareText className="h-5 w-5" />
            </div>
            <span className="font-display text-lg font-semibold">
              {t('common.appName')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {mode === 'login' ? t('auth.loginTitle') : t('auth.signupTitle')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === 'login'
                ? t('auth.loginSubtitle')
                : t('auth.signupSubtitle')}
            </p>
          </div>

          <AuthForm
            initialMode={mode}
            onSuccess={() => setMode('login')}
          />
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t('auth.demoNote')}
        </p>
      </div>
    </div>
  )
}
