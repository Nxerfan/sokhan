import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Inbox reply-echo dedup regression (Scenario C).
 *
 * Verifies that when an agent sends ONE reply from the dashboard, the
 * message renders EXACTLY ONCE in the inbox thread - even though the
 * agent's socket ALSO receives the same message back as a Socket.IO echo
 * on the conversation room they have joined.
 *
 * Before the fix: the inbox appended the POST response AND the Socket.IO
 * echo to the messages array via two separate setMessages(prev => [...prev, msg])
 * calls. The same message ID was inserted twice -> the bubble rendered
 * twice in the thread.
 *
 * After the fix: both the POST response and the Socket.IO echo are routed
 * through the central ID-based merge (`mergeSingle` -> `mergeMessages` in
 * src/lib/inbox-helpers.ts). The second ingest of the same message ID is
 * a no-op (the Map already has the ID; the incoming copy is dropped or
 * replaces the existing copy if strictly newer, but never produces a
 * duplicate entry). ONE render of the message.
 *
 * Setup (copied from tests/module2.spec.ts):
 *   - Caddy BASE = http://127.0.0.1:81 (Socket.IO needs Caddy).
 *   - otpSignupPlaywright for tenant signup.
 *   - Agent sign-in via /api/auth/callback/credentials.
 *   - Visitor side uses the widget REST API (contact + messages) so we
 *     do NOT need a separate widget browser context.
 *
 * Assertion: count <p> elements inside the thread view (div with classes
 * "flex flex-1 flex-col overflow-hidden") whose text equals the agent's
 * unique reply string. Must be exactly 1 (not 2).
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `echo-${stamp}@test.com`,
    workspace: `Echo ${stamp}`,
  }
}

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  // 3-step OTP signup (reliable, no hydration issues)
  await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  // Navigate to the dashboard via Caddy (for Socket.IO) - the session cookie
  // is already set on the page's context.
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  return slug
}

test.describe('Inbox reply-echo dedup (Scenario C)', () => {
  test('agent reply renders exactly once in the thread (POST response + Socket.IO echo dedup)', async ({ browser }) => {
    const { email, workspace } = creds('echo')

    // === Agent dashboard: signup + signin + navigate to inbox ===
    const dashboardCtx = await browser.newContext()
    const dashboardPage = await dashboardCtx.newPage()
    const slug = await signupAndGetSlug(dashboardPage, email, workspace)

    // Navigate to inbox and wait for the realtime-token fetch to confirm
    // the socket setup effect has at least started.
    const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
    await dashboardPage.waitForResponse(
      (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
      { timeout: 15000 },
    ).catch(() => {})
    // Give the socket a moment to finish connecting + joining the tenant
    // room so CONVERSATION_NEW events are received.
    await dashboardPage.waitForTimeout(2000)

    // === Visitor: POST contact + first message via widget REST API ===
    // Using REST (not a widget browser context) keeps the test focused
    // on the inbox dedup behavior and avoids widget-setup flakiness.
    const visitorId = `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const contactRes = await dashboardPage.request.post(`${BASE}/api/widget/${slug}/contact`, {
      data: { visitorId, name: 'EchoVisitor', email: '' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(contactRes.ok(), `contact POST should succeed (status=${contactRes.status()})`).toBe(true)
    const contactData = await contactRes.json()
    const realtimeToken = contactData.realtimeToken
    expect(realtimeToken, 'contact POST should return realtimeToken').toBeTruthy()

    const visitorMessage = `ECHO_VISITOR_${Date.now()}`
    const msgRes = await dashboardPage.request.post(`${BASE}/api/widget/${slug}/messages`, {
      data: { text: visitorMessage },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${realtimeToken}`,
      },
    })
    expect(msgRes.ok(), `messages POST should succeed (status=${msgRes.status()})`).toBe(true)
    const msgData = await msgRes.json()
    const conversationId = msgData.conversationId
    expect(conversationId, 'messages POST should return conversationId').toBeTruthy()

    // === Wait for the conversation to appear in the inbox ===
    // The dashboard's socket is in the tenant room; the server emits
    // CONVERSATION_NEW to the tenant room when a new conversation is
    // created -> the dashboard reloads the list.
    const conversationItem = dashboardPage
      .locator('button')
      .filter({ hasText: visitorMessage })
      .first()
    await expect(
      conversationItem,
      'visitor message should appear in inbox conversation list',
    ).toBeVisible({ timeout: 15000 })

    // Click the conversation to open the thread (also joins the
    // conversation room so the agent's socket receives its own reply
    // echo via Socket.IO - this is the path that the dedup must
    // collapse to a single render).
    await conversationItem.click()
    await dashboardPage.waitForTimeout(500)

    // The visitor's message should now be in the thread.
    await expect(dashboardPage.getByText(visitorMessage).first()).toBeVisible({ timeout: 10000 })

    // === Agent sends ONE reply via the dashboard UI (real keystrokes) ===
    const replyText = `ECHO_REPLY_${Date.now()}`
    // The reply input lives inside the thread view's reply box (the
    // `<div className="border-t border-border p-3">` container). Use
    // that scope to avoid matching the search input in the conversation
    // list header.
    const replyInput = dashboardPage.locator('.border-t input[placeholder]').last()
    await expect(replyInput).toBeVisible({ timeout: 5000 })
    await replyInput.fill(replyText)

    // Wait for the POST to complete - ensures the message is persisted
    // AND published to the conversation room (which the dashboard's
    // socket is in, so the echo will arrive).
    const replyPostPromise = dashboardPage.waitForResponse(
      (res) =>
        res.url().includes(`/api/conversations/${conversationId}/messages`) &&
        res.request().method() === 'POST' &&
        res.status() === 200,
      { timeout: 10000 },
    )
    await replyInput.press('Enter')
    await replyPostPromise

    // === ASSERTION: agent reply appears EXACTLY ONCE in the thread ===
    //
    // The thread view is the div with classes "flex flex-1 flex-col
    // overflow-hidden" (the conversation list has "flex w-72 shrink-0
    // flex-col border-e ..." - no flex-1, no overflow-hidden). Scope
    // the count to this view to exclude the conversation-list preview,
    // which after loadConversations() will also contain the reply text.
    //
    // Each MessageBubble renders its text inside a <p> tag:
    //   {msg.content.text && <p>{msg.content.text}</p>}
    // So counting <p> elements with the reply text inside the thread
    // view counts the message bubbles for that text.
    const threadView = dashboardPage
      .locator('div.flex.flex-1.flex-col.overflow-hidden')
      .first()
    const replyBubbles = threadView.locator('p').filter({ hasText: replyText })

    // Wait for the Socket.IO echo to arrive too (the dedup logic is
    // the thing under test - if we asserted immediately after the
    // POST response we'd only catch the POST append, missing the
    // duplicate echo that the dedup must collapse).
    await expect(
      replyBubbles,
      `agent reply should appear in thread (got count: ${await replyBubbles.count()})`,
    ).toHaveCount(1, { timeout: 10000 })

    // Explicit defensive assertion: NOT 2 (clear failure message if
    // dedup regresses and the echo produces a second render).
    const finalCount = await replyBubbles.count()
    expect(
      finalCount,
      `agent reply should render EXACTLY ONCE in the thread (got ${finalCount} - dedup regression: POST response + Socket.IO echo both rendered)`,
    ).toBe(1)

    await dashboardCtx.close()
  })
})
