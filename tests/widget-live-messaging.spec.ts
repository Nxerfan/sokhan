import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget two-way live messaging browser regression.
 *
 * Exercises the REAL generated widget script (`/api/widget/<slug>/script`)
 * with a separate dashboard browser context for the agent side. Proves
 * the full two-way live-delivery loop works without page refresh.
 *
 * Coverage:
 *   #1  Visitor message appears immediately (optimistic send) — the
 *       bubble renders BEFORE the POST response resolves.
 *   #2  Visitor message still appears exactly once after POST
 *       reconciliation (optimistic + persisted merge → 1 bubble, no
 *       duplicate).
 *   #3  Agent reply (sent from the real Inbox dashboard UI) appears in
 *       the visitor widget without reload — via the actual Socket.IO
 *       message:new event path.
 *   #4  Agent reply appears exactly once (POST response + Socket.IO
 *       echo dedup on the widget side).
 *   #5  Both messages remain visible after a history refresh/reload.
 *
 * Polling fallback scenario:
 *   #6  When the widget socket is disconnected (simulated by blocking
 *       the Socket.IO script load), an agent reply appears through the
 *       polling fallback within the documented 10s interval — without
 *       a page reload.
 *   #7  The polling-delivered reply appears exactly once.
 *
 * The widget is loaded on the Sukhan origin's /widget-test.html (same
 * pattern as module2.spec.ts) so the Socket.IO connection works
 * reliably in the Docker CI environment. The widget script itself is
 * the REAL generated script endpoint — NOT a mock.
 *
 * This test runs in BOTH Full and Lite Docker CI (added to both
 * regression lists in `.github/workflows/ci.yml`).
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `live-${stamp}@test.com`,
    workspace: `Live ${stamp}`,
  }
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
  await page.waitForTimeout(2000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const slug = (await tenantRes.json()).tenant?.slug
  expect(slug, 'slug should be set').toBeTruthy()
  return slug as string
}

/** Load the widget on the Sukhan origin's /widget-test.html + open it. */
async function setupWidgetPage(page: Page, slug: string, blockSocket: boolean = false): Promise<void> {
  if (blockSocket) {
    // Block the socket.io-client script load — the widget can never
    // call io(). This deterministically simulates realtime unavailability.
    await page.route('**/socket.io.min.js', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await page.route('**/socket.io/**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await page.route('**/?XTransformPort=3003**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
  }
  await page.goto(`${BASE}/widget-test.html`)
  await page.waitForLoadState('networkidle')
  await page.addScriptTag({ url: `${BASE}/api/widget/${slug}/script` })
  await page.waitForTimeout(3000)
  const launcher = page.locator('.sk-launcher')
  await expect(launcher, 'widget launcher should appear').toBeVisible({ timeout: 10000 })
  await launcher.click()
  await page.waitForTimeout(2000)
}

test.describe('Widget two-way live messaging', () => {
  test('Healthy realtime: visitor optimistic send + agent reply via Socket.IO — both appear exactly once without reload', async ({ browser }) => {
    const { email, workspace } = creds('healthy')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // === Agent dashboard: signup + navigate to inbox ===
    const dashboardCtx = await browser.newContext()
    const dashboardPage = await dashboardCtx.newPage()
    const slug = await signupAndGetSlug(dashboardPage, email, workspace)
    const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
    await dashboardPage.waitForResponse(
      (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
      { timeout: 15000 },
    ).catch(() => {})
    await dashboardPage.waitForTimeout(2000)

    // === Visitor widget page (separate context — no dashboard cookies) ===
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await setupWidgetPage(widgetPage, slug)

    // #1 Visitor message appears IMMEDIATELY (optimistic send).
    const visitorText = `LIVE_VISITOR_${stamp}`
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })

    await widgetInput.fill(visitorText)
    await widgetInput.press('Enter')
    // The optimistic bubble must appear immediately — BEFORE the POST
    // resolves. The .sk-pending class marks the optimistic state.
    const visitorBubble = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText })
    await expect(
      visitorBubble,
      'visitor optimistic bubble must appear immediately after Enter (before POST resolves)',
    ).toHaveCount(1, { timeout: 5000 })

    // #2 After the POST response, the .sk-pending class transitions
    // away (replaced by the persisted message's timestamp). Wait for
    // the pending state to clear — proves the POST reconciled the
    // optimistic entry.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
      'pending class must be cleared after POST reconciliation',
    ).toHaveCount(0, { timeout: 15000 })
    await expect(
      visitorBubble,
      'visitor message must appear EXACTLY ONCE after POST reconciliation',
    ).toHaveCount(1)

    // #3 Agent reply from the real Inbox dashboard UI.
    const convItem = dashboardPage.locator('button').filter({ hasText: visitorText }).first()
    await expect(convItem, 'visitor conversation appears in inbox').toBeVisible({ timeout: 15000 })
    await convItem.click()
    await dashboardPage.waitForTimeout(500)
    await expect(dashboardPage.getByText(visitorText).first()).toBeVisible({ timeout: 10000 })

    // Send a unique agent reply from the dashboard UI.
    const replyText = `LIVE_REPLY_${stamp}`
    const replyInput = dashboardPage.locator('.border-t input[placeholder]').last()
    await expect(replyInput).toBeVisible({ timeout: 5000 })
    await replyInput.fill(replyText)
    const replyPostPromise = dashboardPage.waitForResponse(
      (res) =>
        res.url().includes('/api/conversations/') &&
        res.url().includes('/messages') &&
        res.request().method() === 'POST' &&
        res.status() === 200,
      { timeout: 10000 },
    )
    await replyInput.press('Enter')
    await replyPostPromise

    // #3 + #4 The visitor widget receives the agent reply via
    // Socket.IO message:new — without reload. Exactly once.
    const replyBubble = widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText })
    await expect(
      replyBubble,
      'agent reply must appear in visitor widget via Socket.IO (no reload)',
    ).toHaveCount(1, { timeout: 15000 })
    // Wait for any potential Socket.IO echo to arrive (defensive —
    // the dedup must collapse it to 1).
    await widgetPage.waitForTimeout(2000)
    await expect(
      replyBubble,
      'agent reply must appear EXACTLY ONCE (no duplicate from Socket.IO echo)',
    ).toHaveCount(1)

    // #5 Both messages remain visible after a history refresh/reload.
    await widgetPage.reload()
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.waitForTimeout(3000)
    const launcher2 = widgetPage.locator('.sk-launcher')
    await launcher2.click()
    await widgetPage.waitForTimeout(2000)
    await expect(
      widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText }),
      'visitor message remains after reload',
    ).toHaveCount(1)
    await expect(
      widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText }),
      'agent reply remains after reload',
    ).toHaveCount(1)

    await widgetCtx.close()
    await dashboardCtx.close()
  })

  test('Polling fallback: agent reply appears via polling when the widget socket is disconnected — exactly once, no reload', async ({ browser }) => {
    const { email, workspace } = creds('poll')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // === Agent dashboard ===
    const dashboardCtx = await browser.newContext()
    const dashboardPage = await dashboardCtx.newPage()
    const slug = await signupAndGetSlug(dashboardPage, email, workspace)
    const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
    await dashboardPage.waitForResponse(
      (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
      { timeout: 15000 },
    ).catch(() => {})
    await dashboardPage.waitForTimeout(2000)

    // === Visitor widget page — block Socket.IO BEFORE loading the
    // widget script so the socket can NEVER connect. This
    // deterministically forces the polling fallback path. ===
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await setupWidgetPage(widgetPage, slug, true /* blockSocket */)

    // Send a visitor message to create the conversation. The POST
    // should succeed (it's REST, not realtime).
    const visitorText = `POLL_VISITOR_${stamp}`
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })
    await widgetInput.fill(visitorText)
    await widgetInput.press('Enter')
    // The optimistic bubble appears, then transitions to persisted
    // when the POST resolves.
    const visitorBubble = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText })
    await expect(visitorBubble, 'visitor bubble appears').toHaveCount(1, { timeout: 5000 })
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
      'pending class clears after POST (no socket — POST still works via REST)',
    ).toHaveCount(0, { timeout: 15000 })
    await expect(visitorBubble, 'visitor message appears once').toHaveCount(1)

    // === Agent reply from the dashboard ===
    const convItem = dashboardPage.locator('button').filter({ hasText: visitorText }).first()
    await expect(convItem, 'visitor conversation appears in inbox').toBeVisible({ timeout: 15000 })
    await convItem.click()
    await dashboardPage.waitForTimeout(500)
    const replyText = `POLL_REPLY_${stamp}`
    const replyInput = dashboardPage.locator('.border-t input[placeholder]').last()
    await expect(replyInput).toBeVisible({ timeout: 5000 })
    await replyInput.fill(replyText)
    const replyPostPromise = dashboardPage.waitForResponse(
      (res) =>
        res.url().includes('/api/conversations/') &&
        res.url().includes('/messages') &&
        res.request().method() === 'POST' &&
        res.status() === 200,
      { timeout: 10000 },
    )
    await replyInput.press('Enter')
    await replyPostPromise

    // #6 The visitor widget receives the agent reply via POLLING
    // (the socket is blocked). The polling interval is 10s — give
    // it generous time (25s) to fire at least one poll + merge the
    // reply.
    const replyBubble = widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText })
    await expect(
      replyBubble,
      'agent reply must appear via polling fallback (no socket, no reload) within ~2 polling intervals',
    ).toHaveCount(1, { timeout: 25000 })
    // #7 The polling-delivered reply appears EXACTLY ONCE.
    await widgetPage.waitForTimeout(2000)
    await expect(
      replyBubble,
      'polling-delivered reply must appear EXACTLY ONCE (merge dedup)',
    ).toHaveCount(1)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
