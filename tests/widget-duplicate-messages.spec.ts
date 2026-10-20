import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget duplicate-identical-message regression.
 *
 * A user may legitimately send the same text twice ("hello" / "hello").
 * Both must persist and render exactly twice. The merge uses an
 * explicit clientMessageId (not text) to reconcile each optimistic
 * placeholder with its exact persisted counterpart.
 *
 * The customer HTML page serves the widget <script> tag in its markup
 * so reload naturally re-loads the widget script (a dynamically injected
 * script via page.addScriptTag() disappears on reload).
 *
 * Coverage:
 *   1. Type the same exact text twice rapidly.
 *   2. Both optimistic bubbles appear.
 *   3. Allow both POSTs to succeed.
 *   4. Final widget shows exactly 2 bubbles with that exact text.
 *   5. Reload the page (script tag is in the HTML → re-loads).
 *   6. History still shows exactly 2.
 *   7. No pending/failed placeholders remain.
 *
 * Mixed failure case:
 *   8. First identical send fails → failed state.
 *   9. Second succeeds → one persisted bubble.
 *   10. Retry first → second persisted bubble.
 *   11. Final result is exactly 2 persisted messages.
 *
 * This test runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const CUSTOMER_PORT = 8086
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`

let customerServer: Server | null = null
let currentSlug = ''

test.beforeAll(async () => {
  customerServer = createServer((req, res) => {
    // Serve a customer HTML page with the widget <script> tag embedded
    // in the markup — so reload naturally re-loads the widget script.
    // A dynamically injected script via page.addScriptTag() disappears
    // on reload, which is a test-harness issue, not a product failure.
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
    email: `dupmsg-${stamp}@test.com`,
    workspace: `DupMsg ${stamp}`,
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
  await page.close()
  return slug as string
}

test.describe('Widget duplicate identical messages', () => {
  test('two identical messages sent rapidly both persist and render exactly twice', async ({ browser }) => {
    const { email, workspace } = creds('dup')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const dashboardCtx = await browser.newContext()
    const slug = await signupAndGetSlug(dashboardCtx, email, workspace)
    currentSlug = slug

    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    // Navigate to the customer page — the HTML markup contains the
    // widget <script> tag, so the widget loads automatically.
    await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.waitForTimeout(3000)

    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    await widgetPage.waitForTimeout(2000)

    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })

    // #1 Type the same exact text twice rapidly.
    const dupText = `DUP_HELLO_${stamp}`
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')
    await widgetPage.waitForTimeout(200)
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')

    // #2 Both optimistic bubbles appear.
    const allDupBubbles = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText })
    await expect(
      allDupBubbles,
      'both optimistic bubbles must appear immediately (two distinct __local_ ids)',
    ).toHaveCount(2, { timeout: 5000 })

    // #3 Allow both POSTs to succeed. Wait for ALL .sk-pending to clear.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: dupText }),
      'all pending classes must clear (both POSTs reconciled)',
    ).toHaveCount(0, { timeout: 20000 })

    // #4 Final widget shows exactly 2 bubbles with that exact text.
    await expect(
      allDupBubbles,
      'exactly 2 persisted bubbles with identical text (not collapsed by the merge)',
    ).toHaveCount(2)

    // #5 Reload the page — the widget script tag is in the HTML, so
    // the widget re-loads automatically on reload.
    await widgetPage.reload()
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.waitForTimeout(5000)
    const launcher2 = widgetPage.locator('.sk-launcher')
    await expect(launcher2, 'launcher reappears after reload (script tag is in HTML)').toBeVisible({ timeout: 15000 })
    await launcher2.click()
    await widgetPage.waitForTimeout(3000)

    // #6 History still shows exactly 2.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText }),
      'history reload shows exactly 2 persisted messages (distinct ids)',
    ).toHaveCount(2)

    // #7 No pending/failed placeholders remain.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: dupText }),
      'no pending placeholders after reload',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: dupText }),
      'no failed placeholders after reload',
    ).toHaveCount(0)

    await widgetCtx.close()
    await dashboardCtx.close()
  })

  test('mixed case: first identical send fails, second succeeds, retry first → exactly 2 persisted', async ({ browser }) => {
    const { email, workspace } = creds('mixed')
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
    await widgetPage.waitForTimeout(2000)

    // Intercept the POST — first call returns 500 (delayed 1s so
    // .sk-pending is visible), subsequent calls pass through.
    const dupText = `MIXED_HELLO_${stamp}`
    let firstCallIntercepted = false
    await widgetPage.route(`**/api/widget/${slug}/messages`, async (route) => {
      if (route.request().method() === 'POST' && !firstCallIntercepted) {
        firstCallIntercepted = true
        await new Promise(resolve => setTimeout(resolve, 1000))
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error' }),
        })
      } else {
        await route.continue()
      }
    })

    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })

    // Send the first message — will fail (500).
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: dupText }),
      'first identical send must transition to failed state',
    ).toHaveCount(1, { timeout: 15000 })

    // Send the second identical message — will succeed.
    await widgetInput.fill(dupText)
    await widgetInput.press('Enter')
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText }),
      '2 bubbles total: 1 failed + 1 persisted',
    ).toHaveCount(2, { timeout: 15000 })

    // #10 Retry the first (failed) — unroute so the retry POST succeeds.
    await widgetPage.unroute(`**/api/widget/${slug}/messages`)
    const retryBtn = widgetPage.locator('.sk-retry-btn').first()
    await expect(retryBtn, 'retry button still present before click').toBeVisible({ timeout: 5000 })
    await retryBtn.click()
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: dupText }),
      'failed state must clear after retry',
    ).toHaveCount(0, { timeout: 15000 })

    // #11 Final result is exactly 2 persisted messages.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: dupText }),
      'exactly 2 persisted messages after retry (first retried + second succeeded)',
    ).toHaveCount(2)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: dupText }),
      'no pending placeholders',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: dupText }),
      'no failed placeholders',
    ).toHaveCount(0)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
