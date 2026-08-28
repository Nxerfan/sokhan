# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: module5-security.spec.ts >> Module 5 — Widget API Security >> 4. Cross-tenant isolation — visitor token scoped to own tenant
- Location: tests/module5-security.spec.ts:110:7

# Error details

```
Error: Debug: {"contactOk":false,"msgOk":false,"msgStatus":401,"msgBody":{"error":"invalid_token"}}

expect(received).toBeTruthy()

Received: undefined
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e5]:
      - generic [ref=e6]:
        - generic [ref=e7]: سُخن
        - generic [ref=e12]:
          - button "تغییر زبان" [ref=e13]
          - button "تغییر پوسته" [ref=e14]
      - generic [ref=e15]:
        - generic [ref=e16]:
          - heading "فضای کاری خود را بسازید" [level=1] [ref=e17]
          - paragraph [ref=e18]: از ثبت‌نام تا ویجت زنده، در کمتر از پنج دقیقه
        - generic [ref=e19]:
          - generic [ref=e20]:
            - generic [ref=e21]: نام شما
            - textbox "نام شما" [ref=e22]
          - generic [ref=e23]:
            - generic [ref=e24]: ایمیل
            - textbox "ایمیل" [ref=e25]
          - generic [ref=e26]:
            - generic [ref=e27]: رمز عبور
            - textbox "رمز عبور" [ref=e28]
          - generic [ref=e29]:
            - generic [ref=e30]: نام فضای کاری
            - textbox "نام فضای کاری" [ref=e31]
            - paragraph [ref=e32]: /workspace
          - button "ایجاد فضای کاری" [ref=e33]
        - generic [ref=e34]:
          - text: قبلاً فضای کاری دارید؟
          - button "وارد شوید" [ref=e35]
      - paragraph [ref=e36]: "نسخه نمایشی: با ساخت فضای کاری فوراً شروع کنید — بدون نیاز به کارت."
    - contentinfo [ref=e37]:
      - generic [ref=e38]:
        - paragraph [ref=e39]: © 2026 تمامی حقوق محفوظ است.
        - paragraph [ref=e40]: متن‌باز هسته تحت AGPL-3.0. کد منبع در صورت درخواست در دسترس است.
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e46] [cursor=pointer]
  - alert [ref=e50]
```

# Test source

```ts
  43  |     const contactRes = await page.evaluate(async ({ slug, stamp }) => {
  44  |       const res = await fetch(`/api/widget/${slug}/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: `visitor-rate-${stamp}` }) })
  45  |       return { status: res.status, body: await res.json() }
  46  |     }, { slug, stamp })
  47  |     expect(contactRes.status).toBe(200)
  48  |     expect(contactRes.body.realtimeToken).toBeTruthy()
  49  | 
  50  |     await ctx.close()
  51  |   })
  52  | 
  53  |   test('2. Input validation — long message truncated, invalid email rejected', async ({ browser }) => {
  54  |     const stamp = Date.now()
  55  |     const ctx = await browser.newContext() // Fresh context = fresh IP for rate limiting
  56  |     const page = await ctx.newPage()
  57  |     const slug = await signupAndGetSlug(page, `input-${stamp}@test.com`, `Input ${stamp}`)
  58  | 
  59  |     // Test invalid email — should be rejected with 400 (not rate limited, since it's the first request)
  60  |     const badEmailRes = await page.evaluate(async ({ slug }) => {
  61  |       const res = await fetch(`/api/widget/${slug}/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email' }) })
  62  |       return { status: res.status, body: await res.json() }
  63  |     }, { slug })
  64  |     expect(badEmailRes.status).toBe(400)
  65  |     expect(badEmailRes.body.error).toBe('invalid_email')
  66  | 
  67  |     // Test valid contact — use a valid visitorId
  68  |     const contactRes = await page.evaluate(async ({ slug, stamp }) => {
  69  |       const res = await fetch(`/api/widget/${slug}/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: `visitor-input-${stamp}` }) })
  70  |       return res.json()
  71  |     }, { slug, stamp })
  72  |     const token = contactRes.realtimeToken
  73  | 
  74  |     // Test overly long message — should be truncated, not rejected
  75  |     const longText = 'A'.repeat(10_000)
  76  |     const longMsgRes = await page.evaluate(async ({ slug, token, longText }) => {
  77  |       const res = await fetch(`/api/widget/${slug}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ text: longText }) })
  78  |       return { status: res.status, body: await res.json() }
  79  |     }, { slug, token, longText })
  80  |     expect(longMsgRes.status).toBe(200)
  81  |     expect(longMsgRes.body.message.content.text.length).toBe(5000)
  82  | 
  83  |     await ctx.close()
  84  |   })
  85  | 
  86  |   test('3. CORS — widget API returns Access-Control-Allow-Origin', async ({ browser }) => {
  87  |     const stamp = Date.now()
  88  |     const ctx = await browser.newContext()
  89  |     const page = await ctx.newPage()
  90  |     const slug = await signupAndGetSlug(page, `cors-${stamp}@test.com`, `CORS ${stamp}`)
  91  | 
  92  |     // Check CORS header on config endpoint
  93  |     const configRes = await page.evaluate(async ({ slug }) => {
  94  |       const res = await fetch(`/api/widget/${slug}/config`)
  95  |       return { cors: res.headers.get('access-control-allow-origin'), status: res.status }
  96  |     }, { slug })
  97  |     expect(configRes.cors).toBe('*')
  98  | 
  99  |     // Check OPTIONS preflight on contact endpoint
  100 |     const preflightRes = await page.evaluate(async ({ slug }) => {
  101 |       const res = await fetch(`/api/widget/${slug}/contact`, { method: 'OPTIONS' })
  102 |       return { cors: res.headers.get('access-control-allow-origin'), status: res.status }
  103 |     }, { slug })
  104 |     expect(preflightRes.status).toBe(204)
  105 |     expect(preflightRes.cors).toBe('*')
  106 | 
  107 |     await ctx.close()
  108 |   })
  109 | 
  110 |   test('4. Cross-tenant isolation — visitor token scoped to own tenant', async ({ browser }) => {
  111 |     const stamp = Date.now()
  112 | 
  113 |     // Tenant A — signup + create a conversation via widget API
  114 |     const ctxA = await browser.newContext()
  115 |     const pageA = await ctxA.newPage()
  116 |     await pageA.goto(DASHBOARD)
  117 |     await pageA.waitForTimeout(2000)
  118 | 
  119 |     // Signup Tenant A and create a conversation via widget API (no auth needed for widget)
  120 |     const resultA = await pageA.evaluate(async ({ email, workspace, stamp }) => {
  121 |       // Signup
  122 |       await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', name: 'Agent', workspaceName: workspace }) })
  123 |       // Get slug from the signup (slug is derived from workspace name)
  124 |       // Actually, let's just use the widget API directly — we need the slug
  125 |       // The slug is the workspace name slugified. Let's get it from the tenant API
  126 |       const { csrfToken } = await (await fetch('/api/auth/csrf')).json()
  127 |       await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true` })
  128 |       const { tenant } = await (await fetch('/api/tenants/me')).json()
  129 |       const slug = tenant?.slug
  130 | 
  131 |       // Now use the widget API as a visitor
  132 |       const contactRes = await fetch(`/api/widget/${slug}/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: `visitor-iso-${stamp}` }) })
  133 |       const contactData = await contactRes.json()
  134 |       const token = contactData.realtimeToken
  135 | 
  136 |       // Send a message
  137 |       const msgRes = await fetch(`/api/widget/${slug}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ text: 'Tenant A secret' }) })
  138 |       const msgData = await msgRes.json()
  139 | 
  140 |       return { slug, token, conversationId: msgData.conversationId, contactOk: contactRes.ok, msgOk: msgRes.ok, msgStatus: msgRes.status, msgBody: msgData }
  141 |     }, { email: `isoA-${stamp}@test.com`, workspace: `IsoA ${stamp}`, stamp })
  142 | 
> 143 |     expect(resultA.slug, `Debug: ${JSON.stringify({ slug: resultA.slug, contactOk: resultA.contactOk, msgOk: resultA.msgOk, msgStatus: resultA.msgStatus, msgBody: resultA.msgBody })}`).toBeTruthy()
      |                                                                                                                                                                                          ^ Error: Debug: {"contactOk":false,"msgOk":false,"msgStatus":401,"msgBody":{"error":"invalid_token"}}
  144 |     expect(resultA.conversationId, `Conversation debug: ${JSON.stringify(resultA.msgBody)}`).toBeTruthy()
  145 | 
  146 |     // Tenant B — separate context, signup
  147 |     const ctxB = await browser.newContext()
  148 |     const pageB = await ctxB.newPage()
  149 |     await pageB.goto(DASHBOARD)
  150 |     await pageB.waitForTimeout(2000)
  151 | 
  152 |     const slugB = await pageB.evaluate(async ({ email, workspace }) => {
  153 |       await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', name: 'Agent', workspaceName: workspace }) })
  154 |       const { csrfToken } = await (await fetch('/api/auth/csrf')).json()
  155 |       await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true` })
  156 |       const { tenant } = await (await fetch('/api/tenants/me')).json()
  157 |       return tenant?.slug
  158 |     }, { email: `isoB-${stamp}@test.com`, workspace: `IsoB ${stamp}` })
  159 | 
  160 |     expect(slugB).toBeTruthy()
  161 | 
  162 |     // Try to read Tenant A's conversation using Tenant A's visitor token but via Tenant B's slug
  163 |     const crossReadRes = await pageB.evaluate(async ({ slugB, tokenA, conversationIdA }) => {
  164 |       const res = await fetch(`/api/widget/${slugB}/messages?conversationId=${conversationIdA}`, { headers: { 'Authorization': `Bearer ${tokenA}` } })
  165 |       return { status: res.status, body: await res.json() }
  166 |     }, { slugB, tokenA: resultA.token, conversationIdA: resultA.conversationId })
  167 |     // The visitor token is scoped to Tenant A's tenantId — accessing via Tenant B's slug
  168 |     // should return empty messages (the conversation doesn't belong to Tenant B's tenantId)
  169 |     expect(crossReadRes.body.messages).toEqual([])
  170 | 
  171 |     await ctxA.close()
  172 |     await ctxB.close()
  173 |   })
  174 | 
  175 |   test('5. File upload safety — HTML/SVG/JS files rejected', async ({ browser }) => {
  176 |     const stamp = Date.now()
  177 |     const ctx = await browser.newContext()
  178 |     const page = await ctx.newPage()
  179 |     await signupAndGetSlug(page, `upload-${stamp}@test.com`, `Upload ${stamp}`)
  180 | 
  181 |     // Try to upload an HTML file — should be rejected
  182 |     const htmlRes = await page.evaluate(async () => {
  183 |       const blob = new Blob(['<script>alert("xss")</script>'], { type: 'text/html' })
  184 |       const formData = new FormData()
  185 |       formData.append('file', blob, 'evil.html')
  186 |       const res = await fetch('/api/attachments', { method: 'POST', body: formData })
  187 |       return { status: res.status, body: await res.json().catch(() => ({})) }
  188 |     })
  189 |     expect(htmlRes.status).toBe(400)
  190 |     expect(htmlRes.body.error).toBe('file_type_not_allowed')
  191 | 
  192 |     // Try to upload an SVG file — should be rejected
  193 |     const svgRes = await page.evaluate(async () => {
  194 |       const blob = new Blob(['<svg onload="alert(1)">'], { type: 'image/svg+xml' })
  195 |       const formData = new FormData()
  196 |       formData.append('file', blob, 'evil.svg')
  197 |       const res = await fetch('/api/attachments', { method: 'POST', body: formData })
  198 |       return { status: res.status, body: await res.json().catch(() => ({})) }
  199 |     })
  200 |     expect(svgRes.status).toBe(400)
  201 |     expect(svgRes.body.error).toBe('file_type_not_allowed')
  202 | 
  203 |     // Verify a valid PNG is accepted
  204 |     const pngRes = await page.evaluate(async () => {
  205 |       const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], { type: 'image/png' })
  206 |       const formData = new FormData()
  207 |       formData.append('file', blob, 'test.png')
  208 |       const res = await fetch('/api/attachments', { method: 'POST', body: formData })
  209 |       return { status: res.status, body: await res.json().catch(() => ({})) }
  210 |     })
  211 |     expect(pngRes.status).toBe(200)
  212 |     expect(pngRes.body.url).toContain('/uploads/')
  213 | 
  214 |     await ctx.close()
  215 |   })
  216 | })
  217 | 
```