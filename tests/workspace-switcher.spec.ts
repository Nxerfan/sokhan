import { test, expect, type Page, type Browser } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Workspace switcher UI behavioral spec (PR #13 stability audit — BLOCKER #1).
 *
 * The backend already exposed the secure switch path (GET /api/workspaces +
 * POST /api/auth/switch-workspace + NextAuth useSession().update) and the
 * API-level behavioral tests (tests/invite-workspace-switching.spec.ts)
 * already prove membership validation, revoked-membership recovery, and
 * stale tenant-data isolation at the API layer. BUT the dashboard only
 * DISPLAYED the current workspace name — the switcher UI was missing. This
 * spec proves the ACTUAL dashboard TopBar switcher dropdown through real UI
 * clicks (NOT merely the switching API).
 *
 * Runs in BOTH Full and Lite Docker editions. Uses BASE = the Caddy public
 * boundary (cookies set via API on :81 are honoured by the UI on :81 —
 * single origin).
 *
 * TIMING: the switch flow is async (validate → useSession().update →
 * verify → window.location.reload()). The reload is NOT synchronous with the
 * menu click, so we POLL /api/auth/session for the workspaceId to change
 * (bounded 15s) instead of relying on waitForLoadState (which resolves
 * against the pre-reload document and races).
 */

const BASE = 'http://127.0.0.1:81'
const PASSWORD = 'password123'

interface TenantCtx {
  page: Page
  email: string
  workspaceName: string
  tenantId: string
  slug: string
}

async function setupTenant(
  browser: Browser,
  email: string,
  workspaceName: string,
): Promise<TenantCtx> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const signupRes = await otpSignupPlaywright(
    page.request as unknown as Parameters<typeof otpSignupPlaywright>[0],
    BASE,
    email,
    workspaceName,
    PASSWORD,
  )
  if (!signupRes.ok || !signupRes.tenantId) {
    throw new Error(`OTP signup failed for ${email}: status=${signupRes.status}`)
  }
  const tenantId = signupRes.tenantId

  let slug = ''
  let sessionOk = false
  for (let attempt = 0; attempt < 2 && !sessionOk; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
      form: { email, password: PASSWORD, csrfToken, json: 'true' },
      maxRedirects: 0,
    })
    if (signinRes.status() >= 400) {
      if (attempt === 0) continue
      throw new Error(`Sign-in failed for ${email}: HTTP ${signinRes.status()}`)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      if (sessionRes.ok()) {
        const sb = await sessionRes.json().catch(() => ({}))
        if (sb && sb.user) {
          const meRes = await page.request.get(`${BASE}/api/tenants/me`)
          if (meRes.ok()) {
            const meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
            if (meData.tenant && meData.tenant.id === tenantId) {
              sessionOk = true
              slug = meData.tenant.slug
              break
            }
          }
        }
      }
      await page.waitForTimeout(250)
    }
  }
  if (!sessionOk) throw new Error(`Auth session not established for ${email}`)
  // Fresh OTP signups default to accessMode='verified_visitor' (the frozen
  // DB contract). The /contact flow below requires anonymous visitor tokens,
  // so explicitly switch the tenant to anonymous before any visitor traffic.
  await setAccessMode(page, 'anonymous')
  return { page, email, workspaceName, tenantId, slug }
}

async function createInvitationApi(
  page: Page,
  inviteeEmail: string,
  role: string,
): Promise<{ workspace: string; token: string }> {
  const res = await page.request.post(`${BASE}/api/invitations`, {
    data: { email: inviteeEmail, role },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`create invitation failed: ${res.status()}`)
  const body = (await res.json()) as { invitation?: { inviteUrl: string } }
  const inviteUrl = body.invitation?.inviteUrl
  if (!inviteUrl) throw new Error('no inviteUrl returned')
  const url = new URL(inviteUrl)
  return { workspace: url.searchParams.get('workspace') || '', token: url.searchParams.get('token') || '' }
}

async function acceptInvitationApi(page: Page, workspace: string, token: string): Promise<{ ok: boolean }> {
  const res = await page.request.post(`${BASE}/api/invitations/accept`, {
    data: { workspace, token },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
  return { ok: !!body.ok }
}

async function createVisitorConversation(slug: string, text: string): Promise<{ conversationId: string }> {
  const visitorId = `v-${slug}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const contactRes = await fetch(`${BASE}/api/widget/${slug}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId }),
  })
  if (!contactRes.ok) throw new Error(`widget contact failed: ${contactRes.status}`)
  const contactData = (await contactRes.json()) as { contactId: string; realtimeToken: string }
  const msgRes = await fetch(`${BASE}/api/widget/${slug}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contactData.realtimeToken}` },
    body: JSON.stringify({ text }),
  })
  if (!msgRes.ok) throw new Error(`widget message failed: ${msgRes.status}`)
  const msgData = (await msgRes.json()) as { conversationId: string }
  return { conversationId: msgData.conversationId }
}

async function getSessionWorkspaceId(page: Page): Promise<string | null> {
  const res = await page.request.get(`${BASE}/api/auth/session`)
  const body = (await res.json()) as { user?: { workspaceId?: string | null } }
  return body.user?.workspaceId ?? null
}

/** Poll /api/auth/session until the workspaceId matches `expected` (bounded). */
async function waitForWorkspaceSwitch(page: Page, expected: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  while (Date.now() < deadline) {
    last = await getSessionWorkspaceId(page)
    if (last === expected) return
    await page.waitForTimeout(250)
  }
  throw new Error(`workspace did not switch to ${expected} within ${timeoutMs}ms (last=${last})`)
}

async function listWorkspacesApi(page: Page): Promise<{ id: string; name: string; isCurrent: boolean }[]> {
  const res = await page.request.get(`${BASE}/api/workspaces`)
  const body = (await res.json()) as { workspaces?: { id: string; name: string; isCurrent: boolean }[] }
  return body.workspaces ?? []
}

/** The TopBar switcher trigger is the <h2> in the header (workspace name). */
const SWITCHER_TRIGGER = 'header h2'

/** Open the switcher dropdown. */
async function openSwitcher(page: Page) {
  await page.locator(SWITCHER_TRIGGER).click()
  await expect(page.locator('[role="menu"]')).toBeVisible()
}

/** Click a workspace menu item by name — ONE click, no retry.
 *
 * `noWaitAfter: true` is the deterministic fix for the revoked-workspace
 * recovery timing: handleSwitch calls `window.location.reload()` AFTER the
 * async validate → useSession().update → verify flow. Playwright's default
 * `click()` auto-waits for navigation triggered by the click; in the recovery
 * timing the reload can begin BEFORE the click promise settles, leaving the
 * click action attached to the old (navigating) document until the test
 * timeout closes the context ("Target page, context or browser has been
 * closed"). `noWaitAfter: true` returns immediately after the click; the
 * session transition is then verified independently by `waitForWorkspaceSwitch`
 * (which polls /api/auth/session). This is still exactly ONE user selection —
 * no retry, no second click, no weakening of the session assertion. */
async function clickWorkspaceItem(page: Page, name: string) {
  await page
    .locator('[role="menu"]')
    .locator('[role="menuitem"]')
    .filter({ hasText: name })
    .click({ noWaitAfter: true })
}

test.describe('Workspace switcher UI (PR #13 BLOCKER #1)', () => {
  let tenantA: TenantCtx
  let tenantB: TenantCtx
  let aConv: { conversationId: string }
  let bConv: { conversationId: string }
  let aInvite: { workspace: string; token: string }

  test.beforeAll(async ({ browser }) => {
    const suffix = `${Date.now()}-${process.pid}`
    tenantA = await setupTenant(browser, `ws-a-${suffix}@iws.test`, `WS A ${suffix}`)
    tenantB = await setupTenant(browser, `ws-b-${suffix}@iws.test`, `WS B ${suffix}`)
    aConv = await createVisitorConversation(tenantA.slug, 'hello from A visitor')
    bConv = await createVisitorConversation(tenantB.slug, 'hello from B visitor')
    // A's owner invites B's owner to A as admin → B now has TWO workspaces.
    aInvite = await createInvitationApi(tenantA.page, tenantB.email, 'admin')
    const accepted = await acceptInvitationApi(tenantB.page, aInvite.workspace, aInvite.token)
    if (!accepted.ok) throw new Error('B could not accept A invitation')
  })

  test.afterAll(async () => {
    await tenantA?.page.context().close().catch(() => {})
    await tenantB?.page.context().close().catch(() => {})
  })

  test('dashboard renders; switcher dropdown lists both workspaces; B marked current', async () => {
    // B's primary (signup) workspace is B → current = B after accept (API accept
    // does not mutate the session; only the /invite page client does).
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await expect(tenantB.page.locator('header')).toBeVisible()
    // The trigger shows B's name.
    await expect(tenantB.page.locator(SWITCHER_TRIGGER)).toContainText('WS B')

    await openSwitcher(tenantB.page)
    const dropdown = tenantB.page.locator('[role="menu"]')
    // Both workspaces listed.
    await expect(dropdown.locator('text=WS A')).toBeVisible()
    await expect(dropdown.locator('text=WS B')).toBeVisible()

    // B is the current workspace → its menu item has the Check icon
    // (the turquoise svg). A's menu item has NO Check.
    const bItem = dropdown.locator('[role="menuitem"]').filter({ hasText: 'WS B' })
    const aItem = dropdown.locator('[role="menuitem"]').filter({ hasText: 'WS A' })
    await expect(bItem.locator('svg.text-turquoise')).toHaveCount(1) // the Check
    await expect(aItem.locator('svg.text-turquoise')).toHaveCount(0) // no Check

    await tenantB.page.keyboard.press('Escape')
  })

  test('click workspace A → session switches to A; top-bar shows A', async () => {
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openSwitcher(tenantB.page)
    await clickWorkspaceItem(tenantB.page, 'WS A')
    await waitForWorkspaceSwitch(tenantB.page, tenantA.tenantId)
    // After reload, the shell re-fetches /api/tenants/me for A. The trigger h2
    // now shows A's name.
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await expect(tenantB.page.locator(SWITCHER_TRIGGER)).toContainText('WS A', { timeout: 10000 })
  })

  test('A-specific data appears; B-specific data disappears', async () => {
    // The Inbox (default view) fetches /api/conversations (tenant-scoped) and
    // renders conv.lastMessagePreview. A's preview must be visible; B's not.
    await expect(tenantB.page.locator('main')).toContainText('hello from A visitor', { timeout: 10000 })
    await expect(tenantB.page.locator('main')).not.toContainText('hello from B visitor')
  })

  test('stale selected Inbox conversation from previous workspace is not displayed', async () => {
    // Start fresh on A (the current workspace after test 111). A clean page
    // state avoids races between the inbox's socket/message fetch and the
    // switcher click (this was the Lite-only differentiator vs test 110).
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await expect(tenantB.page.locator('main')).toContainText('hello from A visitor', { timeout: 15000 })
    // Select A's conversation in the Inbox (sets the Inbox selectedId to A's
    // conversation — the "stale selection" we then prove is cleared).
    await tenantB.page.locator('main').locator('text=hello from A visitor').first().click()
    // Bounded propagation barrier — let the selection + message fetch settle
    // before opening the switcher (NOT an arbitrary sleep; bounded, deterministic).
    await tenantB.page.waitForTimeout(600)
    // Switch to B via the UI. The reload from handleSwitch tears down ALL
    // workspace-specific client state — including the Inbox selectedId (which
    // lives in component state, NOT the URL), so it is cleared by the remount.
    await openSwitcher(tenantB.page)
    await clickWorkspaceItem(tenantB.page, 'WS B')
    await waitForWorkspaceSwitch(tenantB.page, tenantB.tenantId)
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // B's inbox shows B's conversation, NOT A's. The stale A selection cannot
    // remain (selectedId was cleared by the remount + A's conversationId does
    // not exist in B's tenant anyway).
    await expect(tenantB.page.locator('main')).toContainText('hello from B visitor', { timeout: 15000 })
    await expect(tenantB.page.locator('main')).not.toContainText('hello from A visitor')
  })

  test('switch back to A → A data returns; B data disappears', async () => {
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await openSwitcher(tenantB.page)
    await clickWorkspaceItem(tenantB.page, 'WS A')
    await waitForWorkspaceSwitch(tenantB.page, tenantA.tenantId)
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await expect(tenantB.page.locator('main')).toContainText('hello from A visitor', { timeout: 15000 })
    await expect(tenantB.page.locator('main')).not.toContainText('hello from B visitor')
  })

  test('unauthorized workspace id cannot be selected/switched', async () => {
    // Start fresh on A (the current workspace).
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // The dropdown NEVER lists a foreign workspace.
    await openSwitcher(tenantB.page)
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown).not.toContainText('Foreign Nonexistent Workspace')
    await tenantB.page.keyboard.press('Escape')

    // The server-side validation gate rejects a foreign workspace id. The UI
    // switcher calls this FIRST; on 404 it shows an error and does NOT call
    // useSession().update — so the unauthorized switch is blocked here.
    const validateRes = await tenantB.page.request.post(`${BASE}/api/auth/switch-workspace`, {
      data: { workspaceId: 'nonexistent-foreign-id-xyz' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(validateRes.status(), 'switch-workspace must reject foreign id').toBe(404)

    // The validation route is a THIN gate (it does NOT mutate the session), so
    // after a rejected validation the session is unchanged — still on A. The
    // jwt callback (trigger === 'update') independently re-validates an active
    // membership, so a caller that bypasses the gate and calls
    // useSession().update directly with a foreign id is rejected by the jwt
    // callback (it throws not_active_member — proven by the invite spec's
    // auth-contract tests).
    const sessionAfter = await getSessionWorkspaceId(tenantB.page)
    expect(sessionAfter, 'session must remain on A after a rejected switch').toBe(tenantA.tenantId)
  })

  test('revoked membership disappears from dropdown; stranded user recovers', async () => {
    // B is currently on A. A's owner revokes B's membership in A.
    const membersRes = await tenantA.page.request.get(`${BASE}/api/members`)
    const membersBody = (await membersRes.json()) as {
      members?: Array<{ id: string; userId: string; role: string; user: { email: string } }>
    }
    const bMember = membersBody.members?.find((m) => m.user.email === tenantB.email)
    if (!bMember) throw new Error('B not found in A members list for revocation')
    // DELETE /api/members?memberId= expects the MEMBERSHIP id (not the user id)
    // — the route does db.membership.findFirst({ where: { id: memberId, tenantId } }).
    const revokeRes = await tenantA.page.request.delete(
      `${BASE}/api/members?memberId=${encodeURIComponent(bMember.id)}`,
    )
    expect(revokeRes.status(), 'revoke B from A should succeed').toBe(200)

    // B reloads. B's session workspaceId is still A, but B is no longer an
    // active member of A → /api/workspaces no longer lists A.
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const workspaces = await listWorkspacesApi(tenantB.page)
    const ids = workspaces.map((w) => w.id)
    expect(ids, 'revoked workspace A must disappear from the dropdown list').not.toContain(tenantA.tenantId)
    expect(ids, 'active workspace B must remain available for recovery').toContain(tenantB.tenantId)

    // The dropdown offers B as the recovery target. ONE open + ONE click
    // (the user's contract: one dropdown open, one user selection, one workspace
    // mutation). The earlier double-open (open → Escape → re-open) confused
    // Radix's menu state in this degraded (revoked-current-workspace) state and
    // caused the menuitem to continuously detach ("element was detached from
    // the DOM, retrying"). One open + one click is both cleaner and the genuine
    // single user action.
    await openSwitcher(tenantB.page)
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown.locator('text=WS B')).toBeVisible()
    await expect(dropdown).not.toContainText('WS A')

    // B recovers by switching to B (B's membership in B is still active).
    // ONE click (noWaitAfter — the reload is verified independently below).
    await clickWorkspaceItem(tenantB.page, 'WS B')
    await waitForWorkspaceSwitch(tenantB.page, tenantB.tenantId)
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    // The dashboard is functional again — B's data shows.
    await expect(tenantB.page.locator('main')).toContainText('hello from B visitor', { timeout: 10000 })
  })
})
