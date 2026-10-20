'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useTranslations, useLocale } from 'next-intl'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LoadingScreen } from '@/components/loading-screen'
import { AuthModal } from '@/components/marketing/auth-modal'
import { useAuthModal } from '@/components/marketing/auth-modal-store'
import {
  MessageSquareText,
  Mail,
  Users,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogIn,
} from 'lucide-react'
import { toast } from 'sonner'

/**
 * Invitation acceptance landing page (PR #11).
 *
 * Flow:
 *   1. The inviter creates an invitation in the dashboard; the API returns
 *      the raw token EXACTLY ONCE in `inviteUrl`. The inviter shares the
 *      link with the invitee (via email, IM, etc.).
 *   2. The invitee opens `/invite?token=<rawToken>`. This page calls the
 *      PUBLIC `GET /api/invitations/<token>` endpoint (no auth required)
 *      to render the invitation card BEFORE the user decides to sign in.
 *   3. If the user is not signed in, the "Sign in to accept" button opens
 *      the auth modal with `callbackUrl` set to the current URL — so
 *      after a successful sign-in the modal lands them right back here.
 *   4. Once signed in, the session user's email MUST match the invited
 *      email (case-insensitive). The accept endpoint enforces this
 *      server-side; we mirror the check client-side for fast feedback.
 *   5. On accept, POST /api/invitations/accept with `{ token }`. The
 *      backend atomically: marks the invitation 'accepted' (conditional
 *      on `status='pending'` — concurrent accepts return
 *      'already_accepted' idempotently), and creates the active
 *      Membership in the same transaction (P2002 catch → 'already_member'
 *      idempotent outcome).
 *   6. After acceptance, we call /api/auth/switch-workspace with the new
 *      workspaceId so the invitee lands INSIDE their new workspace
 *      instead of staying in the old one. Then a hard `reload()` ensures
 *      the new session JWT (with the new workspaceId) is honoured
 *      throughout the dashboard — inbox, socket, tenant-scoped queries
 *      all need the fresh token.
 *
 * ERROR HANDLING — the public lookup endpoint returns the SAME 404 error
 * for "not found" / "expired" / "revoked" / "already accepted" so an
 * attacker cannot distinguish the failure modes. The accept endpoint,
 * by contrast, returns specific errors ('already_accepted', 'revoked',
 * 'expired', 'email_mismatch') — those are surfaced as actionable toasts.
 */

type InvitationInfo = {
  workspaceName: string
  role: string
  email: string
  expiresAt: string
}

type FetchState = 'loading' | 'not_found' | 'ok'

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'long',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

function InvitePageInner() {
  const t = useTranslations('invite')
  const tc = useTranslations('common')
  // No-namespace translator — needed for cross-namespace lookups like
  // `settings.roles.<role>` which lives outside `common` / `invite`.
  const tt = useTranslations()
  const locale = useLocale()
  const searchParams = useSearchParams()
  const token = searchParams?.get('token') ?? ''
  const { data: session, status } = useSession()
  const { open } = useAuthModal()
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null)
  const [fetchState, setFetchState] = useState<FetchState>('loading')
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFetchState('not_found')
      return
    }
    let cancelled = false
    setFetchState('loading')
    fetch(`/api/invitations/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          // 404 for any non-acceptable state — see file header.
          setFetchState('not_found')
          return
        }
        const data = (await res.json()) as InvitationInfo
        setInvitation(data)
        setFetchState('ok')
      })
      .catch(() => {
        if (!cancelled) setFetchState('not_found')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function onAccept() {
    if (!token) return
    setAccepting(true)
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = data?.error
        if (err === 'email_mismatch') {
          toast.error(t('emailMismatch'))
        } else if (err === 'already_accepted') {
          toast.error(t('alreadyAccepted'))
        } else if (err === 'revoked') {
          toast.error(t('revoked'))
        } else if (err === 'expired') {
          toast.error(t('expired'))
        } else if (err === 'unauthorized') {
          toast.error(t('mustSignIn'))
        } else {
          toast.error(t('acceptFailed'))
        }
        setAccepting(false)
        return
      }

      // Acceptance succeeded — the backend returns the new workspaceId.
      // Switch to it so the invitee lands INSIDE their new workspace, then
      // hard-reload so the fresh session JWT is honoured everywhere.
      const workspaceId = data.workspaceId
      if (workspaceId) {
        try {
          await fetch('/api/auth/switch-workspace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          })
        } catch {
          // Non-fatal — the membership is active, the user can switch
          // later from the workspace menu. Continue to reload so they
          // at least see the dashboard refreshed.
        }
      }
      setAccepted(true)
      // Brief tick so the success state is visible before the reload.
      setTimeout(() => window.location.replace('/'), 700)
    } catch {
      toast.error(t('acceptFailed'))
      setAccepting(false)
    }
  }

  // ---------- render ----------

  if (fetchState === 'loading') {
    return <LoadingScreen />
  }

  if (fetchState === 'not_found' || !invitation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('notFoundTitle')}
        </h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {t('notFoundHint')}
        </p>
        <Button variant="outline" onClick={() => window.location.assign('/')}>
          {tc('back')}
        </Button>
      </div>
    )
  }

  // ----- invitation is valid (pending, not expired) -----
  const sessionEmail = session?.user?.email?.toLowerCase() ?? ''
  const invitedEmail = invitation.email.toLowerCase()
  const emailMatches = !!sessionEmail && sessionEmail === invitedEmail

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
      {/* Brand mark — same as the loading screen, kept consistent. */}
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-ink-foreground">
          <MessageSquareText className="h-5 w-5" />
        </div>
        <span className="font-display text-lg font-semibold">{tc('appName')}</span>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-turquoise/15 text-turquoise-foreground">
            <Users className="h-5 w-5" />
          </div>
          <CardTitle className="font-display text-xl">
            {t('title', { workspace: invitation.workspaceName })}
          </CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">{t('workspaceLabel')}</dt>
              <dd className="font-medium text-end">{invitation.workspaceName}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">{t('roleLabel')}</dt>
              <dd className="font-medium">{tt(`settings.roles.${invitation.role}` as any) || invitation.role}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">{t('invitedEmailLabel')}</dt>
              <dd className="font-mono text-xs" dir="ltr">{invitation.email}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">{t('expiresLabel')}</dt>
              <dd className="text-xs" dir="ltr">{fmtDate(invitation.expiresAt)}</dd>
            </div>
          </dl>

          {accepted ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-turquoise/40 bg-turquoise/10 p-4 text-center">
              <CheckCircle2 className="h-6 w-6 text-turquoise-foreground" />
              <p className="text-sm font-medium">{t('acceptedTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('acceptedHint')}</p>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : status === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tc('loading')}
            </div>
          ) : status === 'unauthenticated' ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t('mustSignInHint')}</p>
              <Button
                className="gap-2"
                onClick={() => open('login', window.location.href)}
              >
                <LogIn className="h-4 w-4" />
                {t('signInToAccept')}
              </Button>
            </div>
          ) : emailMatches ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">{t('readyToAcceptHint')}</p>
              <Button className="gap-2" disabled={accepting} onClick={onAccept}>
                {accepting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {t('acceptInvitation')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-destructive">
                    {t('emailMismatchTitle')}
                  </p>
                  <p className="text-muted-foreground">{t('emailMismatchHint')}</p>
                </div>
              </div>
              <dl className="mt-1 space-y-1 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('invitedEmailLabel')}</dt>
                  <dd className="font-mono" dir="ltr">{invitation.email}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('signedInEmailLabel')}</dt>
                  <dd className="font-mono" dir="ltr">{session?.user?.email}</dd>
                </div>
              </dl>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 gap-2 self-start"
                onClick={() => window.location.assign('/')}
              >
                {locale === 'fa' ? 'بازگشت به خانه' : 'Back to home'}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Mail className="h-3 w-3" />
            <span>{t('securityHint')}</span>
          </div>
        </CardContent>
      </Card>

      {/* The auth modal is rendered locally so the invitee can sign in
          without leaving the invitation page. The store's callbackUrl is
          set to window.location.href before opening — see onAccept above. */}
      <AuthModal />
    </div>
  )
}

export default function InvitePage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <InvitePageInner />
    </Suspense>
  )
}
