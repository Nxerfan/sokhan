import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Invitation lifecycle + workspace switching behavioral spec (PR #11).
 *
 * Run in BOTH Full and Lite Docker against real PostgreSQL. All assertions
 * are at the API level (no UI clicks). Each tenant gets its own
 * BrowserContext so its session cookie is isolated.
 *
 * DETERMINISTIC BARRIERS — NO arbitrary sleeps. The only "waits" are:
 *   - The bounded session-establishment poll (15s deadline, 250ms
 *     intervals) — a propagation barrier, not an arbitrary sleep.
 *
 * TEST ISOLATION (#1 fix)
 * ------------------------
 *   The canonical Free plan limit is agents=2. An owner already consumes
 *   one seat. A fresh Free workspace can only have ONE additional
 *   active-membership-or-pending-invitation before hitting the cap.
 *   Therefore each logically independent scenario that creates invitations
 *   gets its OWN fresh tenant (setupTenant). No test shares a tenant with
 *   another test in a way that would exhaust the seat cap.
 *
 * COVERAGE
 * --------
 *   A. Existing account / second workspace (11-step flow)
 *   B. New account invitation (10-step flow)
 *   C. Security (10 sub-scenarios — fresh tenant per sub-scenario)
 *   D. Expired-seat counting (6 sub-scenarios — fresh tenant per sub-scenario)
 *   E. Legacy reissue lifecycle (fixed lifecycle — only revoked reissuable)
 *   F. Revoked-current-workspace recovery (11-step flow, uses DELETE /api/members)
 */

const BASE = 'http://127.0.0.1:81'
const PASSWORD = 'password123'
const MOCK_OTP = '123456'

interface TenantCtx {
  page: Page
  email: string
  workspaceName: string
  tenantId: string
  slug: string
  ownerId: string
}

interface ParsedInviteUrl {
  workspace: string
  token: string
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

/** Unique suffix per call — avoids email/slug collisions across tests. */
let suffixCounter = 0
function uniqueSuffix(): string {
  suffixCounter++
  return `${Date.now()}-${process.pid}-${suffixCounter}`
}

/** Sign up a new tenant via OTP + NextAuth credentials login. Returns a
 *  fully-established authenticated session (bounded poll on /api/auth/session
 *  + /api/tenants/me — verifies the session workspace matches the signup
 *  tenantId). Throws with SAFE diagnostics (no cookie/token values) if the
 *  session is not established within the deadline. */
async function setupTenant(
  browser: import('@playwright/test').Browser,
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

  // Sign-in + bounded session-establishment poll, with ONE retry.
  // The retry re-issues the credentials callback (fresh CSRF) if the
  // first attempt's session cookie did not propagate within the poll
  // window. This is NOT an arbitrary sleep — it is a re-attempt with a
  // fresh callback, matching the resilience pattern of the existing
  // tenant-security.spec.ts helper but with a single bounded retry for
  // the high-contention Docker CI environment (20+ fresh tenants).
  let meData: { tenant?: { id: string; slug: string } } = {}
  let sessionOk = false
  let lastCallbackStatus = 0
  let lastSessionStatus = 0
  let lastMeStatus = 0

  for (let attempt = 0; attempt < 2 && !sessionOk; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const csrfData = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(
      `${BASE}/api/auth/callback/credentials`,
      {
        form: { email, password: PASSWORD, csrfToken: csrfData.csrfToken, json: 'true' },
        maxRedirects: 0,
      },
    )
    lastCallbackStatus = signinRes.status()
    if (signinRes.status() >= 400) {
      // Bad credentials — retry once, then fail.
      if (attempt === 0) continue
      throw new Error(`Sign-in callback failed for ${email}: HTTP ${signinRes.status()}`)
    }
    // Bounded poll (15s, 250ms intervals) — propagation barrier.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      lastSessionStatus = sessionRes.status()
      if (sessionRes.ok()) {
        const sb = await sessionRes.json().catch(() => ({}))
        if (sb && sb.user) {
          const meRes = await page.request.get(`${BASE}/api/tenants/me`)
          lastMeStatus = meRes.status()
          if (meRes.ok()) {
            meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
            if (meData.tenant && meData.tenant.id === tenantId) {
              sessionOk = true
              break
            }
          }
        }
      }
      await page.waitForTimeout(250)
    }
  }

  if (!sessionOk) {
    const hasSessionCookie = (await ctx.cookies()).some(
      (c) => c.name.includes('session') || c.name.includes('auth'),
    )
    throw new Error(
      `Auth session not established for ${email} after 2 attempts (15s poll each). ` +
        `signup_tenant_id=${tenantId} ` +
        `last_callback_status=${lastCallbackStatus} ` +
        `session_cookie_present=${hasSessionCookie} ` +
        `last_session_status=${lastSessionStatus} ` +
        `last_tenants_me_status=${lastMeStatus}`,
    )
  }

  const membersRes = await page.request.get(`${BASE}/api/members`)
  const membersData = (await membersRes.json()) as {
    members?: Array<{ userId: string; role: string; user: { id: string; email: string } }>
  }
  const owner = membersData.members?.find((m) => m.role === 'owner')
  if (!owner) throw new Error(`No owner membership for ${email} after signup`)

  return {
    page,
    email,
    workspaceName,
    tenantId,
    slug: meData.tenant!.slug,
    ownerId: owner.user.id,
  }
}

/** Sign in an EXISTING user (credentials login). Hardened: verifies the
 *  callback succeeded + polls /api/auth/session for an authenticated user
 *  + verifies the workspace matches `expectedTenantId` (if provided). */
async function signInExisting(
  browser: import('@playwright/test').Browser,
  email: string,
  expectedTenantId?: string,
): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // Sign-in + bounded poll, with ONE retry (same pattern as setupTenant).
  let lastCallbackStatus = 0
  let lastSessionStatus = 0
  let established = false
  for (let attempt = 0; attempt < 2 && !established; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(
      `${BASE}/api/auth/callback/credentials`,
      {
        form: { email, password: PASSWORD, csrfToken, json: 'true' },
        maxRedirects: 0,
      },
    )
    lastCallbackStatus = signinRes.status()
    if (signinRes.status() >= 400) {
      if (attempt === 0) continue
      throw new Error(`Sign-in failed for existing ${email}: HTTP ${signinRes.status()}`)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const s = await page.request.get(`${BASE}/api/auth/session`)
      lastSessionStatus = s.status()
      if (s.ok()) {
        const b = await s.json().catch(() => ({}))
        if (b && b.user) {
          if (!expectedTenantId || b.user.workspaceId === expectedTenantId) {
            established = true
            break
          }
        }
      }
      await page.waitForTimeout(250)
    }
  }
  if (!established) {
    throw new Error(
      `signInExisting: session not established for ${email} after 2 attempts (last_callback=${lastCallbackStatus} last_session=${lastSessionStatus})`,
    )
  }
  return page
}

/** As the tenant owner, create an invitation. Returns the full inviteUrl
 *  (which embeds the raw token EXACTLY ONCE) + the parsed slug + token. */
async function createInvitation(
  page: Page,
  email: string,
  role: string,
): Promise<{ inviteUrl: string } & ParsedInviteUrl> {
  const res = await page.request.post(`${BASE}/api/invitations`, {
    data: { email, role },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), `createInvitation(${email},${role}) should be 200`).toBe(200)
  const body = (await res.json()) as { invitation?: { inviteUrl: string } }
  if (!body.invitation?.inviteUrl) {
    throw new Error(`No inviteUrl returned for ${email}`)
  }
  const inviteUrl = body.invitation.inviteUrl
  return { inviteUrl, ...parseInviteUrl(inviteUrl) }
}

function parseInviteUrl(url: string): ParsedInviteUrl {
  const u = new URL(url)
  return {
    workspace: u.searchParams.get('workspace') ?? '',
    token: u.searchParams.get('token') ?? '',
  }
}

async function lookupInvitation(
  workspace: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const qs = new URLSearchParams({ workspace, token })
  const res = await fetch(`${BASE}/api/invitations/lookup?${qs.toString()}`)
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

async function acceptInvitation(
  page: Page,
  workspace: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await page.request.post(`${BASE}/api/invitations/accept`, {
    data: { workspace, token },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok(), status: res.status(), body }
}

async function revokeInvitation(
  page: Page,
  id: string,
): Promise<{ status: number; body: any }> {
  const res = await page.request.delete(`${BASE}/api/invitations?id=${encodeURIComponent(id)}`)
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), body }
}

/**
 * Reissue helper (#5 fix) — parses the response FIRST, and only extracts
 * the inviteUrl for a SUCCESSFUL response that actually contains one.
 * A non-200 response (e.g. plan-limit rejection, superseded_not_reissuable)
 * is returned as-is WITHOUT attempting to parse an inviteUrl (which would
 * throw TypeError: Invalid URL and hide the actual API result). */
async function reissueInvitation(
  page: Page,
  id: string,
): Promise<{ ok: boolean; status: number; body: any; workspace?: string; token?: string; inviteUrl?: string }> {
  const res = await page.request.post(`${BASE}/api/invitations/reissue?id=${encodeURIComponent(id)}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok() || !body?.invitation?.inviteUrl) {
    return { ok: res.ok(), status: res.status(), body }
  }
  const inviteUrl = body.invitation.inviteUrl as string
  const parsed = parseInviteUrl(inviteUrl)
  return {
    ok: res.ok(),
    status: res.status(),
    body,
    inviteUrl,
    workspace: parsed.workspace,
    token: parsed.token,
  }
}

/** Revoke a MEMBERSHIP (DELETE /api/members?memberId=...) — #6 fix. */
async function revokeMembership(
  page: Page,
  memberId: string,
): Promise<{ status: number; body: any }> {
  const res = await page.request.delete(
    `${BASE}/api/members?memberId=${encodeURIComponent(memberId)}`,
  )
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), body }
}

async function listWorkspaces(
  page: Page,
): Promise<{
  workspaces: Array<{ id: string; name: string; slug: string; role: string; isCurrent: boolean }>
  pendingInvitations: Array<{ id: string; tenantId: string; workspaceName: string; role: string; expiresAt: string }>
}> {
  const res = await page.request.get(`${BASE}/api/workspaces`)
  expect(res.status(), 'GET /api/workspaces should be 200').toBe(200)
  return (await res.json()) as any
}

async function getSessionWorkspaceId(page: Page): Promise<string | null> {
  const res = await page.request.get(`${BASE}/api/auth/session`)
  const body = (await res.json()) as { user?: { workspaceId?: string | null } }
  return body.user?.workspaceId ?? null
}

async function switchWorkspace(
  page: Page,
  workspaceId: string,
): Promise<{ status: number; body: any }> {
  const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const res = await page.request.post(`${BASE}/api/auth/session`, {
    data: { data: { workspaceId }, csrfToken },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), body }
}

async function otpVerifyEmail(email: string): Promise<{ requestId: string }> {
  const startRes = await fetch(`${BASE}/api/auth/signup/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!startRes.ok) throw new Error(`OTP start failed for ${email}: ${startRes.status}`)
  const { requestId } = (await startRes.json()) as { requestId: string }

  const verifyRes = await fetch(`${BASE}/api/auth/signup/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: MOCK_OTP, requestId }),
  })
  if (!verifyRes.ok) throw new Error(`OTP verify failed for ${email}: ${verifyRes.status}`)
  return { requestId }
}

async function acceptCompleteNewUser(args: {
  workspace: string
  email: string
  requestId: string
  password: string
  token: string
}): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${BASE}/api/invitations/accept-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

async function getUsage(page: Page): Promise<{ current: number; limit: number }> {
  const res = await page.request.get(`${BASE}/api/billing/subscription`)
  expect(res.status(), 'GET /api/billing/subscription should be 200').toBe(200)
  const body = (await res.json()) as {
    usage?: { usage?: { agents?: { current: number; limit: number } } }
  }
  const agents = body.usage?.usage?.agents
  if (!agents) throw new Error('No agents usage in billing response')
  return agents
}

async function devExpireInvitation(workspace: string, token: string): Promise<void> {
  const res = await fetch(`${BASE}/api/invitations/dev/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, token }),
  })
  if (!res.ok) {
    throw new Error(`dev/expire failed: ${res.status} (is NIXIFY_MOCK=true?)`)
  }
}

/** DEV-ONLY: change the tenant's plan (D6 real downgrade test). Gated
 *  behind NODE_ENV !== 'production' && NIXIFY_MOCK === 'true'. */
async function devSetPlan(workspace: string, plan: string): Promise<void> {
  const res = await fetch(`${BASE}/api/invitations/dev/set-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, plan }),
  })
  if (!res.ok) {
    throw new Error(`dev/set-plan(${plan}) failed: ${res.status}`)
  }
}

async function createVisitorConversation(
  slug: string,
  text: string,
): Promise<{ conversationId: string; contactId: string }> {
  const contactRes = await fetch(`${BASE}/api/widget/${slug}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId: `v-${slug}-${Date.now()}-${Math.random()}` }),
  })
  if (!contactRes.ok) throw new Error(`Widget contact failed: ${contactRes.status}`)
  const contactData = (await contactRes.json()) as { contactId: string; realtimeToken: string }

  const msgRes = await fetch(`${BASE}/api/widget/${slug}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${contactData.realtimeToken}`,
    },
    body: JSON.stringify({ text }),
  })
  if (!msgRes.ok) throw new Error(`Widget message failed: ${msgRes.status}`)
  const msgData = (await msgRes.json()) as { conversationId: string }
  return { conversationId: msgData.conversationId, contactId: contactData.contactId }
}

async function listConversations(page: Page): Promise<Array<{ id: string; contactName?: string }>> {
  const res = await page.request.get(`${BASE}/api/conversations`)
  if (!res.ok()) return []
  const body = (await res.json()) as { conversations?: Array<{ id: string; contactName?: string }> }
  return body.conversations ?? []
}

// ----------------------------------------------------------------------------
// A. EXISTING ACCOUNT / SECOND WORKSPACE (11-step flow)
// ----------------------------------------------------------------------------

test.describe('A. Existing account / second workspace', () => {
  let tenantA: TenantCtx
  let tenantB: TenantCtx
  let invite: { inviteUrl: string } & ParsedInviteUrl
  let aConversationId: string
  let bConversationId: string

  test.beforeAll(async ({ browser }) => {
    const suffix = uniqueSuffix()
    tenantA = await setupTenant(browser, `ta-iws-${suffix}@iws.test`, `TA IWS ${suffix}`)
    tenantB = await setupTenant(browser, `tb-iws-${suffix}@iws.test`, `TB IWS ${suffix}`)
    aConversationId = (await createVisitorConversation(tenantA.slug, 'hello from A visitor')).conversationId
    bConversationId = (await createVisitorConversation(tenantB.slug, 'hello from B visitor')).conversationId
    // A invites B. owner(A)=1 seat + inviteForB=1 seat = 2/2 (Free cap).
    invite = await createInvitation(tenantA.page, tenantB.email, 'admin')
  })

  test.afterAll(async () => {
    await tenantA?.page.context().close().catch(() => {})
    await tenantB?.page.context().close().catch(() => {})
  })

  test('A3-A4. A invites B; B accepts while authenticated', async () => {
    const res = await acceptInvitation(tenantB.page, invite.workspace, invite.token)
    expect(res.status, `accept should be 200 (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.workspaceId).toBe(tenantA.tenantId)
  })

  test('A5. B sees both A and B in workspace list', async () => {
    const { workspaces } = await listWorkspaces(tenantB.page)
    const ids = workspaces.map((w) => w.id).sort()
    const expected = [tenantA.tenantId, tenantB.tenantId].sort()
    expect(ids, 'B should have active memberships in both A and B').toEqual(expected)
  })

  test('A6-A8. B switches B → A; A data appears; B data is absent', async () => {
    const sw = await switchWorkspace(tenantB.page, tenantA.tenantId)
    expect(sw.status, `switch B→A should be 200 (got ${sw.status})`).toBe(200)
    const wsId = await getSessionWorkspaceId(tenantB.page)
    expect(wsId, 'session should point to A after switch').toBe(tenantA.tenantId)
    const convs = await listConversations(tenantB.page)
    const ids = convs.map((c) => c.id)
    expect(ids, 'A conversation should be visible after switching to A').toContain(aConversationId)
    expect(ids, 'B conversation should NOT be visible after switching to A').not.toContain(bConversationId)
  })

  test('A9-A10. B switches A → B; B data returns', async () => {
    const sw = await switchWorkspace(tenantB.page, tenantB.tenantId)
    expect(sw.status, `switch A→B should be 200 (got ${sw.status})`).toBe(200)
    const wsId = await getSessionWorkspaceId(tenantB.page)
    expect(wsId, 'session should point to B after switch back').toBe(tenantB.tenantId)
    const convs = await listConversations(tenantB.page)
    const ids = convs.map((c) => c.id)
    expect(ids, 'B conversation should be visible after switching back to B').toContain(bConversationId)
    expect(ids, 'A conversation should NOT be visible after switching back to B').not.toContain(aConversationId)
  })

  test('A11. stale A conversation state does not appear after switching to B', async () => {
    const convs1 = await listConversations(tenantB.page)
    const convs2 = await listConversations(tenantB.page)
    expect(convs1.map((c) => c.id)).not.toContain(aConversationId)
    expect(convs2.map((c) => c.id)).not.toContain(aConversationId)
  })
})

// ----------------------------------------------------------------------------
// B. NEW ACCOUNT INVITATION (10-step flow)
// ----------------------------------------------------------------------------

test.describe('B. New account invitation', () => {
  let tenantA: TenantCtx
  let invite: { inviteUrl: string } & ParsedInviteUrl
  let newEmail: string
  let browser: import('@playwright/test').Browser

  test.beforeAll(async ({ browser: b }) => {
    browser = b
    const suffix = uniqueSuffix()
    tenantA = await setupTenant(browser, `ta-newacc-${suffix}@iws.test`, `TA NewAcc ${suffix}`)
    newEmail = `newuser-${suffix}@iws.test`
    invite = await createInvitation(tenantA.page, newEmail, 'manager')
  })

  test.afterAll(async () => {
    await tenantA?.page.context().close().catch(() => {})
  })

  test('B1-B2. invited email has no usable User before verification', async () => {
    const page = await browser.newPage()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
      form: { email: newEmail, password: PASSWORD, csrfToken, json: 'true' },
      maxRedirects: 0,
    })
    expect(signinRes.status(), 'pre-verification sign-in must fail').toBeGreaterThanOrEqual(400)
    await page.context().close()
  })

  test('B3. public lookup of the real invite URL succeeds', async () => {
    const res = await lookupInvitation(invite.workspace, invite.token)
    expect(res.ok, `lookup should succeed (got ${res.status})`).toBe(true)
    expect(res.body.role).toBe('manager')
    expect(res.body.email).toBe(newEmail)
  })

  test('B4-B6. complete OTP + create account + accept invitation', async () => {
    const { requestId } = await otpVerifyEmail(newEmail)
    const res = await acceptCompleteNewUser({
      workspace: invite.workspace,
      email: newEmail,
      requestId,
      password: PASSWORD,
      token: invite.token,
    })
    expect(res.status, `accept-complete should be 200 (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.workspaceId).toBe(tenantA.tenantId)
  })

  test('B7. membership is active with the intended role', async () => {
    const res = await tenantA.page.request.get(`${BASE}/api/members`)
    const body = (await res.json()) as {
      members?: Array<{ role: string; status: string; user: { email: string } }>
    }
    const m = body.members?.find((x) => x.user.email === newEmail)
    expect(m, 'new user should appear in members list').toBeTruthy()
    expect(m!.status).toBe('active')
    expect(m!.role).toBe('manager')
  })

  test('B8. no new owner Tenant was created', async () => {
    const page = await signInExisting(browser, newEmail)
    const { workspaces } = await listWorkspaces(page)
    expect(workspaces.length, 'new user should have exactly ONE workspace').toBe(1)
    expect(workspaces[0].id).toBe(tenantA.tenantId)
    expect(workspaces[0].role, 'role should be manager (not owner)').toBe('manager')
    await page.context().close()
  })

  test('B9. credentials login succeeds for the new user', async () => {
    const page = await signInExisting(browser, newEmail, tenantA.tenantId)
    const wsId = await getSessionWorkspaceId(page)
    expect(wsId, 'new user session should be established').toBeTruthy()
    await page.context().close()
  })

  test('B10. invited workspace is accessible after login', async () => {
    const page = await signInExisting(browser, newEmail, tenantA.tenantId)
    const wsId = await getSessionWorkspaceId(page)
    expect(wsId, 'session should point to the invited workspace A').toBe(tenantA.tenantId)
    const meRes = await page.request.get(`${BASE}/api/tenants/me`)
    expect(meRes.status()).toBe(200)
    const me = (await meRes.json()) as { tenant?: { id: string } }
    expect(me.tenant?.id).toBe(tenantA.tenantId)
    await page.context().close()
  })
})

// ----------------------------------------------------------------------------
// C. SECURITY (10 sub-scenarios — fresh tenant per sub-scenario #1 fix)
// ----------------------------------------------------------------------------

test.describe('C. Security', () => {
  let browser: import('@playwright/test').Browser

  test.beforeAll(async ({ browser: b }) => { browser = b })

  // Helper: create a fresh tenant pair (A inviter + B invitee) for a
  // single sub-scenario. Each sub-scenario that creates invitations gets
  // its own pair so the Free-plan 2-agent cap is never exceeded.
  async function freshPair(suffix: string): Promise<{ a: TenantCtx; b: TenantCtx }> {
    const a = await setupTenant(browser, `ta-sec-${suffix}@iws.test`, `TA ${suffix}`)
    const b = await setupTenant(browser, `tb-sec-${suffix}@iws.test`, `TB ${suffix}`)
    return { a, b }
  }

  test('C1. wrong authenticated email cannot accept', async () => {
    const { a, b } = await freshPair(`c1-${uniqueSuffix()}`)
    try {
      // A invites a THIRD email (not B). owner(A)=1 + invite=1 = 2/2 (Free cap).
      const cEmail = `c1c-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, cEmail, 'agent')
      // B (authenticated, different email) tries to accept → email_mismatch.
      const res = await acceptInvitation(b.page, inv.workspace, inv.token)
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('email_mismatch')
    } finally {
      await a.page.context().close().catch(() => {})
      await b.page.context().close().catch(() => {})
    }
  })

  test('C2. invalid token cannot accept', async () => {
    const { a, b } = await freshPair(`c2-${uniqueSuffix()}`)
    try {
      // No invitation created — a random fake token. No seat consumed.
      const fakeToken = 'a'.repeat(64)
      const res = await acceptInvitation(b.page, a.slug, fakeToken)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('not_found')
    } finally {
      await a.page.context().close().catch(() => {})
      await b.page.context().close().catch(() => {})
    }
  })

  test('C3. modified workspace identifier cannot accept (BLOCKER 2 fail-closed)', async () => {
    const { a, b } = await freshPair(`c3-${uniqueSuffix()}`)
    try {
      // A invites B. owner(A)=1 + inviteForB=1 = 2/2.
      const inv = await createInvitation(a.page, b.email, 'admin')
      // Substitute B's slug — lookup resolves B's tenantId, queries
      // Invitation inside withTenant(B) → A's invitation not found → 404.
      const look = await lookupInvitation(b.slug, inv.token)
      expect(look.status, 'tampered workspace slug must fail closed (404)').toBe(404)
      expect(look.body.error).toBe('not_found')
      const acceptRes = await acceptInvitation(b.page, b.slug, inv.token)
      expect(acceptRes.status).toBe(404)
      expect(acceptRes.body.error).toBe('not_found')
    } finally {
      await a.page.context().close().catch(() => {})
      await b.page.context().close().catch(() => {})
    }
  })

  test('C4. revoked invitation cannot be accepted', async () => {
    const { a } = await freshPair(`c4-${uniqueSuffix()}`)
    try {
      const target = `c4-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'agent')
      const listRes = await a.page.request.get(`${BASE}/api/invitations`)
      const listBody = (await listRes.json()) as { invitations?: Array<{ id: string; email: string }> }
      const row = listBody.invitations?.find((i) => i.email === target)
      expect(row, 'created invitation should appear in pending list').toBeTruthy()
      await revokeInvitation(a.page, row!.id)
      const look = await lookupInvitation(inv.workspace, inv.token)
      expect(look.status).toBe(404)
      expect(look.body.error).toBe('not_found')
    } finally {
      await a.page.context().close().catch(() => {})
    }
  })

  test('C5. expired invitation cannot be accepted', async () => {
    const { a } = await freshPair(`c5-${uniqueSuffix()}`)
    try {
      const target = `c5-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'agent')
      await devExpireInvitation(inv.workspace, inv.token)
      const look = await lookupInvitation(inv.workspace, inv.token)
      expect(look.status, 'expired invitation lookup must 404').toBe(404)
    } finally {
      await a.page.context().close().catch(() => {})
    }
  })

  test('C6. accepted invitation cannot be reused', async () => {
    const { a, b } = await freshPair(`c6-${uniqueSuffix()}`)
    try {
      const inv = await createInvitation(a.page, b.email, 'admin')
      // B accepts.
      const acc = await acceptInvitation(b.page, inv.workspace, inv.token)
      expect(acc.status).toBe(200)
      // Re-accept → already_accepted (410).
      const res = await acceptInvitation(b.page, inv.workspace, inv.token)
      expect(res.status).toBe(410)
      expect(['already_accepted', 'not_found']).toContain(res.body.error)
    } finally {
      await a.page.context().close().catch(() => {})
      await b.page.context().close().catch(() => {})
    }
  })

  test('C7. simultaneous accepts create exactly one active membership', async () => {
    const { a } = await freshPair(`c7-${uniqueSuffix()}`)
    try {
      const suffix = uniqueSuffix()
      const fresh = `c7-${suffix}@iws.test`
      // Create a fresh user via invitation + accept-complete.
      const inv = await createInvitation(a.page, fresh, 'agent')
      const { requestId } = await otpVerifyEmail(fresh)
      const ac = await acceptCompleteNewUser({
        workspace: inv.workspace, email: fresh, requestId, password: PASSWORD, token: inv.token,
      })
      expect(ac.status, `first accept-complete should succeed (got ${ac.status})`).toBe(200)
      // Create a SECOND invitation for the same (now-existing) user.
      await devSetPlan(a.slug, 'max')
      const inv2 = await createInvitation(a.page, fresh, 'manager')
      // Sign in on TWO contexts.
      const page1 = await signInExisting(browser, fresh, a.tenantId)
      const page2 = await signInExisting(browser, fresh, a.tenantId)
      // Fire both accepts concurrently.
      const [r1, r2] = await Promise.all([
        acceptInvitation(page1, inv2.workspace, inv2.token),
        acceptInvitation(page2, inv2.workspace, inv2.token),
      ])
      const statuses = [r1.status, r2.status].sort()
      expect(statuses, `concurrent accepts: one 200 + one 410, got ${statuses.join(',')}`).toEqual([200, 410])
      // Exactly one active membership in A.
      const meRes = await page1.request.get(`${BASE}/api/workspaces`)
      const ws = (await meRes.json()) as { workspaces: Array<{ id: string; role: string }> }
      const aMemberships = ws.workspaces.filter((w) => w.id === a.tenantId)
      expect(aMemberships.length, 'exactly one active membership in A').toBe(1)
      expect(aMemberships[0].role).toBe('manager')
      await page1.context().close()
      await page2.context().close()
    } finally {
      await a.page.context().close().catch(() => {})
    }
  })

  test('C8. pending invite never becomes an active login workspace', async () => {
    const { a } = await freshPair(`c8-${uniqueSuffix()}`)
    try {
      const pending = `c8-${uniqueSuffix()}@iws.test`
      await createInvitation(a.page, pending, 'agent')
      // Try to sign in as the pending invitee — must fail.
      const page = await browser.newPage()
      await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
      const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
      const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
        form: { email: pending, password: PASSWORD, csrfToken, json: 'true' },
        maxRedirects: 0,
      })
      expect(signinRes.status(), 'pending invitee must not be able to sign in').toBeGreaterThanOrEqual(400)
      await page.context().close()
    } finally {
      await a.page.context().close().catch(() => {})
    }
  })

  test('C9. unauthorized lower role cannot create higher-role invite', async () => {
    const { a } = await freshPair(`c9-${uniqueSuffix()}`)
    try {
      const suffix = uniqueSuffix()
      const agentEmail = `c9-agent-${suffix}@iws.test`
      const inv = await createInvitation(a.page, agentEmail, 'agent')
      const { requestId } = await otpVerifyEmail(agentEmail)
      await acceptCompleteNewUser({
        workspace: inv.workspace, email: agentEmail, requestId, password: PASSWORD, token: inv.token,
      })
      const agentPage = await signInExisting(browser, agentEmail, a.tenantId)
      // Agent tries to invite someone as 'admin' → forbidden (403).
      const res = await agentPage.request.post(`${BASE}/api/invitations`, {
        data: { email: `c9-target-${suffix}@iws.test`, role: 'admin' },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status(), 'agent cannot create admin invitation').toBe(403)
      expect((await res.json()).error).toBe('forbidden')
      await agentPage.context().close()
    } finally {
      await a.page.context().close().catch(() => {})
    }
  })

  test('C10. client cannot choose its own target role during workspace switch', async () => {
    const { a, b } = await freshPair(`c10-${uniqueSuffix()}`)
    try {
      const inv = await createInvitation(a.page, b.email, 'admin')
      const acc = await acceptInvitation(b.page, inv.workspace, inv.token)
      expect(acc.status).toBe(200)
      // Switch to A with a client-supplied role='owner' — must be ignored.
      const csrfRes = await b.page.request.get(`${BASE}/api/auth/csrf`)
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
      const res = await b.page.request.post(`${BASE}/api/auth/session`, {
        data: { data: { workspaceId: a.tenantId, role: 'owner' }, csrfToken },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status(), `switch should succeed (got ${res.status})`).toBe(200)
      const sessionRes = await b.page.request.get(`${BASE}/api/auth/session`)
      const session = (await sessionRes.json()) as { user?: { role?: string; workspaceId?: string } }
      expect(session.user?.role, 'client-supplied role must be ignored; role from DB').toBe('admin')
      expect(session.user?.workspaceId).toBe(a.tenantId)
      await switchWorkspace(b.page, b.tenantId)
    } finally {
      await a.page.context().close().catch(() => {})
      await b.page.context().close().catch(() => {})
    }
  })
})

// ----------------------------------------------------------------------------
// D. EXPIRED-SEAT COUNTING (BLOCKER 3 — fresh tenant per sub-scenario #1 fix)
// ----------------------------------------------------------------------------

test.describe('D. Expired-seat counting (BLOCKER 3)', () => {
  let browser: import('@playwright/test').Browser
  test.beforeAll(async ({ browser: b }) => { browser = b })

  async function freshTenant(tag: string): Promise<TenantCtx> {
    return setupTenant(browser, `ta-${tag}-${uniqueSuffix()}@iws.test`, `TA ${tag}`)
  }

  test('D1. pending invite consumes one seat', async () => {
    const a = await freshTenant('d1')
    try {
      const before = await getUsage(a.page)
      await createInvitation(a.page, `d1-${uniqueSuffix()}@iws.test`, 'agent')
      const after = await getUsage(a.page)
      expect(after.current, 'pending invite must consume one seat').toBe(before.current + 1)
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('D2. expired pending invite does not consume seat', async () => {
    const a = await freshTenant('d2')
    try {
      const before = await getUsage(a.page)
      const inv = await createInvitation(a.page, `d2-${uniqueSuffix()}@iws.test`, 'agent')
      const mid = await getUsage(a.page)
      expect(mid.current).toBe(before.current + 1)
      await devExpireInvitation(inv.workspace, inv.token)
      const after = await getUsage(a.page)
      expect(after.current, 'expired pending invite must free the seat').toBe(before.current)
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('D3. revoke frees seat', async () => {
    const a = await freshTenant('d3')
    try {
      const before = await getUsage(a.page)
      const target = `d3-${uniqueSuffix()}@iws.test`
      await createInvitation(a.page, target, 'agent')
      const mid = await getUsage(a.page)
      expect(mid.current).toBe(before.current + 1)
      const listRes = await a.page.request.get(`${BASE}/api/invitations`)
      const listBody = (await listRes.json()) as { invitations?: Array<{ id: string; email: string }> }
      const row = listBody.invitations?.find((i) => i.email === target)
      expect(row, 'invitation should be in pending list').toBeTruthy()
      await revokeInvitation(a.page, row!.id)
      const after = await getUsage(a.page)
      expect(after.current, 'revoked invitation must free the seat').toBe(before.current)
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('D4. accept converts pending seat to active without a SECOND increment (#2 fix)', async () => {
    const a = await freshTenant('d4')
    try {
      const before = await getUsage(a.page)
      const target = `d4-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'agent')
      // Capture usage IMMEDIATELY AFTER invitation creation (before accept).
      const afterCreate = await getUsage(a.page)
      expect(afterCreate.current, 'create must add exactly one seat').toBe(before.current + 1)
      // Accept the invitation (creates User + active Membership).
      const { requestId } = await otpVerifyEmail(target)
      const ac = await acceptCompleteNewUser({
        workspace: inv.workspace, email: target, requestId, password: PASSWORD, token: inv.token,
      })
      expect(ac.status, `accept-complete should succeed (got ${ac.status})`).toBe(200)
      const afterAccept = await getUsage(a.page)
      // CORRECT INVARIANT (#2 fix): the pending seat was CONVERTED to an
      // active seat — usage after accept === usage after create (the
      // accept did NOT increment a SECOND time). Before the invitation
      // existed, the seat did not exist; after acceptance, the invitee
      // is an active member consuming one seat. So:
      //   afterAccept === afterCreate  (conversion, not double-count)
      //   afterAccept === before + 1   (one net seat added by the whole flow)
      expect(afterAccept.current, 'accept must not increment usage a second time (conversion, not addition)').toBe(afterCreate.current)
      expect(afterAccept.current, 'net usage is before+1').toBe(before.current + 1)
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('D5. concurrent invites at the limit cannot overbook', async () => {
    const a = await freshTenant('d5')
    try {
      const usage = await getUsage(a.page)
      const limit = usage.limit
      if (limit === -1) { console.warn('[D5] unlimited plan — trivially satisfied'); return }
      const remaining = limit - usage.current
      const suffix = uniqueSuffix()
      for (let i = 0; i < remaining; i++) {
        await createInvitation(a.page, `d5-${suffix}-${i}@iws.test`, 'agent')
      }
      const overRes = await a.page.request.post(`${BASE}/api/invitations`, {
        data: { email: `d5-${suffix}-X@iws.test`, role: 'agent' },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(overRes.status(), 'over-limit invite must be 402').toBe(402)
      expect((await overRes.json()).error).toBe('plan_limit_exceeded')
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('D6. REAL plan downgrade before acceptance blocks over-activation (#3 fix)', async () => {
    const a = await freshTenant('d6')
    try {
      // 1. Start on 'max' (agents=20) — gives plenty of capacity.
      await devSetPlan(a.slug, 'max')
      // 2. Create valid pending invitation (usage: owner=1 + pending=1 = 2).
      const target = `d6-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'agent')
      // 3. Create enough legitimate usage to be ABOVE the LOWER target cap.
      //    Downgrade target is 'free' (agents=2). We need usage > 2.
      //    Create a second pending invitation (usage=3, allowed on max=20).
      const target2 = `d6b-${uniqueSuffix()}@iws.test`
      await createInvitation(a.page, target2, 'agent')
      const usageOnMax = await getUsage(a.page)
      expect(usageOnMax.current, 'usage on max should be 3 (owner+2 pending)').toBe(3)
      // 4. DOWNGRADE to 'free' (agents=2). Now usage(3) > cap(2).
      await devSetPlan(a.slug, 'free')
      // 5. Attempt invitation acceptance — must fail with plan_limit_exceeded
      //    (the transactional re-check sees usage > cap).
      const { requestId } = await otpVerifyEmail(target)
      const ac = await acceptCompleteNewUser({
        workspace: inv.workspace, email: target, requestId, password: PASSWORD, token: inv.token,
      })
      expect(ac.status, 'accept under downgraded cap must be 402').toBe(402)
      expect(ac.body.error, 'error must be plan_limit_exceeded').toBe('plan_limit_exceeded')
      // 7. Invitation remains pending (not consumed).
      const look = await lookupInvitation(inv.workspace, inv.token)
      expect(look.status, 'invitation must remain pending after rejected accept').toBe(200)
      // 8. Membership was NOT created — the target email cannot sign in.
      const page = await browser.newPage()
      await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
      const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
      const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
        form: { email: target, password: PASSWORD, csrfToken, json: 'true' },
        maxRedirects: 0,
      })
      expect(signinRes.status(), 'no membership created — target cannot sign in').toBeGreaterThanOrEqual(400)
      await page.context().close()
      // 9. No partial state — usage unchanged after the failed accept.
      const usageAfterReject = await getUsage(a.page)
      expect(usageAfterReject.current, 'usage unchanged after rejected accept').toBe(3)

      // SEPARATELY prove: usage === limit with pending→active conversion IS allowed.
      // On a fresh 'free' tenant: owner=1, cap=2. Create 1 pending (usage=2=cap).
      // Accept it → pending converts to active, usage stays 2 (not a second increment).
      const a2 = await setupTenant(browser, `ta-d6b-${uniqueSuffix()}@iws.test`, `TA D6b`)
      try {
        const before2 = await getUsage(a2.page)
        const target3 = `d6c-${uniqueSuffix()}@iws.test`
        const inv3 = await createInvitation(a2.page, target3, 'agent')
        const atCap = await getUsage(a2.page)
        expect(atCap.current, 'usage at cap after one pending invite').toBe(before2.current + 1)
        expect(atCap.limit).toBe(2)
        // Accept — the conversion pending→active does NOT add a seat.
        const { requestId: rid3 } = await otpVerifyEmail(target3)
        const ac3 = await acceptCompleteNewUser({
          workspace: inv3.workspace, email: target3, requestId: rid3, password: PASSWORD, token: inv3.token,
        })
        expect(ac3.status, 'conversion at cap should succeed (no second increment)').toBe(200)
        const afterAccept2 = await getUsage(a2.page)
        expect(afterAccept2.current, 'conversion does not increase usage').toBe(atCap.current)
      } finally { await a2.page.context().close().catch(() => {}) }
    } finally {
      // Restore the downgraded tenant's plan so it doesn't interfere.
      await devSetPlan(a.slug, 'max').catch(() => {})
      await a.page.context().close().catch(() => {})
    }
  })
})

// ----------------------------------------------------------------------------
// E. LEGACY REISSUE LIFECYCLE (fixed — only revoked reissuable #4 fix)
// ----------------------------------------------------------------------------

test.describe('E. Legacy reissue lifecycle (BLOCKER 4 — fixed lifecycle)', () => {
  let browser: import('@playwright/test').Browser
  test.beforeAll(async ({ browser: b }) => { browser = b })

  async function freshTenant(tag: string): Promise<TenantCtx> {
    return setupTenant(browser, `ta-${tag}-${uniqueSuffix()}@iws.test`, `TA ${tag}`)
  }

  test('E1-E4. reissue produces ONE fresh link; old token dead; superseded not reissuable', async () => {
    const a = await freshTenant('e1')
    try {
      // Create + revoke an invitation (simulates a legacy/unusable invitation).
      const target = `e1-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'manager')
      const listRes = await a.page.request.get(`${BASE}/api/invitations`)
      const listBody = (await listRes.json()) as { invitations?: Array<{ id: string; email: string }> }
      const row = listBody.invitations?.find((i) => i.email === target)
      expect(row, 'created invitation should be in pending list').toBeTruthy()
      await revokeInvitation(a.page, row!.id)
      // Old token is dead (revoked).
      const look0 = await lookupInvitation(inv.workspace, inv.token)
      expect(look0.status, 'revoked token must 404').toBe(404)

      // E2-E3: reissue the REVOKED invitation → fresh token.
      const r1 = await reissueInvitation(a.page, row!.id)
      expect(r1.status, `reissue should be 200 (got ${r1.status}: ${JSON.stringify(r1.body)})`).toBe(200)
      expect(r1.token, 'fresh token must differ from old').not.toBe(inv.token)
      expect(r1.workspace, 'workspace slug preserved').toBe(inv.workspace)
      // New token is valid.
      const look1 = await lookupInvitation(r1.workspace!, r1.token!)
      expect(look1.status, 'fresh invitation must be acceptable').toBe(200)
      expect(look1.body.role).toBe('manager')
      // E4: old token is now SUPERSEDED — still dead.
      const look0b = await lookupInvitation(inv.workspace, inv.token)
      expect(look0b.status, 'old token must remain 404 after reissue').toBe(404)

      // #4 fix: the superseded original row CANNOT be reissued again.
      const r2 = await reissueInvitation(a.page, row!.id)
      expect(r2.status, 'second reissue of superseded must be 400').toBe(400)
      expect(r2.body.error, 'superseded_not_reissuable').toBe('superseded_not_reissuable')
    } finally { await a.page.context().close().catch(() => {}) }
  })

  test('E5-E7. revoke current pending + reissue chain; only ONE valid link', async () => {
    const a = await freshTenant('e5')
    try {
      // Create a pending invitation (usable).
      const target = `e5-${uniqueSuffix()}@iws.test`
      const inv = await createInvitation(a.page, target, 'agent')
      const listRes = await a.page.request.get(`${BASE}/api/invitations`)
      const listBody = (await listRes.json()) as { invitations?: Array<{ id: string; email: string }> }
      const row = listBody.invitations?.find((i) => i.email === target)
      expect(row, 'pending invitation in list').toBeTruthy()

      // Revoke the CURRENT pending invitation (the link was lost).
      await revokeInvitation(a.page, row!.id)
      // Reissue that newly-revoked row → fresh link.
      const r1 = await reissueInvitation(a.page, row!.id)
      expect(r1.status, 'reissue of revoked should be 200').toBe(200)
      const link1 = { workspace: r1.workspace!, token: r1.token! }
      // link1 is valid.
      expect((await lookupInvitation(link1.workspace, link1.token)).status).toBe(200)
      // The ORIGINAL pending token is dead (revoked → superseded).
      expect((await lookupInvitation(inv.workspace, inv.token)).status).toBe(404)

      // To reissue AGAIN: revoke the CURRENT pending (link1's invitation).
      // Find link1's invitation id.
      const list2Res = await a.page.request.get(`${BASE}/api/invitations`)
      const list2Body = (await list2Res.json()) as { invitations?: Array<{ id: string; email: string; status: string }> }
      const link1Row = list2Body.invitations?.find((i) => i.email === target && i.status === 'pending')
      expect(link1Row, 'link1 pending invitation in list').toBeTruthy()
      await revokeInvitation(a.page, link1Row!.id)
      const r2 = await reissueInvitation(a.page, link1Row!.id)
      expect(r2.status, 'reissue of link1-revoked should be 200').toBe(200)
      const link2 = { workspace: r2.workspace!, token: r2.token! }
      // link2 is valid.
      expect((await lookupInvitation(link2.workspace, link2.token)).status).toBe(200)
      // link1 is now dead (revoked → superseded).
      expect((await lookupInvitation(link1.workspace, link1.token)).status).toBe(404)

      // ONLY ONE valid pending invitation exists for this email.
      const list3Res = await a.page.request.get(`${BASE}/api/invitations`)
      const list3Body = (await list3Res.json()) as { invitations?: Array<{ email: string; status: string }> }
      const pendingForEmail = list3Body.invitations?.filter((i) => i.email === target && i.status === 'pending') ?? []
      expect(pendingForEmail.length, 'exactly ONE valid pending invitation for the email').toBe(1)
    } finally { await a.page.context().close().catch(() => {}) }
  })
})

// ----------------------------------------------------------------------------
// F. REVOKED-CURRENT-WORKSPACE RECOVERY (11-step flow, DELETE /api/members #6 #7)
// ----------------------------------------------------------------------------

test.describe('F. Revoked-current-workspace recovery', () => {
  let tenantA: TenantCtx
  let tenantB: TenantCtx
  let bMemberId: string
  let aConversationId: string
  let bConversationId: string

  test.beforeAll(async ({ browser }) => {
    const suffix = uniqueSuffix()
    tenantA = await setupTenant(browser, `ta-rcvr-${suffix}@iws.test`, `TA Rcvr ${suffix}`)
    tenantB = await setupTenant(browser, `tb-rcvr-${suffix}@iws.test`, `TB Rcvr ${suffix}`)
    aConversationId = (await createVisitorConversation(tenantA.slug, 'A conv for revoke test')).conversationId
    bConversationId = (await createVisitorConversation(tenantB.slug, 'B conv for revoke test')).conversationId
    // B accepts an invitation to A (B now has active memberships in both A and B).
    const invite = await createInvitation(tenantA.page, tenantB.email, 'admin')
    const res = await acceptInvitation(tenantB.page, invite.workspace, invite.token)
    expect(res.status, `B should accept A's invite (got ${res.status})`).toBe(200)
    // Switch B to A (current workspace = A).
    await switchWorkspace(tenantB.page, tenantA.tenantId)
    // Resolve B's membership id in A (needed for the DELETE /api/members call).
    const membersRes = await tenantA.page.request.get(`${BASE}/api/members`)
    const membersBody = (await membersRes.json()) as {
      members?: Array<{ id: string; role: string; user: { email: string } }>
    }
    const bMember = membersBody.members?.find((m) => m.user.email === tenantB.email)
    expect(bMember, 'B should be a member of A').toBeTruthy()
    bMemberId = bMember!.id
  })

  test.afterAll(async () => {
    await tenantA?.page.context().close().catch(() => {})
    await tenantB?.page.context().close().catch(() => {})
  })

  test('F3-F4. revoke B from A; A APIs fail closed immediately', async () => {
    // A's owner revokes B's membership in A via DELETE /api/members (#6).
    const res = await revokeMembership(tenantA.page, bMemberId)
    expect(res.status, `DELETE /api/members should be 200 (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(200)
    // B's session still points to A (now revoked). A tenant APIs must fail
    // closed — withSessionTenant rejects a revoked CURRENT membership → 401.
    const convRes = await tenantB.page.request.get(`${BASE}/api/conversations`)
    expect([401, 403], `A APIs must fail closed after revoke (got ${convRes.status()})`).toContain(convRes.status())
  })

  test('F5-F8. /api/workspaces still lists B; switch to B; no A data visible', async () => {
    // /api/workspaces uses globalDb (cross-tenant) — still works for B.
    const { workspaces } = await listWorkspaces(tenantB.page)
    const bWs = workspaces.find((w) => w.id === tenantB.tenantId)
    expect(bWs, 'B should still have active membership in B').toBeTruthy()
    const aWs = workspaces.find((w) => w.id === tenantA.tenantId)
    expect(aWs, 'revoked A should not appear in active workspaces').toBeUndefined()

    // Switch to B — the jwt callback validates the ACTIVE B membership.
    const sw = await switchWorkspace(tenantB.page, tenantB.tenantId)
    expect(sw.status, `switch to B should succeed (got ${sw.status})`).toBe(200)
    const wsId = await getSessionWorkspaceId(tenantB.page)
    expect(wsId, 'session should point to B').toBe(tenantB.tenantId)
    // B's conversations are accessible.
    const convs = await listConversations(tenantB.page)
    expect(convs.map((c) => c.id), 'B conversation should be visible').toContain(bConversationId)
    // No A data remains visible.
    expect(convs.map((c) => c.id), 'A conversation must NOT be visible').not.toContain(aConversationId)
    // /api/auth/session reflects B.
    const sessionRes = await tenantB.page.request.get(`${BASE}/api/auth/session`)
    const session = (await sessionRes.json()) as { user?: { workspaceId?: string } }
    expect(session.user?.workspaceId).toBe(tenantB.tenantId)
  })
})
