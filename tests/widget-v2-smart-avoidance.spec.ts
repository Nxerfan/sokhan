import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Independent real-browser Feature 10 Smart Avoidance acceptance.
 * All tests run against actual Full/Lite stacks and real external-origin widgets.
 * No route mocks, synthetic widget DOM, fixed delays, retries, or fake config.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
type Surface = 'slug' | 'v1' | 'npm'
let npmBuilt = false

async function signup(page: Page, label: string) {
  const stamp = [label, process.pid, Date.now()].join('-')
  const email = 'avoid-' + stamp + '@test.com'
  // Start with a unique scenario label: workspace slugs are truncated to 24 chars.
  const created = await otpSignupPlaywright(page.request, DASHBOARD, email, 'SA-' + stamp)
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
async function setPlan(page: Page, name: 'free' | 'pro') {
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan: name }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, enabled: unknown, expected = 200) {
  const res = await page.request.patch(BASE + '/api/widget-config', {
    data: { smartAvoidance: { enabled } }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(expected)
  return res
}
async function publicConfig(page: Page, slug: string) {
  const res = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
async function ownerConfig(page: Page) {
  const res = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
async function serve(html: string, npm: boolean) {
  const server = createServer((req, res) => {
    const filename = req.url?.slice(1) ?? ''
    if (npm && /^[A-Za-z0-9_-]+\.js$/.test(filename) && existsSync(join(DIST, filename))) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(readFileSync(join(DIST, filename)))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('No customer server address')
  return {
    url: 'http://127.0.0.1:' + addr.port,
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
    const ready = page.waitForResponse(r => r.request().method() === 'POST' &&
      r.url().includes('/api/widget/' + slug + '/contact') && r.status() === 200, { timeout: 20_000 })
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async args => {
        const pkg = await import(window.location.origin + '/index.js')
        pkg.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    await ready
    await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
    return { page, close: async () => { try { await page.close() } finally { await site.close() } } }
  } catch (e) {
    try { await page.close() } finally { await site.close() }
    throw e
  }
}
async function addHostOverlay(page: Page) {
  return page.evaluate(() => {
    const launcher = document.querySelector('.sk-launcher')!.getBoundingClientRect()
    const banner = document.createElement('div')
    banner.id = 'host-cookie-banner'
    banner.setAttribute('data-sukhan-avoid', '')
    banner.style.position = 'fixed'
    banner.style.left = Math.max(0, launcher.left - 8) + 'px'
    banner.style.top = Math.max(0, launcher.top - 8) + 'px'
    banner.style.width = launcher.width + 16 + 'px'
    banner.style.height = launcher.height + 16 + 'px'
    banner.style.background = '#b91c1c'
    banner.style.zIndex = '100'
    banner.textContent = 'Host cookie choices'
    document.body.appendChild(banner)
    return { left: launcher.left, top: launcher.top, width: launcher.width, height: launcher.height }
  })
}
async function isSeparated(page: Page) {
  return page.evaluate(() => {
    const launcher = document.querySelector('.sk-launcher')!.getBoundingClientRect()
    const banner = document.querySelector('#host-cookie-banner')!.getBoundingClientRect()
    const gap = 8
    return launcher.right + gap <= banner.left ||
      launcher.left >= banner.right + gap ||
      launcher.bottom + gap <= banner.top ||
      launcher.top >= banner.bottom + gap
  })
}

test.describe('Reviewer — Smart Avoidance Feature 10 / Real browser', () => {
  test('Free is disabled, and both true and false PATCH are denied', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'free')
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: false })
      await patch(owner, true, 403)
      await patch(owner, false, 403)
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: false })
    } finally { await ctx.close() }
  })

  test('Paid enable persists; Free downgrade prevents runtime exposure; upgrading restores', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'downgrade')
      await setPlan(owner, 'pro')
      await patch(owner, true)
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: true })
      await setPlan(owner, 'free')
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: false })
      const saved = await ownerConfig(owner)
      expect(saved.config.appearanceV2.smartAvoidance).toEqual({ enabled: true })
      await setPlan(owner, 'pro')
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: true })
      await patch(owner, false)
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: false })
    } finally { await ctx.close() }
  })

  test('Malformed and cross-plan mutations reject without modifying saved setting', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'invalid')
      await setPlan(owner, 'pro')
      await patch(owner, true)
      for (const body of [
        { smartAvoidance: null }, { smartAvoidance: [] }, { smartAvoidance: {} },
        { smartAvoidance: { enabled: 1 } }, { smartAvoidance: { enabled: 'true' } },
        { smartAvoidance: { enabled: true, javascript: 'alert(1)' } },
        { smartAvoidance: { enabled: true, plan: 'pro' } },
      ]) {
        const response = await owner.request.patch(BASE + '/api/widget-config', { data: body })
        expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400)
      }
      expect((await publicConfig(owner, slug)).smartAvoidance).toEqual({ enabled: true })
    } finally { await ctx.close() }
  })

  test('Saving Smart Avoidance preserves page visibility and alternative contacts', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'truepatch')
      await setPlan(owner, 'pro')
      const pv = await owner.request.patch(BASE + '/api/widget-config', { data: { pageVisibility: {
        rules: [{ pattern: '/checkout', match: 'exact', action: 'hide' }],
      } } })
      expect(pv.ok(), await pv.text()).toBe(true)
      const cb = await owner.request.patch(BASE + '/api/widget-config', { data: { alternativeContactButtons: {
        items: [{ kind: 'email', label: 'Email', value: 'support@example.com' }],
      } } })
      expect(cb.ok(), await cb.text()).toBe(true)
      await patch(owner, true)
      const cfg = await publicConfig(owner, slug)
      expect(cfg.pageVisibility.rules).toEqual([{ pattern: '/checkout', match: 'exact', action: 'hide' }])
      expect(cfg.alternativeContactButtons.items).toHaveLength(1)
      expect(cfg.smartAvoidance).toEqual({ enabled: true })
    } finally { await ctx.close() }
  })

  test('Dashboard paid toggle Save/Discard/reload; Free feature locked', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'dashboard')
      const nav = owner.getByRole('navigation', { name: 'primary' })
      await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('smart-avoidance-panel')).toBeVisible()
      await expect(owner.getByTestId('smart-avoidance-enabled')).toBeDisabled()
      await setPlan(owner, 'pro')
      await owner.reload()
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      const toggle = owner.getByTestId('smart-avoidance-enabled')
      await expect(toggle).toBeEnabled()
      await toggle.click()
      await owner.getByTestId('smart-avoidance-discard').click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.click()
      const response = owner.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/api/widget-config'))
      await owner.getByTestId('smart-avoidance-save').click()
      expect((await response).status()).toBe(200)
      await owner.reload()
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('smart-avoidance-enabled')).toHaveAttribute('aria-checked', 'true')
    } finally { await ctx.close() }
  })

  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test(surface + ': live fixed host obstruction displaces launcher, removal restores original position', async ({ browser }) => {
      const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage(), slug = await signup(owner, 'surface-' + surface)
        await setPlan(owner, 'pro')
        await setAccessMode(owner, 'anonymous')
        await patch(owner, true)
        site = await customer(visitorCtx, slug, surface)
        const before = await site.page.locator('.sk-launcher').boundingBox()
        expect(before).not.toBeNull()
        await addHostOverlay(site.page)
        await expect.poll(() => isSeparated(site!.page), { timeout: 15_000 }).toBe(true)
        const during = await site.page.locator('.sk-launcher').boundingBox()
        expect(during).not.toBeNull()
        expect(Math.hypot((during?.x ?? 0) - before!.x, (during?.y ?? 0) - before!.y)).toBeGreaterThan(10)
        await site.page.evaluate(() => document.querySelector('#host-cookie-banner')?.remove())
        await expect.poll(async () => {
          const now = await site!.page.locator('.sk-launcher').boundingBox()
          return now ? Math.hypot(now.x - before!.x, now.y - before!.y) : Infinity
        }, { timeout: 15_000 }).toBeLessThanOrEqual(2)
        await expect(site.page.locator('.sk-root')).toHaveCount(1)
      } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
    })
  }

  test('Free runtime ignores tagged obstruction and retains configured placement', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'free-runtime')
      await setAccessMode(owner, 'anonymous')
      site = await customer(visitorCtx, slug, 'slug')
      const before = await site.page.locator('.sk-launcher').boundingBox()
      expect(before).not.toBeNull()
      await addHostOverlay(site.page)
      const after = await site.page.locator('.sk-launcher').boundingBox()
      expect(after).not.toBeNull()
      expect(Math.hypot(after!.x - before!.x, after!.y - before!.y)).toBeLessThanOrEqual(2)
      expect(await isSeparated(site.page)).toBe(false)
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })

  test('Smart Avoidance cannot override Page Visibility hide on SPA navigation', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'visibility')
      await setPlan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, true)
      const pv = await owner.request.patch(BASE + '/api/widget-config', { data: {
        pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact', action: 'hide' }] },
      } })
      expect(pv.ok(), await pv.text()).toBe(true)
      site = await customer(visitorCtx, slug, 'slug')
      await addHostOverlay(site.page)
      await site.page.evaluate(() => history.pushState({}, '', '/checkout'))
      await expect(site.page.locator('.sk-root')).toHaveCSS('display', 'none')
      await site.page.evaluate(() => history.replaceState({}, '', '/help'))
      await expect(site.page.locator('.sk-root')).toHaveAttribute('data-sk-page-visibility', 'show')
      await expect(site.page.locator('.sk-launcher')).toBeVisible()
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
})
