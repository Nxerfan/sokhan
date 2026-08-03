import { test, expect, type Page, type BrowserContext } from '@playwright/test'

/**
 * Socket race condition test — verifies that an agent reply sent IMMEDIATELY
 * after the visitor's first message is received by the widget via Socket.IO.
 *
 * Before the fix: the widget only connected its socket AFTER the first message.
 * After the fix: the socket is warmed up during identifyVisitor() (before any
 * conversation exists), and conversation:join is emitted on the already-connected
 * socket when a conversation is created.
 *
 * Uses ?nopoll=1 to disable the polling fallback — if the reply arrives at all,
 * it MUST be via Socket.IO.
 *
 * The dashboard uses Playwright's APIRequestContext for signup (reliable cookie
 * handling). The widget uses a browser page on port 81 (Caddy) for Socket.IO.
 */

const DASHBOARD = 'http://localhost:3000'
const WIDGET = 'http://localhost:81'

async function signupAndSignin(ctx: BrowserContext, email: string, workspace: string): Promise<string> {
  // Use the browser context's own cookie jar via a page
  const page = await ctx.newPage()
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)

  // Signup via API (the page's cookie jar handles session cookies)
  const signupRes = await page.request.post(`${DASHBOARD}/api/auth/signup`, {
    data: { email, password: 'password123', name: 'Agent', workspaceName: workspace },
  })
  expect(signupRes.ok()).toBe(true)

  // Get CSRF
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()

  // Signin
  const signinRes = await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  expect(signinRes.ok()).toBe(true)

  // Get slug
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  expect(slug).toBeTruthy()

  // Now reload the page — the session cookie is set, so the dashboard should render
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)

  return { page, slug }
}

test('Agent reply sent immediately after first message is received via Socket.IO (no race)', async ({ browser }) => {
  const stamp = `${process.pid}-${Date.now()}-race`
  const email = `race-${stamp}@test.com`

  // === Agent dashboard: signup + signin via APIRequestContext ===
  const dashboardCtx = await browser.newContext()
  const { page: dashboardPage, slug } = await signupAndSignin(dashboardCtx, email, `Race ${stamp}`)
  console.log(`Dashboard slug: ${slug}`)

  // Verify the dashboard loaded (heading with workspace name should be visible)
  await expect(dashboardPage.getByRole('heading', { name: `Race ${stamp}` })).toBeVisible({ timeout: 15000 })

  // Navigate to inbox and wait for socket connection
  const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
  await dashboardPage.waitForResponse(
    (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
    { timeout: 15000 },
  ).catch(() => {})
  await dashboardPage.waitForTimeout(4000)

  // === Widget: load with polling disabled via Caddy (for Socket.IO) ===
  const widgetCtx = await browser.newContext()
  const widgetPage = await widgetCtx.newPage()
  await widgetPage.goto(`${WIDGET}/widget-test.html?slug=${slug}`)
  await widgetPage.waitForLoadState('networkidle')

  // Remove auto-embedded widget and re-inject with nopoll=1
  await widgetPage.evaluate(() => {
    const existing = document.querySelector('.sk-root')
    if (existing) existing.remove()
  })
  await widgetPage.addScriptTag({ url: `${WIDGET}/api/widget/${slug}/script?nopoll=1` })

  const launcher = widgetPage.locator('.sk-launcher')
  await expect(launcher).toBeVisible({ timeout: 10000 })
  await launcher.click()
  await widgetPage.waitForTimeout(500)

  // Wait for visitor identification (warms up socket)
  await widgetPage.waitForResponse(
    (res) => res.url().includes('/contact') && res.status() === 200,
    { timeout: 10000 },
  ).catch(() => {})
  await widgetPage.waitForTimeout(3000)

  // Send first message from widget
  const widgetInput = widgetPage.locator('.sk-input input')
  await expect(widgetInput).toBeVisible({ timeout: 3000 })
  const visitorMessage = `RACE_${Date.now()}`
  await widgetInput.fill(visitorMessage)

  const messagePostPromise = widgetPage.waitForResponse(
    (res) => res.url().includes('/messages') && res.request().method() === 'POST' && res.status() === 200,
    { timeout: 10000 },
  )
  await widgetInput.press('Enter')
  const messageResponse = await messagePostPromise
  const messageData = await messageResponse.json()
  const conversationId = messageData.conversationId
  expect(conversationId).toBeTruthy()

  // === IMMEDIATELY reply from dashboard (no delay) ===
  const replyText = `REPLY_${Date.now()}`
  const replyStartTime = Date.now()

  // Poll for conversation to appear, then reply instantly via APIRequestContext
  let replied = false
  for (let attempt = 0; attempt < 15; attempt++) {
    const convRes = await dashboardPage.request.get(`${DASHBOARD}/api/conversations?status=open`)
    const convData = await convRes.json()
    const conv = (convData.conversations || []).find((c: any) =>
      c.lastMessagePreview?.includes(visitorMessage))
    if (conv) {
      await dashboardPage.request.post(`${DASHBOARD}/api/conversations/${conversationId}/messages`, {
        headers: { 'Content-Type': 'application/json' },
        data: { text: replyText },
      })
      replied = true
      break
    }
    await dashboardPage.waitForTimeout(200)
  }

  expect(replied, 'Dashboard should show the conversation within 3s').toBe(true)

  // === ASSERTION: reply appears in widget via Socket.IO (polling disabled) ===
  await expect(
    widgetPage.locator('.sk-agt').filter({ hasText: replyText })
  ).toBeVisible({ timeout: 5000 })

  const latency = Date.now() - replyStartTime
  console.log(`\n=== Race condition test PASSED: agent reply received in ${latency}ms via Socket.IO ===`)

  await dashboardCtx.close()
  await widgetCtx.close()
})
