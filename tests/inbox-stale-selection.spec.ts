import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Inbox stale-selection regression (Scenario A).
 *
 * Verifies that a message delivered to conversation A does NOT appear
 * in conversation B's thread when the agent has switched A -> B. Also
 * verifies that A's unread badge is rendered (regression: the badge
 * must surface for unread conversations so the agent can see there are
 * unreads without selecting the conversation).
 *
 * Before the fix: the socket `message:new` handler captured
 * `selectedId` at effect-mount time (the effect deps were
 * `[sessionStatus]`, so the closure value was the mount-time value -
 * `null` initially). The handler's `if (msg.conversationId ===
 * selectedId)` check used this stale value, so:
 *   - The dashboard's socket was in conversation:A room (because the
 *     open-conversation effect had joined it).
 *   - The visitor sent a message to A -> the dashboard received
 *     `message:new` for A.
 *   - The handler's stale `selectedId` did NOT match A -> the message
 *     was not appended to the thread -> the agent didn't see the new
 *     message in real time (only after the 8s polling REPLACED the
 *     messages array with server data, losing any in-flight state).
 *
 * After the fix: the handler reads `selectedIdRef.current` (the LATEST
 * value via a ref synced by a small effect). A message for A is only
 * appended to the thread if A is the CURRENTLY selected conversation.
 * When B is selected, A's messages are applied to the conversation-list
 * state (preview + unread via the central ID-dedup helper) but NOT to
 * the messages array (so they don't bleed into B's thread).
 *
 * SETUP SIMPLIFICATION (per task spec): a full "stale selection" repro
 * requires the dashboard's socket to receive a message:new for a
 * NON-selected conversation, which the current hardened code does NOT
 * do (the dashboard leaves conversation:A's room when switching to B,
 * so it simply doesn't receive A's messages while on B). To exercise
 * the regression surface in a robust way, this test does the simplified
 * scenario:
 *   1. Create TWO visitor conversations A + B via the widget REST API
 *      (two distinct visitorIds + contact names so the list items are
 *      individually addressable).
 *   2. Agent selects A, then switches to B.
 *   3. Visitor A sends a NEW message to A via the widget REST API.
 *   4. Assert: B's thread (scoped via a CSS selector that excludes the
 *      conversation-list preview) does NOT contain A's new message
 *      text - a defensive regression check that would catch a future
 *      bug where A's messages leaked into B's thread (e.g. via a
 *      broken leaveConversation or a stale-closure handler).
 *   5. Assert: A's unread badge is visible (some unread count > 0 -
 *      from A's first message that the agent has not replied to).
 *
 * Setup (copied from tests/module2.spec.ts):
 *   - Caddy BASE = http://127.0.0.1:81 (Socket.IO needs Caddy).
 *   - otpSignupPlaywright for tenant signup.
 *   - Agent sign-in via /api/auth/callback/credentials.
 *   - Visitors use the widget REST API (contact + messages).
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `stale-${stamp}@test.com`,
    workspace: `Stale ${stamp}`,
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
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  return slug
}

/** Visitor: POST /contact -> returns { realtimeToken, contactId }. */
async function visitorIdentify(
  request: Page['request'],
  slug: string,
  visitorId: string,
  name: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/widget/${slug}/contact`, {
    data: { visitorId, name, email: '' },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `contact POST should succeed for ${name} (status=${res.status()})`).toBe(true)
  const data = await res.json()
  expect(data.realtimeToken, 'contact POST should return realtimeToken').toBeTruthy()
  return data.realtimeToken as string
}

/** Visitor: POST /messages -> returns { conversationId }. */
async function visitorSend(
  request: Page['request'],
  slug: string,
  realtimeToken: string,
  text: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/widget/${slug}/messages`, {
    data: { text },
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${realtimeToken}`,
    },
  })
  expect(res.ok(), `messages POST should succeed (status=${res.status()})`).toBe(true)
  const data = await res.json()
  expect(data.conversationId, 'messages POST should return conversationId').toBeTruthy()
  return data.conversationId as string
}

test.describe('Inbox stale selection (Scenario A)', () => {
  test('message to conversation A does NOT appear in B thread; A shows an unread badge', async ({ browser }) => {
    const { email, workspace } = creds('stale')

    // === Agent dashboard: signup + signin + navigate to inbox ===
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

    // === Two visitors: A and B (distinct visitorIds + contact names) ===
    const stampA = `${Date.now()}-A-${Math.random().toString(36).slice(2, 6)}`
    const stampB = `${Date.now()}-B-${Math.random().toString(36).slice(2, 6)}`
    const visitorA = `stale-A-${stampA}`
    const visitorB = `stale-B-${stampB}`
    const nameA = `VisitorA-${stampA}`
    const nameB = `VisitorB-${stampB}`

    const tokenA = await visitorIdentify(dashboardPage.request, slug, visitorA, nameA)
    const tokenB = await visitorIdentify(dashboardPage.request, slug, visitorB, nameB)

    // Visitor A creates conversation A with a first message.
    const firstMsgA = `FIRST_A_${stampA}`
    const convAId = await visitorSend(dashboardPage.request, slug, tokenA, firstMsgA)
    // Visitor B creates conversation B with a first message.
    const firstMsgB = `FIRST_B_${stampB}`
    const convBId = await visitorSend(dashboardPage.request, slug, tokenB, firstMsgB)
    expect(convAId, 'A and B conversation IDs must differ').not.toBe(convBId)

    // === Wait for BOTH conversations to appear in the inbox ===
    // The dashboard's socket joins the tenant room on connect; the
    // server emits CONVERSATION_NEW to the tenant room for each new
    // conversation -> the dashboard reloads the list.
    const convAItem = dashboardPage.locator('button').filter({ hasText: nameA }).first()
    const convBItem = dashboardPage.locator('button').filter({ hasText: nameB }).first()
    await expect(convAItem, 'conversation A should appear in inbox').toBeVisible({ timeout: 15000 })
    await expect(convBItem, 'conversation B should appear in inbox').toBeVisible({ timeout: 15000 })

    // === Select conversation A, then switch to B ===
    await convAItem.click()
    await dashboardPage.waitForTimeout(500)
    // A's thread should now be visible (visitor's first message).
    await expect(dashboardPage.getByText(firstMsgA).first()).toBeVisible({ timeout: 10000 })

    await convBItem.click()
    await dashboardPage.waitForTimeout(500)
    // B's thread should now be visible (visitor's first message).
    await expect(dashboardPage.getByText(firstMsgB).first()).toBeVisible({ timeout: 10000 })

    // === CRITICAL ASSERTION: firstMsgA is NO LONGER present in B's thread ===
    // Before the selected-thread-isolation fix, switching A->B left A's
    // messages in React `messages` state and the effect merged B's history
    // with them -> B's thread displayed firstMsgA (from A). The fix drops
    // A's messages on switch + a render-time filter guarantees no
    // cross-conversation message displays. Scope to the thread's message-list
    // container (div.space-y-3 inside the thread ScrollArea) to exclude the
    // conversation-list preview (which legitimately shows firstMsgA as A's
    // lastMessagePreview).
    const threadView = dashboardPage
      .locator('div.flex.flex-1.flex-col.overflow-hidden')
      .first()
    const firstMsgABubbles = threadView
      .locator('div.space-y-3')
      .locator('p')
      .filter({ hasText: firstMsgA })
    await dashboardPage.waitForTimeout(1000) // let any late render settle
    const firstMsgAInB = await firstMsgABubbles.count()
    expect(
      firstMsgAInB,
      `firstMsgA ("${firstMsgA}") must NO LONGER be present in B's thread after switching A->B (selected-thread isolation regression - found ${firstMsgAInB} occurrence(s))`,
    ).toBe(0)

    // === Visitor A sends a NEW message to A (B is currently selected) ===
    const newMsgA = `NEW_A_${stampA}`
    await visitorSend(dashboardPage.request, slug, tokenA, newMsgA)

    // === ASSERTION 1: B's thread does NOT contain A's new message text ===
    //
    // Scope to the thread view (div with classes "flex flex-1 flex-col
    // overflow-hidden") to exclude the conversation-list preview (which
    // after a list reload would contain newMsgA as the lastMessagePreview
    // for conversation A). The hardened code does NOT append A's
    // messages to the messages array when B is selected (the handler
    // reads selectedIdRef.current = B, so isSelected = false for A's
    // message), so the count must be 0.
    // (threadView already defined above; reuse it. newMsgA must not leak
    // into B's thread while B is selected.)
    const leakedBubbles = threadView
      .locator('div.space-y-3')
      .locator('p')
      .filter({ hasText: newMsgA })

    // Give the realtime delivery path a moment to land in case a future
    // regression re-introduces a stale-closure handler that incorrectly
    // appends A's message to the thread. If the bug regressed, the
    // count would be > 0 here.
    await dashboardPage.waitForTimeout(2500)
    const leakedCount = await leakedBubbles.count()
    expect(
      leakedCount,
      `B's thread must NOT contain A's message "${newMsgA}" (stale-selection regression - found ${leakedCount} occurrence(s) in the thread view)`,
    ).toBe(0)

    // === ASSERTION 2: A's unread badge is visible (some unread count > 0) ===
    //
    // A's first visitor message set A.unreadCount = 1 on the server
    // (server-side increment on POST). The agent has only SELECTED A
    // (no reply), so unreadCount was NOT reset to 0 server-side (only
    // an agent reply resets it - see src/app/api/conversations/[id]/
    // messages/route.ts line 70). So the unread badge for A should be
    // visible in the conversation list with text >= 1.
    //
    // The unread badge is rendered as:
    //   <span className="... bg-saffron ...">{conv.unreadCount}</span>
    // only when conv.unreadCount > 0.
    const unreadBadgeA = convAItem.locator('span.bg-saffron')
    await expect(
      unreadBadgeA,
      'A unread badge should be visible (unreadCount > 0 from the first visitor message)',
    ).toBeVisible({ timeout: 10000 })

    await dashboardCtx.close()
  })
})
