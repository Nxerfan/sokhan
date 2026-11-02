import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/** Reviewer-owned Feature 11 Context Chat: real Full/Lite backend + 3 runtimes.
 * No mocked config, synthetic DOM, fake message persistence, fixed sleeps or retries.
 * The visitor explicitly consents before ONE message can carry page context.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
type Surface = 'slug' | 'v1' | 'npm'
let npmBuilt = false
const pageContext = { pathname: '/products/example', title: 'Example product' }

async function signup(page: Page, scenario: string) {
  const stamp = scenario + '-' + process.pid + '-' + Date.now()
  const email = 'ctx-' + stamp + '@test.com'
  // Unique scenario prefix must appear before OTP helper truncates workspace slug.
  const registered = await otpSignupPlaywright(page.request, DASHBOARD, email, 'CTX-' + stamp)
  expect(registered.ok).toBe(true)
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
async function plan(page: Page, value: 'free' | 'pro') {
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan: value }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, enabled: unknown, expected = 200) {
  const response = await page.request.patch(BASE + '/api/widget-config', {
    data: { contextChat: { enabled } }, headers: { 'Content-Type': 'application/json' },
  })
  expect(response.status(), await response.text()).toBe(expected)
}
async function getPublic(page: Page, slug: string) {
  const r = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}
async function ownerConfig(page: Page) {
  const r = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
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
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No customer server')
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
    ? '<!doctype html><html><head><title>Example product</title></head><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
    : surface === 'v1'
      ? '<!doctype html><html><head><title>Example product</title></head><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
      : '<!doctype html><html><head><title>Example product</title></head><body></body></html>'
  const site = await serve(html, surface === 'npm')
  const page = await ctx.newPage()
  try {
    const bootstrap = page.waitForResponse(r => r.request().method() === 'POST' &&
      r.url().includes('/api/widget/' + slug + '/contact') && r.status() === 200, { timeout: 20_000 })
    await page.goto(site.url + '/products/example?session=DO_NOT_SEND#fragment', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async params => {
        const mod = await import(window.location.origin + '/index.js')
        ;(window as unknown as { __ctxWidget: { destroy(): void } }).__ctxWidget =
          mod.initSukhan({ apiKey: params.slug, apiUrl: params.origin })
      }, { slug, origin: BASE })
    }
    const res = await bootstrap
    await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
    const data = await res.json()
    return { page, token: data.realtimeToken as string, close: async () => {
      try { await page.close() } finally { await site.close() }
    } }
  } catch (e) {
    try { await page.close() } finally { await site.close() }
    throw e
  }
}
async function open(page: Page) {
  await page.locator('.sk-launcher').click()
  await expect(page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
}
async function send(page: Page, slug: string, text: string) {
  const res = page.waitForResponse(r => r.request().method() === 'POST' &&
    r.url().includes('/api/widget/' + slug + '/messages'), { timeout: 20_000 })
  await page.locator('.sk-input input').fill(text)
  await page.locator('.sk-input input').press('Enter')
  const response = await res
  expect(response.status(), await response.text()).toBe(200)
  return response.json()
}

test.describe('Reviewer — Widget V2 Context Chat / Feature 11', () => {
  test('Free has no context capability and rejects both toggle writes', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'free')
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: false })
      await patch(owner, true, 403)
      await patch(owner, false, 403)
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: false })
    } finally { await ctx.close() }
  })
  test('Paid on → Free downgrade off → upgrade restores stored preference', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'downgrade')
      await plan(owner, 'pro')
      await patch(owner, true)
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: true })
      await plan(owner, 'free')
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: false })
      expect((await ownerConfig(owner)).config.appearanceV2.contextChat).toEqual({ enabled: true })
      await plan(owner, 'pro')
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: true })
      await patch(owner, false)
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: false })
    } finally { await ctx.close() }
  })
  test('Reject malformed and client-plan-overriding PATCHes without changing saved config', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'invalid')
      await plan(owner, 'pro')
      await patch(owner, true)
      for (const raw of [null, [], {}, true, 'true', { enabled: 1 },
        { enabled: 'true' }, { enabled: true, plan: 'pro' },
        { enabled: true, scrapeDOM: true }]) {
        const response = await owner.request.patch(BASE + '/api/widget-config', { data: { contextChat: raw } })
        expect(response.status(), await response.text()).toBeGreaterThanOrEqual(400)
      }
      expect((await getPublic(owner, slug)).contextChat).toEqual({ enabled: true })
    } finally { await ctx.close() }
  })
  test('New feature true-patch preserves Smart Avoidance, Page Visibility, and contact buttons', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'truepatch')
      await plan(owner, 'pro')
      for (const body of [
        { smartAvoidance: { enabled: true } },
        { pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact', action: 'hide' }] } },
        { alternativeContactButtons: { items: [{ kind: 'email', label: 'Email', value: 'support@example.com' }] } },
      ]) {
        const r = await owner.request.patch(BASE + '/api/widget-config', { data: body })
        expect(r.ok(), await r.text()).toBe(true)
      }
      await patch(owner, true)
      const cfg = await getPublic(owner, slug)
      expect(cfg.contextChat).toEqual({ enabled: true })
      expect(cfg.smartAvoidance).toEqual({ enabled: true })
      expect(cfg.pageVisibility.rules).toHaveLength(1)
      expect(cfg.alternativeContactButtons.items).toHaveLength(1)
    } finally { await ctx.close() }
  })
  test('Dashboard Free locked, Pro Save/Discard/reload, clear BETA label', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'dashboard')
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('context-chat-panel')).toBeVisible()
      await expect(owner.getByTestId('context-chat-enabled')).toBeDisabled()
      await plan(owner, 'pro')
      await owner.reload()
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      const toggle = owner.getByTestId('context-chat-enabled')
      await expect(toggle).toBeEnabled()
      await toggle.click()
      await owner.getByTestId('context-chat-discard').click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.click()
      const saved = owner.waitForResponse(r => r.url().endsWith('/api/widget-config') && r.request().method() === 'PATCH')
      await owner.getByTestId('context-chat-save').click()
      expect((await saved).status()).toBe(200)
      await owner.reload()
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('context-chat-enabled')).toHaveAttribute('aria-checked', 'true')
    } finally { await ctx.close() }
  })
  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test(surface + ': visitor explicitly shares current page ONCE, persisted message contains safe snapshot', async ({ browser }) => {
      const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
      let site: Awaited<ReturnType<typeof customer>> | null = null
      try {
        const owner = await ownerCtx.newPage(), slug = await signup(owner, 'surface-' + surface)
        await plan(owner, 'pro')
        await setAccessMode(owner, 'anonymous')
        await patch(owner, true)
        site = await customer(visitorCtx, slug, surface)
        await open(site.page)
        await expect(site.page.getByTestId('context-chat-share')).toBeVisible()
        await expect(site.page.getByTestId('context-chat-indicator')).toHaveCount(0)
        await site.page.getByTestId('context-chat-share').click()
        await expect(site.page.getByTestId('context-chat-indicator')).toBeVisible()
        const reply = await send(site.page, slug, 'Can you help with this product?')
        expect(reply.message?.content?.pageContext).toEqual(pageContext)
        expect(JSON.stringify(reply.message?.content)).not.toContain('DO_NOT_SEND')
        expect(JSON.stringify(reply.message?.content)).not.toContain('fragment')
        await expect(site.page.getByTestId('context-chat-indicator')).toHaveCount(0)
        const second = await send(site.page, slug, 'Another question')
        expect(second.message?.content?.pageContext).toBeUndefined()
      } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
    })
  }
  test('Visitor can cancel a page attachment; no context is stored without consent', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | null = null
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'cancel')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, true)
      site = await customer(visitorCtx, slug, 'slug')
      await open(site.page)
      await site.page.getByTestId('context-chat-share').click()
      await expect(site.page.getByTestId('context-chat-indicator')).toBeVisible()
      await site.page.getByTestId('context-chat-clear').click()
      await expect(site.page.getByTestId('context-chat-indicator')).toHaveCount(0)
      const sent = await send(site.page, slug, 'No context please')
      expect(sent.message?.content?.pageContext).toBeUndefined()
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
  test('Free cannot persist forged pageContext through authenticated visitor message POST', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | null = null
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'forged')
      await setAccessMode(owner, 'anonymous')
      site = await customer(visitorCtx, slug, 'slug')
      await open(site.page)
      await expect(site.page.getByTestId('context-chat-share')).toHaveCount(0)
      const forged = await site.page.request.post(BASE + '/api/widget/' + slug + '/messages', {
        data: { text: 'Forged context attempt', pageContext },
        headers: { authorization: 'Bearer ' + site.token, 'Content-Type': 'application/json' },
      })
      expect(forged.ok(), await forged.text()).toBe(true)
      const result = await forged.json()
      expect(result.message?.content?.pageContext).toBeUndefined()
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
  test('Page Visibility wins over Context Chat, no visible share control on hidden route', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | null = null
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'visibility')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, true)
      const r = await owner.request.patch(BASE + '/api/widget-config', {
        data: { pageVisibility: { rules: [{ pattern: '/checkout', match: 'exact', action: 'hide' }] } },
      })
      expect(r.ok(), await r.text()).toBe(true)
      site = await customer(visitorCtx, slug, 'slug')
      await open(site.page)
      await expect(site.page.getByTestId('context-chat-share')).toBeVisible()
      await site.page.evaluate(() => history.pushState({}, '', '/checkout'))
      await expect(site.page.locator('.sk-root')).toHaveCSS('display', 'none')
      await expect(site.page.getByTestId('context-chat-share')).not.toBeVisible()
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
})
