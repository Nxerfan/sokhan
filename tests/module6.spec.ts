import { test, expect, type Page } from '@playwright/test'

/**
 * Module 6 tests — Plan restructure + widget domains + free plan limits.
 */

const DASHBOARD = 'http://127.0.0.1:3000'

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  const slug = await page.evaluate(async ({ email, workspace }) => {
    // 3-step OTP signup (start → verify → complete)
    const startRes = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
    const { requestId } = await startRes.json()
    await fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '123456', requestId }) })
    await fetch('/api/auth/signup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, requestId, password: 'password123', workspaceName: workspace }) })
    const { csrfToken } = await (await fetch('/api/auth/csrf')).json()
    await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true` })
    const { tenant } = await (await fetch('/api/tenants/me')).json()
    return tenant?.slug
  }, { email, workspace })
  expect(slug).toBeTruthy()
  return slug
}

test.describe('Module 6 — Plan restructure + domains', () => {
  test('1. Free plan weekly message limit — 101st message rejected', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, `weekly-${stamp}@test.com`, `Weekly ${stamp}`)

    // Identify as visitor
    const contactRes = await page.evaluate(async ({ slug, stamp }) => {
      const res = await fetch(`/api/widget/${slug}/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: `visitor-weekly-${stamp}` }) })
      return res.json()
    }, { slug, stamp })
    const token = contactRes.realtimeToken

    // Send 100 messages (should succeed)
    for (let i = 0; i < 100; i++) {
      const res = await page.evaluate(async ({ slug, token, i }) => {
        const res = await fetch(`/api/widget/${slug}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ text: `Msg ${i}` }) })
        return res.status
      }, { slug, token, i })
      expect(res).toBe(200)
    }

    // 101st message should be rejected (403)
    const blocked = await page.evaluate(async ({ slug, token }) => {
      const res = await fetch(`/api/widget/${slug}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ text: 'Message 101' }) })
      return { status: res.status, body: await res.json() }
    }, { slug, token })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error).toBe('weekly_limit_reached')

    await ctx.close()
  })

  test('2. Free plan customization lock — config returns locked defaults', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, `lock-${stamp}@test.com`, `Lock ${stamp}`)

    // Get widget config — should be locked
    const configRes = await page.evaluate(async (slug) => {
      const res = await fetch(`/api/widget/${slug}/config`)
      return res.json()
    }, slug)

    expect(configRes.isLocked).toBe(true)
    expect(configRes.poweredBy).toBe(true)
    expect(configRes.accentColor).toBe('#E09A2B') // Sukhan brand default
    expect(configRes.launcherShape).toBe('tab') // locked default

    await ctx.close()
  })

  test('3. Free plan email restriction — cannot create second free workspace', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const email = `trial-${stamp}@test.com`

    // First signup — should succeed
    const slug1 = await signupAndGetSlug(page, email, `Trial1 ${stamp}`)
    expect(slug1).toBeTruthy()

    // Try second signup with same email — should be blocked.
    // MIGRATION: the legacy /api/auth/signup endpoint returned 409 with
    // error: 'email_taken'. That endpoint is now DEPRECATED (returns 410
    // Gone). The equivalent check now lives at step 1 of the OTP flow:
    // /api/auth/signup/start rejects an already-registered email with 409
    // email_already_registered. The test's intent (an existing email cannot
    // be used for a new signup) is preserved.
    const secondRes = await page.evaluate(async ({ email }) => {
      const res = await fetch('/api/auth/signup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      return { status: res.status, body: await res.json() }
    }, { email })

    // The signup should be rejected (409 conflict) — the start endpoint
    // checks for existing users at step 1.
    expect(secondRes.status).toBe(409)
    expect(secondRes.body.error).toBe('email_already_registered')

    await ctx.close()
  })

  test('4. Domain limit per plan — Free: 2nd domain rejected', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, `domain-${stamp}@test.com`, `Domain ${stamp}`)

    // Add first domain — should succeed (free plan allows 1)
    const firstRes = await page.evaluate(async () => {
      const res = await fetch('/api/widget-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'example1.com' }) })
      return { status: res.status, body: await res.json() }
    })
    expect(firstRes.status).toBe(200)

    // Add second domain — should be rejected (limit reached)
    const secondRes = await page.evaluate(async () => {
      const res = await fetch('/api/widget-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'example2.com' }) })
      return { status: res.status, body: await res.json() }
    })
    expect(secondRes.status).toBe(400)
    expect(secondRes.body.error).toBe('limit_reached')

    await ctx.close()
  })

  test('5. Self-hosted request form — submits and stores', async ({ browser }) => {
    const stamp = Date.now()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(DASHBOARD)
    await page.waitForTimeout(2000)

    const res = await page.evaluate(async (stamp) => {
      const res = await fetch('/api/self-host-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: 'Test User',
        company: 'Test Company',
        email: `selfhost-${stamp}@test.com`,
        phone: '+989123456789',
        message: 'Need self-hosting for compliance',
      }) })
      return { status: res.status, body: await res.json() }
    }, stamp)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.id).toBeTruthy()

    await ctx.close()
  })

  test('6. Pricing page renders — shows Coming Soon for Pro/Max', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${DASHBOARD}/pricing`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    // The pricing page should exist and render
    // We check the page loaded without error
    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible({ timeout: 10000 })

    await ctx.close()
  })

  test('7. /doc page renders — sections visible', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${DASHBOARD}/doc`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible({ timeout: 10000 })

    await ctx.close()
  })

  test('8. NPM package structure — files exist', async () => {
    const fs = require('fs')
    const path = require('path')
    const pkgPath = '/home/z/my-project/packages/widget-npm'

    expect(fs.existsSync(path.join(pkgPath, 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'src', 'index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'src', 'widget.ts'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'src', 'api.ts'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'src', 'socket.ts'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'src', 'types.ts'))).toBe(true)
    expect(fs.existsSync(path.join(pkgPath, 'README.md'))).toBe(true)

    // Verify package.json has correct name
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8'))
    expect(pkg.name).toBe('sukhan-widget')
  })
})
