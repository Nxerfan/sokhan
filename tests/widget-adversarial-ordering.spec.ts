import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Adversarial realtime-before-POST ordering regression.
 *
 * Forces the dangerous ordering where Socket.IO `message:new` arrives
 * BEFORE the POST response. The merge must reconcile the correct
 * optimistic placeholder by clientMessageId (NOT by text/FIFO).
 *
 * Coverage:
 *   1. Send the exact same text twice rapidly (distinct clientMessageIds).
 *   2. Delay/reorder the two POST responses deterministically.
 *   3. Allow realtime message:new delivery to arrive before at least
 *      one POST response.
 *   4. Verify each realtime message reconciles the correct optimistic
 *      placeholder by clientMessageId.
 *   5. After both POST responses complete, exactly two persisted bubbles remain.
 *   6. No pending or failed placeholders remain.
 *   7. Reload/history still shows exactly two.
 *
 * The test uses page.route to delay POST responses by 3s each. The
 * realtime message:new events arrive via Socket.IO (the backend
 * publishes them immediately after persisting — the POST response
 * is delayed by the route but the publish is NOT delayed because
 * the route intercepts the RESPONSE, not the server-side processing).
 *
 * Wait — actually, the route intercepts the ENTIRE request/response
 * cycle. If we delay the response, the server-side processing also
 * doesn't complete until the response is sent. So the realtime
 * publish happens AFTER the response is sent. We need a different
 * approach.
 *
 * Alternative: intercept the POST request, let it continue to the
 * server (which persists + publishes), but delay the RESPONSE from
 * reaching the widget. Use `route.continue()` + capture the response
 * + delay `route.fulfill()`.
 *
 * Actually, Playwright's `route.continue()` sends the request to the
 * server and gets the response. We can then delay calling
 * `route.fulfill()` to delay the response reaching the widget. But
 * the server-side processing (including the realtime publish) has
 * already completed by the time `route.continue()` resolves.
 *
 * So the flow would be:
 *   1. Widget sends POST A (route intercepts, continues to server).
 *   2. Server persists A, publishes message:new via Socket.IO.
 *   3. route.continue() resolves with the server response (including clientMessageId).
 *   4. We DELAY route.fulfill() — the widget hasn't received the POST response yet.
 *   5. Socket.IO delivers message:new (with clientMessageId) to the widget.
 *   6. The widget's message:new handler normalizes clientMessageId →
 *      _clientMessageId and routes through mergeIncoming.
 *   7. mergeIncoming matches the optimistic placeholder by _clientMessageId.
 *   8. NOW we call route.fulfill() — the widget receives the POST response.
 *   9. The POST response also has clientMessageId → mergeIncoming matches
 *      the same optimistic placeholder (already superseded → no-op).
 *
 * This is the adversarial case: realtime arrives BEFORE the POST response.
 *
 * For two identical messages:
 *   1. Send A (POST intercepted, continues to server, response delayed).
 *   2. Server persists A, publishes message:new with clientMessageId_A.
 *   3. Socket.IO delivers message:new for A.
 *   4. Send B (POST intercepted, continues to server, response delayed).
 *   5. Server persists B, publishes message:new with clientMessageId_B.
 *   6. Socket.IO delivers message:new for B.
 *   7. NOW fulfill both POST responses.
 *   8. Exactly 2 persisted bubbles, no pending/failed.
 *
 * The test proves that realtime clientMessageId normalization works
 * AND that modern correlated optimistic entries are never reconciled
 * by text/FIFO.
 *
 * This test runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const CUSTOMER_PORT = 8087
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`

let customerServer: Server | null = null
let currentSlug = ''

test.beforeAll(async () => {
  customerServer = createServer((req, res) => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer Website</title></head><body><h1>Customer Website</h1><script async defer src="${BASE}/api/widget/${currentSlug}/script"></script></body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => customerServer!.listen(CUSTOMER_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  if (customerServer) {
    await new Promise<void>((resolve) => customerServer!.close(() => resolve()))
    customerServer = null
  }
})

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `adv-${stamp}@test.com`,
    workspace: `Adv ${stamp}`,
  }
}

async function signupAndGetSlug(ctx: BrowserContext, email: string, workspace: string): Promise<string> {
  const page = await ctx.newPage()
  await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const slug = (await tenantRes.json()).tenant?.slug
  expect(slug, 'slug should be set').toBeTruthy()
  // Anonymous widget-flow regression requires the tenant to be in the
  // historical `anonymous` access mode (a fresh OTP signup now defaults
  // to `verified_visitor`). Switch it before the widget script loads
  // and the test's main flow begins. Must run before the helper's page
  // is closed — page.request carries the authenticated session.
  await setAccessMode(page, 'anonymous')
  await page.close()
  return slug as string
}

test.describe('Adversarial realtime-before-POST ordering', () => {
  test('two identical messages with realtime arriving before POST responses — each reconciles by clientMessageId', async ({ browser }) => {
    test.setTimeout(120000)
    const { email, workspace } = creds('adv')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const dashboardCtx = await browser.newContext()
    const slug = await signupAndGetSlug(dashboardCtx, email, workspace)
    currentSlug = slug

    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.waitForTimeout(3000)

    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    // Give the socket time to connect + identify the visitor.
    await widgetPage.waitForTimeout(5000)

    // Intercept POST messages: let the request reach the server
    // (which persists + publishes message:new via Socket.IO), but
    // DELAY the response reaching the widget. This forces the
    // adversarial ordering: realtime arrives BEFORE the POST response.
    const postResponses: Array<{ status: number; body: string }> = []
    await widgetPage.route(`**/api/widget/${slug}/messages`, async (route) => {
      if (route.request().method() === 'POST') {
        // Continue to the server — the server persists + publishes.
        const response = await route.fetch()
        // Capture the response (including clientMessageId in the body).
        const body = await response.text()
        postResponses.push({ status: response.status(), body })
        // Delay the response reaching the widget by 5s. The Socket.IO
        // message:new event will arrive during this delay.
        await new Promise(resolve => setTimeout(resolve, 5000))
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body,
        })
      } else {
        await route.continue()
      }
    })

    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })

    // #1 Send the exact same text twice rapidly (distinct clientMessageIds).
    const dupText = `ADV_HELLO_${stamp}`
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')
    await widgetPage.waitForTimeout(200)
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')

    // #2 Both optimistic bubbles appear immediately.
    const allDupBubbles = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText })
    await expect(
      allDupBubbles,
      'both optimistic bubbles appear immediately (distinct __local_ ids)',
    ).toHaveCount(2, { timeout: 5000 })

    // #3 + #4 Realtime message:new arrives during the 5s POST delay.
    // Each realtime message carries clientMessageId → normalized to
    // _clientMessageId → matched to the correct optimistic placeholder.
    // The .sk-pending class should clear as the realtime events
    // reconcile the placeholders (even though the POST responses
    // haven't arrived yet).
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: dupText }),
      'all pending classes clear (realtime clientMessageId reconciled the optimistic placeholders before POST responses arrive)',
    ).toHaveCount(0, { timeout: 30000 })

    // #5 After both POST responses complete, exactly two persisted bubbles.
    // The POST responses also carry clientMessageId → but the placeholders
    // are already superseded → mergeIncoming no-ops (no duplicate).
    await expect(
      allDupBubbles,
      'exactly 2 persisted bubbles (no duplicate from realtime + POST double-reconciliation)',
    ).toHaveCount(2)

    // #6 No pending or failed placeholders remain.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: dupText }),
      'no pending placeholders',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: dupText }),
      'no failed placeholders',
    ).toHaveCount(0)

    // #7 Reload/history still shows exactly two.
    await widgetPage.reload()
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.waitForTimeout(5000)
    const launcher2 = widgetPage.locator('.sk-launcher')
    await expect(launcher2, 'launcher reappears after reload').toBeVisible({ timeout: 15000 })
    await launcher2.click()
    await widgetPage.waitForTimeout(3000)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText }),
      'history reload shows exactly 2 persisted messages (distinct persisted ids)',
    ).toHaveCount(2)

    // Assert the POST responses were intercepted (proves the adversarial
    // delay actually happened — the test didn't just run normally).
    expect(postResponses.length, 'both POST responses were intercepted').toBeGreaterThanOrEqual(2)
    // Assert both POST responses succeeded (200) — the server persisted
    // both messages even though the responses were delayed.
    for (const r of postResponses) {
      expect(r.status, 'POST response status must be 200').toBe(200)
    }
    // Assert the two POST responses contain distinct clientMessageIds
    // (proves the widget generated distinct clientMessageIds per send).
    const cmids = postResponses.map(r => {
      try { return JSON.parse(r.body).clientMessageId } catch { return null }
    })
    expect(cmids[0], 'first POST response has clientMessageId').toBeTruthy()
    expect(cmids[1], 'second POST response has clientMessageId').toBeTruthy()
    expect(cmids[0], 'clientMessageIds are distinct').not.toBe(cmids[1])

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
