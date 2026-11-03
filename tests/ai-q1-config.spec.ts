import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Independent reviewer-owned AI Phase / AI-Q1 integration contract.
 * Real authenticated database + Full and Lite production-like stacks.
 * No route mocks, fake config, test-only public provider endpoint or sleeps.
 *
 * Positive E2E is deterministic for exact, enabled FAQ. Product positive
 * provider generation is tested separately using an injected test provider
 * in reviewer-owned Bun Unit tests (no production test backdoor).
 */
const APP = 'http://127.0.0.1:3000'
const BASE = 'http://127.0.0.1:81'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function signup(page: Page, scenario: string) {
  const stamp = scenario + '-' + process.pid + '-' + Date.now()
  const email = 'aiq1-' + stamp + '@test.com'
  const reg = await otpSignupPlaywright(page.request, APP, email, 'AIQ1-' + stamp)
  expect(reg.ok).toBe(true)
  const csrf = await page.request.get(APP + '/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const { csrfToken } = await csrf.json()
  const login = await page.request.post(APP + '/api/auth/callback/credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'email=' + email + '&password=password123&csrfToken=' + csrfToken + '&json=true',
  })
  expect(login.status()).toBeLessThan(500)
  await page.goto(BASE)
  const tenant = await page.request.get(APP + '/api/tenants/me')
  expect(tenant.ok(), await tenant.text()).toBe(true)
  const slug = (await tenant.json()).tenant?.slug as string | undefined
  expect(slug).toBeTruthy()
  return slug!
}
async function config(page: Page) {
  const r = await page.request.get(APP + '/api/ai-config')
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).config as { faqEnabled: boolean; productQaEnabled: boolean; tenantId?: string; aiActionCount?: number }
}
async function patch(page: Page, body: unknown, status = 200) {
  const r = await page.request.patch(APP + '/api/ai-config', {
    headers: JSON_HEADERS, data: body,
  })
  expect(r.status(), await r.text()).toBe(status)
  return r
}
async function setPlan(page: Page, plan: 'free' | 'pro') {
  const r = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    headers: JSON_HEADERS, data: { plan },
  })
  expect(r.ok(), await r.text()).toBe(true)
}
async function visitorToken(page: Page, slug: string, suffix: string) {
  await setAccessMode(page, 'anonymous')
  const r = await page.request.post(BASE + '/api/widget/' + slug + '/contact', {
    headers: JSON_HEADERS,
    data: { visitorId: 'ai-q1-visitor-' + suffix + '-' + Date.now() },
  })
  expect(r.ok(), await r.text()).toBe(true)
  const body = await r.json()
  expect(body.realtimeToken).toBeTruthy()
  return body.realtimeToken as string
}
async function message(page: Page, slug: string, token: string, text: string) {
  const r = await page.request.post(BASE + '/api/widget/' + slug + '/messages', {
    headers: { ...JSON_HEADERS, Authorization: 'Bearer ' + token },
    data: { text },
  })
  expect(r.status(), await r.text()).toBe(200)
  return r.json()
}
async function thread(page: Page, conversationId: string) {
  const r = await page.request.get(APP + '/api/conversations/' + conversationId + '/messages')
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).messages as Array<{ senderType: string; content: { text?: string; source?: string } }>
}

test.describe('Reviewer — AI-Q1 Settings and reliable positive AI', () => {
  test('anonymous GET and PATCH remain unauthorized', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const get = await page.request.get(APP + '/api/ai-config')
      expect(get.status()).toBe(401)
      const change = await page.request.patch(APP + '/api/ai-config', {
        headers: JSON_HEADERS, data: { faqEnabled: true },
      })
      expect(change.status()).toBe(401)
    } finally { await ctx.close() }
  })
  test('new tenant is off/off; repeated GET retains the stable baseline', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await signup(page, 'defaults')
      const first = await config(page)
      const again = await config(page)
      expect(first.faqEnabled).toBe(false)
      expect(first.productQaEnabled).toBe(false)
      expect(again.faqEnabled).toBe(false)
      expect(again.productQaEnabled).toBe(false)
    } finally { await ctx.close() }
  })
  test('true PATCH in both directions preserves the independent setting', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await signup(page, 'true-patch')
      await patch(page, { faqEnabled: true })
      expect(await config(page)).toMatchObject({ faqEnabled: true, productQaEnabled: false })
      await patch(page, { productQaEnabled: true })
      expect(await config(page)).toMatchObject({ faqEnabled: true, productQaEnabled: true })
      await patch(page, { faqEnabled: false })
      expect(await config(page)).toMatchObject({ faqEnabled: false, productQaEnabled: true })
      await patch(page, { productQaEnabled: false })
      expect(await config(page)).toMatchObject({ faqEnabled: false, productQaEnabled: false })
      await page.reload()
      expect(await config(page)).toMatchObject({ faqEnabled: false, productQaEnabled: false })
    } finally { await ctx.close() }
  })
  test('malformed JSON field types are rejected without silently changing saved flags', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await signup(page, 'bad-types')
      await patch(page, { faqEnabled: true, productQaEnabled: true })
      for (const payload of [
        {}, { faqEnabled: 'false' }, { faqEnabled: 0 },
        { productQaEnabled: null }, { productQaEnabled: 1 },
        { faqEnabled: {} }, { productQaEnabled: [] },
        { faqEnabled: true, extra: 'unknown' },
      ]) {
        await patch(page, payload, 400)
        expect(await config(page)).toMatchObject({ faqEnabled: true, productQaEnabled: true })
      }
    } finally { await ctx.close() }
  })
  test('malformed body and attempts to change AI consumption fields are rejected', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await signup(page, 'counter-forgery')
      const baseline = await config(page)
      for (const body of [null, [], ['faqEnabled'], 1, 'yes',
        { aiActionCount: 100000 }, { aiActionResetAt: '2099-01-01' },
        { faqEnabled: true, tenantId: 'foreign-tenant' },
      ]) await patch(page, body, 400)
      expect(await config(page)).toMatchObject({
        faqEnabled: baseline.faqEnabled,
        productQaEnabled: baseline.productQaEnabled,
        aiActionCount: baseline.aiActionCount,
      })
    } finally { await ctx.close() }
  })
  test('two tenants never share toggle settings and one cannot change the other', async ({ browser }) => {
    const ctxA = await browser.newContext(), ctxB = await browser.newContext()
    try {
      const a = await ctxA.newPage(), b = await ctxB.newPage()
      await signup(a, 'tenant-a')
      await signup(b, 'tenant-b')
      await patch(a, { faqEnabled: true })
      expect(await config(a)).toMatchObject({ faqEnabled: true, productQaEnabled: false })
      expect(await config(b)).toMatchObject({ faqEnabled: false, productQaEnabled: false })
      await patch(b, { productQaEnabled: true })
      expect(await config(a)).toMatchObject({ faqEnabled: true, productQaEnabled: false })
      expect(await config(b)).toMatchObject({ faqEnabled: false, productQaEnabled: true })
    } finally { await ctxA.close(); await ctxB.close() }
  })
  test('Free cap zero prevents AI reply even when owner toggles FAQ and matches exactly', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'free-zero')
      await patch(page, { faqEnabled: true })
      const faqQuestion = 'ساعات پشتیبانی برای تست AI Q1 رایگان؟'
      const created = await page.request.post(APP + '/api/faqs', {
        headers: JSON_HEADERS, data: { question: faqQuestion, answer: 'پاسخ نباید ارسال شود.', enabled: true },
      })
      expect(created.ok(), await created.text()).toBe(true)
      const token = await visitorToken(page, slug, 'free')
      const result = await message(page, slug, token, faqQuestion)
      const messages = await thread(page, result.conversationId)
      expect(messages.filter(x => x.senderType === 'ai')).toHaveLength(0)
    } finally { await ctx.close() }
  })
  test('Pro exact FAQ generates a REAL persisted AI answer with the owner-authored text', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'paid-positive')
      await setPlan(page, 'pro')
      await patch(page, { faqEnabled: true })
      const question = 'آیا برای آزمایش قطعی AI-Q1 پرداخت حضوری دارید؟'
      const answer = 'بله، پرداخت حضوری طبق راهنمای ثبت‌شده مجاز است.'
      const create = await page.request.post(APP + '/api/faqs', {
        headers: JSON_HEADERS, data: { question, answer, enabled: true },
      })
      expect(create.ok(), await create.text()).toBe(true)
      const token = await visitorToken(page, slug, 'paid')
      const sent = await message(page, slug, token, question)
      expect(sent.conversationId).toBeTruthy()
      const stored = await thread(page, sent.conversationId)
      const ai = stored.filter(x => x.senderType === 'ai')
      expect(ai.length, 'Paid exact FAQ MUST deliver a real positive answer; no probabilistic skip').toBe(1)
      expect(ai[0].content.source).toBe('faq')
      expect(ai[0].content.text).toBe(answer)
      const visitor = stored.filter(x => x.senderType === 'contact')
      expect(visitor.some(x => x.content.text === question)).toBe(true)
    } finally { await ctx.close() }
  })
  test('Paid tenant with FAQ disabled never auto-answers even exact stored FAQ', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'paid-disabled')
      await setPlan(page, 'pro')
      const question = 'آیا پرداخت حضوری برای آزمایش غیرفعال بودن مجاز است؟'
      const create = await page.request.post(APP + '/api/faqs', {
        headers: JSON_HEADERS, data: { question, answer: 'پاسخ آزمایشی', enabled: true },
      })
      expect(create.ok(), await create.text()).toBe(true)
      expect(await config(page)).toMatchObject({ faqEnabled: false })
      const token = await visitorToken(page, slug, 'off')
      const result = await message(page, slug, token, question)
      expect((await thread(page, result.conversationId)).filter(x => x.senderType === 'ai')).toHaveLength(0)
    } finally { await ctx.close() }
  })

  test('parallel independent PATCHes do not lose either flag (real DB concurrency)', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      await signup(page, 'concurrent-toggles')
      // All requests ONLY turn their own flag ON, so regardless of
      // interleaving, the final value of BOTH flags MUST be true.
      for (let round = 0; round < 3; round++) {
        await patch(page, { faqEnabled: false, productQaEnabled: false })
        const payloads = Array.from({ length: 12 }, (_, i) =>
          i % 2 === 0 ? { faqEnabled: true } : { productQaEnabled: true })
        const results = await Promise.all(payloads.map(body =>
          page.request.patch(APP + '/api/ai-config', {
            headers: JSON_HEADERS,
            data: body,
          }),
        ))
        for (const r of results) expect(r.status(), await r.text()).toBe(200)
        expect(await config(page)).toMatchObject({
          faqEnabled: true,
          productQaEnabled: true,
        })
      }
    } finally { await ctx.close() }
  })
})
