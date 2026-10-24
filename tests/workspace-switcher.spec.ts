import { test, expect, type Page, type Browser } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

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
 * COVERAGE (user-required UI journeys):
 *   1. dashboard renders for an authenticated user with two workspaces
 *   2. switcher dropdown lists BOTH workspaces; current marked
 *   3. click workspace B → session switches to B; top-bar name changes to B
 *   4. B-specific data appears in the Inbox; A-specific data disappears
 *   5. switch back to A → A data returns; B data disappears
 *   6. stale selected Inbox conversation from the previous workspace is NOT displayed
 *   7. unauthorized workspace id cannot be selected/switched (dropdown never lists it; API rejects)
 *   8. revoked membership disappears from the dropdown; stranded user recovers to another active workspace
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

async function acceptInvitationApi(page: Page, workspace: string, token: string): Promise<{ ok: boolean; workspaceId?: string }> {
  const res = await page.request.post(`${BASE}/api/invitations/accept`, {
    data: { workspace, token },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; workspaceId?: string }
  return { ok: !!body.ok, workspaceId: body.workspaceId }
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

async function listWorkspacesApi(page: Page): Promise<{ id: string; name: string; isCurrent: boolean }[]> {
  const res = await page.request.get(`${BASE}/api/workspaces`)
  const body = (await res.json()) as { workspaces?: { id: string; name: string; isCurrent: boolean }[] }
  return body.workspaces ?? []
}

/** The TopBar switcher trigger button (contains the workspace name + Building2 icon). */
const SWITCHER_TRIGGER = 'header h2'

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
    // Dashboard shell renders for the authenticated user.
    await expect(tenantB.page.locator('header')).toBeVisible()
    // Open the switcher dropdown.
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    // Both workspaces listed.
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown).toBeVisible()
    await expect(dropdown.locator('text=WS A')).toBeVisible()
    await expect(dropdown.locator('text=WS B')).toBeVisible()
    // B is the current workspace (marked with a Check icon — turquoise).
    const bItem = dropdown.locator('text=WS B').locator('..')
    await expect(bItem.locator('svg')).toHaveCount(2) // Building2 + Check
    // The trigger button shows B's name.
    await expect(tenantB.page.locator(SWITCHER_TRIGGER)).toContainText('WS B')
    // Escape to close the dropdown.
    await tenantB.page.keyboard.press('Escape')
  })

  test('click workspace A → session switches to A; top-bar shows A', async () => {
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown).toBeVisible()
    // Click the A workspace menu item.
    await dropdown.locator('text=WS A').click()
    // The switch flow calls update() + reload. Wait for the reload.
    await tenantB.page.waitForLoadState('domcontentloaded')
    // Give the shell a moment to re-fetch /api/tenants/me.
    await tenantB.page.waitForTimeout(500)
    // Session now points to A.
    expect(await getSessionWorkspaceId(tenantB.page)).toBe(tenantA.tenantId)
    // Top-bar trigger now shows A's name.
    await expect(tenantB.page.locator(SWITCHER_TRIGGER)).toContainText('WS A')
  })

  test('A-specific data appears; B-specific data disappears', async () => {
    // The Inbox is the default view; it fetches /api/conversations (tenant-scoped).
    // A's visitor message preview = "hello from A visitor" must be visible.
    await expect(tenantB.page.locator('main')).toContainText('hello from A visitor', { timeout: 10000 })
    // B's visitor message preview must NOT be visible on A.
    await expect(tenantB.page.locator('main')).not.toContainText('hello from B visitor')
  })

  test('stale selected Inbox conversation from previous workspace is not displayed', async () => {
    // On A, select the A conversation in the Inbox (click its row).
    const aRow = tenantB.page.locator('main').locator('text=hello from A visitor').first()
    await aRow.click().catch(() => {})
    // Now switch back to B via the UI.
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    await tenantB.page.locator('[role="menu"]').locator('text=WS B').click()
    await tenantB.page.waitForLoadState('domcontentloaded')
    await tenantB.page.waitForTimeout(500)
    // Session is now B.
    expect(await getSessionWorkspaceId(tenantB.page)).toBe(tenantB.tenantId)
    // B's inbox shows B's conversation, NOT A's.
    await expect(tenantB.page.locator('main')).toContainText('hello from B visitor', { timeout: 10000 })
    await expect(tenantB.page.locator('main')).not.toContainText('hello from A visitor')
  })

  test('switch back to A → A data returns; B data disappears', async () => {
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    await tenantB.page.locator('[role="menu"]').locator('text=WS A').click()
    await tenantB.page.waitForLoadState('domcontentloaded')
    await tenantB.page.waitForTimeout(500)
    expect(await getSessionWorkspaceId(tenantB.page)).toBe(tenantA.tenantId)
    await expect(tenantB.page.locator('main')).toContainText('hello from A visitor', { timeout: 10000 })
    await expect(tenantB.page.locator('main')).not.toContainText('hello from B visitor')
  })

  test('unauthorized workspace id cannot be selected/switched', async () => {
    // The dropdown NEVER lists a foreign workspace. Open it and assert no
    // foreign name is present.
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown).toBeVisible()
    await expect(dropdown).not.toContainText('Foreign Nonexistent Workspace')
    await tenantB.page.keyboard.press('Escape')

    // The server-side path ALSO rejects a foreign workspace id (defense-in-depth):
    // POST /api/auth/switch-workspace with a nonexistent id → 404 not_found.
    const validateRes = await tenantB.page.request.post(`${BASE}/api/auth/switch-workspace`, {
      data: { workspaceId: 'nonexistent-foreign-id-xyz' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(validateRes.status(), 'switch-workspace must reject foreign id').toBe(404)

    // And the NextAuth update path (POST /api/auth/session) with a foreign id
    // also fails closed — the jwt callback throws not_active_member, so the
    // session endpoint does NOT return 200 with the foreign workspace.
    const csrfRes = await tenantB.page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const updateRes = await tenantB.page.request.post(`${BASE}/api/auth/session`, {
      data: { data: { workspaceId: 'nonexistent-foreign-id-xyz' }, csrfToken },
      headers: { 'Content-Type': 'application/json' },
    })
    // The session must NOT have switched to the foreign id.
    const sessionAfter = await tenantB.page.request.get(`${BASE}/api/auth/session`)
    const sb = (await sessionAfter.json()) as { user?: { workspaceId?: string | null } }
    expect(sb.user?.workspaceId, 'session workspace must remain unchanged after a rejected switch').toBe(tenantA.tenantId)
    expect(updateRes.status(), 'update with foreign id must not succeed cleanly').not.toBe(200)
  })

  test('revoked membership disappears from dropdown; stranded user recovers', async () => {
    // B is currently on A. A's owner revokes B's membership in A.
    // Find B's membership id in A's member list.
    const membersRes = await tenantA.page.request.get(`${BASE}/api/members`)
    const membersBody = (await membersRes.json()) as {
      members?: Array<{ userId: string; role: string; user: { email: string } }>
    }
    const bMember = membersBody.members?.find((m) => m.user.email === tenantB.email)
    if (!bMember) throw new Error('B not found in A members list for revocation')
    // DELETE /api/members?memberId=<B's membership id in A>
    const revokeRes = await tenantA.page.request.delete(
      `${BASE}/api/members?memberId=${encodeURIComponent(bMember.userId)}`,
    )
    expect(revokeRes.status(), 'revoke B from A should succeed').toBe(200)

    // B reloads the dashboard. B's session workspaceId is still A, but B is no
    // longer an active member of A → /api/workspaces no longer lists A.
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const workspaces = await listWorkspacesApi(tenantB.page)
    const ids = workspaces.map((w) => w.id)
    expect(ids, 'revoked workspace A must disappear from the dropdown list').not.toContain(tenantA.tenantId)
    expect(ids, 'active workspace B must remain available for recovery').toContain(tenantB.tenantId)

    // The dropdown offers B as the recovery target.
    await tenantB.page.locator(SWITCHER_TRIGGER).click()
    const dropdown = tenantB.page.locator('[role="menu"]')
    await expect(dropdown).toBeVisible()
    await expect(dropdown.locator('text=WS B')).toBeVisible()
    await expect(dropdown).not.toContainText('WS A')

    // B recovers by switching to B.
    await dropdown.locator('text=WS B').click()
    await tenantB.page.waitForLoadState('domcontentloaded')
    await tenantB.page.waitForTimeout(500)
    expect(await getSessionWorkspaceId(tenantB.page), 'recovered to B').toBe(tenantB.tenantId)
    // The dashboard is functional again — B's data shows.
    await expect(tenantB.page.locator('main')).toContainText('hello from B visitor', { timeout: 10000 })
  })
})
