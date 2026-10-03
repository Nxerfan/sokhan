import { test, expect, type Page } from '@playwright/test'

/**
 * Module 7 — OTP-based authentication tests.
 * Uses NIXIFY_MOCK=true — mock OTP code is always "123456".
 */

const DASHBOARD = 'http://127.0.0.1:3000'

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  const slug = await page.evaluate(async ({ email, workspace }) => {
    await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', name: 'Agent', workspaceName: workspace }) })
    const { csrfToken } = await (await fetch('/api/auth/csrf')).json()
    await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true` })
    const { tenant } = await (await fetch('/api/tenants/me')).json()
    return tenant?.slug
  }, { email, workspace })
  expect(slug).toBeTruthy()
  return slug
}

test.describe('Module 7 — OTP Authentication', () => {
  test('1. Signup: full 3-step OTP flow (email → OTP → complete)', async ({ browser }) => {
    const stamp = Date.now()
    const email = `otp-signup-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    // Step 1: Start signup
    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return { status: res.status, body: await res.json() }
    }, email)
    expect(startRes.status).toBe(200)
    expect(startRes.body.requestId).toBeTruthy()

    // Step 2: Verify OTP
    const verifyRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '123456', requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.body.requestId })
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.verified).toBe(true)

    // Step 3: Complete signup
    const completeRes = await page.evaluate(async ({ email, requestId, workspaceName }) => {
      const res = await fetch('/api/auth/signup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, requestId, password: 'password123', workspaceName }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.body.requestId, workspaceName: `OTP Test ${stamp}` })
    expect(completeRes.status).toBe(200)
    expect(completeRes.body.ok).toBe(true)

    await ctx.close()
  })

  test('2. Signup: wrong OTP code rejected', async ({ browser }) => {
    const stamp = Date.now()
    const email = `otp-wrong-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return res.json()
    }, email)

    const verifyRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '999999', requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.requestId })
    expect(verifyRes.status).toBe(400)
    expect(verifyRes.body.error).toBe('code_mismatch')

    await ctx.close()
  })

  test('3. Signup: resend limit (3 max)', async ({ browser }) => {
    const stamp = Date.now()
    const email = `otp-resend-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return res.json()
    }, email)

    let currentRequestId = startRes.requestId

    // Resend 3 times
    for (let i = 0; i < 3; i++) {
      const resendRes = await page.evaluate(async ({ email, requestId }) => {
        const res = await fetch('/api/auth/otp/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, purpose: 'signup', originalRequestId: requestId }) })
        return { status: res.status, body: await res.json() }
      }, { email, requestId: currentRequestId })
      expect(resendRes.status).toBe(200)
      currentRequestId = resendRes.body.requestId
    }

    // 4th resend should be rejected
    const fourthRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/otp/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, purpose: 'signup', originalRequestId: requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: currentRequestId })
    expect(fourthRes.status).toBe(400)
    expect(fourthRes.body.error).toBe('resend_limit_reached')

    await ctx.close()
  })

  test('4. Login: password works (existing flow)', async ({ browser }) => {
    const stamp = Date.now()
    const email = `legacy-login-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    // Create user via legacy signup
    await page.evaluate(async (email) => {
      await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', name: 'Test', workspaceName: `Legacy ${Date.now()}` }) })
    }, email)

    // Login via credentials
    const loginRes = await page.evaluate(async (email) => {
      const { csrfToken } = await (await fetch('/api/auth/csrf')).json()
      const res = await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true` })
      return res.status
    }, email)
    expect(loginRes).toBe(200)

    await ctx.close()
  })

  test('5. Login: OTP flow (email → OTP → verified)', async ({ browser }) => {
    const stamp = Date.now()
    const email = `otp-login-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    // Create user first
    await page.evaluate(async (email) => {
      await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123', name: 'Test', workspaceName: `OTP Login ${Date.now()}` }) })
    }, email)

    // Start OTP login
    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/login-otp/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return { status: res.status, body: await res.json() }
    }, email)
    expect(startRes.status).toBe(200)
    expect(startRes.body.requestId).toBeTruthy()

    // Verify OTP
    const verifyRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/login-otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '123456', requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.body.requestId })
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.verified).toBe(true)

    await ctx.close()
  })

  test('6. Reset password: full 3-step flow', async ({ browser }) => {
    const stamp = Date.now()
    const email = `reset-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    // Create user
    await page.evaluate(async (email) => {
      await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'oldpassword', name: 'Test', workspaceName: `Reset ${Date.now()}` }) })
    }, email)

    // Step 1: Request reset
    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/reset-password/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return { status: res.status, body: await res.json() }
    }, email)
    expect(startRes.status).toBe(200)

    // Step 2: Verify OTP
    const verifyRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/reset-password/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '123456', requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.body.requestId })
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.verified).toBe(true)

    // Step 3: Set new password
    const completeRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/reset-password/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, requestId, newPassword: 'newpassword123' }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.body.requestId })
    expect(completeRes.status).toBe(200)
    expect(completeRes.body.ok).toBe(true)

    await ctx.close()
  })

  test('7. Legacy account works (existing users can still login)', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, `legacy-${stamp}@test.com`, `Legacy ${stamp}`)
    expect(slug).toBeTruthy()

    const tenantRes = await page.evaluate(async () => {
      const res = await fetch('/api/tenants/me')
      return res.json()
    })
    expect(tenantRes.tenant).toBeTruthy()

    await ctx.close()
  })

  test('8. Mock mode works — OTP code 123456 accepted', async ({ browser }) => {
    const stamp = Date.now()
    const email = `mock-${stamp}@test.com`
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    const startRes = await page.evaluate(async (email) => {
      const res = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return res.json()
    }, email)

    const verifyRes = await page.evaluate(async ({ email, requestId }) => {
      const res = await fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '123456', requestId }) })
      return { status: res.status, body: await res.json() }
    }, { email, requestId: startRes.requestId })
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.body.verified).toBe(true)

    await ctx.close()
  })
})
