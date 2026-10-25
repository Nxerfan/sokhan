import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget Domains — behavioral regression (stabilization audit,
 * journeys 11 + 12).
 *
 * Proves: valid domain add, normalization (scheme+case), duplicate
 * rejection, invalid-domain rejection, delete, cross-tenant isolation,
 * and the REAL domain enforcement on the public widget config endpoint:
 * an authorized Origin is served, an unauthorized Origin is blocked with
 * 403 domain_not_allowed.
 *
 * Uses dev/set-plan('pro') for the 3-domain website allowance so the
 * matrix does not fight the free plan's 1-domain limit (the free-limit
 * path is already covered by onboarding.spec.ts).
 *
 * This spec runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return { email: `dom-${stamp}@test.com`, workspace: `Dom ${stamp}` }
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
  await page.waitForTimeout(1500)
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const slug = (await tenantRes.json()).tenant?.slug
  expect(slug, 'slug should be set').toBeTruthy()
  return slug as string
}

test.describe('Widget domains — validation, isolation, enforcement', () => {
  test('domain matrix: invalid rejected, normalization, duplicate, delete, tenant isolation', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('a')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // Allow 3 domains (pro) so the matrix doesn't hit the free 1-domain cap.
    const planRes = await page.request.post(`${BASE}/api/invitations/dev/set-plan`, {
      data: { plan: 'pro' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(planRes.ok()).toBeTruthy()

    const addDomain = (domain: string) =>
      page.request.post(`${BASE}/api/widget-domains`, {
        data: { domain },
        headers: { 'Content-Type': 'application/json' },
      })

    // ---- Invalid domains are rejected (strict validator) ----
    for (const bad of ['bad..com', '-bad.example.com', 'a_b.example.com', 'example', '']) {
      const res = await addDomain(bad)
      expect(res.status(), `domain ${JSON.stringify(bad)} must be rejected`).toBe(400)
      expect((await res.json()).error).toBe('invalid_domain')
    }

    // ---- Normalization: scheme + case are normalized to the hostname ----
    const normRes = await addDomain('https://Shop.Example.COM')
    expect(normRes.status()).toBe(200)
    const list1 = await (await page.request.get(`${BASE}/api/widget-domains`)).json()
    expect(list1.domains.map((d: { domain: string }) => d.domain)).toContain('shop.example.com')

    // ---- Duplicate rejection ----
    const dupRes = await addDomain('shop.example.com')
    expect(dupRes.status()).toBe(400)
    expect((await dupRes.json()).error).toBe('already_exists')

    // ---- Cross-tenant isolation: tenant B cannot delete tenant A's domain ----
    const ctxB = await browser.newContext()
    const pageB = await ctxB.newPage()
    const credsB = creds('b')
    await signupAndGetSlug(pageB, credsB.email, credsB.workspace)
    const domainIdA = list1.domains.find(
      (d: { domain: string }) => d.domain === 'shop.example.com',
    )?.id
    expect(domainIdA).toBeTruthy()
    const crossRes = await pageB.request.delete(`${BASE}/api/widget-domains?id=${domainIdA}`)
    expect(crossRes.status(), 'cross-tenant domain delete must be rejected').toBe(404)

    // Tenant B's list does NOT contain tenant A's domain.
    const listB = await (await pageB.request.get(`${BASE}/api/widget-domains`)).json()
    expect(listB.domains.map((d: { domain: string }) => d.domain)).not.toContain('shop.example.com')

    // ---- Domain enforcement on the PUBLIC widget config (authorized vs blocked) ----
    // Authorized Origin (the configured domain) -> served.
    const okCfg = await pageB.request.get(`${BASE}/api/widget/${slug}/config`, {
      headers: { Origin: 'https://shop.example.com' },
    })
    expect(okCfg.status(), 'authorized origin must be served').toBe(200)
    // Unauthorized Origin -> blocked with 403 domain_not_allowed.
    const badCfg = await pageB.request.get(`${BASE}/api/widget/${slug}/config`, {
      headers: { Origin: 'https://evil.example.net' },
    })
    expect(badCfg.status(), 'unauthorized origin must be blocked').toBe(403)
    expect((await badCfg.json()).error).toBe('domain_not_allowed')

    // ---- Delete works for the owning tenant ----
    const delRes = await page.request.delete(`${BASE}/api/widget-domains?id=${domainIdA}`)
    expect(delRes.status()).toBe(200)
    const list2 = await (await page.request.get(`${BASE}/api/widget-domains`)).json()
    expect(list2.domains.map((d: { domain: string }) => d.domain)).not.toContain('shop.example.com')

    // After deleting the last domain, the list is empty and the config
    // endpoint is served again (allow-all when no domains are configured —
    // the documented backward-compat behavior).
    const postDeleteCfg = await pageB.request.get(`${BASE}/api/widget/${slug}/config`, {
      headers: { Origin: 'https://anywhere.example.org' },
    })
    expect(postDeleteCfg.status()).toBe(200)

    await ctxB.close()
    await ctx.close()
  })
})
