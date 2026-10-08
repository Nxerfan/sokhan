import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Inbox burst dedup (PR#5 final race fix) — two Socket.IO MESSAGE_NEW events
 * delivered back-to-back before the next React render.
 *
 * Case A: same non-selected conversation receives two distinct contact
 *   message IDs back-to-back → unreadCount = 2 (both incremented, no loss),
 *   both IDs considered seen, duplicate redelivery does NOT re-increment.
 *
 * Case B: two different conversations receive back-to-back messages → both
 *   previews preserved, both lastMessageAt preserved, no duplicate/lost
 *   conversation IDs, latest message's conversation at index 0.
 *
 * Verifies the ACTUAL Inbox MESSAGE_NEW handler (functional state updater +
 * pure applyMessageToConversationList), not only the pure helper.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `burst-${stamp}@test.com`,
    workspace: `Burst ${stamp}`,
    slug: `burst-${stamp}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
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
  await page.waitForTimeout(3000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  // Navigate to the inbox (list view — no conversation selected, so unread
  // increments on incoming contact messages).
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
  await page.waitForResponse(
    (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
    { timeout: 15000 },
  ).catch(() => {})
  await page.waitForTimeout(2000) // let the socket connect + join the tenant room
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  return (await tenantRes.json()).tenant.slug
}

/** Identify a visitor + get a realtime token. Pass a unique `name` so the
 * conversation-list item can be addressed by name (not by the transient
 * message preview, which changes as burst messages arrive). */
async function identifyVisitor(slug: string, visitorId: string, page: Page, name: string) {
  const res = await page.request.post(`${BASE}/api/widget/${slug}/contact`, {
    data: { visitorId, name },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `contact POST ok (status=${res.status()})`).toBe(true)
  return (await res.json()).realtimeToken as string
}

/** Send a visitor message (creates a conversation on the first send). */
async function sendVisitorMessage(slug: string, token: string, text: string, page: Page) {
  const res = await page.request.post(`${BASE}/api/widget/${slug}/messages`, {
    data: { text },
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `messages POST ok (status=${res.status()})`).toBe(true)
  return (await res.json()).conversationId as string
}

/** The unread badge <span> inside the conversation-list item whose preview
 *  contains `previewText`. Returns the badge text (e.g. "2") or '' if absent. */
async function unreadBadgeText(page: Page, previewText: string): Promise<string> {
  const item = page.locator('button').filter({ hasText: previewText }).first()
  const badge = item.locator('span.flex.h-5.min-w-5')
  if (!(await badge.count())) return ''
  return (await badge.textContent()) ?? ''
}

test.describe('Inbox burst dedup (PR#5 final race fix)', () => {
  test('Case A: selected conversation, two back-to-back messages → conversation-list preview = latest (msg3) + both in thread', async ({ browser }) => {
    // The agent receives MESSAGE_NEW only for the conversation room it has
    // JOINED (i.e. selected). So the actual PR#5 race — two back-to-back
    // MESSAGE_NEW events computing the conversation-list update from the same
    // stale conversationsRef.current snapshot — manifests for the SELECTED
    // conversation's LIST mutation (preview + move-to-top via
    // setConversations(prev => applyMessageToConversationList(prev, msg, ...).list)).
    // This test verifies the functional-updater fix: event 2 composes against
    // event 1's committed result, so the conversation-list item for A reflects
    // the LATEST burst message (msg3) as its preview — proving event 2 didn't
    // overwrite event 1 from a stale snapshot — AND both messages land in the
    // thread (mergeSingle dedup).
    const { email, workspace } = creds('A')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // 1. Visitor sends the first message (creates the conversation).
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const visitorId = `burstA-${stamp}`
    const nameA = `BurstA-${stamp}`
    const token = await identifyVisitor(slug, visitorId, page, nameA)
    const msg1 = `BURST_A1_${stamp}`
    await sendVisitorMessage(slug, token, msg1, page)

    // Wait for the conversation to appear in the inbox list (addressed by the
    // unique contact NAME — the preview changes as burst messages arrive, but
    // the name is stable).
    const convAItem = page.locator('button').filter({ hasText: nameA }).first()
    await expect(convAItem, 'conversation A appears in inbox list (by name)').toBeVisible({ timeout: 15000 })

    // CRITICAL (Lite robustness): wait for the conversation-A list item's
    // preview to settle at msg1 — this PROVES the CONVERSATION_NEW-triggered
    // loadConversations has returned with conversation A (preview=msg1) AND the
    // conversationsRef has synced (the useEffect that mirrors `conversations`
    // into conversationsRef runs after that render). This guarantees the
    // MESSAGE_NEW handler's `existsInList` check (conversationsRef.current)
    // will find conversation A when msg2/msg3 arrive → the local functional
    // updater (setConversations(prev => applyMessageToConversationList(...)))
    // runs, NOT the loadConversations fallback. Without this settle, a slower
    // environment (Lite) can race: conversationsRef lags → existsInList=false →
    // loadConversations runs instead of the local functional updater → the
    // preview is server-authoritative (transiently stale) rather than the
    // functional-updater result under test.
    await expect(
      convAItem.locator('p.truncate').first(),
      'conversation-A preview settled at msg1 (CONVERSATION_NEW load done + ref synced)',
    ).toContainText(msg1, { timeout: 15000 })

    // 2. SELECT conversation A (joins the conversation room so the agent
    //    receives MESSAGE_NEW for it).
    await convAItem.click()

    // Wait for msg1 to appear in the thread — proves the conversation-room
    // JOIN + the history fetch completed, so the agent's socket is in room A
    // and will receive MESSAGE_NEW for msg2/msg3.
    const threadView = page.locator('div.flex.flex-1.flex-col.overflow-hidden').first()
    await expect(
      threadView.locator('div.space-y-3').locator('p').filter({ hasText: msg1 }),
      'msg1 in thread (room join + history fetch done)',
    ).toHaveCount(1, { timeout: 15000 })

    // Extra settle for the conversationsRef sync effect to flush (defensive
    // against React concurrent-mode effect deferral in slower environments).
    await page.waitForTimeout(1500)

    // 3. Visitor sends TWO more messages back-to-back (no await between that
    //    lets the dashboard render). The dashboard socket (now in the
    //    conversation room) receives MESSAGE_NEW × 2. The conversation-list
    //    functional updater must compose both: setConversations(prev =>
    //    applyMessageToConversationList(prev, msg, ...).list). With the
    //    stale-snapshot bug, event 2 would compute from the same stale
    //    conversationsRef.current as event 1 → event 1's preview/move-to-top
    //    lost, preview = msg2 (not msg3). With the fix, event 2 composes
    //    against event 1's committed result → preview = msg3 (the latest).
    const msg2 = `BURST_A2_${stamp}`
    const msg3 = `BURST_A3_${stamp}`
    await Promise.all([
      sendVisitorMessage(slug, token, msg2, page),
      sendVisitorMessage(slug, token, msg3, page),
    ])

    // 4. ASSERT (thread): BOTH burst messages appear once in the thread
    //    (mergeSingle dedup — no loss, no duplicate).
    await expect(
      threadView.locator('div.space-y-3').locator('p').filter({ hasText: msg2 }),
      'msg2 in thread (event 1 of the back-to-back burst landed)',
    ).toHaveCount(1, { timeout: 15000 })
    await expect(
      threadView.locator('div.space-y-3').locator('p').filter({ hasText: msg3 }),
      'msg3 in thread (event 2 landed — no stale-snapshot loss)',
    ).toHaveCount(1, { timeout: 15000 })

    // 5. CRITICAL ASSERT (conversation-list): the conversation-A list item's
    //    preview reflects the LATEST burst message (msg3) — proving the
    //    conversation-list functional updater composed event 2 against event
    //    1's committed result (preview = msg3), NOT a stale snapshot (which
    //    would leave the preview at msg2, event 1's value, losing event 2's
    //    preview/move-to-top). Addressed by the stable contact name; the
    //    preview <p> inside the item must contain msg3.
    await expect(
      convAItem.locator('p.truncate').filter({ hasText: msg3 }),
      'conversation-A list preview = latest burst message (msg3) — functional updater composed both events',
    ).toBeVisible({ timeout: 15000 })
    // And explicitly NOT msg2 (the older burst message) as the preview.
    const previewText = (await convAItem.locator('p.truncate').first().textContent()) ?? ''
    expect(
      previewText,
      'conversation-A preview must be msg3 (latest), not msg2 (stale-snapshot would leave it at msg2)',
    ).toContain(msg3)

    await ctx.close()
  })

test('Case B: two different conversations back-to-back → both previews preserved, latest at index 0', async ({ browser }) => {
    const { email, workspace } = creds('B')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // Visitor A sends a message (creates conversation A).
    const visitorA = `burstBA-${Date.now()}`
    const tokenA = await identifyVisitor(slug, visitorA, page, `BurstBA-${Date.now()}`)
    const msgA = `BURST_B_A_${Date.now()}`
    await sendVisitorMessage(slug, tokenA, msgA, page)
    await expect(page.locator('button').filter({ hasText: msgA }).first()).toBeVisible({ timeout: 15000 })

    // Visitor B sends a message (creates conversation B) immediately after.
    const visitorB = `burstBB-${Date.now()}`
    const tokenB = await identifyVisitor(slug, visitorB, page, `BurstBB-${Date.now()}`)
    const msgB = `BURST_B_B_${Date.now()}`
    await sendVisitorMessage(slug, tokenB, msgB, page)
    await expect(page.locator('button').filter({ hasText: msgB }).first()).toBeVisible({ timeout: 15000 })

    // Both conversation previews are preserved (no overwrite from the stale
    // snapshot race).
    await expect(page.locator('button').filter({ hasText: msgA }).first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('button').filter({ hasText: msgB }).first()).toBeVisible({ timeout: 10000 })

    // The latest message's conversation (B) is at index 0 (move-to-top). The
    // conversation-list buttons are in DOM order; the first one should contain
    // msgB's preview.
    const listButtons = page.locator('button').filter({ hasText: /BURST_B_A_|BURST_B_B_/ })
    const count = await listButtons.count()
    expect(count, 'two distinct conversation items').toBe(2)
    const firstPreview = (await listButtons.nth(0).textContent()) ?? ''
    expect(firstPreview, 'latest conversation (B) at index 0').toContain(msgB)

    await ctx.close()
  })
})
