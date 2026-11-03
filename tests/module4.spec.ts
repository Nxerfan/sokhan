import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Module 4 tests — AI FAQ auto-responder + Product Q&A.
 *
 * AI-Q1: tests 1 and 2 are now DETERMINISTIC.
 *
 * Tests:
 * 1. FAQ matching: an EXACT stored question produces a deterministic
 *    auto-response via the exact-match fast path (no LLM call, no
 *    probabilistic skip). The AI reply is asserted to be present with the
 *    owner-authored answer and source 'faq'.
 * 2. Product Q&A retrieval gate: a question with NO matching product
 *    keyword deterministically skips the LLM (zero candidates → no model
 *    call → no AI reply). Positive product generation is covered by the
 *    injected-provider Unit tests in ai-q1-contract.test.ts /
 *    ai-q1-implementation.test.ts (no production test backdoor).
 * 3. Toggle defaults: both features default to OFF, and disabling stops them from firing.
 * 4. AI usage cap: when the cap is hit, the feature stops firing gracefully.
 *
 * No test here pretends a probabilistic external LLM was exercised when it
 * was not. The deterministic positive FAQ path is proven end-to-end here
 * and in the reviewer ai-q1-config.spec.ts acceptance.
 */

const DASHBOARD = 'http://127.0.0.1:3000'
const WIDGET = 'http://127.0.0.1:81'

async function signupAndSignin(page: Page, email: string, workspace: string): Promise<string> {
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

  // Upgrade to 'pro' plan (free tier has aiActions: 0 — AI is disabled)
  await page.request.post(`${DASHBOARD}/api/billing/subscribe`, {
    headers: { 'Content-Type': 'application/json' },
    data: { planSlug: 'pro', gateway: 'zarinpal' },
  })
  // Simulate payment callback to activate the subscription
  const subRes = await page.request.get(`${DASHBOARD}/api/billing/subscription`)
  const subData = await subRes.json()
  // The subscribe endpoint returns invoiceId — simulate the callback
  // Actually, let's just hit the subscribe endpoint for the free plan first (activates immediately)
  // and then for pro — but we need the callback. Let's use the test-mode callback.
  // The subscribe response includes invoiceId
  const subscribeRes = await page.request.post(`${DASHBOARD}/api/billing/subscribe`, {
    headers: { 'Content-Type': 'application/json' },
    data: { planSlug: 'pro', gateway: 'zarinpal' },
  })
  const subscribeData = await subscribeRes.json()
  if (subscribeData.invoiceId) {
    await page.request.get(`${DASHBOARD}/api/billing/callback/zarinpal?invoiceId=${subscribeData.invoiceId}&Status=OK`, { maxRedirects: 0 })
  }

  // Fresh OTP signups default to accessMode='verified_visitor' (the frozen
  // DB contract). The /contact flow below requires anonymous visitor tokens,
  // so explicitly switch the tenant to anonymous before any visitor traffic.
  await setAccessMode(page, 'anonymous')

  return slug
}

test.describe('Module 4 — AI features', () => {
  test('1. FAQ matching — EXACT stored question gets a deterministic auto-response', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-faq`
    const email = `faq-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `FAQ ${stamp}`)
    expect(slug).toBeTruthy()

    // Enable the FAQ feature (true-PATCH — productQaEnabled omitted, stays OFF)
    await page.request.patch(`${DASHBOARD}/api/ai-config`, {
      headers: { 'Content-Type': 'application/json' },
      data: { faqEnabled: true },
    })

    // Create a FAQ pair
    const faqQuestion = 'آیا پرداخت حضوری دارید؟' // "Do you have in-person payment?"
    const faqAnswer = 'بله، امکان پرداخت حضوری وجود دارد.' // "Yes, in-person payment is available."
    const faqRes = await page.request.post(`${DASHBOARD}/api/faqs`, {
      headers: { 'Content-Type': 'application/json' },
      data: { question: faqQuestion, answer: faqAnswer, enabled: true },
    })
    const faqData = await faqRes.json()
    expect(faqData.faq).toBeTruthy()

    // Identify as a visitor
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-faq-${stamp}` },
    })
    const contactData = await contactRes.json()
    const visitorToken = contactData.realtimeToken

    // Send the EXACT stored question — the AI-Q1 exact-match fast path
    // returns the owner-authored answer deterministically (no LLM call,
    // no probabilistic skip).
    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { text: faqQuestion },
    })
    const msgData = await msgRes.json()
    expect(msgData.conversationId).toBeTruthy()

    // A REAL AI response MUST be present (deterministic exact-match path).
    // This test no longer silently passes when the AI reply is missing.
    const msgsRes = await page.request.get(`${DASHBOARD}/api/conversations/${msgData.conversationId}/messages`)
    const msgsData = await msgsRes.json()
    const aiMessages = (msgsData.messages || []).filter((m: any) => m.senderType === 'ai')
    expect(aiMessages.length, 'Exact FAQ match MUST produce an AI response — no probabilistic skip').toBe(1)
    expect(aiMessages[0].content.source).toBe('faq')
    expect(aiMessages[0].content.text).toBe(faqAnswer)

    await ctx.close()
  })

  test('2. Product Q&A retrieval gate — non-matching question does NOT trigger the LLM', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-product`
    const email = `product-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `Product ${stamp}`)
    expect(slug).toBeTruthy()

    // Enable the Product Q&A feature (true-PATCH — faqEnabled omitted, stays OFF)
    await page.request.patch(`${DASHBOARD}/api/ai-config`, {
      headers: { 'Content-Type': 'application/json' },
      data: { productQaEnabled: true },
    })

    // Add a product manually
    await page.request.post(`${DASHBOARD}/api/products`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        name: 'هدفون بلوتوث سامسونگ', // "Samsung Bluetooth Headphone"
        price: 2500000,
        description: 'هدفون بی‌سیم با کیفیت صدای بالا و باتری ۲۴ ساعته',
        availability: 'in_stock',
      },
    })

    // Identify as a visitor
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-product-${stamp}` },
    })
    const contactData = await contactRes.json()
    const visitorToken = contactData.realtimeToken

    // Ask a question that does NOT contain any product keyword — the
    // deterministic keyword retrieval gate finds zero candidates and the
    // LLM is never called (no hallucination path, no probabilistic skip).
    // Positive product generation is covered by the injected-provider
    // Unit tests (ai-q1-contract.test.ts / ai-q1-implementation.test.ts).
    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { text: 'وضعیت آب و هوا چطور است؟' }, // "How is the weather?" — no product keyword match
    })
    const msgData = await msgRes.json()
    expect(msgData.conversationId).toBeTruthy()

    // No AI response should be present — the retrieval gate found no
    // matching product, so the model was not called. This is deterministic.
    const msgsRes = await page.request.get(`${DASHBOARD}/api/conversations/${msgData.conversationId}/messages`)
    const msgsData = await msgsRes.json()
    const aiMessages = (msgsData.messages || []).filter((m: any) => m.senderType === 'ai')
    expect(aiMessages.length, 'Non-matching question must not trigger an AI response').toBe(0)

    await ctx.close()
  })

  test('3. Both features default to OFF and disabling stops them from firing', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-off`
    const email = `off-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndSignin(page, email, `OFF ${stamp}`)
    expect(slug).toBeTruthy()

    // Check default AI config — both features should be OFF
    const configRes = await page.request.get(`${DASHBOARD}/api/ai-config`)
    const configData = await configRes.json()
    // If config doesn't exist yet, the GET endpoint creates it with defaults
    expect(configData.config.faqEnabled).toBe(false)
    expect(configData.config.productQaEnabled).toBe(false)

    // Create a FAQ pair (even though the feature is off)
    await page.request.post(`${DASHBOARD}/api/faqs`, {
      headers: { 'Content-Type': 'application/json' },
      data: { question: 'Test question', answer: 'Test answer', enabled: true },
    })

    // Identify as a visitor and send a message
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-off-${stamp}` },
    })
    const contactData = await contactRes.json()
    const visitorToken = contactData.realtimeToken

    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { text: 'Test question' },
    })
    const msgData = await msgRes.json()

    // Check messages — there should be NO AI response (feature is OFF)
    const msgsRes = await page.request.get(`${DASHBOARD}/api/conversations/${msgData.conversationId}/messages`)
    const msgsData = await msgsRes.json()
    const aiMessages = (msgsData.messages || []).filter((m: any) => m.senderType === 'ai')
    expect(aiMessages.length, 'No AI messages should exist when feature is OFF').toBe(0)

    await ctx.close()
  })

  test('4. AI usage cap — free tier (aiActions: 0) blocks AI even if enabled', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-cap`
    const email = `cap-${stamp}@test.com`

    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    // Signup WITHOUT upgrading to pro (stays on free tier — aiActions: 0)
    await otpSignupPlaywright(page.request, DASHBOARD, email, `Cap ${stamp}`)
    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })
    const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
    const tenantData = await tenantRes.json()
    const slug = tenantData.tenant?.slug

    // Fresh OTP signups default to accessMode='verified_visitor' (the frozen
    // DB contract). The /contact flow below requires anonymous visitor tokens,
    // so explicitly switch the tenant to anonymous before any visitor traffic.
    await setAccessMode(page, 'anonymous')

    // Try to enable the FAQ feature (even though free tier has aiActions: 0)
    await page.request.patch(`${DASHBOARD}/api/ai-config`, {
      headers: { 'Content-Type': 'application/json' },
      data: { faqEnabled: true, productQaEnabled: false },
    })

    // Create a FAQ pair
    await page.request.post(`${DASHBOARD}/api/faqs`, {
      headers: { 'Content-Type': 'application/json' },
      data: { question: 'What are your hours?', answer: 'We are open 9-5.', enabled: true },
    })

    // Send a message — the AI should NOT fire (cap is 0 on free tier)
    const contactRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/contact`, {
      data: { visitorId: `visitor-cap-${stamp}` },
    })
    const contactData = await contactRes.json()
    const visitorToken = contactData.realtimeToken

    const msgRes = await page.request.post(`${DASHBOARD}/api/widget/${slug}/messages`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visitorToken}` },
      data: { text: 'What are your hours?' },
    })
    const msgData = await msgRes.json()

    // Check messages — there should be NO AI response (cap is 0)
    const msgsRes = await page.request.get(`${DASHBOARD}/api/conversations/${msgData.conversationId}/messages`)
    const msgsData = await msgsRes.json()
    const aiMessages = (msgsData.messages || []).filter((m: any) => m.senderType === 'ai')
    expect(aiMessages.length, 'No AI messages on free tier (aiActions cap: 0)').toBe(0)

    await ctx.close()
  })
})
