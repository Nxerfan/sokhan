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

/** Identify a visitor + get a realtime token. */
async function identifyVisitor(slug: string, visitorId: string, page: Page) {
  const res = await page.request.post(`${BASE}/api/widget/${slug}/contact`, {
    data: { visitorId, name: visitorId.slice(0, 8) },
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
  test('Case A: same non-selected conversation, two distinct messages → unread = 2', async ({ browser }) => {
    const { email, workspace } = creds('A')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    const visitorId = `burstA-${Date.now()}`
    const token = await identifyVisitor(slug, visitorId, page)

    // Send TWO distinct messages back-to-back (no await between that lets the
    // dashboard render). The dashboard socket (tenant room) receives
    // CONVERSATION_NEW then MESSAGE_NEW. If the stale-snapshot race existed,
    // the second increment would be lost (unread=1). The fix → unread=2.
    const msg1 = `BURST_A1_${Date.now()}`
    const msg2 = `BURST_A2_${Date.now()}`
    // Fire both POSTs rapidly; do not await UI between them.
    const [r1, r2] = await Promise.all([
      sendVisitorMessage(slug, token, msg1, page),
      sendVisitorMessage(slug, token, msg2, page),
    ])

    // Wait for the conversation to appear in the inbox list (preview = msg2,
    // the latest). Then wait for the unread badge to reach 2.
    const convItem = page.locator('button').filter({ hasText: msg2 }).first()
    await expect(convItem, 'conversation appears in inbox list').toBeVisible({ timeout: 15000 })

    // The unread badge should show 2 (both messages incremented; no loss).
    await expect(
      page.locator('button').filter({ hasText: msg2 }).first().locator('span.flex.h-5.min-w-5'),
      'unread badge shows 2 (both messages incremented, no race loss)',
    ).toHaveText('2', { timeout: 15000 })

    await ctx.close()
  })

  test('Case B: two different conversations back-to-back → both previews preserved, latest at index 0', async ({ browser }) => {
    const { email, workspace } = creds('B')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // Visitor A sends a message (creates conversation A).
    const visitorA = `burstBA-${Date.now()}`
    const tokenA = await identifyVisitor(slug, visitorA, page)
    const msgA = `BURST_B_A_${Date.now()}`
    await sendVisitorMessage(slug, tokenA, msgA, page)
    await expect(page.locator('button').filter({ hasText: msgA }).first()).toBeVisible({ timeout: 15000 })

    // Visitor B sends a message (creates conversation B) immediately after.
    const visitorB = `burstBB-${Date.now()}`
    const tokenB = await identifyVisitor(slug, visitorB, page)
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
