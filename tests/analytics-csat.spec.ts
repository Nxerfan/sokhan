import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Analytics + CSAT — behavioral regression (stabilization audit,
 * journey 16).
 *
 * Creates KNOWN state (2 visitor conversations, an agent reply on one,
 * one closed + CSAT-rated) through the REAL public widget API and the
 * REAL agent API, then proves the analytics calculations from that
 * state:
 *   - total / open / closed counts
 *   - avg first-response time is computed (agent reply present)
 *   - avg resolution time is computed (closed conversation)
 *   - 7-day volume includes the created conversations
 *   - CSAT average + count + distribution reflect the submitted rating
 *   - tenant isolation (a second tenant's analytics do not include
 *     this tenant's data)
 *
 * CSAT lifecycle rules proven behaviorally:
 *   - the survey endpoint rejects a rating on an OPEN conversation
 *   - a valid rating on a CLOSED conversation persists and flows into
 *     analytics
 *   - invalid ratings (0, 6, non-numeric) are rejected
 *   - another contact cannot rate someone else's conversation (404)
 *   - duplicate rating is rejected (already_rated)
 *
 * This spec runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return { email: `ana-${stamp}@test.com`, workspace: `Ana ${stamp}` }
}

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const slug = (await tenantRes.json()).tenant?.slug
  expect(slug, 'slug should be set').toBeTruthy()
  return slug as string
}

type VisitorInfo = { conversationId: string; contactId: string; token: string }

async function createVisitorConversation(
  slug: string,
  text: string,
  visitorId: string,
): Promise<VisitorInfo> {
  const contactRes = await fetch(`${BASE}/api/widget/${slug}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId }),
  })
  if (!contactRes.ok) throw new Error(`Widget contact failed: ${contactRes.status}`)
  const contactData = (await contactRes.json()) as { contactId: string; conversationId: string; realtimeToken: string }

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

  return {
    conversationId: msgData.conversationId ?? contactData.conversationId,
    contactId: contactData.contactId,
    token: contactData.realtimeToken,
  }
}

async function csat(slug: string, token: string, conversationId: string, rating: unknown) {
  const res = await fetch(`${BASE}/api/widget/${slug}/csat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ conversationId, rating }),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string> }
}

test.describe('Analytics + CSAT — calculations proven from known state', () => {
  test('close → CSAT → analytics; CSAT lifecycle rules; tenant isolation', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('main')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // === Known state: two visitor conversations ===
    const v1 = await createVisitorConversation(slug, 'سلام، سوال اول', `ana-v1-${Date.now()}`)
    const v2 = await createVisitorConversation(slug, 'سلام، سوال دوم', `ana-v2-${Date.now()}`)

    // Agent replies to conversation 1 (sets firstResponseAt).
    const replyRes = await page.request.post(
      `${BASE}/api/conversations/${v1.conversationId}/messages`,
      { data: { text: 'پاسخ کارشناس' }, headers: { 'Content-Type': 'application/json' } },
    )
    expect(replyRes.status(), 'agent reply must succeed').toBe(200)

    // CSAT on an OPEN conversation must be rejected.
    const openRate = await csat(slug, v1.token, v1.conversationId, 5)
    expect(openRate.status).toBe(400)
    expect(openRate.body.error).toBe('conversation_not_closed')

    // Close conversation 1.
    const closeRes = await page.request.patch(
      `${BASE}/api/conversations/${v1.conversationId}`,
      { data: { status: 'closed' }, headers: { 'Content-Type': 'application/json' } },
    )
    expect(closeRes.status(), 'close must succeed').toBe(200)

    // Invalid ratings are rejected.
    expect((await csat(slug, v1.token, v1.conversationId, 0)).status).toBe(400)
    expect((await csat(slug, v1.token, v1.conversationId, 6)).status).toBe(400)
    expect((await csat(slug, v1.token, v1.conversationId, 'five')).status).toBe(400)

    // A valid rating on the closed conversation persists.
    const goodRate = await csat(slug, v1.token, v1.conversationId, 5)
    expect(goodRate.status).toBe(200)

    // Duplicate rating is rejected.
    const dupRate = await csat(slug, v1.token, v1.conversationId, 3)
    expect(dupRate.status).toBe(400)
    expect(dupRate.body.error).toBe('already_rated')

    // === Analytics reflect the known state (exactly TWO conversations
    // exist at this point: v1 closed+rated, v2 open — the third visitor
    // conversation for the cross-contact check is created AFTER these
    // assertions) ===
    const analyticsRes = await page.request.get(`${BASE}/api/analytics`)
    expect(analyticsRes.status()).toBe(200)
    const a = await analyticsRes.json()
    expect(a.totalConversations).toBe(2)          // exactly the two created
    expect(a.openConversations).toBe(1)           // v2 still open
    expect(a.closedConversations).toBe(1)         // v1 closed
    expect(a.avgResponseMs, 'first-response time must be computed').not.toBeNull()
    expect(a.avgResponseMs).toBeGreaterThan(0)
    expect(a.avgResolutionMs, 'resolution time must be computed').not.toBeNull()
    expect(a.avgResolutionMs).toBeGreaterThan(0)
    expect(a.csatCount).toBe(1)
    expect(a.csatAvg).toBe(5)
    const dist5 = a.csatDistribution.find((d: { rating: number }) => d.rating === 5)
    expect(dist5.count).toBe(1)
    const dist1 = a.csatDistribution.find((d: { rating: number }) => d.rating === 1)
    expect(dist1.count).toBe(0)
    // 7-day volume includes both conversations.
    const volumeTotal = a.volumeByDay.reduce(
      (sum: number, day: { count: number }) => sum + day.count, 0,
    )
    expect(volumeTotal).toBe(2)

    // Another contact cannot rate this conversation (cross-contact) —
    // created AFTER the analytics assertions so the known-state numbers
    // above stay exact.
    const other = await createVisitorConversation(slug, 'پیام بازدیدکننده دیگر', `ana-other-${Date.now()}`)
    const crossRate = await csat(slug, other.token, v1.conversationId, 4)
    expect(crossRate.status).toBe(404)
    expect(crossRate.body.error).toBe('not_found')

    // === Tenant isolation: a second tenant sees none of this ===
    const ctxB = await browser.newContext()
    const pageB = await ctxB.newPage()
    const credsB = creds('iso')
    await signupAndGetSlug(pageB, credsB.email, credsB.workspace)
    const analyticsB = await (await pageB.request.get(`${BASE}/api/analytics`)).json()
    expect(analyticsB.totalConversations).toBe(0)
    expect(analyticsB.csatCount).toBe(0)
    expect(analyticsB.avgResponseMs).toBeNull()

    await ctxB.close()
    await ctx.close()
  })
})
