'use client'

import { useTranslations, useLocale } from 'next-intl'
import { MessageSquareText, Loader2, ArrowLeft, ArrowRight } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { signIn } from 'next-auth/react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useAuthModal } from '@/components/marketing/auth-modal-store'

/**
 * Global auth modal. Handles both OTP signup (3-step wizard) and password login.
 * The "Sign up" button opens the OTP signup flow.
 * The "Log in" button opens the password login form.
 */
export function AuthModal() {
  const t = useTranslations()
  const locale = useLocale()
  const { isOpen, mode, close } = useAuthModal()
  const [loading, setLoading] = useState(false)

  // OTP signup state
  const [otpStep, setOtpStep] = useState<'email' | 'otp' | 'complete'>('email')
  const [email, setEmail] = useState('')
  const [requestId, setRequestId] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [password, setPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [resendCount, setResendCount] = useState(0)
  const [countdown, setCountdown] = useState(600)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  // Login state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  useEffect(() => {
    if (otpStep === 'otp' && countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [otpStep, countdown])

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setOtpStep('email')
      setEmail('')
      setRequestId('')
      setOtp(['', '', '', '', '', ''])
      setPassword('')
      setWorkspaceName('')
      setResendCount(0)
      setLoginEmail('')
      setLoginPassword('')
    }
  }, [isOpen])

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.error === 'email_already_registered' ? (locale === 'fa' ? 'ایمیل قبلاً ثبت شده' : 'Email already registered')
          : data.error === 'free_trial_already_used' ? (locale === 'fa' ? 'اشتراک رایگان قبلاً استفاده شده' : 'Free trial already used')
          : data.error
        toast.error(msg)
        return
      }
      setRequestId(data.requestId)
      setOtpStep('otp')
      setCountdown(600)
    } catch { toast.error('Error') }
    finally { setLoading(false) }
  }

  async function handleVerifyOtp() {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: otp.join(''), requestId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error === 'code_mismatch' ? (locale === 'fa' ? 'کد اشتباه است' : 'Invalid code')
          : data.error === 'expired' ? (locale === 'fa' ? 'کد منقضی شده' : 'Code expired')
          : data.error)
        return
      }
      setOtpStep('complete')
    } finally { setLoading(false) }
  }

  async function handleResend() {
    if (resendCount >= 3) return
    setLoading(true)
    try {
      const res = await fetch('/api/auth/otp/resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, purpose: 'signup', originalRequestId: requestId }),
      })
      const data = await res.json()
      if (res.ok) { setRequestId(data.requestId); setResendCount(c => c + 1); setCountdown(600); toast.success(locale === 'fa' ? 'کد ارسال شد' : 'Code sent') }
      else { toast.error(data.error) }
    } finally { setLoading(false) }
  }

  async function handleComplete(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, requestId, password, workspaceName }),
      })
      if (!res.ok) { const d = await res.json(); toast.error(d.error); return }
      await signIn('credentials', { email, password, redirect: false })
      window.location.href = '/'
    } finally { setLoading(false) }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await signIn('credentials', { email: loginEmail, password: loginPassword, redirect: false })
      if (result?.error) { toast.error(locale === 'fa' ? 'ایمیل یا رمز اشتباه است' : 'Invalid credentials'); return }
      window.location.href = '/'
    } finally { setLoading(false) }
  }

  function handleOtpChange(idx: number, value: string) {
    if (!/^\d?$/.test(value)) return
    const newOtp = [...otp]; newOtp[idx] = value; setOtp(newOtp)
    if (value && idx < 5) otpRefs.current[idx + 1]?.focus()
  }

  const mins = Math.floor(countdown / 60)
  const secs = countdown % 60

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (o ? null : close())}>
      <DialogContent
        className="max-w-md gap-0 p-0 sm:max-w-md"
        onEscapeKeyDown={close}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-ink-foreground">
              <MessageSquareText className="h-5 w-5" />
            </div>
            <span className="font-display text-lg font-semibold">{t('common.appName')}</span>
          </div>
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          {mode === 'signup' ? (
            <>
              {/* Step indicator */}
              <div className="mb-6 flex items-center gap-2">
                {[1, 2, 3].map(n => (
                  <div key={n} className={`h-1.5 flex-1 rounded-full transition-colors ${
                    (otpStep === 'email' && n === 1) || (otpStep === 'otp' && n <= 2) || (otpStep === 'complete' && n <= 3) ? 'bg-saffron' : 'bg-muted'
                  }`} />
                ))}
              </div>

              {otpStep === 'email' && (
                <>
                  <h2 className="font-display text-xl font-semibold mb-2">{locale === 'fa' ? 'ساخت فضای کاری' : 'Create workspace'}</h2>
                  <p className="text-sm text-muted-foreground mb-5">{locale === 'fa' ? 'ابتدا ایمیل خود را وارد کنید.' : 'Enter your email to get started.'}</p>
                  <form onSubmit={handleSendOtp} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="otp-email">{t('auth.email')}</Label>
                      <Input id="otp-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required dir="ltr" />
                    </div>
                    <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'ادامه' : 'Continue')}
                    </Button>
                  </form>
                </>
              )}

              {otpStep === 'otp' && (
                <>
                  <button onClick={() => setOtpStep('email')} className="mb-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    {locale === 'fa' ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
                    {locale === 'fa' ? 'تغییر ایمیل' : 'Change email'}
                  </button>
                  <h2 className="font-display text-xl font-semibold mb-2">{locale === 'fa' ? 'کد تایید' : 'Verification code'}</h2>
                  <p className="text-sm text-muted-foreground mb-2">{locale === 'fa' ? `کد ۶ رقمی به ${email} ارسال شد` : `6-digit code sent to ${email}`}</p>
                  {countdown > 0 && <p className="text-xs text-muted-foreground mb-4">{locale === 'fa' ? `منقضی در ${mins}:${secs.toString().padStart(2, '0')}` : `Expires in ${mins}:${secs.toString().padStart(2, '0')}`}</p>}
                  <div className="flex gap-2 justify-center mb-5" dir="ltr">
                    {otp.map((digit, idx) => (
                      <input key={idx} ref={el => { otpRefs.current[idx] = el }} type="text" inputMode="numeric" maxLength={1} value={digit}
                        onChange={e => handleOtpChange(idx, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Backspace' && !otp[idx] && idx > 0) otpRefs.current[idx - 1]?.focus() }}
                        className="h-12 w-12 rounded-xl border border-border bg-background text-center text-lg font-medium focus:border-saffron focus:outline-none focus:ring-2 focus:ring-saffron/20" />
                    ))}
                  </div>
                  <Button onClick={handleVerifyOtp} className="w-full bg-ink text-ink-foreground hover:bg-ink/90 mb-3" disabled={loading || otp.join('').length !== 6}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'تایید' : 'Verify')}
                  </Button>
                  <button onClick={handleResend} disabled={resendCount >= 3 || loading} className="w-full text-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
                    {locale === 'fa' ? 'ارسال مجدد کد' : 'Resend code'}{resendCount > 0 && ` (${3 - resendCount} ${locale === 'fa' ? 'باقی‌مانده' : 'left'})`}
                  </button>
                </>
              )}

              {otpStep === 'complete' && (
                <>
                  <h2 className="font-display text-xl font-semibold mb-2">{locale === 'fa' ? 'تکمیل ثبت‌نام' : 'Complete signup'}</h2>
                  <p className="text-sm text-muted-foreground mb-5">{locale === 'fa' ? 'رمز عبور و نام فضای کاری را وارد کنید.' : 'Set your password and workspace name.'}</p>
                  <form onSubmit={handleComplete} className="space-y-4">
                    <div className="space-y-2"><Label htmlFor="otp-password">{t('auth.password')}</Label><Input id="otp-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required dir="ltr" minLength={6} /></div>
                    <div className="space-y-2"><Label htmlFor="otp-workspace">{t('auth.workspaceName')}</Label><Input id="otp-workspace" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} required /></div>
                    <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'ایجاد فضای کاری' : 'Create workspace')}
                    </Button>
                  </form>
                </>
              )}
            </>
          ) : (
            // Login mode
            <>
              <h2 className="font-display text-xl font-semibold mb-2">{t('auth.loginTitle')}</h2>
              <p className="text-sm text-muted-foreground mb-5">{t('auth.loginSubtitle')}</p>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2"><Label htmlFor="login-email">{t('auth.email')}</Label><Input id="login-email" type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required dir="ltr" /></div>
                <div className="space-y-2"><Label htmlFor="login-password">{t('auth.password')}</Label><Input id="login-password" type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required dir="ltr" /></div>
                <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('auth.login')}
                </Button>
              </form>
            </>
          )}
        </div>

        {/* Hidden a11y */}
        <span className="sr-only">
          <DialogTitle>{mode === 'login' ? t('auth.loginTitle') : t('auth.signupTitle')}</DialogTitle>
          <DialogDescription>{mode === 'login' ? t('auth.loginSubtitle') : t('auth.signupSubtitle')}</DialogDescription>
        </span>
      </DialogContent>
    </Dialog>
  )
}
