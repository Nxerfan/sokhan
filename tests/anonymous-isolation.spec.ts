import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Anonymous-user tenant isolation — security regression.
 *
 * Threat model:
 *   An attacker has NO authenticated dashboard session. They may know
 *   a valid tenant/workspace slug. They may know or guess
 *   tenant-scoped resource IDs (e.g. a conversationId). They must NOT
 *   be able to read dashboard/private tenant data.
 *
 * This is NOT a replacement for the authenticated cross-tenant tests
 * (`tests/tenant-security.spec.ts`, `tests/tenant-isolation.spec.ts`,
 * DB-boundary PostgreSQL tests, realtime authorization tests). Those
 * remain the primary defense against authenticated-tenant-B-attacks-
 * tenant-A scenarios. This test covers the orthogonal anonymous-attacker
 * scenario.
 *
 * Coverage:
 *   - From a completely fresh browser/API context with NO Tenant A
 *     authentication cookies, every protected dashboard/private API
 *     endpoint must fail-closed with 401 unauthorized.
 *   - Anonymous access without a visitor/realtime token must NOT
 *     gain access to protected conversation/message operations (the
 *     widget message POST requires a Bearer realtimeToken, which is
 *     only issued via the public /api/widget/<slug>/contact flow).
 *   - Public-widget positive control: an anonymous visitor CAN
 *     still perform the intentionally-public bootstrap/contact flow
 *     for a valid tenant. We did NOT "secure" the product by
 *     accidentally breaking the public widget.
 *
 * This spec is added to BOTH the Full and Lite Docker regression
 * lists in `.github/workflows/ci.yml`.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000'  // Next.js direct — signup API

interface TenantAInfo {
  tenantId: string
  slug: string
  conversationId: string
  contactId: string
}

/**
 * Set up Tenant A with at least one real widget conversation. Uses
 * an authenticated browser context. The conversationId + contactId
 * are then used as attack targets in the anonymous context.
 */
async function setupTenantA(browser: import('@playwright/test').Browser): Promise<{ tenantA: TenantAInfo; authedPage: Page }> {
  const stamp = `${process.pid}-${Date.now()}-anoniso`
  const email = `anoniso-a-${stamp}@test.com`
  const workspace = `AnonIso A ${stamp}`
  const PASSWORD = 'password123'

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  // Navigate once to establish the origin (cookie scope).
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // OTP signup (start → verify → complete) via page.request.
  const signupRes = await otpSignupPlaywright(
    page.request as unknown as Parameters<typeof otpSignupPlaywright>[0],
    BASE,
    email,
    workspace,
    PASSWORD,
  )
  if (!signupRes.ok || !signupRes.tenantId) {
    throw new Error(`OTP signup failed for Tenant A: status=${signupRes.status} ok=${signupRes.ok} tenantId=${signupRes.tenantId}`)
  }
  const tenantId = signupRes.tenantId

  // Sign in via NextAuth credentials callback.
  const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
  const csrfData = (await csrfRes.json()) as { csrfToken: string }
  await page.request.post(`${BASE}/api/auth/callback/credentials`, {
    form: { email, password: PASSWORD, csrfToken: csrfData.csrfToken, json: 'true' },
    maxRedirects: 0,
  })

  // Confirm the session works + resolve the slug.
  const meRes = await page.request.get(`${BASE}/api/tenants/me`)
  const meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
  if (!meData.tenant) {
    throw new Error(`Tenant A /api/tenants/me failed: status=${meRes.status()}`)
  }
  const slug = meData.tenant.slug

  // Create a real widget conversation via the public widget API.
  // (Tenant A's authed page can also be the one to drive the widget
  // flow — the contact POST is intentionally public.)
  const contactRes = await page.request.post(
    `${BASE}/api/widget/${slug}/contact`,
    {
      data: { visitorId: `visitor-anoniso-a-${stamp}` },
      headers: { 'Content-Type': 'application/json' },
    },
  )
  if (!contactRes.ok()) {
    throw new Error(`Tenant A widget contact failed: ${contactRes.status()}`)
  }
  const contactData = (await contactRes.json()) as { contactId: string; realtimeToken: string }

  // Send a visitor message — creates the conversation.
  const msgRes = await page.request.post(
    `${BASE}/api/widget/${slug}/messages`,
    {
      data: { text: `tenant-a-private-message-${stamp}` },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${contactData.realtimeToken}`,
      },
    },
  )
  if (!msgRes.ok()) {
    throw new Error(`Tenant A widget message failed: ${msgRes.status()}`)
  }
  const msgData = (await msgRes.json()) as { conversationId: string }
  if (!msgData.conversationId) {
    throw new Error('Tenant A widget message did not return a conversationId')
  }

  return {
    tenantA: {
      tenantId,
      slug,
      conversationId: msgData.conversationId,
      contactId: contactData.contactId,
    },
    authedPage: page,
  }
}

test.describe('Anonymous-user tenant isolation', () => {
  let tenantA: TenantAInfo
  let authedPage: Page
  let anonymousCtx: BrowserContext
  let anonPage: Page

  test.beforeAll(async ({ browser }) => {
    const setup = await setupTenantA(browser)
    tenantA = setup.tenantA
    authedPage = setup.authedPage

    // Fresh, completely unauthenticated context. No Tenant A cookies.
    anonymousCtx = await browser.newContext()
    anonPage = await anonymousCtx.newPage()
    // A goto is required to establish the cookie scope + baseURL for
    // page.request. We hit the public landing page (no auth required).
    await anonPage.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
  })

  test.afterAll(async () => {
    await authedPage?.context().close().catch(() => {})
    await anonymousCtx?.close().catch(() => {})
  })

  // -----------------------------------------------------------
  // Protected dashboard/private APIs — anonymous must get 401.
  // -----------------------------------------------------------

  test('anonymous GET /api/tenants/me → 401 unauthorized', async () => {
    const res = await anonPage.request.get(`${BASE}/api/tenants/me`)
    expect(res.status(), 'must be 401 (not 200)').toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error, 'must return the defined unauthorized error body').toBe('unauthorized')
  })

  test('anonymous GET /api/conversations → 401 unauthorized', async () => {
    const res = await anonPage.request.get(`${BASE}/api/conversations`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/conversations/<tenant-A-conversation-id> → 401 unauthorized', async () => {
    // Even with a known valid conversationId, an anonymous attacker
    // must NOT be able to read the conversation detail.
    const res = await anonPage.request.get(`${BASE}/api/conversations/${tenantA.conversationId}`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/conversations/<tenant-A-conversation-id>/messages → 401 unauthorized', async () => {
    // The message history is the most sensitive endpoint — it
    // contains the actual visitor/agent chat content. An anonymous
    // attacker with a guessed conversationId must NOT read it.
    const res = await anonPage.request.get(`${BASE}/api/conversations/${tenantA.conversationId}/messages`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous POST /api/conversations/<tenant-A-conversation-id>/messages → 401 unauthorized', async () => {
    // An anonymous attacker must NOT be able to inject an agent
    // reply into Tenant A's conversation.
    const res = await anonPage.request.post(`${BASE}/api/conversations/${tenantA.conversationId}/messages`, {
      data: { text: 'anonymous-injection-attempt' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/contacts → 401 unauthorized', async () => {
    const res = await anonPage.request.get(`${BASE}/api/contacts`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/routing-rules → 401 unauthorized', async () => {
    const res = await anonPage.request.get(`${BASE}/api/routing-rules`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/widget-config → 401 unauthorized', async () => {
    // Dashboard widget-config (private — Tenant A's widget
    // customization). Distinct from the PUBLIC
    // /api/widget/<slug>/config used by the widget script.
    const res = await anonPage.request.get(`${BASE}/api/widget-config`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/widget-domains → 401 unauthorized', async () => {
    const res = await anonPage.request.get(`${BASE}/api/widget-domains`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  test('anonymous GET /api/widget-status → 401 unauthorized', async () => {
    // The authenticated internal backend readiness check (added in
    // PR #7). Must be session-authenticated — anonymous cannot use
    // it to enumerate tenant readiness.
    const res = await anonPage.request.get(`${BASE}/api/widget-status`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })

  // -----------------------------------------------------------
  // Public widget control cases — verify we did NOT break the
  // intentionally-public bootstrap flow.
  // -----------------------------------------------------------

  test('PUBLIC control: anonymous visitor CAN hit /api/widget/<slug>/contact (intentionally public)', async () => {
    // The widget contact endpoint is intentionally public — it
    // creates a Contact + issues a realtimeToken. This is the
    // legitimate visitor bootstrap flow. Securing it would break
    // the widget for every customer website.
    const res = await anonPage.request.post(`${BASE}/api/widget/${tenantA.slug}/contact`, {
      data: { visitorId: `anon-visitor-${Date.now()}` },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status(), 'public widget contact must succeed (200)').toBe(200)
    const body = (await res.json()) as { contactId?: string; realtimeToken?: string }
    expect(body.contactId, 'must return a contactId').toBeTruthy()
    expect(body.realtimeToken, 'must return a realtimeToken').toBeTruthy()
  })

  test('PUBLIC control: anonymous visitor CAN fetch the public widget script', async () => {
    // The script endpoint is intentionally public — it serves the
    // generated widget JavaScript that customers embed on their
    // websites.
    const res = await anonPage.request.get(`${BASE}/api/widget/${tenantA.slug}/script`)
    expect(res.status(), 'public widget script must succeed (200)').toBe(200)
    expect(res.headers()['content-type'] ?? '').toMatch(/javascript|text\/plain/i)
  })

  test('PROTECTED: anonymous visitor without a realtime token CANNOT POST /api/widget/<slug>/messages', async () => {
    // Even though /contact is public, the messages POST requires a
    // Bearer realtimeToken. An anonymous attacker who knows the slug
    // but does NOT go through /contact first must NOT be able to
    // inject visitor messages.
    const res = await anonPage.request.post(`${BASE}/api/widget/${tenantA.slug}/messages`, {
      data: { text: 'anonymous-without-token' },
      headers: { 'Content-Type': 'application/json' },
      // Intentionally NO Authorization header.
    })
    expect(res.status(), 'must be 401 (no Authorization header)').toBe(401)
  })

  test('PROTECTED: anonymous visitor with a GUESSABLE/invalid bearer token CANNOT POST messages', async () => {
    // Even with an Authorization header, a forged / guessed token
    // must be rejected. The token is HMAC-signed with NEXTAUTH_SECRET
    // — an attacker cannot forge one without the secret.
    const res = await anonPage.request.post(`${BASE}/api/widget/${tenantA.slug}/messages`, {
      data: { text: 'anonymous-with-forged-token' },
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer forged-invalid-token-attempt',
      },
    })
    // The widget messages endpoint rejects invalid tokens with 401.
    expect([401, 403]).toContain(res.status())
  })

  // -----------------------------------------------------------
  // Sanity: the slug alone must NOT leak tenant dashboard data.
  // -----------------------------------------------------------

  test('slug alone does NOT leak /api/tenants/me (no slug-based enumeration)', async () => {
    // Even if the attacker knows the slug, /api/tenants/me only
    // resolves to the authenticated tenant in the session — it
    // does NOT accept a slug query param.
    const res = await anonPage.request.get(`${BASE}/api/tenants/me?slug=${tenantA.slug}`)
    expect(res.status()).toBe(401)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('unauthorized')
  })
})
