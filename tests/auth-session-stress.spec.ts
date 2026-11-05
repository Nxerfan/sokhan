import { test, expect, type Page, type Browser } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Authentication + session stress regression (AI-Q3 PR #30 reliability blocker).
 *
 * Exercises real authentication, session switching, revocation and reactivation
 * in BOTH Full and Lite Docker stacks against real PostgreSQL. No mocks.
 * All assertions are at the API level (Playwright APIRequestContext through
 * Caddy on port 81 — the real HTTP/session stack).
 *
 * BLOCKER A fix — immediate consistency (no polling in the main path):
 *   `switchWorkspaceRaw` issues the POST and returns immediately. Callers
 *   verify immediate consistency via a SINGLE session GET + SINGLE authorized
 *   API read — no polling, no sleeps. If immediate consistency fails, the
 *   test captures sanitized diagnostics and fails (does NOT retry).
 *
 *   A SEPARATE diagnostic test (#9) measures cookie-propagation latency
 *   with a bounded poll. It does NOT replace or weaken the strict
 *   immediate-consistency assertions in scenarios 3–8.
 *
 * BLOCKER B fix — real persisted data for cross-tenant isolation:
 *   Scenario 6 seeds real widget conversations in Tenant A and Tenant B,
 *   verifies both exist, then attempts the unauthorized switch. It asserts
 *   real data isolation: B's conversation ID present, A's conversation ID
 *   absent (or HTTP 401 if session invalidated). No optional-chain fallback
 *   that turns absent evidence into success.
 *
 * COVERAGE (9 scenarios):
 *   1. Successful credential login establishes the correct authenticated session.
 *   2. Failed authentication never silently proceeds.
 *   3. A successful workspace switch is immediately reflected by the POST
 *      body, a single session GET, and a single authorized API read.
 *   4. Revoked memberships cannot access the former tenant.
 *   5. Reactivation restores exactly the permitted membership.
 *   6. No stale session permits cross-tenant data access (real persisted data).
 *   7. Repeated sequential switches never leak a previous workspace.
 *   8. Concurrent independent browser contexts remain isolated.
 *   9. DIAGNOSTIC: cookie-propagation latency measurement (does NOT replace
 *      the strict immediate-consistency assertion).
 */

const BASE = 'http://127.0.0.1:81'
const PASSWORD = 'password123'

interface TenantCtx {
  page: Page
  email: string
  tenantId: string
  slug: string
}

let suffixCounter = 0
function uniqueSuffix(): string {
  suffixCounter++
  return `${Date.now()}-${process.pid}-${suffixCounter}`
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

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

  // Sign-in + bounded session-establishment poll (15s, 250ms intervals).
  // This poll is for INITIAL session establishment (credentials callback →
  // cookie set), NOT for workspace-switch consistency. The switch tests
  // below use immediate single-read verification.
  let sessionOk = false
  let lastCallbackStatus = 0
  let lastSessionStatus = 0
  let slug = ''

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
      if (attempt === 0) continue
      throw new Error(`Sign-in callback failed for ${email}: HTTP ${signinRes.status()}`)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      lastSessionStatus = sessionRes.status()
      if (sessionRes.ok()) {
        const sb = await sessionRes.json().catch(() => ({}))
        if (sb?.user) {
          const meRes = await page.request.get(`${BASE}/api/tenants/me`)
          if (meRes.ok()) {
            const meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
            if (meData.tenant?.id === tenantId) {
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

  if (!sessionOk) {
    throw new Error(
      `Auth session not established for ${email} ` +
        `(last_callback=${lastCallbackStatus} last_session=${lastSessionStatus})`,
    )
  }

  await setAccessMode(page, 'anonymous')

  return { page, email, tenantId, slug }
}

async function signInExisting(
  browser: Browser,
  email: string,
  expectedTenantId?: string,
): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

  let established = false
  for (let attempt = 0; attempt < 2 && !established; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(
      `${BASE}/api/auth/callback/credentials`,
      { form: { email, password: PASSWORD, csrfToken, json: 'true' }, maxRedirects: 0 },
    )
    if (signinRes.status() >= 400) {
      if (attempt === 0) continue
      throw new Error(`Sign-in failed for ${email}: HTTP ${signinRes.status()}`)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const s = await page.request.get(`${BASE}/api/auth/session`)
      if (s.ok()) {
        const b = await s.json().catch(() => ({}))
        if (b?.user && (!expectedTenantId || b.user.workspaceId === expectedTenantId)) {
          established = true
          break
        }
      }
      await page.waitForTimeout(250)
    }
  }
  if (!established) {
    throw new Error(`signInExisting: session not established for ${email}`)
  }
  return page
}

async function getSessionWorkspaceId(page: Page): Promise<string | null> {
  const res = await page.request.get(`${BASE}/api/auth/session`)
  const body = (await res.json()) as { user?: { workspaceId?: string | null } }
  return body.user?.workspaceId ?? null
}

async function getSessionUser(page: Page): Promise<{ id?: string; email?: string; workspaceId?: string | null } | null> {
  const res = await page.request.get(`${BASE}/api/auth/session`)
  if (!res.ok()) return null
  const body = (await res.json()) as { user?: { id?: string; email?: string; workspaceId?: string | null } }
  return body.user ?? null
}

/**
 * RAW workspace-switch HTTP request — NO body verification, NO polling.
 * Returns { status, body } immediately. Callers are responsible for
 * verifying immediate consistency.
 *
 * This is separated from any eventual-consistency verification so that
 * tests can assert IMMEDIATE session consistency via a single GET right
 * after the POST returns.
 */
async function switchWorkspaceRaw(
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

/**
 * Verify IMMEDIATE workspace-switch consistency — ONE session GET + ONE
 * authorized API read, NO polling, NO sleeping.
 *
 * Asserts:
 *   1. POST status === 200.
 *   2. POST response body user.workspaceId === expectedWorkspaceId.
 *   3. Immediate session GET (single call) user.workspaceId === expectedWorkspaceId.
 *   4. Immediate /api/tenants/me (single call) returns the expected tenant.
 *
 * If any assertion fails, the test fails with sanitized diagnostics.
 * This does NOT retry or poll — it verifies immediate consistency.
 */
async function verifySwitchImmediateConsistency(
  page: Page,
  swResult: { status: number; body: any },
  expectedWorkspaceId: string,
): Promise<void> {
  // 1. POST status must be 200.
  expect(swResult.status, `switch POST status must be 200 (got ${swResult.status})`).toBe(200)

  // 2. POST response body must reflect the new workspaceId.
  const bodyWs = swResult.body?.user?.workspaceId
  expect(
    bodyWs,
    `POST body user.workspaceId must be ${expectedWorkspaceId} (got ${String(bodyWs)})`,
  ).toBe(expectedWorkspaceId)

  // 3. IMMEDIATE session GET (single call, no poll) — must reflect the new workspace.
  const immediateSessionWs = await getSessionWorkspaceId(page)
  expect(
    immediateSessionWs,
    `IMMEDIATE session GET after switch must be ${expectedWorkspaceId} (got ${String(immediateSessionWs)}). ` +
      `POST body confirmed ${bodyWs} but the session cookie was not immediately visible to the next GET. ` +
      `This indicates a cookie-propagation delay, NOT a server-side defect.`,
  ).toBe(expectedWorkspaceId)

  // 4. IMMEDIATE authorized API read — /api/tenants/me must return the new tenant.
  const meRes = await page.request.get(`${BASE}/api/tenants/me`)
  expect(meRes.status(), `IMMEDIATE /api/tenants/me must be 200 after switch`).toBe(200)
  const meData = (await meRes.json()) as { tenant?: { id: string } }
  expect(
    meData.tenant?.id,
    `IMMEDIATE /api/tenants/me tenant.id must be ${expectedWorkspaceId}`,
  ).toBe(expectedWorkspaceId)
}

async function createInvitation(
  page: Page,
  email: string,
  role: string,
): Promise<{ workspace: string; token: string }> {
  const res = await page.request.post(`${BASE}/api/invitations`, {
    data: { email, role },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json()
  const inviteUrl: string = body?.invitation?.inviteUrl ?? body?.inviteUrl ?? ''
  const parsed = new URL(inviteUrl)
  const workspace = parsed.searchParams.get('workspace') ?? ''
  const token = parsed.searchParams.get('token') ?? ''
  return { workspace, token }
}

async function acceptInvitation(
  page: Page,
  workspace: string,
  token: string,
): Promise<{ status: number; body: any }> {
  const res = await page.request.post(`${BASE}/api/invitations/accept`, {
    data: { workspace, token },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), body }
}

async function revokeMembership(
  page: Page,
  memberId: string,
): Promise<{ status: number }> {
  const res = await page.request.delete(`${BASE}/api/members?memberId=${encodeURIComponent(memberId)}`)
  return { status: res.status() }
}

async function getMembers(page: Page): Promise<Array<{ id: string; role: string; status: string; user: { email: string } }>> {
  const res = await page.request.get(`${BASE}/api/members`)
  const body = (await res.json()) as { members?: Array<{ id: string; role: string; status: string; user: { email: string } }> }
  return body.members ?? []
}

/**
 * Create a REAL persisted visitor conversation via the public widget API.
 * Uses the tenant's slug + the anonymous widget contact + messages flow.
 * Returns the conversationId.
 *
 * This creates real data in PostgreSQL — no mocks.
 */
async function seedWidgetConversation(
  slug: string,
  visitorId: string,
  text: string,
): Promise<string> {
  // 1. Create a widget contact (public, anonymous).
  const contactRes = await fetch(`${BASE}/api/widget/${slug}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId }),
  })
  if (!contactRes.ok) {
    throw new Error(`Widget contact failed for slug=${slug}: ${contactRes.status}`)
  }
  const contactData = (await contactRes.json()) as { contactId: string; realtimeToken: string }

  // 2. Send a visitor message — creates the conversation.
  const msgRes = await fetch(`${BASE}/api/widget/${slug}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${contactData.realtimeToken}`,
    },
    body: JSON.stringify({ text }),
  })
  if (!msgRes.ok) {
    throw new Error(`Widget message failed for slug=${slug}: ${msgRes.status}`)
  }
  const msgData = (await msgRes.json()) as { conversationId: string }
  if (!msgData.conversationId) {
    throw new Error(`Widget message did not return a conversationId for slug=${slug}`)
  }
  return msgData.conversationId
}

/**
 * Fetch conversations via the authenticated API. Returns the raw response
 * + parsed body. Rejects malformed bodies — no optional-chain fallback
 * that turns absent evidence into success.
 */
async function fetchConversations(
  page: Page,
): Promise<{ status: number; body: { conversations?: Array<{ id: string; tenantId?: string }> } }> {
  const res = await page.request.get(`${BASE}/api/conversations`)
  if (!res.ok()) {
    return { status: res.status(), body: {} }
  }
  const body = await res.json()
  // Reject malformed bodies — the conversations array MUST be present and
  // be an array on a successful 200 response.
  if (!body || typeof body !== 'object' || !Array.isArray(body.conversations)) {
    throw new Error(
      `fetchConversations: 200 response has malformed body (no conversations array). ` +
        `body=${JSON.stringify(body).slice(0, 200)}`,
    )
  }
  return { status: res.status(), body: body as { conversations: Array<{ id: string; tenantId?: string }> } }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test.describe('Auth + session stress — real PostgreSQL, real HTTP/session stack', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test('1. Successful credential login establishes the correct authenticated session', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const email = `auth-stress-login-${stamp}@test.local`
    const tenant = await setupTenant(browser, email, `ws-login-${stamp}`)

    try {
      const user = await getSessionUser(tenant.page)
      expect(user, 'session must have a user').not.toBeNull()
      expect(user!.email, 'session email must match').toBe(email)
      expect(user!.workspaceId, 'session workspaceId must match the signup tenant').toBe(tenant.tenantId)

      const meRes = await tenant.page.request.get(`${BASE}/api/tenants/me`)
      expect(meRes.status(), '/api/tenants/me must be 200').toBe(200)
      const meData = (await meRes.json()) as { tenant?: { id: string } }
      expect(meData.tenant?.id, 'tenant me must match signup tenantId').toBe(tenant.tenantId)
    } finally {
      await tenant.page.context().close()
    }
  })

  test('2. Failed authentication never silently proceeds', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const email = `auth-stress-fail-${stamp}@test.local`
    const tenant = await setupTenant(browser, email, `ws-fail-${stamp}`)

    try {
      const anonCtx = await browser.newContext()
      const anonPage = await anonCtx.newPage()
      await anonPage.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

      const meRes = await anonPage.request.get(`${BASE}/api/tenants/me`)
      expect(meRes.status(), 'anonymous /api/tenants/me must be 401').toBe(401)

      const csrfRes = await anonPage.request.get(`${BASE}/api/auth/csrf`)
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
      const badSignin = await anonPage.request.post(`${BASE}/api/auth/callback/credentials`, {
        form: { email, password: 'WRONG_PASSWORD', csrfToken, json: 'true' },
        maxRedirects: 0,
      })
      expect(badSignin.status(), 'wrong password must not return 200').toBeGreaterThanOrEqual(400)

      const sessionRes = await anonPage.request.get(`${BASE}/api/auth/session`)
      const sessionBody = (await sessionRes.json()) as { user?: unknown }
      expect(sessionBody.user, 'no session after failed login').toBeUndefined()

      await anonCtx.close()
    } finally {
      await tenant.page.context().close()
    }
  })

  test('3. Successful workspace switch is immediately reflected by POST body + single session GET + single API read', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-sw-a-${stamp}@test.local`, `ws-sw-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-sw-b-${stamp}@test.local`, `ws-sw-b-${stamp}`)

    try {
      const inv = await createInvitation(a.page, b.email, 'agent')
      const acc = await acceptInvitation(b.page, inv.workspace, inv.token)
      expect(acc.status, 'B accepts A invite').toBe(200)

      // RAW switch — no polling in the helper.
      const sw = await switchWorkspaceRaw(b.page, a.tenantId)

      // IMMEDIATE consistency verification — single session GET + single API read.
      // No polling, no sleeping. If this fails, it reveals a real
      // cookie-propagation or session-consistency issue.
      await verifySwitchImmediateConsistency(b.page, sw, a.tenantId)

      // Authorized API read on A must work immediately.
      const convRes = await b.page.request.get(`${BASE}/api/conversations`)
      expect(convRes.status(), 'A APIs work after switch').toBe(200)
    } finally {
      await a.page.context().close()
      await b.page.context().close()
    }
  })

  test('4. Revoked memberships cannot access the former tenant', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-rev-a-${stamp}@test.local`, `ws-rev-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-rev-b-${stamp}@test.local`, `ws-rev-b-${stamp}`)

    try {
      const inv = await createInvitation(a.page, b.email, 'agent')
      await acceptInvitation(b.page, inv.workspace, inv.token)
      const sw = await switchWorkspaceRaw(b.page, a.tenantId)
      await verifySwitchImmediateConsistency(b.page, sw, a.tenantId)

      const members = await getMembers(a.page)
      const bMember = members.find((m) => m.user.email === b.email)
      expect(bMember, 'B is a member of A').toBeTruthy()
      const revokeRes = await revokeMembership(a.page, bMember!.id)
      expect(revokeRes.status, 'revoke succeeds').toBe(200)

      // B (still on A, now revoked) must get 401/403 from A APIs.
      const failRes = await b.page.request.get(`${BASE}/api/conversations`)
      expect([401, 403], 'A APIs fail closed after revoke').toContain(failRes.status())
    } finally {
      await a.page.context().close()
      await b.page.context().close()
    }
  })

  test('5. Reactivation restores exactly the permitted membership', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-react-a-${stamp}@test.local`, `ws-react-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-react-b-${stamp}@test.local`, `ws-react-b-${stamp}`)

    try {
      const inv1 = await createInvitation(a.page, b.email, 'agent')
      await acceptInvitation(b.page, inv1.workspace, inv1.token)
      const members1 = await getMembers(a.page)
      const bMember1 = members1.find((m) => m.user.email === b.email)
      expect(bMember1?.status, 'B is active').toBe('active')
      expect(bMember1?.role, 'B is agent').toBe('agent')
      const membershipId = bMember1!.id

      await revokeMembership(a.page, membershipId)

      const inv2 = await createInvitation(a.page, b.email, 'manager')
      const bPage = await signInExisting(browser, b.email, b.tenantId)
      const acc2 = await acceptInvitation(bPage, inv2.workspace, inv2.token)
      expect(acc2.status, 'B accepts reinvitation').toBe(200)

      const members2 = await getMembers(a.page)
      const bMember2 = members2.find((m) => m.user.email === b.email)
      expect(bMember2?.status, 'reactivated to active').toBe('active')
      expect(bMember2?.role, 'role updated to manager').toBe('manager')
      expect(bMember2?.id, 'same membership row, not duplicated').toBe(membershipId)

      // Switch to A with IMMEDIATE consistency verification (no polling).
      const sw = await switchWorkspaceRaw(bPage, a.tenantId)
      await verifySwitchImmediateConsistency(bPage, sw, a.tenantId)
      const convRes = await bPage.request.get(`${BASE}/api/conversations`)
      expect(convRes.status(), 'A APIs work after reactivation').toBe(200)

      await bPage.context().close()
    } finally {
      await a.page.context().close()
      await b.page.context().close()
    }
  })

  test('6. No stale session permits cross-tenant data access (real persisted data)', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-stale-a-${stamp}@test.local`, `ws-stale-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-stale-b-${stamp}@test.local`, `ws-stale-b-${stamp}`)

    try {
      // 1. Seed REAL persisted conversations in both tenants via the widget API.
      const aConvId = await seedWidgetConversation(
        a.slug,
        `visitor-a-${stamp}`,
        `tenant-a-private-message-${stamp}`,
      )
      const bConvId = await seedWidgetConversation(
        b.slug,
        `visitor-b-${stamp}`,
        `tenant-b-private-message-${stamp}`,
      )

      // 2. Verify both records exist via the authenticated API.
      const aConvFetch = await fetchConversations(a.page)
      expect(aConvFetch.status, 'A can read own conversations').toBe(200)
      const aConversations = aConvFetch.body.conversations
      if (!aConversations) throw new Error('A conversations array missing on 200 response')
      const aConvIds = aConversations.map((c) => c.id)
      expect(aConvIds, 'A conversations must include A seeded conversation').toContain(aConvId)

      const bConvFetch = await fetchConversations(b.page)
      expect(bConvFetch.status, 'B can read own conversations').toBe(200)
      const bConversations = bConvFetch.body.conversations
      if (!bConversations) throw new Error('B conversations array missing on 200 response')
      const bConvIds = bConversations.map((c) => c.id)
      expect(bConvIds, 'B conversations must include B seeded conversation').toContain(bConvId)

      // 3. B is NOT a member of A. B attempts an unauthorized switch to A.
      //    Use a RAW POST (not verifySwitchImmediateConsistency) because
      //    the switch is expected to FAIL — the jwt callback throws
      //    'not_active_member'.
      const sw = await switchWorkspaceRaw(b.page, a.tenantId)
      const bodyWs = sw.body?.user?.workspaceId

      // 4. The unauthorized switch body must NOT have A's workspaceId.
      expect(
        bodyWs,
        'unauthorized switch body must NOT have A workspaceId',
      ).not.toBe(a.tenantId)

      // 5. Check B's session state after the failed switch. Two valid
      //    outcomes:
      //    a. Session survived (still on B) → B can read own data, NOT A's.
      //    b. Session invalidated (NextAuth cleaned cookie) → 401.
      //    Both are secure. A 200 with A's conversation would be a FAIL.
      const wsAfterFailedSwitch = await getSessionWorkspaceId(b.page)
      expect(
        [b.tenantId, null],
        'B session is either still on B or null (cookie cleaned) — never on A',
      ).toContain(wsAfterFailedSwitch)

      const convRes = await b.page.request.get(`${BASE}/api/conversations`)
      if (convRes.status() === 200) {
        // B is still authenticated on B. Verify real data isolation:
        // B's conversation present, A's conversation ABSENT.
        const convBody = await convRes.json()
        if (!convBody || !Array.isArray(convBody.conversations)) {
          throw new Error(
            '200 /api/conversations response has malformed body (no conversations array). ' +
              `body=${JSON.stringify(convBody).slice(0, 200)}`,
          )
        }
        const convIds = convBody.conversations.map((c: any) => c.id)
        expect(convIds, 'B conversation list must contain B seeded conversation').toContain(bConvId)
        expect(
          convIds,
          'B conversation list must NOT contain A seeded conversation',
        ).not.toContain(aConvId)
      } else if (convRes.status() === 401) {
        // Session was cleaned by NextAuth's error handler. No data access.
        expect(convRes.status(), 'cleaned session returns 401').toBe(401)
      } else {
        throw new Error(
          `Unexpected /api/conversations status after failed switch: ${convRes.status()}. ` +
            `Expected 200 (B data) or 401 (no session).`,
        )
      }

      // 6. Repeat the isolation assertion with an INDEPENDENT browser context.
      //    A fresh B session (never attempted the unauthorized switch) must
      //    see B's conversation and NOT A's.
      const bPage2 = await signInExisting(browser, b.email, b.tenantId)
      const convRes2 = await fetchConversations(bPage2)
      expect(convRes2.status, 'fresh B session reads own conversations').toBe(200)
      const conv2List = convRes2.body.conversations
      if (!conv2List) throw new Error('fresh B conversations array missing on 200 response')
      const convIds2 = conv2List.map((c) => c.id)
      expect(convIds2, 'fresh B context has B conversation').toContain(bConvId)
      expect(
        convIds2,
        'fresh B context does NOT have A conversation',
      ).not.toContain(aConvId)
      await bPage2.context().close()
    } finally {
      await a.page.context().close()
      await b.page.context().close()
    }
  })

  test('7. Repeated sequential switches never leak a previous workspace', async ({ browser }) => {
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-seq-a-${stamp}@test.local`, `ws-seq-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-seq-b-${stamp}@test.local`, `ws-seq-b-${stamp}`)
    const c = await setupTenant(browser, `auth-stress-seq-c-${stamp}@test.local`, `ws-seq-c-${stamp}`)

    try {
      const invA = await createInvitation(a.page, b.email, 'agent')
      await acceptInvitation(b.page, invA.workspace, invA.token)
      const invC = await createInvitation(c.page, b.email, 'agent')
      await acceptInvitation(b.page, invC.workspace, invC.token)

      // 10 rounds of sequential A → B → C → B switching.
      // Each switch uses RAW POST + IMMEDIATE single-read verification.
      // No polling — immediate consistency must hold on every switch.
      for (let i = 0; i < 10; i++) {
        // Switch to A
        const swA = await switchWorkspaceRaw(b.page, a.tenantId)
        await verifySwitchImmediateConsistency(b.page, swA, a.tenantId)

        // Switch to B
        const swB = await switchWorkspaceRaw(b.page, b.tenantId)
        await verifySwitchImmediateConsistency(b.page, swB, b.tenantId)

        // Switch to C
        const swC = await switchWorkspaceRaw(b.page, c.tenantId)
        await verifySwitchImmediateConsistency(b.page, swC, c.tenantId)

        // Switch back to B
        const swB2 = await switchWorkspaceRaw(b.page, b.tenantId)
        await verifySwitchImmediateConsistency(b.page, swB2, b.tenantId)
      }
    } finally {
      await a.page.context().close()
      await b.page.context().close()
      await c.page.context().close()
    }
  })

  test('8. Concurrent independent browser contexts remain isolated', async ({ browser }) => {
    const stamp = uniqueSuffix()

    const tenants: TenantCtx[] = []
    for (let i = 0; i < 3; i++) {
      const t = await setupTenant(
        browser,
        `auth-stress-conc-${i}-${stamp}@test.local`,
        `ws-conc-${i}-${stamp}`,
      )
      tenants.push(t)
    }

    try {
      // Circular invitations: tenant[i] invites tenant[(i+1)%3].
      // So tenant[(i+1)%3] is a member of tenant[i].
      // tenant[i] is a member of tenant[(i-1+3)%3].
      for (let i = 0; i < 3; i++) {
        const inviter = tenants[i]
        const invitee = tenants[(i + 1) % 3]
        const inv = await createInvitation(inviter.page, invitee.email, 'agent')
        await acceptInvitation(invitee.page, inv.workspace, inv.token)
      }

      // All three switch simultaneously (concurrent APIRequestContext calls).
      // Each tenant[i] switches to tenant[(i-1+3)%3] (the one they're a member of).
      const switchPromises = tenants.map((t, i) => {
        const targetIdx = (i - 1 + 3) % 3
        return switchWorkspaceRaw(t.page, tenants[targetIdx].tenantId).then((sw) => ({
          idx: i,
          sw,
          targetIdx,
          expectedWs: tenants[targetIdx].tenantId,
        }))
      })

      const results = await Promise.all(switchPromises)

      // Each context's session must reflect its OWN switch target.
      // IMMEDIATE single-read verification — no polling.
      for (const r of results) {
        await verifySwitchImmediateConsistency(
          tenants[r.idx].page,
          r.sw,
          r.expectedWs,
        )
      }

      // Post-burst sequential verification (still immediate, no poll).
      for (let i = 0; i < 3; i++) {
        const targetIdx = (i - 1 + 3) % 3
        const expectedWs = tenants[targetIdx].tenantId
        const ws = await getSessionWorkspaceId(tenants[i].page)
        expect(ws, `post-burst context ${i} still on ${targetIdx}`).toBe(expectedWs)
      }
    } finally {
      for (const t of tenants) {
        await t.page.context().close().catch(() => {})
      }
    }
  })

  test('9. DIAGNOSTIC: cookie-propagation latency measurement (does NOT replace strict immediate assertion)', async ({ browser }) => {
    // This test MEASURES the delay between the POST /api/auth/session
    // response and the session cookie becoming visible to a subsequent GET.
    // It does NOT replace the strict immediate-consistency assertion in
    // scenarios 3–8 — those assert that a SINGLE GET right after the POST
    // returns the new workspace. This test reports the latency data for
    // investigation if immediate consistency ever fails.
    //
    // If the immediate GET already reflects the new workspace, latency=0
    // and the test passes trivially. If not, the bounded poll (5s, 50ms
    // intervals) measures the convergence time and reports it. The test
    // NEVER silently accepts a stale value — it reports the exact latency.
    const stamp = uniqueSuffix()
    const a = await setupTenant(browser, `auth-stress-diag-a-${stamp}@test.local`, `ws-diag-a-${stamp}`)
    const b = await setupTenant(browser, `auth-stress-diag-b-${stamp}@test.local`, `ws-diag-b-${stamp}`)

    try {
      const inv = await createInvitation(a.page, b.email, 'agent')
      await acceptInvitation(b.page, inv.workspace, inv.token)

      const sw = await switchWorkspaceRaw(b.page, a.tenantId)
      expect(sw.status, 'diagnostic switch must succeed').toBe(200)
      expect(sw.body?.user?.workspaceId, 'POST body confirms new workspace').toBe(a.tenantId)

      // Measure latency: how long until session GET reflects the new workspace?
      const t0 = Date.now()
      let converged = false
      let latencyMs = -1
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const ws = await getSessionWorkspaceId(b.page)
        if (ws === a.tenantId) {
          latencyMs = Date.now() - t0
          converged = true
          break
        }
        await b.page.waitForTimeout(50)
      }

      if (!converged) {
        const finalWs = await getSessionWorkspaceId(b.page)
        throw new Error(
          `DIAGNOSTIC: session cookie did NOT converge to ${a.tenantId} within 5s. ` +
            `final workspaceId=${String(finalWs)}. ` +
            `This indicates a cookie-propagation issue that the strict ` +
            `immediate-consistency tests would catch.`,
        )
      }

      // Report the latency. If latency=0, immediate consistency holds.
      // If latency>0, the strict tests in scenarios 3–8 would FAIL —
      // investigate the cookie-propagation root cause.
      console.log(
        `[auth-session-stress diagnostic] cookie-propagation latency: ${latencyMs}ms ` +
          `(0ms = immediate consistency holds)`,
      )

      // The diagnostic test passes if convergence occurred within 5s.
      // But if latency > 0, the strict tests would fail — the reviewer
      // should investigate why the cookie wasn't immediately visible.
      expect(converged, 'cookie must converge within 5s').toBe(true)
    } finally {
      await a.page.context().close()
      await b.page.context().close()
    }
  })
})
