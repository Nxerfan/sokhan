'use client'

import { useTranslations } from 'next-intl'
import { MessageSquareText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { AuthForm } from '@/components/auth/auth-form'
import { useAuthModal } from '@/components/marketing/auth-modal-store'

/**
 * Global auth modal. Mounted once at the marketing layout root. Any "Sign up"
 * / "Log in" button in the marketing site calls `useAuthModal().open(mode)`.
 */
export function AuthModal() {
  const t = useTranslations()
  const { isOpen, mode, close } = useAuthModal()

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (o ? null : close())}>
      <DialogContent
        className="max-w-md gap-0 p-0 sm:max-w-md"
        // Prevent the dialog from closing on outside-click while loading —
        // the form will set window.location.href on success.
        onEscapeKeyDown={close}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        {/* Header with brand mark + locale/theme controls */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
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

        {/* Body */}
        <div className="px-6 py-6">
          <div className="mb-5">
            <h2 className="font-display text-xl font-semibold tracking-tight">
              {mode === 'login'
                ? t('auth.loginTitle')
                : t('auth.signupTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === 'login'
                ? t('auth.loginSubtitle')
                : t('auth.signupSubtitle')}
            </p>
          </div>

          <AuthForm initialMode={mode} compact />
        </div>

        <div className="border-t border-border px-6 py-3">
          <p className="text-center text-xs text-muted-foreground">
            {t('auth.demoNote')}
          </p>
        </div>

        {/* Accessible title + description (Radix requires a DialogTitle).
            We hide them visually because we render our own heading above. */}
        <span className="sr-only">
          <DialogTitle>
            {mode === 'login' ? t('auth.loginTitle') : t('auth.signupTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'login'
              ? t('auth.loginSubtitle')
              : t('auth.signupSubtitle')}
          </DialogDescription>
        </span>
      </DialogContent>
    </Dialog>
  )
}
