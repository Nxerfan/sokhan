'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UserPlus, Copy, Check, Trash2, Clock, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { VALID_ROLES, canManageRole } from '@/lib/authz'

type Member = {
  id: string
  role: string
  status: string
  user: { id: string; name: string | null; email: string }
}

type Invitation = {
  id: string
  email: string
  role: string
  status: string
  expiresAt: string
  createdAt?: string
}

/**
 * Members panel (PR #11 — invitation flow).
 *
 * The legacy `POST /api/members` endpoint is now a 410 Gone (see
 * `src/app/api/members/route.ts`). Invitations are created via
 * `POST /api/invitations`, which returns the RAW invitation token
 * EXACTLY ONCE in `inviteUrl`. The token is never persisted server-side
 * (only its SHA-256 hash is stored in `Invitation.tokenHash`), so the
 * UI must surface the link to the inviter immediately after creation
 * — there is no way to retrieve it again later.
 *
 * Role-authorisation helpers (`VALID_ROLES`, `canManageRole`) are
 * imported from `@/lib/authz` (the shared module lifted out of the
 * members route in PR #11) so the client and server agree on the same
 * assignable-role rules.
 */

export function MembersPanel() {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const { data: session } = useSession()
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingInvites, setLoadingInvites] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('agent')
  const [inviting, setInviting] = useState(false)
  /** Last-created invite link — surfaced exactly once after creation. */
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null)
  const [lastInviteEmail, setLastInviteEmail] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const actorRole = session?.user?.role

  /** Roles the current actor is allowed to assign (strictly below their own). */
  const assignableRoles = useMemo(
    () => VALID_ROLES.filter((r) => canManageRole(actorRole ?? '', r)),
    [actorRole],
  )

  // Ensure the invite role is always valid for the actor's authority.
  const effectiveInviteRole = assignableRoles.includes(inviteRole)
    ? inviteRole
    : (assignableRoles[assignableRoles.length - 1] || 'viewer')

  const loadMembers = useCallback(async () => {
    const res = await fetch('/api/members')
    const data = await res.json()
    setMembers(data.members ?? [])
    setLoading(false)
  }, [])

  const loadInvitations = useCallback(async () => {
    const res = await fetch('/api/invitations')
    if (!res.ok) {
      setLoadingInvites(false)
      return
    }
    const data = await res.json()
    setInvitations(data.invitations ?? [])
    setLoadingInvites(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMembers()
    loadInvitations()
  }, [loadMembers, loadInvitations])

  /** Format an ISO date for display in the user's locale. */
  function fmtDate(iso: string) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    } catch {
      return iso
    }
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault()
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    setInviting(true)
    setLastInviteUrl(null)
    setLastInviteEmail(null)
    const role = effectiveInviteRole
    const res = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(humanizeInviteError(data?.error, t))
      setInviting(false)
      return
    }
    // The raw token is returned EXACTLY ONCE — surface it immediately so
    // the inviter can copy / email / share it. After this render the link
    // is gone for good (only the SHA-256 hash lives in the DB).
    setLastInviteUrl(data.invitation?.inviteUrl ?? null)
    setLastInviteEmail(email)
    setInviteEmail('')
    toast.success(t('invitationCreated'))
    setInviting(false)
    await loadInvitations()
  }

  async function onRevoke(inv: Invitation) {
    setRevokingId(inv.id)
    const res = await fetch(`/api/invitations?id=${encodeURIComponent(inv.id)}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(humanizeInviteError(data?.error, t))
      setRevokingId(null)
      return
    }
    toast.success(t('invitationRevoked'))
    setRevokingId(null)
    // If the revoked invitation was the one whose link we just surfaced,
    // hide the link too — no longer valid for acceptance.
    if (lastInviteEmail?.toLowerCase() === inv.email.toLowerCase()) {
      setLastInviteUrl(null)
      setLastInviteEmail(null)
    }
    await loadInvitations()
  }

  async function onCopyLink() {
    if (!lastInviteUrl) return
    try {
      await navigator.clipboard.writeText(lastInviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
      toast.success(tc('copied'))
    } catch {
      toast.error('Copy failed — select and copy manually')
    }
  }

  async function onRoleChange(memberId: string, role: string) {
    const res = await fetch('/api/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, role }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Failed to update role')
      return
    }
    toast.success(t('saved'))
    loadMembers()
  }

  const currentUserId = session?.user?.id
  const canManage =
    actorRole === 'owner' || actorRole === 'admin' || actorRole === 'manager'

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('membersTitle')} hint={t('membersHint')} />

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base">{t('inviteEmail')}</CardTitle>
            <CardDescription>{t('inviteHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="invite-email" className="sr-only">
                  {t('inviteEmail')}
                </Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="agent@example.com"
                  required
                  dir="ltr"
                />
              </div>
              <div className="w-full sm:w-40">
                <Select value={effectiveInviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}` as any)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={inviting} className="gap-2">
                <UserPlus className="h-4 w-4" />
                {tc('create')}
              </Button>
            </form>

            {lastInviteUrl && (
              <div className="mt-4 rounded-lg border border-saffron/40 bg-saffron/10 p-3">
                <p className="mb-2 text-xs text-saffron-foreground">
                  {t('inviteLinkOnceHint')}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    readOnly
                    value={lastInviteUrl}
                    dir="ltr"
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={onCopyLink}
                    className="gap-2 shrink-0"
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {tc('copy')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base">{t('membersTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
          ) : members.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">{t('noMembers')}</div>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((m) => {
                const isSelf = m.user.id === currentUserId
                const canModifyTarget =
                  canManageRole(actorRole ?? '', m.role) && !isSelf
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3 p-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className="bg-turquoise/15 text-xs">
                          {(m.user.name || m.user.email).slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {m.user.name || m.user.email}
                        </p>
                        <p className="truncate text-xs text-muted-foreground" dir="ltr">
                          {m.user.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isSelf && (
                        <Badge variant="outline" className="text-xs">
                          {tc('you')}
                        </Badge>
                      )}
                      {m.role === 'owner' || !canModifyTarget ? (
                        <Badge
                          className={
                            m.role === 'owner'
                              ? 'bg-saffron/20 text-saffron-foreground'
                              : 'bg-muted text-muted-foreground'
                          }
                        >
                          {t(`roles.${m.role}` as any)}
                        </Badge>
                      ) : (
                        <Select
                          value={m.role}
                          onValueChange={(role) => onRoleChange(m.id, role)}
                        >
                          <SelectTrigger className="h-8 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {assignableRoles.map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(`roles.${r}` as any)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Pending invitations — only visible to managers+ (the GET endpoint
          enforces this server-side; we hide the section for non-managers so
          the UI does not dangle an empty card for agents/viewers). */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Mail className="h-4 w-4" />
              {t('invitationsTitle')}
            </CardTitle>
            <CardDescription>{t('invitationsHint')}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loadingInvites ? (
              <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
            ) : invitations.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">{t('noInvitations')}</div>
            ) : (
              <ul className="divide-y divide-border max-h-96 overflow-y-auto scroll-thin">
                {invitations.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className="bg-saffron/15 text-xs">
                          <Mail className="h-4 w-4" />
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p
                          className="truncate text-sm font-medium"
                          dir="ltr"
                          title={inv.email}
                        >
                          {inv.email}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {t('expires')} {fmtDate(inv.expiresAt)}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge className="bg-muted text-muted-foreground">
                        {t(`roles.${inv.role}` as any)}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {t(`status_${inv.status}` as any) || inv.status}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={revokingId === inv.id}
                        onClick={() => onRevoke(inv)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {tc('delete')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * Map server-side invitation error codes to human-friendly messages. Falls
 * back to the raw error string for unknown codes (the API may add new ones
 * without coordinated UI updates).
 */
function humanizeInviteError(
  code: string | undefined,
  t: (k: string) => string,
): string {
  if (!code) return 'Failed to invite'
  // t() here is scoped to the 'settings' namespace — alreadyMember /
  // invitationAlreadyPending resolve to the localized strings we just
  // added to en.json / fa.json. Unknown codes fall through to the raw
  // value so the API can ship new codes without coordinated UI updates.
  const map: Record<string, string> = {
    invalid_email: 'Invalid email address',
    invalid_role: 'Invalid role',
    cannot_assign_owner: 'Cannot assign owner role',
    already_member: t('alreadyMember'),
    invitation_already_pending: t('invitationAlreadyPending'),
    plan_limit_exceeded: 'Plan limit reached — upgrade to invite more agents',
    forbidden: 'You do not have permission to manage this role',
    not_found: 'Invitation not found',
    not_pending: 'Invitation is no longer pending',
  }
  return map[code] ?? code
}

export function PanelHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}
