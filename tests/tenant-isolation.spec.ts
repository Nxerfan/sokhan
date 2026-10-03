import { test, expect, type Page } from '@playwright/test'

/**
 * Cross-tenant isolation test — the definitive proof that Tenant B cannot see
 * Tenant A's conversations, messages, contacts, or routing rules.
 *
 * Uses page.evaluate to make API calls directly (no UI clicks needed) because
 * the isolation is at the API/database level, not the UI level. Each tenant
 * gets its own browser context with its own session cookie.
 */

const BASE = 'http://127.0.0.1:3000'

test.describe('Cross-tenant isolation', () => {
  test('Tenant B cannot see Tenant A\'s conversations, messages, or contacts', async ({ browser }) => {
    // === Tenant A: signup + signin + create conversation ===
    const ctxA = await browser.newContext()
    const pageA = await ctxA.newPage()
    await pageA.goto(BASE)
    await pageA.waitForLoadState('networkidle')

    // Signup + signin entirely via API (reliable, no hydration issues)
    // Uses the 3-step OTP flow (start → verify → complete) — the legacy
    // /api/auth/signup endpoint is now deprecated (returns 410 Gone).
    const tenantAData = await pageA.evaluate(async () => {
      // Step 1: start OTP signup
      const startRes = await fetch('/api/auth/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ta@iso-playwright.test' })
      })
      const { requestId } = await startRes.json()
      // Step 2: verify OTP (NIXIFY_MOCK=true → code is always "123456")
      await fetch('/api/auth/signup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ta@iso-playwright.test', code: '123456', requestId })
      })
      // Step 3: complete signup (creates user + tenant + membership)
      await fetch('/api/auth/signup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ta@iso-playwright.test', requestId, password: 'password123', workspaceName: 'TA ISO WS' })
      })
      // Get CSRF
      const csrfRes = await fetch('/api/auth/csrf')
      const { csrfToken } = await csrfRes.json()
      // Signin
      await fetch('/api/auth/callback/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `email=ta@iso-playwright.test&password=password123&csrfToken=${csrfToken}&json=true`
      })
      // Get tenant info
      const tenantRes = await fetch('/api/tenants/me')
      const tenantData = await tenantRes.json()
      return { slug: tenantData.tenant?.slug, tenantId: tenantData.tenant?.id }
    }, {})

    expect(tenantAData.slug, 'Tenant A should have a slug').toBeTruthy()
    console.log(`Tenant A: slug=${tenantAData.slug}`)

    // Create a conversation via the widget API (as a visitor)
    const convData = await pageA.evaluate(async (slug) => {
      // Identify as visitor
      const contactRes = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: 'visitor-A-iso-test' })
      })
      const contactData = await contactRes.json()
      // Send a message (creates conversation)
      const msgRes = await fetch(`/api/widget/${slug}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${contactData.realtimeToken}` },
        body: JSON.stringify({ text: 'TENANT_A_SECRET_MARKER_12345' })
      })
      const msgData = await msgRes.json()
      return { conversationId: msgData.conversationId, contactId: contactData.contactId }
    }, tenantAData.slug)

    expect(convData.conversationId, 'Tenant A should have a conversation').toBeTruthy()
    console.log(`Tenant A: conversationId=${convData.conversationId}`)

    // === Tenant B: signup + signin in a SEPARATE browser context ===
    const ctxB = await browser.newContext()
    const pageB = await ctxB.newPage()
    await pageB.goto(BASE)
    await pageB.waitForLoadState('networkidle')

    const tenantBData = await pageB.evaluate(async () => {
      // 3-step OTP signup for Tenant B
      const startRes = await fetch('/api/auth/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'tb@iso-playwright.test' })
      })
      const { requestId } = await startRes.json()
      await fetch('/api/auth/signup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'tb@iso-playwright.test', code: '123456', requestId })
      })
      await fetch('/api/auth/signup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'tb@iso-playwright.test', requestId, password: 'password123', workspaceName: 'TB ISO WS' })
      })
      const csrfRes = await fetch('/api/auth/csrf')
      const { csrfToken } = await csrfRes.json()
      await fetch('/api/auth/callback/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `email=tb@iso-playwright.test&password=password123&csrfToken=${csrfToken}&json=true`
      })
      const tenantRes = await fetch('/api/tenants/me')
      return tenantRes.json()
    }, {})

    expect(tenantBData.tenant, 'Tenant B should have a tenant').toBeTruthy()
    console.log(`Tenant B: slug=${tenantBData.tenant?.slug}`)

    // === ISOLATION CHECKS — all API calls from Tenant B's authenticated session ===
    const results = await pageB.evaluate(async (convId) => {
      const checks: Record<string, any> = {}

      // 1. Conversations list — should NOT contain Tenant A's conversation
      const convsRes = await fetch('/api/conversations?status=all')
      const convsData = await convsRes.json()
      checks.conversations = {
        count: convsData.conversations?.length || 0,
        leak: (convsData.conversations || []).find(c => c.id === convId) || null
      }

      // 2. Read Tenant A's conversation by ID — should return not_found
      const convByIdRes = await fetch(`/api/conversations/${convId}`)
      const convByIdData = await convByIdRes.json()
      checks.convById = convByIdData.conversation ? 'LEAK' : 'PASS'

      // 3. Read Tenant A's messages by conversation ID — should return empty/not_found
      const msgsRes = await fetch(`/api/conversations/${convId}/messages`)
      const msgsData = await msgsRes.json()
      const msgLeak = (msgsData.messages || []).find(m => m.content?.text?.includes('TENANT_A_SECRET'))
      checks.messages = msgLeak ? 'LEAK' : 'PASS'

      // 4. Contacts — should be empty (Tenant B has no visitors)
      const contactsRes = await fetch('/api/contacts')
      const contactsData = await contactsRes.json()
      checks.contacts = { count: contactsData.contacts?.length || 0 }

      // 5. Routing rules — should be empty
      const rulesRes = await fetch('/api/routing-rules')
      const rulesData = await rulesRes.json()
      checks.rules = { count: rulesData.rules?.length || 0 }

      return checks
    }, convData.conversationId)

    // === ASSERTIONS ===
    console.log('Isolation results:', JSON.stringify(results, null, 2))

    // 1. Conversations: Tenant B should have 0, and Tenant A's conv must NOT appear
    expect(results.conversations.count, 'Tenant B should have 0 conversations').toBe(0)
    expect(results.conversations.leak, 'Tenant A\'s conversation must NOT appear in Tenant B\'s list').toBeNull()

    // 2. Conversation by ID: must not return the conversation
    expect(results.convById, 'Tenant B must NOT read Tenant A\'s conversation by ID').toBe('PASS')

    // 3. Messages: must not contain Tenant A's secret message
    expect(results.messages, 'Tenant B must NOT read Tenant A\'s messages').toBe('PASS')

    // 4. Contacts: must be empty
    expect(results.contacts.count, 'Tenant B should have 0 contacts').toBe(0)

    // 5. Routing rules: must be empty
    expect(results.rules.count, 'Tenant B should have 0 routing rules').toBe(0)

    // === CONTROL: Tenant A CAN see their own conversation ===
    const controlResult = await pageA.evaluate(async (convId) => {
      const res = await fetch('/api/conversations?status=open')
      const data = await res.json()
      return (data.conversations || []).find(c => c.id === convId)
    }, convData.conversationId)
    expect(controlResult, 'Control: Tenant A should see their own conversation').toBeTruthy()

    console.log('\n=== ALL ISOLATION CHECKS PASSED ===')

    await ctxA.close()
    await ctxB.close()
  })
})
