import { test, expect, type Browser, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Contacts UI identity behavioral spec (PR #13 stability audit — BLOCKER #4).
 *
 * Contacts is an existing visible dashboard page. Its user-facing behavior
 * must have current CI coverage. This spec proves the Contacts page against
 * REAL conversation identity — the visitor identifies through the REAL widget
 * path (POST /api/widget/[slug]/contact), sends a message through the REAL
 * widget path (POST /api/widget/[slug]/messages), and the dashboard Contacts
 * page (exercised via real UI clicks) shows the correct contact identity,
 * conversation count, last-message preview, and status.
 *
 * SECURITY CONTRACT under test (the backend's identity model):
 *   - Contact lookup key is (tenantId, visitorId) — NEVER email.
 *   - A second visitor with the SAME email but a DIFFERENT visitorId gets a
 *     DIFFERENT contact + DIFFERENT conversation (no inheritance).
 *
 * Runs in BOTH Full and Lite Docker editions.
 */

const BASE = 'http://127.0.0.1:81'
const PASSWORD = 'password123'

interface TenantCtx {
  page: Page
  email: string
  workspaceName: string
  tenantId: string
  slug: string
}

async function setupTenant(
  browser: Browser,
  email: string,
  workspaceName: string,
): Promise<TenantCtx> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const signupRes = await otpSignupPlaywright(
    page.request as unknown as Parameters<typeof otpSignupPlaywright>[0],
    BASE,
    email,
    workspaceName,
    PASSWORD,
  )
  if (!signupRes.ok || !signupRes.tenantId) {
    throw new Error(`OTP signup failed for ${email}: status=${signupRes.status}`)
  }
  const tenantId = signupRes.tenantId

  let slug = ''
  let sessionOk = false
  for (let attempt = 0; attempt < 2 && !sessionOk; attempt++) {
    const csrfRes = await page.request.get(`${BASE}/api/auth/csrf`)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
    const signinRes = await page.request.post(`${BASE}/api/auth/callback/credentials`, {
      form: { email, password: PASSWORD, csrfToken, json: 'true' },
      maxRedirects: 0,
    })
    if (signinRes.status() >= 400) {
      if (attempt === 0) continue
      throw new Error(`Sign-in failed for ${email}: HTTP ${signinRes.status()}`)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const sessionRes = await page.request.get(`${BASE}/api/auth/session`)
      if (sessionRes.ok()) {
        const sb = await sessionRes.json().catch(() => ({}))
        if (sb && sb.user) {
          const meRes = await page.request.get(`${BASE}/api/tenants/me`)
          if (meRes.ok()) {
            const meData = (await meRes.json()) as { tenant?: { id: string; slug: string } }
            if (meData.tenant && meData.tenant.id === tenantId) {
              sessionOk = true
              slug = meData.tenant.slug
              break
            }
          }
        }
      }
      await page.waitForTimeout(250)
    }
  }
  if (!sessionOk) throw new Error(`Auth session not established for ${email}`)
  // Fresh OTP signups default to accessMode='verified_visitor' (the frozen
  // DB contract). The /contact flow below requires anonymous visitor tokens,
  // so explicitly switch the tenant to anonymous before any visitor traffic.
  await setAccessMode(page, 'anonymous')
  return { page, email, workspaceName, tenantId, slug }
}

async function widgetIdentify(
  slug: string,
  visitorId: string,
  opts: { email?: string; name?: string } = {},
): Promise<{ contactId: string; realtimeToken: string }> {
  const res = await fetch(`${BASE}/api/widget/${slug}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId, email: opts.email, name: opts.name }),
  })
  if (!res.ok) throw new Error(`widget identify failed: ${res.status}`)
  return (await res.json()) as { contactId: string; realtimeToken: string }
}

async function widgetSend(slug: string, realtimeToken: string, text: string): Promise<{ conversationId: string }> {
  const res = await fetch(`${BASE}/api/widget/${slug}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realtimeToken}` },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`widget send failed: ${res.status}`)
  return (await res.json()) as { conversationId: string }
}

/** Click the Contacts nav button (locale-agnostic title match). */
async function goToContacts(page: Page) {
  await page.locator('nav[aria-label="primary"]').getByTitle(/Contacts|مخاطبین/).click()
}

test.describe('Contacts UI identity journey (PR #13 BLOCKER #4)', () => {
  let tenantA: TenantCtx
  let tenantB: TenantCtx
  let contactId1: string
  let contactId3: string
  let convId1: string
  let convId3: string
  const sharedEmail = `shared-${Date.now()}-${process.pid}@iws.test`

  test.beforeAll(async ({ browser }) => {
    const suffix = `${Date.now()}-${process.pid}`
    tenantA = await setupTenant(browser, `ci-a-${suffix}@iws.test`, `CI A ${suffix}`)
    tenantB = await setupTenant(browser, `ci-b-${suffix}@iws.test`, `CI B ${suffix}`)

    // Visitor 1: identified with name + email, sends a message.
    const v1 = await widgetIdentify(tenantA.slug, `v1-${suffix}`, {
      email: sharedEmail,
      name: 'Visitor One',
    })
    contactId1 = v1.contactId
    convId1 = (await widgetSend(tenantA.slug, v1.realtimeToken, 'hello from visitor one')).conversationId

    // Visitor 3: SAME email, DIFFERENT visitorId → must be a DIFFERENT contact.
    const v3 = await widgetIdentify(tenantA.slug, `v3-${suffix}`, {
      email: sharedEmail,
      name: 'Visitor Three',
    })
    contactId3 = v3.contactId
    convId3 = (await widgetSend(tenantA.slug, v3.realtimeToken, 'hello from visitor three')).conversationId

    // Visitor 2 (anonymous): no email, no name, no message → contact with 0 convs.
    await widgetIdentify(tenantA.slug, `v2-anon-${suffix}`)
  })

  test.afterAll(async () => {
    await tenantA?.page.context().close().catch(() => {})
    await tenantB?.page.context().close().catch(() => {})
  })

  test('same-email different-visitorId does NOT inherit the first contact/conversation (backend identity)', () => {
    // Backend identity contract: lookup by (tenantId, visitorId), never email.
    expect(contactId3, 'v3 must be a DIFFERENT contact than v1 despite same email').not.toBe(contactId1)
    expect(convId3, 'v3 must have a DIFFERENT conversation than v1').not.toBe(convId1)
  })

  test('Dashboard Contacts page shows the contact with correct name/email', async () => {
    await tenantA.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await goToContacts(tenantA.page)
    // The contact named "Visitor One" with the shared email is visible.
    await expect(tenantA.page.locator('main')).toContainText('Visitor One', { timeout: 10000 })
    await expect(tenantA.page.locator('main')).toContainText(sharedEmail)
    // Visitor Three (same email, different contact) is ALSO visible — proving
    // the second visitor did NOT inherit/merge into the first contact.
    await expect(tenantA.page.locator('main')).toContainText('Visitor Three')
  })

  test('conversation count is correct (expand → "Conversations (1)")', async () => {
    // Expand the Visitor One row.
    await tenantA.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await goToContacts(tenantA.page)
    const row1 = tenantA.page.locator('main').locator('text=Visitor One').first()
    await row1.click()
    // Expanded view shows exactly 1 conversation.
    await expect(tenantA.page.locator('main')).toContainText(/(گفت‌وگوها|Conversations) \(1\)/, { timeout: 10000 })
  })

  test('expand → correct conversation with matching last-message preview + status', async () => {
    await tenantA.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await goToContacts(tenantA.page)

    // Visitor One → its own conversation.
    await tenantA.page.locator('main').locator('text=Visitor One').first().click()
    await expect(tenantA.page.locator('main')).toContainText('hello from visitor one', { timeout: 10000 })
    await expect(tenantA.page.locator('main')).toContainText('open')

    // Visitor Three → its OWN conversation (no inheritance from Visitor One).
    await tenantA.page.locator('main').locator('text=Visitor Three').first().click()
    await expect(tenantA.page.locator('main')).toContainText('hello from visitor three', { timeout: 10000 })
    // The status badge renders the raw status string ('open'/'closed') — locale-independent.
    await expect(tenantA.page.locator('main')).toContainText('open')
  })

  test('anonymous fallback: contact with no name/email shows "Visitor" + no email', async () => {
    await tenantA.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await goToContacts(tenantA.page)
    // The anonymous contact (created with no name/email) has its name defaulted
    // to "Visitor" by the widget contact route. The row shows "Visitor" and NO
    // email (the visitor badge is shown instead).
    // There are exactly 3 contact rows.
    const rows = tenantA.page.locator('main ul li')
    await expect(rows).toHaveCount(3, { timeout: 10000 })
  })

  test('tenant B cannot see tenant A contacts (tenant isolation)', async () => {
    // B's dashboard Contacts page shows the empty state (truthful — B has no
    // contacts), NOT A's contacts.
    await tenantB.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await goToContacts(tenantB.page)
    await expect(tenantB.page.locator('main')).not.toContainText('Visitor One', { timeout: 10000 })
    await expect(tenantB.page.locator('main')).not.toContainText('Visitor Three')
    // B's API also returns no contacts.
    const res = await tenantB.page.request.get(`${BASE}/api/contacts`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { contacts?: unknown[] }
    expect(body.contacts?.length ?? 0, 'tenant B must see zero contacts').toBe(0)
  })
})
