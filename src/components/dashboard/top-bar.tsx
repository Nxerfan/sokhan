'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { signOut, useSession } from 'next-auth/react'
import { LogOut, Search, ChevronDown, Building2, Check, Clock, AlertCircle } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ThemeToggle } from '@/components/theme-toggle'
import { useDashboardStore } from './nav-store'

type WorkspaceItem = {
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

type WorkspacesResponse = {
  workspaces: WorkspaceItem[]
  pendingInvitations: PendingInvitation[]
}

/**
 * Workspace switcher (PR #13 stability audit — capability completion).
 *
 * The backend already exposed the secure switch path (GET /api/workspaces +
 * POST /api/auth/switch-workspace + NextAuth useSession().update), and the
 * behavioral API tests already prove membership validation, revoked-membership
 * recovery, and stale tenant-data isolation. The dashboard, however, only
 * DISPLAYED the current workspace name — the switcher UI was missing, making
 * the capability incomplete from the user's perspective.
 *
 * This component adds the minimal switcher WITHOUT redesigning the dashboard:
 * the current workspace name becomes a clickable dropdown that lists every
 * active workspace for the user (current marked with a Check + role badge),
 * plus a separate non-switchable "Pending invitations" section.
 *
 * SECURE SWITCH FLOW (fail-closed — the client NEVER mutates tenant/workspace
 * state locally without server validation):
 *   1. POST /api/auth/switch-workspace { workspaceId } — fast server-side
 *      validation that the target is an ACTIVE membership. 403/404 aborts
 *      with a truthful toast and NO local state mutation.
 *   2. await useSession().update({ workspaceId }) — NextAuth's SUPPORTED
 *      session/JWT mutation path. The `jwt` callback (trigger === 'update')
 *      RE-validates the active membership via globalDb and throws
 *      `not_active_member` if invalid — so even a caller that skips step 1
 *      is still safe.
 *   3. Verify the returned session actually contains the requested
 *      workspaceId. If not (e.g. update resolved to null after a callback
 *      throw), abort with a toast — the token is left unchanged so no
 *      switch occurs.
 *   4. window.location.reload() — tears down ALL workspace-specific client
 *      state (Inbox selectedId, contacts cache, departments, tenant info,
 *      optimistic UI, socket room membership) and re-mounts the shell, which
 *      re-fetches /api/tenants/me + /api/departments for the NEW workspace.
 *      This guarantees old-workspace conversations/contacts/departments/inbox
 *      state cannot remain visible. A stale Inbox selection (which lives in
 *      component state, not the URL) is cleared by the remount.
 */
export function TopBar({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations()
  const { data: session, update } = useSession()
  const { setCommandOpen } = useDashboardStore()

  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([])
  const [pending, setPending] = useState<PendingInvitation[]>([])
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch('/api/workspaces')
      if (!res.ok) return // fail-silently on the list (the trigger still shows the name)
      const data = (await res.json()) as WorkspacesResponse
      setWorkspaces(data.workspaces ?? [])
      setPending(data.pendingInvitations ?? [])
    } catch {
      // network error — leave the list empty; the trigger still shows the name
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWorkspaces()
  }, [loadWorkspaces])

  const handleSwitch = useCallback(
    async (target: WorkspaceItem) => {
      if (target.isCurrent || switching) return
      setSwitching(true)
      setSwitchError(null)
      try {
        // 1. Fast server-side validation of the active membership.
        const validateRes = await fetch('/api/auth/switch-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: target.id }),
        })
        if (!validateRes.ok) {
          // 403 not_active_member / 404 not_found / 401 unauthorized — abort.
          setSwitchError(t('settings.switchFailed'))
          setSwitching(false)
          return
        }

        // 2. NextAuth supported session/JWT mutation. The jwt callback
        //    re-validates the membership independently (defense-in-depth).
        const updated = await update({ workspaceId: target.id })

        // 3. Verify the returned session actually contains the requested
        //    workspace. If update() resolved to null/missing (callback
        //    threw not_active_member), the token is unchanged — abort
        //    WITHOUT reloading so the user stays in their current workspace.
        const newWorkspaceId = (updated?.user as any)?.workspaceId
        if (newWorkspaceId !== target.id) {
          setSwitchError(t('settings.switchFailed'))
          setSwitching(false)
          return
        }

        // 4. Hard reload — clears all workspace-specific client state and
        //    re-fetches tenant data for the new workspace.
        window.location.reload()
      } catch {
        // update() throws when the jwt callback throws (e.g. revoked
        // membership between step 1 and step 2). Fail closed: no reload,
        // user stays in the current workspace, truthful toast shown.
        setSwitchError(t('settings.switchFailed'))
        setSwitching(false)
      }
    },
    [switching, update, t],
  )

  const initials = (session?.user?.name || session?.user?.email || '?')
    .slice(0, 2)
    .toUpperCase()

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-4 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <h2
              className={`flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 font-display text-sm font-semibold tracking-tight outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-ring ${
                switching ? 'opacity-50' : ''
              }`}
              tabIndex={switching ? -1 : 0}
            >
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="max-w-[40vw] truncate sm:max-w-[260px]">
                {workspaceName}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                  switching ? 'animate-pulse' : ''
                }`}
              />
            </h2>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('settings.workspaces')}
            </DropdownMenuLabel>
            {workspaces.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {workspaceName}
              </div>
            ) : (
              workspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.id}
                  onSelect={(e) => {
                    // Prevent the menu from closing before the async switch
                    // resolves — we control closing via the reload.
                    e.preventDefault()
                    void handleSwitch(ws)
                  }}
                  className="flex items-center gap-2"
                  disabled={switching}
                >
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{ws.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground" dir="ltr">
                      {ws.slug}
                    </div>
                  </div>
                  <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
                    {ws.role}
                  </Badge>
                  {ws.isCurrent && <Check className="h-4 w-4 shrink-0 text-turquoise" />}
                </DropdownMenuItem>
              ))
            )}

            {pending.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t('settings.pendingInvitations')}
                </DropdownMenuLabel>
                {pending.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center gap-2 px-2 py-2 opacity-80"
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{inv.workspaceName}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {t('settings.expires')}:{' '}
                        {new Date(inv.expiresAt).toLocaleDateString(
                          undefined,
                          { year: 'numeric', month: 'short', day: 'numeric' },
                        )}
                      </div>
                    </div>
                    <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
                      {inv.role}
                    </Badge>
                  </div>
                ))}
                <div className="px-2 pb-1 pt-1 text-[10px] text-muted-foreground">
                  {t('settings.checkEmailForInvite')}
                </div>
              </>
            )}

            {switchError && (
              <>
                <DropdownMenuSeparator />
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{switchError}</span>
                </div>
              </>
            )}
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
              onClick={() => signOut({ callbackUrl: '/' })}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="me-2 h-4 w-4" />
              {t('auth.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
