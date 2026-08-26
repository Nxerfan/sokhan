# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tenant-isolation.spec.ts >> Cross-tenant isolation >> Tenant B cannot see Tenant A's conversations, messages, or contacts
- Location: tests/tenant-isolation.spec.ts:15:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/
Call log:
  - navigating to "http://localhost:3000/", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test'
  2   | 
  3   | /**
  4   |  * Cross-tenant isolation test — the definitive proof that Tenant B cannot see
  5   |  * Tenant A's conversations, messages, contacts, or routing rules.
  6   |  *
  7   |  * Uses page.evaluate to make API calls directly (no UI clicks needed) because
  8   |  * the isolation is at the API/database level, not the UI level. Each tenant
  9   |  * gets its own browser context with its own session cookie.
  10  |  */
  11  | 
  12  | const BASE = 'http://localhost:3000'
  13  | 
  14  | test.describe('Cross-tenant isolation', () => {
  15  |   test('Tenant B cannot see Tenant A\'s conversations, messages, or contacts', async ({ browser }) => {
  16  |     // === Tenant A: signup + signin + create conversation ===
  17  |     const ctxA = await browser.newContext()
  18  |     const pageA = await ctxA.newPage()
> 19  |     await pageA.goto(BASE)
      |                 ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/
  20  |     await pageA.waitForLoadState('networkidle')
  21  | 
  22  |     // Signup + signin entirely via API (reliable, no hydration issues)
  23  |     const tenantAData = await pageA.evaluate(async () => {
  24  |       // Signup
  25  |       await fetch('/api/auth/signup', {
  26  |         method: 'POST',
  27  |         headers: { 'Content-Type': 'application/json' },
  28  |         body: JSON.stringify({ email: 'ta@iso-playwright.test', password: 'password123', name: 'TA', workspaceName: 'TA ISO WS' })
  29  |       })
  30  |       // Get CSRF
  31  |       const csrfRes = await fetch('/api/auth/csrf')
  32  |       const { csrfToken } = await csrfRes.json()
  33  |       // Signin
  34  |       await fetch('/api/auth/callback/credentials', {
  35  |         method: 'POST',
  36  |         headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  37  |         body: `email=ta@iso-playwright.test&password=password123&csrfToken=${csrfToken}&json=true`
  38  |       })
  39  |       // Get tenant info
  40  |       const tenantRes = await fetch('/api/tenants/me')
  41  |       const tenantData = await tenantRes.json()
  42  |       return { slug: tenantData.tenant?.slug, tenantId: tenantData.tenant?.id }
  43  |     }, {})
  44  | 
  45  |     expect(tenantAData.slug, 'Tenant A should have a slug').toBeTruthy()
  46  |     console.log(`Tenant A: slug=${tenantAData.slug}`)
  47  | 
  48  |     // Create a conversation via the widget API (as a visitor)
  49  |     const convData = await pageA.evaluate(async (slug) => {
  50  |       // Identify as visitor
  51  |       const contactRes = await fetch(`/api/widget/${slug}/contact`, {
  52  |         method: 'POST',
  53  |         headers: { 'Content-Type': 'application/json' },
  54  |         body: JSON.stringify({ visitorId: 'visitor-A-iso-test' })
  55  |       })
  56  |       const contactData = await contactRes.json()
  57  |       // Send a message (creates conversation)
  58  |       const msgRes = await fetch(`/api/widget/${slug}/messages`, {
  59  |         method: 'POST',
  60  |         headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${contactData.realtimeToken}` },
  61  |         body: JSON.stringify({ text: 'TENANT_A_SECRET_MARKER_12345' })
  62  |       })
  63  |       const msgData = await msgRes.json()
  64  |       return { conversationId: msgData.conversationId, contactId: contactData.contactId }
  65  |     }, tenantAData.slug)
  66  | 
  67  |     expect(convData.conversationId, 'Tenant A should have a conversation').toBeTruthy()
  68  |     console.log(`Tenant A: conversationId=${convData.conversationId}`)
  69  | 
  70  |     // === Tenant B: signup + signin in a SEPARATE browser context ===
  71  |     const ctxB = await browser.newContext()
  72  |     const pageB = await ctxB.newPage()
  73  |     await pageB.goto(BASE)
  74  |     await pageB.waitForLoadState('networkidle')
  75  | 
  76  |     const tenantBData = await pageB.evaluate(async () => {
  77  |       await fetch('/api/auth/signup', {
  78  |         method: 'POST',
  79  |         headers: { 'Content-Type': 'application/json' },
  80  |         body: JSON.stringify({ email: 'tb@iso-playwright.test', password: 'password123', name: 'TB', workspaceName: 'TB ISO WS' })
  81  |       })
  82  |       const csrfRes = await fetch('/api/auth/csrf')
  83  |       const { csrfToken } = await csrfRes.json()
  84  |       await fetch('/api/auth/callback/credentials', {
  85  |         method: 'POST',
  86  |         headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  87  |         body: `email=tb@iso-playwright.test&password=password123&csrfToken=${csrfToken}&json=true`
  88  |       })
  89  |       const tenantRes = await fetch('/api/tenants/me')
  90  |       return tenantRes.json()
  91  |     }, {})
  92  | 
  93  |     expect(tenantBData.tenant, 'Tenant B should have a tenant').toBeTruthy()
  94  |     console.log(`Tenant B: slug=${tenantBData.tenant?.slug}`)
  95  | 
  96  |     // === ISOLATION CHECKS — all API calls from Tenant B's authenticated session ===
  97  |     const results = await pageB.evaluate(async (convId) => {
  98  |       const checks = {}
  99  | 
  100 |       // 1. Conversations list — should NOT contain Tenant A's conversation
  101 |       const convsRes = await fetch('/api/conversations?status=all')
  102 |       const convsData = await convsRes.json()
  103 |       checks.conversations = {
  104 |         count: convsData.conversations?.length || 0,
  105 |         leak: (convsData.conversations || []).find(c => c.id === convId) || null
  106 |       }
  107 | 
  108 |       // 2. Read Tenant A's conversation by ID — should return not_found
  109 |       const convByIdRes = await fetch(`/api/conversations/${convId}`)
  110 |       const convByIdData = await convByIdRes.json()
  111 |       checks.convById = convByIdData.conversation ? 'LEAK' : 'PASS'
  112 | 
  113 |       // 3. Read Tenant A's messages by conversation ID — should return empty/not_found
  114 |       const msgsRes = await fetch(`/api/conversations/${convId}/messages`)
  115 |       const msgsData = await msgsRes.json()
  116 |       const msgLeak = (msgsData.messages || []).find(m => m.content?.text?.includes('TENANT_A_SECRET'))
  117 |       checks.messages = msgLeak ? 'LEAK' : 'PASS'
  118 | 
  119 |       // 4. Contacts — should be empty (Tenant B has no visitors)
```