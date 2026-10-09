import { test, expect, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget optimistic-send failure regression.
 *
 * #8 When the visitor message POST is intentionally made to fail,
 * the widget must NOT silently treat the message as sent. The user
 * must get a visible failed state + retry affordance, the text must
 * NOT be irretrievably discarded, and no fake persisted message must
 * remain after the failed request.
 *
 * Coverage:
 *   1.  Visitor types a message + presses Enter.
 *   2.  Optimistic bubble appears immediately (with .sk-pending
 *       class + "sending…" caption).
 *   3.  The POST is intercepted by Playwright and returns a 500.
 *   4.  The optimistic bubble transitions to a visibly FAILED state
 *       (.sk-failed class, red border, "failed" caption).
 *   5.  A retry button (.sk-retry-btn) appears.
 *   6.  An edit button (.sk-edit-btn) restores the original text to
 *       the input.
 *   7.  The user's text is NOT irretrievably discarded (still
 *       visible in the failed bubble).
 *   8.  After retry (with the interceptor removed), the message is
 *       persisted + appears exactly once — the failed-state UI is
 *       gone, no duplicate remains.
 *
 * The test does NOT require a backend production code path to
 * intentionally fail — the failure is injected by Playwright's
 * route() interception on the customer page only.
 *
 * This test runs in BOTH Full and Lite Docker CI (added to both
 * regression lists in `.github/workflows/ci.yml`).
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'
const CUSTOMER_PORT = 8084
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`
const WIDGET_SCRIPT_URL = (slug: string) => `${SUKHAN_ORIGIN}/api/widget/${slug}/script`

let customerServer: Server | null = null

test.beforeAll(async () => {
  customerServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer Website</title></head><body><h1>Customer Website</h1></body></html>')
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
    email: `optfail-${stamp}@test.com`,
    workspace: `OptFail ${stamp}`,
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

test.describe('Widget optimistic-send failure', () => {
  test('failed POST → visible failed state + retry affordance + text preserved + no duplicate after retry', async ({ browser }) => {
    const { email, workspace } = creds('optfail')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Sign up a tenant.
    const dashboardCtx = await browser.newContext()
    const slug = await signupAndGetSlug(dashboardCtx, email, workspace)

    // Set up the widget page on a separate customer-origin context.
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await widgetPage.waitForLoadState('domcontentloaded')
    await widgetPage.addScriptTag({ url: WIDGET_SCRIPT_URL(slug) })
    await widgetPage.waitForTimeout(3000)
    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    await widgetPage.waitForTimeout(2000)

    // Intercept the visitor message POST → return a 500 with a JSON
    // error body. This deterministically fails the send WITHOUT
    // requiring a backend production code path to fail.
    const failedText = `OPTFAIL_${stamp}`
    let postIntercepted = false
    await widgetPage.route(`**/api/widget/${slug}/messages`, async (route) => {
      // Only intercept the POST (the GET history fetch must pass through).
      if (route.request().method() === 'POST') {
        postIntercepted = true
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error' }),
        })
      } else {
        await route.continue()
      }
    })

    // #1 + #2 Type the message + press Enter. The optimistic bubble
    // appears immediately (with .sk-pending class) before the POST
    // failure resolves.
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })
    // Start the POST response waiter BEFORE pressing Enter — the
    // intercepted 500 response may arrive very quickly.
    const failedPostResponsePromise = widgetPage.waitForResponse(
      (res) =>
        res.url().includes(`/api/widget/${slug}/messages`) &&
        res.request().method() === 'POST' &&
        res.status() === 500,
      { timeout: 10000 },
    )
    await widgetInput.fill(failedText)
    await widgetInput.press('Enter')

    // The optimistic bubble (pending state) should appear almost
    // immediately — the .sk-pending class marks it.
    const optimisticBubble = widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText })
    await expect(
      optimisticBubble,
      'optimistic bubble appears immediately with .sk-pending class (before POST failure resolves)',
    ).toHaveCount(1, { timeout: 5000 })

    // #3 The POST is intercepted → 500.
    await failedPostResponsePromise
    expect(postIntercepted, 'POST must have been intercepted by the test').toBe(true)

    // #4 The optimistic bubble transitions to a visibly FAILED state
    // (the .sk-pending class is replaced by .sk-failed).
    await widgetPage.waitForTimeout(1000) // let the catch handler run + re-render
    const failedBubble = widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText })
    await expect(
      failedBubble,
      'failed optimistic bubble must have .sk-failed class (visible failed state)',
    ).toHaveCount(1)
    // The .sk-pending class must be GONE (replaced by .sk-failed).
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText }),
      '.sk-pending must be replaced by .sk-failed after the POST rejects',
    ).toHaveCount(0)
    // The "failed" caption must be visible.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed span').filter({ hasText: /failed|ارسال ناموفق/ }),
      'failed caption must be visible on the bubble',
    ).toHaveCount(1)

    // #5 A retry button must appear.
    await expect(
      widgetPage.locator('.sk-retry-btn'),
      'retry button must appear on the failed bubble',
    ).toHaveCount(1)

    // #6 An edit button must appear + restore the text to the input.
    await expect(
      widgetPage.locator('.sk-edit-btn'),
      'edit button must appear on the failed bubble',
    ).toHaveCount(1)
    await widgetPage.locator('.sk-edit-btn').click()
    await expect(widgetInput).toHaveValue(failedText, { timeout: 2000 })

    // #7 The user's text is NOT irretrievably discarded — it's still
    // visible in the failed bubble.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText }),
      'the original text is still visible in the failed bubble (not discarded)',
    ).toHaveCount(1)

    // #8 No fake persisted message remains + retry succeeds. Unroute
    // the POST interceptor (so the retry's POST will succeed) then
    // click retry — the retry POST should succeed + the bubble should
    // transition from failed → persisted (exactly once, no duplicate).
    await widgetPage.unroute(`**/api/widget/${slug}/messages`)
    const retryPostPromise = widgetPage.waitForResponse(
      (res) =>
        res.url().includes(`/api/widget/${slug}/messages`) &&
        res.request().method() === 'POST' &&
        res.status() === 200,
      { timeout: 10000 },
    )
    await widgetPage.locator('.sk-retry-btn').click()
    await retryPostPromise
    await widgetPage.waitForTimeout(1000) // let reconciliation settle

    // After the successful retry, the message should appear EXACTLY
    // ONCE (the optimistic entry is reconciled with the persisted
    // server response — no duplicate). The failed-state UI (red
    // border, retry button) must be GONE.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: failedText }),
      'after retry, the message appears exactly once (no duplicate from failed + retry)',
    ).toHaveCount(1)
    await expect(
      widgetPage.locator('.sk-retry-btn'),
      'retry button must be gone after successful retry',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText }),
      '.sk-failed class must be gone after successful retry',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText }),
      '.sk-pending class must not reappear after successful retry',
    ).toHaveCount(0)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
