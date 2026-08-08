import { test, expect, type Page } from '@playwright/test'

/**
 * Module 3 tests — Contacts panel, Billing flow, CSAT submission.
 *
 * Uses API-based signup (reliable) like the isolation test.
 */

const DASHBOARD = 'http://localhost:3000'
const WIDGET = 'http://localhost:81'

async function signupAndSignin(page: Page, email: string, workspace: string): Promise<string> {
  await page.request.post(`${DASHBOARD}/api/auth/signup`, {
    data: { email, password: 'password123', name: 'Agent', workspaceName: workspace },
  })
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug

  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)
  return slug
}

test.describe('Module 3', () => {
  test('1. Contacts panel shows contacts from widget conversations', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-contacts`
    const email = `contacts-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `Contacts ${stamp}`)
    expect(slug).toBeTruthy()

    // Create a conversation via the widget API (creates a contact)
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-contacts-${stamp}` },
    })
    const contactData = await contactRes.json()
    expect(contactData.contactId).toBeTruthy()

    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${contactData.realtimeToken}` },
      data: { text: 'Hello from contacts test' },
    })
    const msgData = await msgRes.json()
    expect(msgData.conversationId).toBeTruthy()

    // Navigate to the Contacts panel
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /مخاطبین|Contacts/ }).click()
    await page.waitForTimeout(2000)

    // Verify the contact appears in the list
    // The contact name is derived from the visitorId or email
    const contactRow = page.locator('button').filter({ hasText: 'visitor' }).first()
    await expect(contactRow).toBeVisible({ timeout: 10000 })

    // Click the contact to expand and see conversations
    await contactRow.click()
    await page.waitForTimeout(2000)

    // Verify the conversation appears in the expanded view
    await expect(page.getByText('Hello from contacts test')).toBeVisible({ timeout: 5000 })

    await ctx.close()
  })

  test('2. Billing flow — list plans, subscribe, callback activates subscription', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-billing`
    const email = `billing-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `Billing ${stamp}`)
    expect(slug).toBeTruthy()

    // List plans
    const plansRes = await page.request.get(`${DASHBOARD}/api/billing/plans`)
    const plansData = await plansRes.json()
    expect(plansData.plans).toBeDefined()
    expect(plansData.plans.length).toBeGreaterThanOrEqual(3)
    const proPlan = plansData.plans.find((p: any) => p.slug === 'pro')
    expect(proPlan).toBeTruthy()

    // Subscribe to pro plan via ZarinPal (test mode)
    const subscribeRes = await page.request.post(`${DASHBOARD}/api/billing/subscribe`, {
      headers: { 'Content-Type': 'application/json' },
      data: { planSlug: 'pro', gateway: 'zarinpal' },
    })
    const subscribeData = await subscribeRes.json()
    expect(subscribeData.gatewayUrl).toBeTruthy()
    expect(subscribeData.authority).toBeTruthy()
    expect(subscribeData.testMode).toBe(true)
    expect(subscribeData.invoiceId).toBeTruthy()

    // Simulate the payment callback — the callback expects invoiceId + Status=OK
    const callbackUrl = `${DASHBOARD}/api/billing/callback/zarinpal?invoiceId=${subscribeData.invoiceId}&Status=OK`
    const callbackRes = await page.request.get(callbackUrl, { maxRedirects: 0 })
    // The callback redirects to /?billing=success — we just check it doesn't error
    expect(callbackRes.status()).toBeLessThan(400)

    // Verify the subscription is now active
    const subRes = await page.request.get(`${DASHBOARD}/api/billing/subscription`)
    const subData = await subRes.json()
    expect(subData.subscription).toBeTruthy()
    expect(subData.subscription.status).toBe('active')
    expect(subData.plan.slug).toBe('pro')

    // Verify the tenant's plan was updated
    const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
    const tenantData = await tenantRes.json()
    expect(tenantData.tenant.plan).toBe('pro')

    await ctx.close()
  })

  test('3. CSAT submission — visitor rates conversation after closure', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-csat`
    const email = `csat-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `CSAT ${stamp}`)
    expect(slug).toBeTruthy()

    // Create a conversation via the widget API
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-csat-${stamp}` },
    })
    const contactData = await contactRes.json()
    const visitorToken = contactData.realtimeToken

    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { text: 'I need help with CSAT' },
    })
    const msgData = await msgRes.json()
    const conversationId = msgData.conversationId
    expect(conversationId).toBeTruthy()

    // Agent closes the conversation
    await page.request.patch(`${DASHBOARD}/api/conversations/${conversationId}`, {
      headers: { 'Content-Type': 'application/json' },
      data: { status: 'closed' },
    })

    // Visitor submits CSAT rating
    const csatRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/csat`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { conversationId, rating: 5, comment: 'Great service!' },
    })
    const csatData = await csatRes.json()
    expect(csatData.ok).toBe(true)

    // Verify the CSAT rating was saved — check the analytics endpoint
    const analyticsRes = await page.request.get(`${DASHBOARD}/api/analytics`)
    const analyticsData = await analyticsRes.json()
    expect(analyticsData.csatCount).toBeGreaterThanOrEqual(1)
    expect(analyticsData.csatAvg).toBeGreaterThanOrEqual(5)

    // Verify the conversation has the CSAT rating
    const convRes = await page.request.get(`${DASHBOARD}/api/conversations/${conversationId}`)
    const convData = await convRes.json()
    expect(convData.conversation.csatRating).toBe(5)
    expect(convData.conversation.csatComment).toBe('Great service!')

    await ctx.close()
  })

  test('4. Plan gating — free tier limits are enforced', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-gating`
    const email = `gating-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `Gating ${stamp}`)
    expect(slug).toBeTruthy()

    // Free tier allows 1 department. Create one — should succeed.
    const dept1Res = await page.request.post(`${DASHBOARD}/api/departments`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: 'Dept 1' },
    })
    expect(dept1Res.ok()).toBe(true)

    // Try to create a second department — should be blocked (free tier limit: 1)
    const dept2Res = await page.request.post(`${DASHBOARD}/api/departments`, {
      headers: { 'Content-Type': 'application/json' },
      data: { name: 'Dept 2' },
    })
    expect(dept2Res.status()).toBe(402) // Payment Required
    const dept2Data = await dept2Res.json()
    expect(dept2Data.error).toBe('plan_limit_exceeded')
    expect(dept2Data.limit).toBe('departments')

    await ctx.close()
  })
})
