'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useAuthModal } from '@/components/marketing/auth-modal-store'
import type { AuthMode } from '@/components/marketing/auth-modal-store'

interface AuthFormProps {
  /** Initial mode (login or signup). */
  initialMode?: AuthMode
  /** Called when auth succeeds (before the page reloads). */
  onSuccess?: () => void
  /** When true, uses a compact layout suitable for a dialog. */
  compact?: boolean
}

/**
 * The actual auth form. Shared between the full-page AuthScreen and the
 * marketing AuthModal. Self-contained: holds all form state and submits via
 * /api/auth/signup + next-auth signIn.
 */
export function AuthForm({
  initialMode = 'signup',
  onSuccess,
  compact = false,
}: AuthFormProps) {
  const t = useTranslations()
  const { setMode: setStoreMode } = useAuthModal()
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [loading, setLoading] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')

  function switchMode(next: AuthMode) {
    setMode(next)
    setStoreMode(next)
  }

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
      // See auth-screen.tsx for the rationale: a hard navigation is the only
      // thing that reliably re-evaluates the session cookie for a Client
      // Component page that uses useSession().
      onSuccess?.()
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

      <div
        className={
          compact
            ? 'text-center text-sm text-muted-foreground'
            : 'mt-2 text-center text-sm text-muted-foreground'
        }
      >
        {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
        <button
          type="button"
          onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
          className="font-medium text-turquoise underline-offset-4 hover:underline"
        >
          {mode === 'login' ? t('auth.createOne') : t('auth.signInInstead')}
        </button>
      </div>
    </form>
  )
}
