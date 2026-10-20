'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { signOut, useSession } from 'next-auth/react'
import { LogOut, Search, ChevronDown, Building2, Check, Mail, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { useDashboardStore } from './nav-store'
import { toast } from 'sonner'

/**
 * Workspace summary returned by GET /api/workspaces. NOT tenant-scoped —
 * the endpoint queries the user's active memberships across ALL tenants
 * (using `globalDb`), so we get the full set of switchable workspaces plus
 * any pending invitations still awaiting acceptance.
 */
type Workspace = {
  id: string
  name: string
  slug: string
  role: string
  isCurrent: boolean
}

type PendingInvitation = {
  id: string
  tenantId: string
  workspaceName: string
  role: string
  expiresAt: string
}

/**
 * Format an ISO date in the user's locale (short form for the dropdown).
 */
function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      dateStyle: 'medium',
    })
  } catch {
    return iso
  }
}

export function TopBar({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations()
  const { data: session } = useSession()
  const { setCommandOpen } = useDashboardStore()

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [pendingInvites, setPendingInvites] = useState<PendingInvitation[]>([])
  const [switching, setSwitching] = useState<string | null>(null)

  const loadWorkspaces = useCallback(async () => {
    const res = await fetch('/api/workspaces')
    if (!res.ok) return
    const data = await res.json()
    setWorkspaces(data.workspaces ?? [])
    setPendingInvites(data.pendingInvitations ?? [])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWorkspaces()
  }, [loadWorkspaces])

  /**
   * Switch the active workspace. POST /api/auth/switch-workspace sets a
   * short-lived HttpOnly cookie that the NextAuth `jwt` callback consumes
   * on the NEXT page load. The client therefore MUST reload after a
   * successful switch — without the reload the stale JWT (still pinned
   * to the OLD workspace) would persist for the rest of the session,
   * and the inbox / socket / tenant-scoped state would all be wrong.
   *
   * We use `window.location.reload()` (hard reload) instead of
   * `router.refresh()` because the entire dashboard state — auth token,
   * socket connection, optimistic UI caches — must be torn down and
   * reconstructed for the new workspace. A soft refresh would leave
   * zombie socket subscriptions to the old conversation rooms.
   */
  async function onSwitchWorkspace(target: Workspace) {
    if (target.isCurrent) return
    setSwitching(target.id)
    try {
      const res = await fetch('/api/auth/switch-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: target.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? t('settings.switchFailed'))
        setSwitching(null)
        return
      }
      // Hard reload — see method docstring for the rationale.
      window.location.reload()
    } catch {
      toast.error(t('settings.switchFailed'))
      setSwitching(null)
    }
  }

  const initials = (session?.user?.name || session?.user?.email || '?')
    .slice(0, 2)
    .toUpperCase()

  const currentWorkspace = workspaces.find((w) => w.isCurrent)
  // The dashboard shell passes the workspace name it resolved via
  // `/api/tenants/me`; if the workspaces list hasn't loaded yet we
  // fall back to that name so the button is never empty.
  const displayedName = currentWorkspace?.name ?? workspaceName

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-4 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 px-2 font-display text-sm font-semibold tracking-tight"
              aria-label={t('settings.switchWorkspace')}
            >
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="max-w-[180px] truncate sm:max-w-[240px]">
                {displayedName}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto scroll-thin">
            <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('settings.workspaces')}
            </DropdownMenuLabel>
            {workspaces.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('common.loading')}
              </div>
            ) : (
              <div className="flex flex-col">
                {workspaces.map((w) => {
                  const isSwitchingThis = switching === w.id
                  return (
                    <DropdownMenuItem
                      key={w.id}
                      disabled={w.isCurrent || switching !== null}
                      onSelect={(e) => {
                        // Prevent the menu from auto-closing on a switch —
                        // we want the user to see the loading state. Once
                        // the switch completes the page reloads anyway.
                        if (!w.isCurrent) e.preventDefault()
                        onSwitchWorkspace(w)
                      }}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">
                          {w.name}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground" dir="ltr">
                          {w.slug}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t(`settings.roles.${w.role}` as any) || w.role}
                        </span>
                        {w.isCurrent && (
                          <Check className="h-4 w-4 text-turquoise" />
                        )}
                        {isSwitchingThis && !w.isCurrent && (
                          <span className="text-[10px] text-muted-foreground">
                            …
                          </span>
                        )}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </div>
            )}

            {pendingInvites.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" />
                  {t('settings.pendingInvitations')}
                </DropdownMenuLabel>
                <div className="flex flex-col">
                  {pendingInvites.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between gap-2 rounded-sm px-2 py-2"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">
                          {inv.workspaceName}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {t(`settings.roles.${inv.role}` as any) || inv.role}{' · '}
                          {t('settings.expires')} {fmtDate(inv.expiresAt)}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => {
                          // The raw token is NOT exposed by /api/workspaces
                          // (security contract: it is returned exactly once
                          // to the inviter at creation time and never again).
                          // The invitee must accept through the link emailed
                          // to them — point them back to their inbox.
                          toast.info(t('settings.checkEmailForInvite'))
                        }}
                      >
                        <ChevronRight className="h-3 w-3" />
                        {t('settings.accept')}
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => signOut({ callbackUrl: '/' })}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="me-2 h-4 w-4" />
              {t('auth.login')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCommandOpen(true)}
          className="gap-2 text-muted-foreground"
        >
          <Search className="h-4 w-4" />
          <span className="hidden text-xs sm:inline">{t('common.search')}</span>
          <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono sm:inline">
            ⌘K
          </kbd>
        </Button>
        <LocaleSwitcher />
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="bg-saffron/20 text-xs font-medium text-saffron-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{session?.user?.name}</span>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {session?.user?.email}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => signOut({ callbackUrl: '/' })}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="me-2 h-4 w-4" />
              {t('auth.login')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
