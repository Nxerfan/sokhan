'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { signIn } from 'next-auth/react'
import { MessageSquareText, Mail, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'

type Step = 'email' | 'otp' | 'complete'

export function OtpSignupScreen() {
  const t = useTranslations()
  const locale = useLocale()
  const [step, setStep] = useState<Step>('email')
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [requestId, setRequestId] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [password, setPassword] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [resendCount, setResendCount] = useState(0)
  const [countdown, setCountdown] = useState(600)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (step === 'otp' && countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [step, countdown])

  async function sendOtp() {
    setLoading(true)
    try {
      const res = await fetch('/api/auth/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error === 'email_already_registered' ? (locale === 'fa' ? 'ایمیل قبلاً ثبت شده' : 'Email already registered')
          : data.error === 'free_trial_already_used' ? (locale === 'fa' ? 'اشتراک رایگان قبلاً استفاده شده' : 'Free trial already used')
          : data.error)
        return
      }
      setRequestId(data.requestId)
      setStep('otp')
      setCountdown(600)
    } catch {
      toast.error('Error')
    } finally {
      setLoading(false)
    }
  }

  async function verifyOtp() {
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
        toast.error(data.error === 'code_mismatch' ? (locale === 'fa' ? 'کد اشتباه است' : 'Invalid code')
          : data.error === 'expired' ? (locale === 'fa' ? 'کد منقضی شده' : 'Code expired')
          : data.error)
        return
      }
      setStep('complete')
    } finally {
      setLoading(false)
    }
  }

  async function resendOtp() {
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
        toast.error(data.error === 'resend_limit_reached' ? (locale === 'fa' ? 'حداکثر تلاش مجاز' : 'Resend limit reached') : data.error)
      }
    } finally {
      setLoading(false)
    }
  }

  async function completeSignup() {
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
        return
      }
      // Sign in with credentials
      const result = await signIn('credentials', { email, password, redirect: false })
      if (result?.error) {
        toast.error(locale === 'fa' ? 'ورود ناموفق' : 'Login failed')
        return
      }
      window.location.href = '/'
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

  return (
    <div className="relative flex flex-1 items-center justify-center px-4 py-10">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 start-1/4 h-72 w-72 rounded-full bg-saffron/20 blur-3xl" />
        <div className="absolute -bottom-24 end-1/4 h-72 w-72 rounded-full bg-turquoise/20 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
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

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          {/* Step indicator */}
          <div className="mb-6 flex items-center gap-2">
            {[1, 2, 3].map(n => (
              <div key={n} className={`h-1.5 flex-1 rounded-full transition-colors ${
                (step === 'email' && n === 1) || (step === 'otp' && n <= 2) || (step === 'complete' && n <= 3) ? 'bg-saffron' : 'bg-muted'
              }`} />
            ))}
          </div>

          {step === 'email' && (
            <>
              <h1 className="font-display text-2xl font-semibold tracking-tight mb-2">
                {locale === 'fa' ? 'ساخت فضای کاری' : 'Create workspace'}
              </h1>
              <p className="text-sm text-muted-foreground mb-6">
                {locale === 'fa' ? 'ابتدا ایمیل خود را وارد کنید. کد تایید برای شما ارسال می‌شود.' : 'Enter your email. A verification code will be sent.'}
              </p>
              <form onSubmit={(e) => { e.preventDefault(); sendOtp() }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t('auth.email')}</Label>
                  <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} required dir="ltr" />
                </div>
                <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'ادامه' : 'Continue')}
                </Button>
              </form>
            </>
          )}

          {step === 'otp' && (
            <>
              <button onClick={() => setStep('email')} className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                {locale === 'fa' ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
                {locale === 'fa' ? 'تغییر ایمیل' : 'Change email'}
              </button>
              <h1 className="font-display text-2xl font-semibold tracking-tight mb-2">
                {locale === 'fa' ? 'کد تایید' : 'Verification code'}
              </h1>
              <p className="text-sm text-muted-foreground mb-4">
                {locale === 'fa' ? `کد ۶ رقمی به ${email} ارسال شد` : `6-digit code sent to ${email}`}
              </p>
              {countdown > 0 && (
                <p className="text-xs text-muted-foreground mb-4">
                  {locale === 'fa' ? `منقضی در ${mins}:${secs.toString().padStart(2, '0')}` : `Expires in ${mins}:${secs.toString().padStart(2, '0')}`}
                </p>
              )}
              <div className="flex gap-2 justify-center mb-6" dir="ltr">
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
              <Button onClick={verifyOtp} className="w-full bg-ink text-ink-foreground hover:bg-ink/90 mb-3" disabled={loading || otp.join('').length !== 6}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'تایید' : 'Verify')}
              </Button>
              <button
                onClick={resendOtp}
                disabled={resendCount >= 3 || loading}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {locale === 'fa' ? 'ارسال مجدد کد' : 'Resend code'}
                {resendCount > 0 && ` (${3 - resendCount} ${locale === 'fa' ? 'باقی‌مانده' : 'left'})`}
              </button>
            </>
          )}

          {step === 'complete' && (
            <>
              <h1 className="font-display text-2xl font-semibold tracking-tight mb-2">
                {locale === 'fa' ? 'تکمیل ثبت‌نام' : 'Complete signup'}
              </h1>
              <p className="text-sm text-muted-foreground mb-6">
                {locale === 'fa' ? 'رمز عبور و نام فضای کاری را وارد کنید.' : 'Set your password and workspace name.'}
              </p>
              <form onSubmit={(e) => { e.preventDefault(); completeSignup() }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required dir="ltr" minLength={6} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="workspace">{t('auth.workspaceName')}</Label>
                  <Input id="workspace" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} required />
                  <p className="text-xs text-muted-foreground" dir="ltr">/{slugPreview}</p>
                </div>
                <Button type="submit" className="w-full bg-ink text-ink-foreground hover:bg-ink/90" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (locale === 'fa' ? 'ایجاد فضای کاری' : 'Create workspace')}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
