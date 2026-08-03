import { test, expect, type Page } from '@playwright/test'

/**
 * Socket race condition test — verifies that an agent reply sent IMMEDIATELY
 * after the visitor's first message is received by the widget via Socket.IO,
 * not lost to the race between "conversation created" and "socket joins room".
 *
 * Before the fix: the widget only connected its socket AFTER the first message
 * was sent (since it needed a conversationId to join a room). If the agent
 * replied faster than socket.io-client could load+connect+join, the reply was
 * published before the widget was listening — and was only caught 10s later
 * by the polling fallback.
 *
 * After the fix: the socket is warmed up during identifyVisitor() (before any
 * conversation exists). When a conversation is created, the widget emits
 * conversation:join on the already-connected socket.
 *
 * This test uses ?nopoll=1 to disable the polling fallback, so if the reply
 * arrives at all, it MUST be via Socket.IO.
 */

const BASE = 'http://localhost:81'

function creds() {
  const stamp = `${process.pid}-${Date.now()}-race`
  return {
    email: `race-${stamp}@test.com`,
    workspace: `Race ${stamp}`,
  }
}

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.getByLabel(/نام شما|Your name/).fill('Agent Test')
  await page.getByLabel(/ایمیل|Email/).fill(email)
  await page.getByLabel(/رمز عبور|Password/).fill('password123')
  await page.getByLabel(/نام فضای کاری|Workspace name/).fill(workspace)
  await page.getByRole('button', { name: /ایجاد فضای کاری|Create workspace/ }).click()
  await page.waitForURL(BASE + '/', { timeout: 15000 })
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/tenants/me')
    return r.json()
  })
  return res.tenant.slug
}

test('Agent reply sent immediately after first message is received via Socket.IO (no race)', async ({ browser }) => {
  const { email, workspace } = creds()

  // Set up the agent dashboard
  const dashboardCtx = await browser.newContext()
  const dashboardPage = await dashboardCtx.newPage()
  const slug = await signupAndGetSlug(dashboardPage, email, workspace)

  // Navigate to inbox and wait for the socket to connect
  const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
  // Wait for the realtime token fetch + socket connection
  await dashboardPage.waitForResponse(
    (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
    { timeout: 15000 },
  ).catch(() => {})
  await dashboardPage.waitForTimeout(5000) // let the socket connect

  // Set up the widget with polling DISABLED (?nopoll=1)
  const widgetCtx = await browser.newContext()
  const widgetPage = await widgetCtx.newPage()
  await widgetPage.goto(`${BASE}/widget-test.html?slug=${slug}`)
  await widgetPage.waitForLoadState('networkidle')

  // The widget-test.html auto-embeds the script via ?slug= param.
  // We need to add ?nopoll=1 to the script URL. The easiest way is to
  // intercept the script request and add the param.
  // Actually, the widget-test.html embeds without nopoll. Let me inject
  // the script manually with nopoll=1 for this test.
  await widgetPage.evaluate(() => {
    // Remove any existing widget script
    const existing = document.querySelector('.sk-root')
    if (existing) existing.remove()
  })
  await widgetPage.addScriptTag({ url: `${BASE}/api/widget/${slug}/script?nopoll=1` })

  const launcher = widgetPage.locator('.sk-launcher')
  await expect(launcher).toBeVisible({ timeout: 10000 })
  await launcher.click()
  await widgetPage.waitForTimeout(500)

  // Wait for visitor identification (which now warms up the socket)
  await widgetPage.waitForResponse(
    (res) => res.url().includes('/contact') && res.status() === 200,
    { timeout: 10000 },
  ).catch(() => {})

  // Give the socket time to connect (warmed up during identification)
  await widgetPage.waitForTimeout(3000)

  // Send the first message from the widget
  const widgetInput = widgetPage.locator('.sk-input input')
  await expect(widgetInput).toBeVisible({ timeout: 3000 })
  const visitorMessage = `RACE_TEST_${Date.now()}`
  await widgetInput.fill(visitorMessage)

  // Send the message and IMMEDIATELY set up to reply from the dashboard
  // (no artificial delay — this is the race condition test)
  const messagePostPromise = widgetPage.waitForResponse(
    (res) => res.url().includes('/messages') && res.request().method() === 'POST' && res.status() === 200,
    { timeout: 10000 },
  )

  // Press Enter to send
  await widgetInput.press('Enter')

  // Wait for the message POST to complete
  const messageResponse = await messagePostPromise
  const messageData = await messageResponse.json()
  const conversationId = messageData.conversationId
  expect(conversationId).toBeTruthy()

  // === IMMEDIATELY reply from the dashboard (no delay) ===
  // The dashboard should show the new conversation (via Socket.IO or polling).
  // We'll poll the conversations API for up to 5s to find it, then reply.
  const replyText = `INSTANT_REPLY_${Date.now()}`
  const replyStartTime = Date.now()

  // Poll for the conversation to appear, then reply via API immediately
  let replied = false
  for (let attempt = 0; attempt < 10; attempt++) {
    const convData = await dashboardPage.evaluate(async () => {
      const r = await fetch('/api/conversations?status=open')
      return r.json()
    })
    const conv = (convData.conversations || []).find((c: any) => c.lastMessagePreview?.includes(visitorMessage))
    if (conv) {
      // Found it — reply IMMEDIATELY via API (simulates agent clicking send)
      await dashboardPage.evaluate(async ({ id, text }) => {
        await fetch(`/api/conversations/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
      }, { id: conversationId, text: replyText })
      replied = true
      break
    }
    await dashboardPage.waitForTimeout(200)
  }

  expect(replied, 'Dashboard should show the new conversation within 2s').toBe(true)

  // === ASSERTION: the reply appears in the widget via Socket.IO (not polling) ===
  // With polling disabled (nopoll=1), if the reply appears at all, it MUST be
  // via Socket.IO. Wait up to 5s (well within the 10s polling interval).
  try {
    await expect(
      widgetPage.locator('.sk-agt').filter({ hasText: replyText })
    ).toBeVisible({ timeout: 5000 })
    const latency = Date.now() - replyStartTime
    console.log(`\n=== Race condition test PASSED: agent reply received in ${latency}ms via Socket.IO ===`)
  } catch {
    const latency = Date.now() - replyStartTime
    console.log(`\n=== Race condition test FAILED: agent reply not received after ${latency}ms ===`)
    throw new Error(`Agent reply "${replyText}" did not appear in widget within 5s — socket race condition not fixed`)
  }

  await dashboardCtx.close()
  await widgetCtx.close()
})
