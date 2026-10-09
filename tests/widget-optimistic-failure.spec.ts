import { test, expect, type BrowserContext } from '@playwright/test'
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
 *       class).
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
 * The widget is loaded on the Sukhan origin's /widget-test.html
 * (same pattern as module2.spec.ts) so the widget script + REST
 * fetches work reliably.
 *
 * This test runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

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

    const dashboardCtx = await browser.newContext()
    const slug = await signupAndGetSlug(dashboardCtx, email, workspace)

    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.goto(`${BASE}/widget-test.html`)
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.addScriptTag({ url: `${BASE}/api/widget/${slug}/script` })
    await widgetPage.waitForTimeout(3000)
    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    await widgetPage.waitForTimeout(2000)

    const failedText = `OPTFAIL_${stamp}`
    let postIntercepted = false
    await widgetPage.route(`**/api/widget/${slug}/messages`, async (route) => {
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

    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })
    await widgetInput.fill(failedText)
    await widgetInput.press('Enter')

    // #2 optimistic bubble appears immediately with .sk-pending
    const optimisticBubble = widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText })
    await expect(
      optimisticBubble,
      'optimistic bubble appears immediately with .sk-pending class (before POST failure resolves)',
    ).toHaveCount(1, { timeout: 5000 })

    // #3 + #4 POST intercepted → 500, bubble transitions to .sk-failed
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText }),
      'failed optimistic bubble must have .sk-failed class after the 500 response',
    ).toHaveCount(1, { timeout: 15000 })
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText }),
      '.sk-pending must be replaced by .sk-failed after the POST rejects',
    ).toHaveCount(0)
    expect(postIntercepted, 'POST must have been intercepted by the test').toBe(true)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed span').filter({ hasText: /failed|ارسال ناموفق/ }),
      'failed caption must be visible on the bubble',
    ).toHaveCount(1)

    // #5 retry button
    await expect(
      widgetPage.locator('.sk-retry-btn'),
      'retry button must appear on the failed bubble',
    ).toHaveCount(1)

    // #6 edit button restores text
    await expect(
      widgetPage.locator('.sk-edit-btn'),
      'edit button must appear on the failed bubble',
    ).toHaveCount(1)
    await widgetPage.locator('.sk-edit-btn').click()
    await expect(widgetInput).toHaveValue(failedText, { timeout: 2000 })

    // #7 text not discarded
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText }),
      'the original text is still visible in the failed bubble (not discarded)',
    ).toHaveCount(1)

    // #8 retry succeeds, no duplicate
    await widgetPage.unroute(`**/api/widget/${slug}/messages`)
    await widgetPage.locator('.sk-retry-btn').click()
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-failed p').filter({ hasText: failedText }),
      '.sk-failed class must be gone after successful retry',
    ).toHaveCount(0, { timeout: 15000 })
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: failedText }),
      'after retry, the message appears exactly once (no duplicate from failed + retry)',
    ).toHaveCount(1)
    await expect(
      widgetPage.locator('.sk-retry-btn'),
      'retry button must be gone after successful retry',
    ).toHaveCount(0)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: failedText }),
      '.sk-pending class must not reappear after successful retry',
    ).toHaveCount(0)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
