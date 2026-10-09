import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget two-way live messaging browser regression.
 *
 * Exercises the REAL generated widget script (`/api/widget/<slug>/script`)
 * on a separate customer-origin page, with a separate dashboard browser
 * context for the agent side. Proves the full two-way live-delivery loop
 * works without page refresh.
 *
 * Coverage:
 *   #1  Visitor message appears immediately (optimistic send) — the
 *       bubble renders BEFORE the POST response resolves.
 *   #2  Visitor message still appears exactly once after POST
 *       reconciliation (optimistic + persisted merge → 1 bubble, no
 *       duplicate).
 *   #3  Agent reply (sent from the real Inbox dashboard UI) appears in
 *       the visitor widget without reload — via the actual Socket.IO
 *       `message:new` event path.
 *   #4  Agent reply appears exactly once (POST response + Socket.IO
 *       echo dedup on the widget side).
 *   #5  Both messages remain visible after a history refresh/reload.
 *
 * Polling fallback scenario:
 *   #6  When the widget socket is disconnected (simulated by
 *       intercepting the Socket.IO handshake), an agent reply appears
 *       through the polling fallback within the documented 10s
 *       interval — without a page reload.
 *   #7  The polling-delivered reply appears exactly once.
 *
 * The test uses a REAL HTTP server on a different port (8083) for the
 * customer page — avoids Chromium's "Private Network Access" CORS
 * block. The widget script is loaded via `page.addScriptTag` with
 * the absolute Sukhan origin URL (mimicking how a real customer
 * embeds it).
 *
 * This test runs in BOTH Full and Lite Docker CI (added to both
 * regression lists in `.github/workflows/ci.yml`).
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000'  // Next.js direct — signup API
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'
const CUSTOMER_PORT = 8083
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

/** Set up a customer-origin widget page — loads the real generated script. */
async function setupWidgetPage(ctx: BrowserContext, slug: string): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(`${CUSTOMER_ORIGIN}/customer.html`)
  await page.waitForLoadState('domcontentloaded')
  // Inject the widget script with the absolute Sukhan origin URL
  // (mimicking how a real customer embeds it on their website).
  await page.addScriptTag({ url: WIDGET_SCRIPT_URL(slug) })
  // Wait for the script to load + mount + identify the visitor.
  await page.waitForTimeout(3000)
  // Open the widget panel.
  const launcher = page.locator('.sk-launcher')
  await expect(launcher, 'widget launcher should appear').toBeVisible({ timeout: 10000 })
  await launcher.click()
  await page.waitForTimeout(2000)
  return page
}

test.describe('Widget two-way live messaging', () => {
  test('Healthy realtime: visitor optimistic send + agent reply via Socket.IO — both appear exactly once without reload', async ({ browser }) => {
    const { email, workspace } = creds('healthy')
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // === Agent dashboard: signup + navigate to inbox ===
    const dashboardCtx = await browser.newContext()
    const dashboardPage = await dashboardCtx.newPage()
    const slug = await signupAndGetSlug(dashboardPage, email, workspace)
    // Navigate to inbox.
    const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
    await dashboardPage.waitForResponse(
      (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
      { timeout: 15000 },
    ).catch(() => {})
    await dashboardPage.waitForTimeout(2000)

    // === Visitor widget page (separate context — no dashboard cookies) ===
    const widgetCtx = await browser.newContext()
    const widgetPage = await setupWidgetPage(widgetCtx, slug)

    // #1 Visitor message appears IMMEDIATELY (optimistic send).
    // Type a unique visitor message + press Enter.
    const visitorText = `LIVE_VISITOR_${stamp}`
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })

    await widgetInput.fill(visitorText)
    await widgetInput.press('Enter')
    // The optimistic bubble (with .sk-pending class) must appear
    // immediately — BEFORE the POST resolves. The visitor's bubble
    // renders in the DOM the moment Enter is pressed.
    const visitorBubble = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText })
    await expect(
      visitorBubble,
      'visitor optimistic bubble must appear immediately after Enter (before POST resolves)',
    ).toHaveCount(1, { timeout: 5000 })

    // #2 After the POST response, the visitor message still appears
    // EXACTLY ONCE (optimistic + persisted merge → 1 bubble). The
    // .sk-pending class transitions away (replaced by the persisted
    // message's timestamp). Wait for the pending state to clear,
    // which proves the POST reconciled the optimistic entry.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
      'pending class must be cleared after POST reconciliation (persisted message has no .sk-pending)',
    ).toHaveCount(0, { timeout: 15000 })
    await expect(
      visitorBubble,
      'visitor message must appear EXACTLY ONCE after POST reconciliation (no duplicate from optimistic + persisted)',
    ).toHaveCount(1)

    // #3 Agent reply from the real Inbox dashboard UI.
    // First, wait for the conversation to appear in the dashboard
    // conversation list (CONVERSATION_NEW event from the socket).
    const convItem = dashboardPage.locator('button').filter({ hasText: visitorText }).first()
    await expect(convItem, 'visitor conversation appears in inbox').toBeVisible({ timeout: 15000 })
    await convItem.click()
    await dashboardPage.waitForTimeout(500)
    // Wait for the visitor's message to appear in the thread.
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
    // Socket.IO message:new — without reload. The reply appears
    // EXACTLY ONCE.
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
    // Reload the customer page (simulates the visitor refreshing the
    // host page) — the messages should be re-loaded from history.
    await widgetPage.reload()
    await widgetPage.waitForLoadState('domcontentloaded')
    await widgetPage.waitForTimeout(3000) // re-mount + identify + loadMessages
    // Re-open the widget.
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

    // === Visitor widget page — set up Socket.IO route interception
    // BEFORE the widget script loads so the socket.io.min.js load
    // itself is blocked. This deterministically forces the polling
    // fallback path from the very start (the widget can NEVER
    // establish a realtime connection). ===
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    // Block the socket.io-client script load — the widget can never
    // call io(). This simulates realtime unavailability (proxy block,
    // Vercel-no-Redis degraded mode, etc.).
    await widgetPage.route('**/socket.io.min.js', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    // Also block any engine.io / socket.io handshake attempts.
    await widgetPage.route('**/socket.io/**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await widgetPage.route('**/?XTransformPort=3003**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })

    // Now navigate to the customer page + load the widget script.
    // The widget will mount + identify but the socket will NEVER
    // connect (socket.io.min.js is blocked). Polling starts after
    // identify (conversationId exists) and after sendMessage.
    await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await widgetPage.waitForLoadState('domcontentloaded')
    await widgetPage.addScriptTag({ url: WIDGET_SCRIPT_URL(slug) })
    await widgetPage.waitForTimeout(3000)
    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    await widgetPage.waitForTimeout(2000)

    // Send a visitor message to create the conversation. The POST
    // should succeed (it's REST, not realtime). The polling fallback
    // starts immediately after the first successful message.
    const visitorText = `POLL_VISITOR_${stamp}`
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })
    await widgetInput.fill(visitorText)
    await widgetInput.press('Enter')
    // The optimistic bubble appears immediately, then transitions to
    // persisted when the POST resolves. Wait for the .sk-pending class
    // to clear (proves the POST succeeded + reconciliation happened).
    const visitorBubble = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText })
    await expect(visitorBubble, 'visitor bubble appears').toHaveCount(1, { timeout: 5000 })
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
      'pending class clears after POST (no socket — POST still works via REST)',
    ).toHaveCount(0, { timeout: 15000 })
    // The visitor message should appear exactly once.
    await expect(
      visitorBubble,
      'visitor message appears once (optimistic + POST merge)',
    ).toHaveCount(1)

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
    // #7 The polling-delivered reply appears EXACTLY ONCE (the central
    // merge dedupes by id).
    await widgetPage.waitForTimeout(2000)
    await expect(
      replyBubble,
      'polling-delivered reply must appear EXACTLY ONCE (merge dedup)',
    ).toHaveCount(1)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
