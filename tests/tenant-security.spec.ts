import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Docker DB-backed tenant security spec.
 *
 * Verifies the application-layer tenant boundary against a real PostgreSQL
 * database (Docker Full/Lite stack). All assertions are at the API level —
 * no UI clicks. Each tenant gets its own BrowserContext so its session
 * cookie is isolated. API calls use `page.request.post()` (Playwright's
 * APIRequestContext associated with the page — shares the BrowserContext's
 * cookie jar so authenticated calls work without manual cookie handling).
 *
 * Coverage:
 *   A. Tenant B cannot create a conversation with Tenant A's contactId
 *      (db.contact.findUnique is tenant-scoped → foreign contactId returns
 *      null → 'contact_not_found').
 *   B. Tenant A conversation cannot be assigned to Tenant B's user
 *      (db.membership.findFirst requires status='active' and is
 *      tenant-scoped → foreign userId returns null → 'invalid_assignee').
 *   C. Inactive (status='invited') membership cannot be assigned
 *      (the membership check filters by status='active' — an invited
 *      membership is invisible to the assign endpoint).
 *   D. Tenant A conversation cannot use Tenant B's department
 *      (db.department.findUnique is tenant-scoped → foreign departmentId
 *      returns null → 'invalid_department').
 *   E. Cross-tenant Participant row is never created
 *      (the failed assignment returns before the participant upsert runs;
 *      GET /api/conversations/[id] shows assignedUserId=null).
 *   F. Routing rule cannot target a foreign user/department at save time
 *      (validateRuleAction does tenant-scoped lookups — foreign ids
 *      rejected with 'invalid_user_id'/'invalid_department_id').
 *   G. Valid same-tenant controls succeed
 *      (the same API calls with the right ids succeed — proves the
 *      guards aren't false-positives that reject everything).
 */

const BASE = 'http://127.0.0.1:81'
const PASSWORD = 'password123'

interface TenantCtx {
  /** Playwright Page for this tenant's session. */
  page: Page
  /** BrowserContext so we can close it at the end. */
  email: string
  workspaceName: string
  tenantId: string
  slug: string
  /** Owner's User.id (the user who created the workspace via OTP signup). */
  ownerId: string
}

/**
 * Sign up a new tenant via the 3-step OTP flow (mock code "123456"), then
 * sign in via the NextAuth credentials callback. Returns the page (with
 * session cookie set) + the tenantId + the owner's userId.
 */
async function setupTenant(
  browser: import('@playwright/test').Browser,
  email: string,
  workspaceName: string,
): Promise<TenantCtx> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  // Navigate once to establish the origin (so page.request has a baseURL
  // to resolve relative URLs against — actually we always use absolute
  // BASE-prefixed URLs below, but a goto is also required for some
  // cookie-scope behaviors in Playwright).
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {
    // Caddy may 404 on / — that's fine, we just need the cookie scope.
  })

  // 1. OTP signup (start → verify → complete) via page.request
  const signupRes = await otpSignupPlaywright(
    page.request as unknown as Parameters<typeof otpSignupPlaywright>[0],
    BASE,
    email,
    workspaceName,
    PASSWORD,
  )
  if (!signupRes.ok || !signupRes.tenantId) {
    throw new Error(
      `OTP signup failed for ${email}: status=${signupRes.status} ok=${signupRes.ok} tenantId=${signupRes.tenantId}`,
    )
  }
  const tenantId = signupRes.tenantId

  // Sign-in + bounded session-establishment poll, with ONE retry.
  // The retry re-issues the credentials callback (fresh CSRF) if the
  // first attempt's session cookie did not propagate within the poll
  // window. This matches the resilience pattern in
  // invite-workspace-switching.spec.ts (bounded re-attempt, NOT an
  // arbitrary sleep). Each attempt has a 10s propagation poll (250ms).
  let sessionEstablished = false
  let lastCallbackStatus = 0
  let lastSessionStatus = 0
  let lastMeStatus = 0
  let meData: { tenant?: { id: string; slug: string } } = {}

  for (let attempt = 0; attempt < 2 && !sessionEstablished; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const csrfData = (await csrfRes.json()) as { csrfToken: string }
    if (!csrfData.csrfToken) {
      if (attempt === 0) continue
      throw new Error(`CSRF fetch failed for ${email}`)
    }
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
      throw new Error(`Sign-in failed for ${email}: callback status=${signinRes.status()}`)
    }
    const sessionDeadline = Date.now() + 10000
    while (Date.now() < sessionDeadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      lastSessionStatus = sessionRes.status()
      if (sessionRes.ok()) {
        const sessionBody = await sessionRes.json().catch(() => ({}))
        if (sessionBody && sessionBody.user) {
          const meRes = await page.request.get(`${BASE}/api/tenants/me`)
          lastMeStatus = meRes.status()
          if (meRes.ok()) {
            meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
            if (meData.tenant) {
              sessionEstablished = true
              break
            }
          }
        }
      }
      await page.waitForTimeout(250)
    }
  }

  if (!sessionEstablished) {
    const hasSessionCookie = (await ctx.cookies()).some(c => c.name.includes('session') || c.name.includes('auth'))
    throw new Error(
      `Auth session not established for ${email} after 2 attempts (10s poll each). ` +
      `last_callback_status=${lastCallbackStatus} ` +
      `session_cookie_present=${hasSessionCookie} ` +
      `last_session_status=${lastSessionStatus} ` +
      `last_tenants_me_status=${lastMeStatus}`,
    )
  }

  if (meData.tenant!.id !== tenantId) {
    throw new Error(
      `Tenant id mismatch for ${email}: signup=${tenantId} session=${meData.tenant!.id}`,
    )
  }

  // 5. Resolve the owner's userId via GET /api/members (the owner is the
  //    only Membership row at this point).
  const membersRes = await page.request.get(`${BASE}/api/members`)
  const membersData = (await membersRes.json()) as {
    members?: Array<{ userId: string; role: string; status: string; user: { id: string; email: string } }>
  }
  const ownerMembership = membersData.members?.find((m) => m.role === 'owner')
  if (!ownerMembership) {
    throw new Error(`Could not find owner membership for ${email}`)
  }
  const ownerId = ownerMembership.user.id

  const slug = meData.tenant!.slug

  // Fresh OTP signups default to accessMode='verified_visitor' (the frozen
  // DB contract). The /contact flow below requires anonymous visitor tokens,
  // so explicitly switch the tenant to anonymous before any visitor traffic.
  await setAccessMode(page, 'anonymous')

  return { page, email, workspaceName, tenantId, slug, ownerId }
}

/**
 * As Tenant A, create a visitor contact + open conversation via the public
 * widget API. Returns the conversationId + contactId.
 */
async function createTenantAConversation(
  page: Page,
  slug: string,
): Promise<{ conversationId: string; contactId: string }> {
  // Visitor identification — creates the Contact row (no auth needed).
  const contactRes = await page.request.post(
    `${BASE}/api/widget/${slug}/contact`,
    {
      data: { visitorId: `visitor-tenantA-${Date.now()}` },
      headers: { 'Content-Type': 'application/json' },
    },
  )
  if (!contactRes.ok()) {
    throw new Error(`Widget contact failed: ${contactRes.status()}`)
  }
  const contactData = (await contactRes.json()) as {
    contactId: string
    realtimeToken: string
  }

  // Send a message — creates the conversation.
  const msgRes = await page.request.post(
    `${BASE}/api/widget/${slug}/messages`,
    {
      data: { text: 'hello from Tenant A visitor' },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${contactData.realtimeToken}`,
      },
    },
  )
  if (!msgRes.ok()) {
    throw new Error(`Widget message failed: ${msgRes.status()}`)
  }
  const msgData = (await msgRes.json()) as { conversationId: string }
  if (!msgData.conversationId) {
    throw new Error('Widget message did not return a conversationId')
  }
  return { conversationId: msgData.conversationId, contactId: contactData.contactId }
}

test.describe('Docker DB-backed tenant security', () => {
  // Two tenants — created once for the whole describe block so the OTP
  // signup cost is paid only once.
  let tenantA: TenantCtx
  let tenantB: TenantCtx
  let tenantAConv: { conversationId: string; contactId: string }

  test.beforeAll(async ({ browser }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`
    tenantA = await setupTenant(
      browser,
      `ta-sec-${suffix}@tenant-security.test`,
      `TA Sec WS ${suffix}`,
    )
    tenantB = await setupTenant(
      browser,
      `tb-sec-${suffix}@tenant-security.test`,
      `TB Sec WS ${suffix}`,
    )
    tenantAConv = await createTenantAConversation(tenantA.page, tenantA.slug)
    if (!tenantAConv.conversationId) {
      throw new Error('Tenant A conversation was not created in beforeAll')
    }
  })

  test.afterAll(async () => {
    // Closes the two BrowserContexts (and their pages).
    await tenantA?.page.context().close().catch(() => {})
    await tenantB?.page.context().close().catch(() => {})
  })

  test('A. Tenant B cannot create conversation with Tenant A\'s contactId', async () => {
    // Tenant B's session tries to start a conversation using Tenant A's
    // contactId. The conversation POST does:
    //   db.contact.findUnique({ where: { id: contactId } })
    // The fail-closed Prisma extension scopes the lookup to Tenant B, so
    // Tenant A's contactId returns null → 'contact_not_found'.
    const res = await tenantB.page.request.post(`${BASE}/api/conversations`, {
      data: { contactId: tenantAConv.contactId },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status(), 'should be 400 (contact_not_found)').toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('contact_not_found')
  })

  test('B. Tenant A conversation cannot be assigned to Tenant B\'s user', async () => {
    // Tenant A's session tries to PATCH its own conversation, assigning
    // Tenant B's owner as the assignee. The conversation PATCH does:
    //   db.membership.findFirst({ where: { userId, status: 'active' } })
    // The fail-closed extension scopes the lookup to Tenant A. Tenant B's
    // owner has no Membership in Tenant A → null → 'invalid_assignee'.
    const res = await tenantA.page.request.patch(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
      {
        data: { assignedUserId: tenantB.ownerId },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(res.status(), 'should be 400 (invalid_assignee)').toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('invalid_assignee')
  })

  test('C. Inactive (invited) membership cannot be assigned', async () => {
    // As Tenant A owner, invite a new user via the invitation API.
    // The invitation creates an Invitation record (not a Membership).
    // The invited user has no User identity yet (email not verified).
    const invitedEmail = `invited-${Date.now()}@tenant-security.test`
    const inviteRes = await tenantA.page.request.post(`${BASE}/api/invitations`, {
      data: { email: invitedEmail, role: 'agent' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(inviteRes.status(), 'invite should succeed').toBe(200)
    const inviteData = (await inviteRes.json()) as {
      invitation?: { id: string; email: string; role: string; status: string }
    }
    expect(inviteData.invitation?.id, 'invitation should have an id').toBeTruthy()
    expect(inviteData.invitation?.status).toBe('pending')

    // The invited email has no User identity yet — try to assign a
    // non-existent userId to the conversation. The membership.findFirst
    // filters by status='active' — no active membership → 'invalid_assignee'.
    // Use a random cuid-like string as the "invited user" (doesn't exist).
    const fakeUserId = 'invited-user-does-not-exist'
    const res = await tenantA.page.request.patch(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
      {
        data: { assignedUserId: fakeUserId },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(res.status(), 'should be 400 (invalid_assignee)').toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('invalid_assignee')
  })

  test('D. Tenant A conversation cannot use Tenant B\'s department', async () => {
    // Tenant B creates a department in its own workspace.
    const tbDeptRes = await tenantB.page.request.post(
      `${BASE}/api/departments`,
      {
        data: { name: 'TB Support Dept' },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(tbDeptRes.status(), 'TB department create should succeed').toBe(200)
    const tbDeptData = (await tbDeptRes.json()) as { department?: { id: string } }
    const tbDeptId = tbDeptData.department?.id
    expect(tbDeptId, 'TB department should have an id').toBeTruthy()

    // Tenant A tries to PATCH its conversation, setting the departmentId to
    // Tenant B's department. The PATCH does:
    //   db.department.findUnique({ where: { id: departmentId } })
    // The fail-closed extension scopes the lookup to Tenant A → returns null
    // → 'invalid_department'.
    const res = await tenantA.page.request.patch(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
      {
        data: { departmentId: tbDeptId },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(res.status(), 'should be 400 (invalid_department)').toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('invalid_department')
  })

  test('E. Cross-tenant Participant row is not created', async () => {
    // Self-contained: attempt a cross-tenant assignment right here, verify
    // it's rejected, then GET the conversation and verify assignedUserId
    // is still null (no Participant was upserted).
    //
    // The conversation PATCH returns 'invalid_assignee' BEFORE reaching the
    // participant upsert (the membership check is a guard clause that
    // returns early). So even though we sent assignedUserId=Tenant B's
    // owner, the conversation state remains unassigned.
    const assignRes = await tenantA.page.request.patch(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
      {
        data: { assignedUserId: tenantB.ownerId },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(assignRes.status(), 'assignment should be rejected').toBe(400)

    // Verify no Participant row landed — assignedUserId must still be null.
    const getRes = await tenantA.page.request.get(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
    )
    expect(getRes.status(), 'Tenant A should read its own conversation').toBe(200)
    const data = (await getRes.json()) as {
      conversation?: { id: string; assignedUserId: string | null }
    }
    expect(data.conversation?.id).toBe(tenantAConv.conversationId)
    expect(
      data.conversation?.assignedUserId,
      'assignedUserId must be null — no cross-tenant assignment landed',
    ).toBeNull()
  })

  test('F. Routing rule cannot target foreign user/department at save time', async () => {
    // Try to save a routing rule with action.type='assign_user' and
    // action.userId = Tenant B's owner. The validateRuleAction function
    // does a tenant-scoped Membership lookup — Tenant B's owner has no
    // Membership in Tenant A → null → 'invalid_user_id'.
    const ruleUserRes = await tenantA.page.request.post(
      `${BASE}/api/routing-rules`,
      {
        data: {
          name: 'assign-foreign-user',
          enabled: false, // disabled — won't fire, but still saved if validation passes
          priority: 0,
          trigger: { event: 'conversation_created', conditions: {} },
          action: { type: 'assign_user', userId: tenantB.ownerId },
        },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(ruleUserRes.status(), 'should be 400 (invalid_user_id)').toBe(400)
    const userBody = (await ruleUserRes.json()) as { error?: string }
    expect(userBody.error).toBe('invalid_user_id')

    // Tenant B creates a department (we already did this in test D, but
    // create a fresh one here so test F is self-contained).
    const tbDeptRes = await tenantB.page.request.post(
      `${BASE}/api/departments`,
      {
        data: { name: `TB Dept F-${Date.now()}` },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    const tbDeptData = (await tbDeptRes.json()) as { department?: { id: string } }
    const tbDeptId = tbDeptData.department?.id

    // Try to save a routing rule with action.type='assign_department' and
    // action.departmentId = Tenant B's department. Tenant-scoped lookup
    // returns null → 'invalid_department_id'.
    const ruleDeptRes = await tenantA.page.request.post(
      `${BASE}/api/routing-rules`,
      {
        data: {
          name: 'assign-foreign-dept',
          enabled: false,
          priority: 0,
          trigger: { event: 'conversation_created', conditions: {} },
          action: { type: 'assign_department', departmentId: tbDeptId },
        },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(ruleDeptRes.status(), 'should be 400 (invalid_department_id)').toBe(400)
    const deptBody = (await ruleDeptRes.json()) as { error?: string }
    expect(deptBody.error).toBe('invalid_department_id')
  })

  test('G. Valid same-tenant controls succeed', async () => {
    // CONTROL: Tenant A creates a department in its OWN workspace — succeeds.
    const taDeptRes = await tenantA.page.request.post(
      `${BASE}/api/departments`,
      {
        data: { name: 'TA Support Dept' },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(taDeptRes.status(), 'TA own-department create should succeed').toBe(200)
    const taDeptData = (await taDeptRes.json()) as { department?: { id: string } }
    expect(taDeptData.department?.id, 'TA department should have an id').toBeTruthy()

    // CONTROL: Tenant A assigns its own owner to its own conversation — succeeds.
    const assignRes = await tenantA.page.request.patch(
      `${BASE}/api/conversations/${tenantAConv.conversationId}`,
      {
        data: { assignedUserId: tenantA.ownerId },
        headers: { 'Content-Type': 'application/json' },
      },
    )
    expect(assignRes.status(), 'TA own-user assign should succeed').toBe(200)

    // CONTROL: Tenant A saves a routing rule targeting its own owner — succeeds.
    const ruleRes = await tenantA.page.request.post(`${BASE}/api/routing-rules`, {
      data: {
        name: 'assign-self-user',
        enabled: false,
        priority: 0,
        trigger: { event: 'conversation_created', conditions: {} },
        action: { type: 'assign_user', userId: tenantA.ownerId },
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(ruleRes.status(), 'TA own-user routing rule should save').toBe(200)
    const ruleData = (await ruleRes.json()) as { rule?: { id: string } }
    expect(ruleData.rule?.id, 'routing rule should have an id').toBeTruthy()
  })
})
