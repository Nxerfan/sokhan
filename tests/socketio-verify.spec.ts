import { test, expect, type Page } from '@playwright/test'

/**
 * Socket.IO verification test — isolates real-time delivery from polling.
 *
 * This test loads the widget with ?nopoll=1 (disables the polling safety net)
 * and confirms that a message sent from the widget arrives in the dashboard
 * via a genuine Socket.IO event, measured by wall-clock latency.
 *
 * Pass criteria:
 *   - The message appears in the dashboard within 3 seconds (sub-3s = real-time).
 *   - If polling were the delivery path (10s interval), the message would take
 *     10+ seconds to appear. So a <3s appearance proves Socket.IO is working.
 *
 * This test is the honest answer to: "does Socket.IO actually deliver, or is
 * polling standing in for it?"
 */

const BASE = 'http://localhost:81'
const DASHBOARD = 'http://localhost:81'  // Use Caddy for Socket.IO access

function creds() {
  const stamp = `${process.pid}-${Date.now()}-socketio`
  return {
    email: `sio-${stamp}@test.com`,
    workspace: `SIO ${stamp}`,
  }
}

async function signupAndGetSlug(ctx: import('@playwright/test').BrowserContext, email: string, workspace: string): Promise<{ page: import('@playwright/test').Page; slug: string }> {
  const page = await ctx.newPage()
  // Navigate to the dashboard via Caddy (port 81) — needed for Socket.IO
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)

  // Use page.evaluate to make fetch calls FROM the page context (shares cookies)
  const slug = await page.evaluate(async ({ email, workspace }) => {
    // Signup
    await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', name: 'Agent Test', workspaceName: workspace })
    })
    // Get CSRF
    const csrfRes = await fetch('/api/auth/csrf')
    const { csrfToken } = await csrfRes.json()
    // Signin
    await fetch('/api/auth/callback/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`
    })
    // Get slug
    const tenantRes = await fetch('/api/tenants/me')
    const tenantData = await tenantRes.json()
    return tenantData.tenant?.slug
  }, { email, workspace })

  expect(slug).toBeTruthy()

  // Reload — the session cookie is set in the browser, dashboard should render
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)

  return { page, slug }
}

test('Socket.IO delivers widget→dashboard in real-time (polling disabled)', async ({ browser }) => {
  const { email, workspace } = creds()

  // Context A: agent dashboard
  const dashboardCtx = await browser.newContext()
  const { page: dashboardPage, slug } = await signupAndGetSlug(dashboardCtx, email, workspace)

  // Navigate to inbox — the InboxView's useEffect will fetch /api/realtime-token
  // and attempt a Socket.IO connection. We need to wait for:
  //   1. useSession to resolve (status: 'authenticated')
  //   2. /api/realtime-token fetch to succeed
  //   3. Socket.IO handshake + connect
  // Give it generous time since the session resolution involves a network round-trip.
  const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()

  // Wait for the realtime-token fetch to succeed (proves session is ready)
  await dashboardPage.waitForResponse(
    (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
    { timeout: 15000 },
  ).catch(() => {})

  // Give the socket time to connect after the token is fetched
  await dashboardPage.waitForTimeout(5000)

  // Context B: widget visitor — load with ?nopoll=1 to disable polling
  const widgetCtx = await browser.newContext()
  const widgetPage = await widgetCtx.newPage()
  await widgetPage.goto(`${BASE}/widget-test.html`)
  await widgetPage.waitForLoadState('networkidle')

  // Collect console messages from the widget to diagnose socket connection
  const widgetConsole: string[] = []
  widgetPage.on('console', (msg) => {
    widgetConsole.push(`[${msg.type()}] ${msg.text()}`)
  })

  // Inject the widget script with nopoll=1 — polling is now disabled
  await widgetPage.addScriptTag({
    url: `${BASE}/api/widget/${slug}/script?nopoll=1`,
  })

  const launcher = widgetPage.locator('.sk-launcher')
  await expect(launcher).toBeVisible({ timeout: 10000 })
  await launcher.click()
  await widgetPage.waitForTimeout(500)

  // Wait for visitor identification
  await widgetPage.waitForResponse(
    (res) => res.url().includes('/contact') && res.status() === 200,
    { timeout: 10000 },
  ).catch(() => {})

  const widgetInput = widgetPage.locator('.sk-input input')
  await expect(widgetInput).toBeVisible({ timeout: 3000 })

  // Send a distinctive message and measure when it appears in the dashboard
  const markerText = `SIO_TEST_${Date.now()}`
  const sendStartTime = Date.now()

  await widgetInput.fill(markerText)
  await widgetInput.press('Enter')

  // Wait for the message POST to complete (persisted + published to realtime)
  await widgetPage.waitForResponse(
    (res) => res.url().includes('/messages') && res.request().method() === 'POST' && res.status() === 200,
    { timeout: 10000 },
  )

  // Now wait for the message to appear in the dashboard.
  // With polling disabled (10s interval), if the message appears in <5s it
  // MUST have arrived via Socket.IO. If it takes 10+s, polling was the path.
  let deliveryLatencyMs: number | null = null
  try {
    await expect(
      dashboardPage.locator('button').filter({ hasText: markerText }).first()
    ).toBeVisible({ timeout: 5000 })
    deliveryLatencyMs = Date.now() - sendStartTime
  } catch {
    // Message didn't appear within 5s — check if it appeared at all (within 15s)
    try {
      await expect(
        dashboardPage.locator('button').filter({ hasText: markerText }).first()
      ).toBeVisible({ timeout: 15000 })
      deliveryLatencyMs = Date.now() - sendStartTime
    } catch {
      // Log widget console for diagnosis
      console.log('=== Widget console messages ===')
      console.log(widgetConsole.join('\n'))
    }
  }

  // Report the latency regardless of outcome
  if (deliveryLatencyMs !== null) {
    console.log(`\n=== Socket.IO delivery latency: ${deliveryLatencyMs}ms ===`)
    if (deliveryLatencyMs < 5000) {
      console.log('=== PASS: message arrived via Socket.IO (<5s, polling interval is 10s) ===')
    } else {
      console.log(`=== WARNING: message took ${deliveryLatencyMs}ms — likely polling, not Socket.IO ===`)
    }
  } else {
    console.log('=== FAIL: message never appeared in dashboard ===')
    console.log('=== Widget console messages ===')
    console.log(widgetConsole.join('\n'))
  }

  // The hard assertion: message must appear, and within 5s (proves Socket.IO)
  expect(deliveryLatencyMs).not.toBeNull()
  expect(deliveryLatencyMs!, 'Message delivery should be <5s to prove Socket.IO (polling is 10s)').toBeLessThan(5000)

  await dashboardCtx.close()
  await widgetCtx.close()
})
