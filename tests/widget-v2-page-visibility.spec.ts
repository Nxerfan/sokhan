import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/** Reviewer-owned REAL browser acceptance: Page Visibility / PR #23.
 * No mocked configuration, synthetic widget DOM, artificial API responses,
 * retries or fixed waits. Uses actual Full/Lite HTTP stacks and 3 runtimes.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
type Surface = 'slug' | 'v1' | 'npm'
let npmBuilt = false
const r = (pattern: string, action: 'show' | 'hide', match: 'exact' | 'prefix' = 'exact', device?: 'mobile' | 'desktop') =>
  ({ pattern, action, match, ...(device ? { device } : {}) })

async function signup(page: Page, label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  const email = 'visibility-' + stamp + '@test.com'
  const created = await otpSignupPlaywright(page.request, DASHBOARD, email, 'PV-' + label + '-' + stamp)
  expect(created.ok).toBe(true)
  const csrf = await page.request.get(DASHBOARD + '/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const { csrfToken } = await csrf.json()
  const login = await page.request.post(DASHBOARD + '/api/auth/callback/credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'email=' + email + '&password=password123&csrfToken=' + csrfToken + '&json=true',
  })
  expect(login.status()).toBeLessThan(500)
  await page.goto(BASE)
  const tenant = await page.request.get(DASHBOARD + '/api/tenants/me')
  expect(tenant.ok()).toBe(true)
  const slug = (await tenant.json()).tenant?.slug as string | undefined
  expect(slug).toBeTruthy()
  return slug!
}
async function plan(page: Page, name: 'free' | 'pro') {
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', { data: { plan: name } })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, rules: ReturnType<typeof r>[], expected = 200) {
  const res = await page.request.patch(BASE + '/api/widget-config', {
    data: { pageVisibility: { rules } }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(expected)
  return res
}
async function publicConfig(page: Page, slug: string) {
  const response = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
async function ownerConfig(page: Page) {
  const response = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
async function serve(html: string, npm: boolean) {
  const server = createServer((req, res) => {
    const filename = req.url?.slice(1) ?? ''
    if (npm && /^[A-Za-z0-9_-]+\.js$/.test(filename) && existsSync(join(DIST, filename))) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(readFileSync(join(DIST, filename)))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    }
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No customer server address')
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((ok, fail) => {
      server.closeAllConnections()
      server.close(err => err ? fail(err) : ok())
    }),
  }
}
async function customer(ctx: BrowserContext, slug: string, surface: Surface) {
  if (surface === 'npm' && !npmBuilt) {
    execSync('bun run build', { cwd: resolve(process.cwd(), 'packages/widget-npm'), stdio: 'pipe' })
    npmBuilt = true
  }
  const html = surface === 'slug'
    ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
    : surface === 'v1'
      ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
      : '<!doctype html><html><body></body></html>'
  const site = await serve(html, surface === 'npm')
  const page = await ctx.newPage()
  try {
    const contact = page.waitForResponse(x =>
      x.request().method() === 'POST' && x.url().includes('/api/widget/' + slug + '/contact') && x.status() === 200,
      { timeout: 20_000 })
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async args => {
        const mod = await import(window.location.origin + '/index.js')
        ;(window as unknown as { __reviewWidget: { destroy(): void } }).__reviewWidget =
          mod.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    await contact
    await expect(page.locator('.sk-root')).toHaveCount(1, { timeout: 15_000 })
    return {
      page,
      close: async () => { try { await page.close() } finally { await site.close() } },
    }
  } catch (e) {
    try { await page.close() } finally { await site.close() }
    throw e
  }
}
async function visibility(page: Page, expected: 'show' | 'hide') {
  await expect(page.locator('.sk-root')).toHaveAttribute('data-sk-page-visibility', expected, { timeout: 15_000 })
  await expect(page.locator('.sk-root')).toHaveCSS('display', expected === 'hide' ? 'none' : 'block')
}
async function navigate(page: Page, method: 'pushState' | 'replaceState', path: string) {
  await page.evaluate(({ method, path }) => history[method]({}, '', path), { method, path })
}

test.describe('Reviewer — Widget V2 Page Visibility (Feature 8)', () => {
  test('Free: exact URL rules only; block prefix/device/4th rule, public config does not leak paidRules', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'free')
      const basic = [r('/checkout', 'hide')]
      await patch(owner, basic)
      expect((await publicConfig(owner, slug)).pageVisibility).toEqual({ rules: basic })
      for (const paid of [r('/shop', 'hide', 'prefix'), r('/checkout', 'hide', 'exact', 'mobile')]) {
        await patch(owner, [paid], 403)
      }
      await patch(owner, [r('/1', 'hide'), r('/2', 'hide'), r('/3', 'hide'), r('/4', 'hide')], 403)
      expect((await publicConfig(owner, slug)).pageVisibility.rules).toEqual(basic)
    } finally { await ctx.close() }
  })

  test('Pro device-specific exact rule NEVER leaks into Free effective config after downgrade', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'downgrade')
      await plan(owner, 'pro')
      const paid = [r('/checkout', 'hide', 'exact', 'mobile'), r('/account', 'hide', 'exact', 'desktop')]
      await patch(owner, paid)
      expect((await publicConfig(owner, slug)).pageVisibility.rules).toEqual(paid)
      await plan(owner, 'free')
      expect((await publicConfig(owner, slug)).pageVisibility.rules,
        'Free must never receive device-scoped paid rules').toEqual([])
      const basic = [r('/privacy', 'hide')]
      await patch(owner, basic)
      const stored = (await ownerConfig(owner)).config.appearanceV2.pageVisibility
      expect(stored.paidRules).toEqual(paid)
      expect((await publicConfig(owner, slug)).pageVisibility.rules).toEqual(basic)
      await plan(owner, 'pro')
      expect((await publicConfig(owner, slug)).pageVisibility.rules).toEqual(paid)
      await patch(owner, basic)
      expect((await ownerConfig(owner)).config.appearanceV2.pageVisibility.paidRules).toBeUndefined()
    } finally { await ctx.close() }
  })

  test('Invalid payloads and unrelated V2 PATCHes cannot corrupt page rules', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'invalid')
      await plan(owner, 'pro')
      const valid = [r('/checkout', 'hide')]
      await patch(owner, valid)
      for (const raw of [null, [], {}, { rules: 'bad' }, { rules: [r('checkout', 'hide')] },
        { rules: [r('/*', 'hide')] }, { rules: [r('/checkout', 'hide'), r('/checkout', 'hide')] },
        { rules: valid, paidRules: [r('/private', 'hide')] }]) {
        const reply = await owner.request.patch(BASE + '/api/widget-config', { data: { pageVisibility: raw } })
        expect(reply.status(), 'Bad page rule payload must be rejected').toBeGreaterThanOrEqual(400)
      }
      const color = await owner.request.patch(BASE + '/api/widget-config', {
        data: { colors: { mode: 'preset', presetId: 'emerald' } },
      })
      expect(color.ok(), await color.text()).toBe(true)
      expect((await publicConfig(owner, slug)).pageVisibility.rules).toEqual(valid)
    } finally { await ctx.close() }
  })

  test('Free dashboard Save, Discard, reload, and paid match selector gating', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'dashboard')
      const nav = owner.getByRole('navigation', { name: 'primary' })
      await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('page-visibility-panel')).toBeVisible()
      await owner.getByTestId('page-visibility-add').click()
      await expect(owner.getByTestId('page-visibility-match-0')).toBeDisabled()
      await owner.getByTestId('page-visibility-pattern-0').fill('/checkout')
      await owner.getByTestId('page-visibility-discard').click()
      await expect(owner.getByTestId('page-visibility-rule-0')).toHaveCount(0)
      await owner.getByTestId('page-visibility-add').click()
      await owner.getByTestId('page-visibility-pattern-0').fill('/checkout')
      const posted = owner.waitForResponse(x => x.url().endsWith('/api/widget-config') && x.request().method() === 'PATCH')
      await owner.getByTestId('page-visibility-save').click()
      expect((await posted).status()).toBe(200)
      await owner.reload()
      const nav2 = owner.getByRole('navigation', { name: 'primary' })
      await nav2.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('page-visibility-pattern-0')).toHaveValue('/checkout')
    } finally { await ctx.close() }
  })

  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test(surface + ': real widget hides on checkout and restores on SPA push/replace/back without duplicate roots', async ({ browser }) => {
      const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'spa-' + surface)
        await setAccessMode(owner, 'anonymous')
        await patch(owner, [r('/checkout', 'hide')])
        site = await customer(visitorCtx, slug, surface)
        await visibility(site.page, 'show')
        await navigate(site.page, 'pushState', '/checkout')
        await visibility(site.page, 'hide')
        await navigate(site.page, 'replaceState', '/products')
        await visibility(site.page, 'show')
        await navigate(site.page, 'pushState', '/checkout')
        await visibility(site.page, 'hide')
        await site.page.goBack()
        await visibility(site.page, 'show')
        await expect(site.page.locator('.sk-root')).toHaveCount(1)
      } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
    })
  }

  test('Pro root prefix / hides all nested routes, not just the home page', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'rootprefix')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, [r('/', 'hide', 'prefix')])
      site = await customer(visitorCtx, slug, 'slug')
      await visibility(site.page, 'hide')
      await navigate(site.page, 'pushState', '/checkout')
      await visibility(site.page, 'hide')
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })

  test('Pro mobile-only rule follows viewport, does not hide desktop widget', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'device')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, [r('/customer.html', 'hide', 'exact', 'mobile')])
      site = await customer(visitorCtx, slug, 'npm')
      await visibility(site.page, 'show')
      await site.page.setViewportSize({ width: 375, height: 812 })
      await visibility(site.page, 'hide')
      await site.page.setViewportSize({ width: 1280, height: 800 })
      await visibility(site.page, 'show')
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })

  test('NPM destroy removes widget and restores original host navigation behavior', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'destroy')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, [r('/checkout', 'hide')])
      site = await customer(visitorCtx, slug, 'npm')
      await visibility(site.page, 'show')
      await site.page.evaluate(() => (window as unknown as { __reviewWidget: { destroy(): void } }).__reviewWidget.destroy())
      await expect(site.page.locator('.sk-root')).toHaveCount(0)
      await navigate(site.page, 'pushState', '/checkout')
      expect(new URL(site.page.url()).pathname).toBe('/checkout')
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
})
