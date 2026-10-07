'use client'

import { useState, useRef, useEffect } from 'react'
import { signIn } from 'next-auth/react'
import { useTranslations, useLocale } from 'next-intl'
import { Loader2, ArrowLeft, ArrowRight } from 'lucide-react'
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

type SignupStep = 'email' | 'otp' | 'complete'

/**
 * The actual auth form. Shared between the full-page AuthScreen and the
 * marketing AuthModal.
 *
 * Login mode: password-based via next-auth `signIn('credentials', ...)`.
 * Signup mode: 3-step OTP flow (start → verify → complete). The legacy
 *   `/api/auth/signup` bypass has been removed — all signup MUST go
 *   through OTP verification.
 */
export function AuthForm({
  initialMode = 'signup',
  onSuccess,
  compact = false,
}: AuthFormProps) {
  const t = useTranslations()
  const locale = useLocale()
  const { setMode: setStoreMode } = useAuthModal()
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [loading, setLoading] = useState(false)

  // Login state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // Signup OTP state
  const [signupStep, setSignupStep] = useState<SignupStep>('email')
  const [email, setEmail] = useState('')
  const [requestId, setRequestId] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [password, setPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [resendCount, setResendCount] = useState(0)
  const [countdown, setCountdown] = useState(600)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (signupStep === 'otp' && countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [signupStep, countdown])

  function switchMode(next: AuthMode) {
    setMode(next)
    setStoreMode(next)
    setSignupStep('email')
  }

  // ---- Login ----
  async function onLoginSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await signIn('credentials', {
        email: loginEmail,
        password: loginPassword,
        redirect: false,
      })
      if (result?.error) {
        toast.error(t('auth.invalidCredentials'))
        setLoading(false)
        return
      }
      onSuccess?.()
      window.location.href = '/'
    } catch {
      toast.error('Something went wrong')
      setLoading(false)
    }
  }

  // ---- Signup Step 1: send OTP ----
  async function onSendOtp(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(
          data.error === 'email_already_registered'
            ? (locale === 'fa' ? 'ایمیل قبلاً ثبت شده' : 'Email already registered')
            : data.error,
        )
        setLoading(false)
        return
      }
      setRequestId(data.requestId)
      setSignupStep('otp')
      setCountdown(600)
    } catch {
      toast.error('Error')
    } finally {
      setLoading(false)
    }
  }

  // ---- Signup Step 2: verify OTP ----
  async function onVerifyOtp() {
    const code = otp.join('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, requestId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(
          data.error === 'code_mismatch'
            ? (locale === 'fa' ? 'کد اشتباه است' : 'Invalid code')
            : data.error === 'expired'
              ? (locale === 'fa' ? 'کد منقضی شده' : 'Code expired')
              : data.error,
        )
        setLoading(false)
        return
      }
      setSignupStep('complete')
    } finally {
      setLoading(false)
    }
  }

  // ---- Signup Step 3: complete (create account) ----
  async function onCompleteSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, requestId, password, workspaceName }),
      })
      if (!res.ok) {
        const data = await res.json()
        toast.error(data.error)
        setLoading(false)
        return
      }
      // Sign in with the new credentials
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })
      if (result?.error) {
        toast.error(locale === 'fa' ? 'ورود ناموفق' : 'Login failed')
        setLoading(false)
        return
      }
      onSuccess?.()
      window.location.href = '/'
    } catch {
      toast.error('Something went wrong')
      setLoading(false)
    }
  }

  async function onResendOtp() {
    if (resendCount >= 3) return
    setLoading(true)
    try {
      const res = await fetch('/api/auth/otp/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, purpose: 'signup', originalRequestId: requestId }),
      })
      const data = await res.json()
      if (res.ok) {
        setRequestId(data.requestId)
        setResendCount(c => c + 1)
        setCountdown(600)
        toast.success(locale === 'fa' ? 'کد ارسال شد' : 'Code sent')
      } else {
        toast.error(data.error)
      }
    } finally {
      setLoading(false)
    }
  }

  function handleOtpChange(idx: number, value: string) {
    if (!/^\d?$/.test(value)) return
    const newOtp = [...otp]
    newOtp[idx] = value
    setOtp(newOtp)
    if (value && idx < 5) otpRefs.current[idx + 1]?.focus()
  }

  function handleOtpKeyDown(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus()
    }
  }

  const slugPreview = workspaceName
    ? workspaceName.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'workspace'
    : 'workspace'

  const mins = Math.floor(countdown / 60)
  const secs = countdown % 60

  // ===== LOGIN =====
  if (mode === 'login') {
    return (
      <form onSubmit={onLoginSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.email')}</Label>
          <Input
            id="email"
            type="email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
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
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            required
            autoComplete="current-password"
            dir="ltr"
            minLength={6}
          />
        </div>
        <Button
          type="submit"
          className="w-full bg-ink text-ink-foreground hover:bg-ink/90"
          disabled={loading}
        >
          {loading ? t('common.loading') : t('auth.login')}
        </Button>
        <div className={compact ? 'text-center text-sm text-muted-foreground' : 'mt-2 text-center text-sm text-muted-foreground'}>
          {t('auth.noAccount')}{' '}
          <button
            type="button"
            onClick={() => switchMode('signup')}
            className="font-medium text-turquoise underline-offset-4 hover:underline"
          >
            {t('auth.createOne')}
          </button>
        </div>
      </form>
    )
  }

  // ===== SIGNUP (OTP 3-step flow) =====
  return (
    <div className="space-y-4">
      {/* Step indicator */}
      <div className="mb-2 flex items-center gap-2">
        {[1, 2, 3].map(n => (
          <div key={n} className={`h-1.5 flex-1 rounded-full transition-colors ${
            (signupStep === 'email' && n === 1) || (signupStep === 'otp' && n <= 2) || (signupStep === 'complete' && n <= 3) ? 'bg-saffron' : 'bg-muted'
          }`} />
        ))}
      </div>

      {signupStep === 'email' && (
        <form onSubmit={onSendOtp} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="signup-email">{t('auth.email')}</Label>
            <Input
              id="signup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              dir="ltr"
            />
          </div>
          <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'ادامه' : 'Continue')}
          </Button>
        </form>
      )}

      {signupStep === 'otp' && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setSignupStep('email')}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {locale === 'fa' ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
            {locale === 'fa' ? 'تغییر ایمیل' : 'Change email'}
          </button>
          <div>
            <h3 className="font-display text-lg font-semibold mb-1">
              {locale === 'fa' ? 'کد تایید' : 'Verification code'}
            </h3>
            <p className="text-sm text-muted-foreground mb-2">
              {locale === 'fa' ? `کد ۶ رقمی به ${email} ارسال شد` : `6-digit code sent to ${email}`}
            </p>
            {countdown > 0 && (
              <p className="text-xs text-muted-foreground mb-3">
                {locale === 'fa' ? `منقضی در ${mins}:${secs.toString().padStart(2, '0')}` : `Expires in ${mins}:${secs.toString().padStart(2, '0')}`}
              </p>
            )}
          </div>
          <div className="flex gap-2 justify-center" dir="ltr">
            {otp.map((digit, idx) => (
              <input
                key={idx}
                ref={el => { otpRefs.current[idx] = el }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={e => handleOtpChange(idx, e.target.value)}
                onKeyDown={e => handleOtpKeyDown(idx, e)}
                className="h-12 w-12 rounded-xl border border-border bg-background text-center text-lg font-medium focus:border-saffron focus:outline-none focus:ring-2 focus:ring-saffron/20"
              />
            ))}
          </div>
          <Button
            type="button"
            onClick={onVerifyOtp}
            className="w-full bg-ink text-ink-foreground hover:bg-ink/90"
            disabled={loading || otp.join('').length !== 6}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'تایید' : 'Verify')}
          </Button>
          <button
            type="button"
            onClick={onResendOtp}
            disabled={resendCount >= 3 || loading}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {locale === 'fa' ? 'ارسال مجدد کد' : 'Resend code'}
            {resendCount > 0 && ` (${3 - resendCount} ${locale === 'fa' ? 'باقی‌مانده' : 'left'})`}
          </button>
        </div>
      )}

      {signupStep === 'complete' && (
        <form onSubmit={onCompleteSignup} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="signup-password">{t('auth.password')}</Label>
            <Input
              id="signup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              dir="ltr"
              minLength={6}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-workspace">{t('auth.workspaceName')}</Label>
            <Input
              id="signup-workspace"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground" dir="ltr">
              /<span className="text-turquoise">{slugPreview}</span>
            </p>
          </div>
          <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('auth.signup')}
          </Button>
        </form>
      )}

      <div className={compact ? 'text-center text-sm text-muted-foreground' : 'mt-2 text-center text-sm text-muted-foreground'}>
        {t('auth.haveAccount')}{' '}
        <button
          type="button"
          onClick={() => switchMode('login')}
          className="font-medium text-turquoise underline-offset-4 hover:underline"
        >
          {t('auth.signInInstead')}
        </button>
      </div>
    </div>
  )
}
