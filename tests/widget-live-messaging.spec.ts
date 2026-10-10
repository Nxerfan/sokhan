import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget two-way live messaging browser regression — REAL EXTERNAL ORIGIN.
 *
 * Exercises the REAL generated widget script (`/api/widget/<slug>/script`)
 * loaded on a GENUINELY DIFFERENT customer origin (a real HTTP server on
 * port 8085, distinct from the Sukhan origin on port 81). This proves
 * the production embed case where a customer website has a different
 * origin and loads:
 *   <script src="http://<sukhan-origin>/api/widget/<slug>/script"></script>
 *
 * Coverage (healthy realtime scenario — true external origin):
 *   1.  Generated widget script loads from Sukhan origin.
 *   2.  Config/contact/messages REST calls go to Sukhan origin.
 *   3.  Visitor optimistic message appears immediately.
 *   4.  Persisted visitor message reconciles to exactly one bubble.
 *   5.  Socket.IO connection goes to Sukhan origin.
 *   6.  Agent reply sent from the real Inbox UI appears in the
 *       customer-origin widget without reload.
 *   7.  Agent reply appears exactly once.
 *   8.  Reload/history restore still shows both messages.
 *
 * Polling fallback scenario (may remain same-origin for deterministic
 * socket blocking):
 *   9.  Block Socket.IO → agent reply appears via polling without reload.
 *   10. Polling-delivered reply appears exactly once.
 *
 * The customer-origin HTTP server is a REAL server (not page.route())
 * to avoid Chromium's "Private Network Access" CORS block on
 * cross-origin requests from a route-fulfilled page.
 *
 * This test runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000'  // Next.js direct — signup API
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'
const CUSTOMER_PORT = 8085
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

test.describe('Widget two-way live messaging — real external origin', () => {
  test('Healthy realtime: visitor optimistic send + agent reply via Socket.IO — both appear exactly once without reload', async ({ browser }) => {
    const { email, workspace } = creds('healthy')
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

    // === Visitor widget page — GENUINELY DIFFERENT origin (port 8085) ===
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()

    // Track all widget-related requests to PROVE they go to the Sukhan origin.
    const widgetRequests: string[] = []
    widgetPage.on('request', (req) => {
      const url = req.url()
      if (
        url.includes('/api/widget/') ||
        url.includes('/socket.io') ||
        url.includes('XTransformPort') ||
        url.includes('/socket.io.min.js') ||
        url.includes('engine.io')
      ) {
        widgetRequests.push(url)
      }
    })
    widgetPage.on('websocket', (ws) => {
      widgetRequests.push(`[ws] ${ws.url()}`)
    })

    // #1 Load the customer page (different origin from Sukhan).
    await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await widgetPage.waitForLoadState('domcontentloaded')

    // #1 Load the REAL generated widget script from the Sukhan origin.
    await widgetPage.addScriptTag({ url: WIDGET_SCRIPT_URL(slug) })
    await widgetPage.waitForTimeout(3000)

    // Open the widget.
    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher, 'widget launcher should appear on customer page').toBeVisible({ timeout: 10000 })
    await launcher.click()
    // Give the socket time to connect (cross-origin WebSocket upgrade
    // may take a few seconds in the CI Docker environment).
    await widgetPage.waitForTimeout(3000)

    // #2 Config + contact REST calls went to the Sukhan origin.
    const configReq = widgetRequests.find((u) => u.includes(`/api/widget/${slug}/config`))
    expect(configReq, 'config fetch must go to Sukhan origin').toBeTruthy()
    expect(configReq!.replace(/^[a-z]+:\/\//, '').startsWith('127.0.0.1:81'), 'config must be on port 81').toBe(true)

    // #3 Visitor optimistic message appears immediately.
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

    // #4 Persisted visitor message reconciles to exactly one bubble.
    // Wait for the .sk-pending class to clear — proves the POST
    // reconciled the optimistic entry.
    await expect(
      widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
      'pending class must be cleared after POST reconciliation',
    ).toHaveCount(0, { timeout: 15000 })
    await expect(
      visitorBubble,
      'visitor message must appear EXACTLY ONCE after POST reconciliation',
    ).toHaveCount(1)

    // #2 (cont.) Messages REST call also went to the Sukhan origin.
    const messagesReq = widgetRequests.find((u) => u.includes(`/api/widget/${slug}/messages`))
    expect(messagesReq, 'messages fetch must go to Sukhan origin').toBeTruthy()
    expect(messagesReq!.replace(/^[a-z]+:\/\//, '').startsWith('127.0.0.1:81'), 'messages must be on port 81').toBe(true)

    // #5 Socket.IO connection goes to the Sukhan origin.
    const socketHandshake = widgetRequests.find(
      (u) => u.includes('XTransformPort=3003') || u.includes('/socket.io/') || u.includes('engine.io'),
    )
    expect(socketHandshake, 'Socket.IO handshake must fire').toBeTruthy()
    expect(
      socketHandshake!.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '').startsWith('127.0.0.1:81'),
      'Socket.IO must go to Sukhan origin (port 81)',
    ).toBe(true)

    // #6 Agent reply from the real Inbox dashboard UI.
    const convItem = dashboardPage.locator('button').filter({ hasText: visitorText }).first()
    await expect(convItem, 'visitor conversation appears in inbox').toBeVisible({ timeout: 15000 })
    await convItem.click()
    await dashboardPage.waitForTimeout(500)
    await expect(dashboardPage.getByText(visitorText).first()).toBeVisible({ timeout: 10000 })

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

    // #6 + #7 Agent reply appears in the customer-origin widget via
    // Socket.IO — without reload. Exactly once.
    const replyBubble = widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText })
    await expect(
      replyBubble,
      'agent reply must appear in customer-origin widget via Socket.IO (no reload)',
    ).toHaveCount(1, { timeout: 20000 })
    await widgetPage.waitForTimeout(2000)
    await expect(
      replyBubble,
      'agent reply must appear EXACTLY ONCE (no duplicate from Socket.IO echo)',
    ).toHaveCount(1)

    // #8 Reload/history restore still shows both messages.
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
    // Uses the Sukhan origin /widget-test.html for the polling
    // scenario (deterministic socket blocking is easier same-origin).
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.route('**/socket.io.min.js', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await widgetPage.route('**/socket.io/**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await widgetPage.route('**/?XTransformPort=3003**', (route) => {
      route.fulfill({ status: 502, body: 'blocked by test' })
    })
    await widgetPage.goto(`${BASE}/widget-test.html`)
    await widgetPage.waitForLoadState('networkidle')
    await widgetPage.addScriptTag({ url: `${BASE}/api/widget/${slug}/script` })
    await widgetPage.waitForTimeout(3000)
    const launcher = widgetPage.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 10000 })
    await launcher.click()
    await widgetPage.waitForTimeout(2000)

    // Send a visitor message.
    const visitorText = `POLL_VISITOR_${stamp}`
    const widgetInput = widgetPage.locator('.sk-panel input').first()
    await expect(widgetInput).toBeVisible({ timeout: 5000 })
    await widgetInput.fill(visitorText)
    await widgetInput.press('Enter')
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

    // #9 Agent reply appears via polling fallback.
    const replyBubble = widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText })
    await expect(
      replyBubble,
      'agent reply must appear via polling fallback (no socket, no reload) within ~2 polling intervals',
    ).toHaveCount(1, { timeout: 25000 })
    // #10 Polling-delivered reply appears exactly once.
    await widgetPage.waitForTimeout(2000)
    await expect(
      replyBubble,
      'polling-delivered reply must appear EXACTLY ONCE (merge dedup)',
    ).toHaveCount(1)

    await widgetCtx.close()
    await dashboardCtx.close()
  })
})
