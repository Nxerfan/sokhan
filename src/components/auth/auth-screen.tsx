'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useTranslations } from 'next-intl'
import { MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'

type Mode = 'login' | 'signup'

export function AuthScreen() {
  const t = useTranslations()
  const [mode, setMode] = useState<Mode>('signup')
  const [loading, setLoading] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      if (mode === 'signup') {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name, workspaceName }),
        })
        const data = await res.json()
        if (!res.ok) {
          toast.error(data.error ?? 'Signup failed')
          setLoading(false)
          return
        }
      }
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })
      if (result?.error) {
        toast.error(t('auth.invalidCredentials'))
        setLoading(false)
        return
      }
      // Force a full page navigation so the server re-evaluates the session
      // cookie and renders the dashboard. router.replace('/') + router.refresh()
      // is NOT sufficient here because page.tsx is a Client Component using
      // useSession() — router.refresh() only re-fetches Server Components and
      // does not invalidate the client-side useSession cache, so the page
      // keeps rendering <AuthScreen/> and the button hangs in loading forever.
      // This was the signup-hang bug. See worklog Task ID 2.
      window.location.href = '/'
    } catch {
      toast.error('Something went wrong')
      setLoading(false)
    }
  }

  const slugPreview = workspaceName
    ? workspaceName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'workspace'
    : 'workspace'

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

          <form onSubmit={onSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div className="space-y-2">
                <Label htmlFor="name">{t('auth.name')}</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                dir="ltr"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                dir="ltr"
                minLength={6}
              />
            </div>
            {mode === 'signup' && (
              <div className="space-y-2">
                <Label htmlFor="workspace">{t('auth.workspaceName')}</Label>
                <Input
                  id="workspace"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground" dir="ltr">
                  /<span className="text-turquoise">{slugPreview}</span>
                </p>
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-ink text-ink-foreground hover:bg-ink/90"
              disabled={loading}
            >
              {loading
                ? t('common.loading')
                : mode === 'login'
                  ? t('auth.login')
                  : t('auth.signup')}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
              className="font-medium text-turquoise underline-offset-4 hover:underline"
            >
              {mode === 'login' ? t('auth.createOne') : t('auth.signInInstead')}
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t('auth.demoNote')}
        </p>
      </div>
    </div>
  )
}
