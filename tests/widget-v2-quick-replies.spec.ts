import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Reviewer-owned Feature 6 browser qualification.
 * Real Full/Lite tenant, HTTP customer origin, authorized visitor bootstrap,
 * actual click -> POST -> persisted widget message. No fake quick-reply DOM,
 * synthetic socket events, fixed sleeps, retries or unrelated suites.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
let npmBuilt = false
type Surface = 'slug' | 'v1' | 'npm'
const TEN = [
  'Pricing', 'Features', 'Support', 'Billing', 'Availability',
  'Training', 'Installation', 'Cancel', 'Account', 'Talk to a person',
]
async function signup(page: Page, label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  const email = 'quick-' + stamp + '@test.com'
  const workspace = 'Quick ' + stamp
  const created = await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
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
async function plan(page: Page, slug: 'free' | 'pro') {
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan: slug }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, body: unknown, status = 200) {
  const res = await page.request.patch(BASE + '/api/widget-config', {
    data: body, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(status)
  return res
}
async function publicConfig(page: Page, slug: string) {
  const res = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(res.ok()).toBe(true)
  return res.json()
}
async function dashboardConfig(page: Page) {
  const res = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(res.ok()).toBe(true)
  return res.json()
}
async function panel(page: Page) {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
  await expect(page.getByTestId('quick-replies-panel')).toBeVisible({ timeout: 15_000 })
}
async function serve(html: string, npm = false) {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/customer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const filename = req.url?.slice(1) ?? ''
    if (npm && /^[A-Za-z0-9_-]+\.js$/.test(filename)) {
      const filepath = join(DIST, filename) // Exact emitted ESM module path. Never remap widget.js.
      if (existsSync(filepath)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(readFileSync(filepath))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('Missing customer HTTP address')
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
    // Identity bootstrap is asynchronous and essential: the launcher is
    // rendered before /contact succeeds. Starting the visitor POST early
    // leads to a REAL 401 invalid_token, not a Quick Replies failure.
    const contactReady = page.waitForResponse(res =>
      res.request().method() === 'POST' &&
      res.url().includes('/api/widget/' + slug + '/contact') &&
      res.status() === 200, { timeout: 20_000 })
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async (args) => {
        const widget = await import(window.location.origin + '/index.js')
        widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    const contactResponse = await contactReady
    await contactResponse.finished()
    await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
    return {
      page,
      close: async () => { try { await page.close() } finally { await site.close() } },
    }
  } catch (e) {
    try { await page.close() } finally { await site.close() }
    throw e
  }
}
async function chooseQuickReply(page: Page, slug: string, index: number, text: string) {
  const button = page.locator('.sk-quick-reply').nth(index)
  await expect(button).toBeVisible({ timeout: 15_000 })
  await expect(button).toHaveText(text)
  const sent = page.waitForResponse(res =>
    res.request().method() === 'POST' &&
    res.url().includes('/api/widget/' + slug + '/messages'),
    { timeout: 20_000 })
  await button.click()
  const result = await sent
  expect(result.status(), 'Quick Reply must use authorized REAL visitor POST: ' +
    (await result.text())).toBe(200)
  await expect(page.locator('.sk-msg.sk-vis p').filter({ hasText: text }))
    .toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('.sk-quick-reply')).toHaveCount(0)
}

test.describe('Widget V2 Quick Replies — Feature 6 only', () => {
  test('Free 2 options, paid 10, public API never exposes saved paidItems to Free', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'tier-caps')
      expect((await publicConfig(owner, slug)).quickReplies).toEqual({ items: [] })
      await patch(owner, { quickReplies: { items: TEN.slice(0, 2) } })
      expect((await publicConfig(owner, slug)).quickReplies).toEqual({ items: TEN.slice(0, 2) })
      const denied = await owner.request.patch(BASE + '/api/widget-config', {
        data: { quickReplies: { items: TEN.slice(0, 3) } },
      })
      expect(denied.status()).toBe(403)
      await plan(owner, 'pro')
      await patch(owner, { quickReplies: { items: TEN } })
      expect((await publicConfig(owner, slug)).quickReplies).toEqual({ items: TEN })
      await plan(owner, 'free')
      expect((await publicConfig(owner, slug)).quickReplies).toEqual({ items: TEN.slice(0, 2) })
      expect((await dashboardConfig(owner)).config.appearanceV2.quickReplies.items).toEqual(TEN)
    } finally { await ctx.close() }
  })

  test('downgrade Free edits two, upgrade restores ten, explicit Pro same-list override clears paid preference', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'restore')
      await plan(owner, 'pro')
      await patch(owner, { quickReplies: { items: TEN } })
      await plan(owner, 'free')
      await patch(owner, { quickReplies: { items: ['Hello', 'Shipping'] } })
      expect((await publicConfig(owner, slug)).quickReplies.items).toEqual(['Hello', 'Shipping'])
      expect((await dashboardConfig(owner)).config.appearanceV2.quickReplies)
        .toEqual({ items: ['Hello', 'Shipping'], paidItems: TEN })
      await plan(owner, 'pro')
      expect((await publicConfig(owner, slug)).quickReplies.items).toEqual(TEN)
      // The stored Free items match this explicit Pro write; it must still
      // override the restored effective ten (Feature 3/4 equality bug).
      await patch(owner, { quickReplies: { items: ['Hello', 'Shipping'] } })
      expect((await dashboardConfig(owner)).config.appearanceV2.quickReplies)
        .toEqual({ items: ['Hello', 'Shipping'] })
      expect((await publicConfig(owner, slug)).quickReplies.items).toEqual(['Hello', 'Shipping'])
    } finally { await ctx.close() }
  })

  test('malformed, oversized, duplicate and smuggled PATCH requests cannot mutate saved settings', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'validation')
      await plan(owner, 'pro')
      await patch(owner, { colors: { mode: 'preset', presetId: 'emerald' } })
      await patch(owner, { quickReplies: { items: ['Safe'] } })
      for (const items of [
        'Hi', null, [42], [''], ['Hi', 'Hi'], ['A'.repeat(81)], [...TEN, 'Eleventh'],
      ]) {
        const res = await owner.request.patch(BASE + '/api/widget-config', {
          data: { quickReplies: { items } },
        })
        expect(res.status()).toBeGreaterThanOrEqual(400)
      }
      const injected = await owner.request.patch(BASE + '/api/widget-config', {
        data: { quickReplies: { items: ['Safe'], paidItems: ['Secret'] } },
      })
      expect(injected.status()).toBeGreaterThanOrEqual(400)
      const cfg = await publicConfig(owner, slug)
      expect(cfg.quickReplies.items).toEqual(['Safe'])
      expect(cfg.colors.presetId).toBe('emerald')
    } finally { await ctx.close() }
  })

  test('dashboard Add, Discard, Save, Delete and reload reflect exactly persisted options', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'dashboard')
      await panel(owner)
      await expect(owner.getByTestId('quick-replies-discard')).toBeDisabled()
      const text = owner.getByTestId('quick-replies-input')
      await text.fill('First question')
      await owner.getByTestId('quick-replies-add').click()
      await expect(owner.getByTestId('quick-replies-save')).toBeEnabled()
      await owner.getByTestId('quick-replies-discard').click()
      await expect(owner.getByTestId('quick-replies-row-0')).toHaveCount(0)
      await expect(owner.getByTestId('quick-replies-save')).toBeDisabled()
      await text.fill('First question')
      await owner.getByTestId('quick-replies-add').click()
      await owner.getByTestId('quick-replies-save').click()
      await expect.poll(async () => (await publicConfig(owner, slug)).quickReplies.items)
        .toEqual(['First question'])
      await owner.reload()
      await panel(owner)
      await expect(owner.getByTestId('quick-replies-row-0')).toContainText('First question')
      await expect(owner.getByTestId('quick-replies-save')).toBeDisabled()
      await owner.getByTestId('quick-replies-remove-0').click()
      await expect(owner.getByTestId('quick-replies-save')).toBeEnabled()
      await owner.getByTestId('quick-replies-save').click()
      await expect.poll(async () => (await publicConfig(owner, slug)).quickReplies.items).toEqual([])
    } finally { await ctx.close() }
  })

  // A launcher can be rendered long before identity bootstrap finishes.
  // Hold the REAL /contact request in Playwright's network layer; no fake
  // response, test-only production hook, sleep, or token injection. This
  // proves suggestions cannot appear until server-issued visitor identity
  // is ready, on all three runtimes. Once released, they must become usable.
  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test('identity boundary ' + surface + ': quick replies hidden until real visitor /contact succeeds', async ({ browser }) => {
      test.setTimeout(120_000)
      const ownerCtx = await browser.newContext()
      const visitorCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
      let site: Awaited<ReturnType<typeof serve>> | undefined
      let visitorPage: Page | undefined
      let releaseContact: (() => void) | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'identity-gate-' + surface)
        await setAccessMode(owner, 'anonymous')
        await patch(owner, { quickReplies: { items: ['First', 'Second'] } })

        if (surface === 'npm' && !npmBuilt) {
          execSync('bun run build', {
            cwd: resolve(process.cwd(), 'packages/widget-npm'), stdio: 'pipe',
          })
          npmBuilt = true
        }
        const html = surface === 'slug'
          ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
          : surface === 'v1'
            ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
            : '<!doctype html><html><body></body></html>'
        site = await serve(html, surface === 'npm')
        const page = await visitorCtx.newPage()
        visitorPage = page

        const hold = new Promise<void>(resolve => { releaseContact = resolve })
        const urlPart = '/api/widget/' + slug + '/contact'
        await page.route('**/api/widget/' + slug + '/contact', async route => {
          // The request is forwarded unchanged after the test releases it.
          await hold
          await route.continue()
        })
        const requestStarted = page.waitForRequest(req =>
          req.method() === 'POST' && req.url().includes(urlPart),
          { timeout: 20_000 },
        )
        await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
        if (surface === 'npm') {
          await page.evaluate(async args => {
            const widget = await import(window.location.origin + '/index.js')
            widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
          }, { slug, origin: BASE })
        }
        await requestStarted
        await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
        await page.locator('.sk-launcher').click()
        await expect(page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
        // This is the regression check. Rendering early is allowed;
        // advertising clickable suggestions before authorization is not.
        await expect(page.locator('.sk-quick-reply').first()).toBeHidden()

        const responseReady = page.waitForResponse(res =>
          res.request().method() === 'POST' &&
          res.url().includes(urlPart) &&
          res.status() === 200, { timeout: 20_000 })
        releaseContact?.()
        releaseContact = undefined
        const ready = await responseReady
        await ready.finished()
        await expect(page.locator('.sk-quick-reply')).toHaveCount(2, { timeout: 15_000 })
        await expect(page.locator('.sk-quick-reply').first()).toBeVisible()
      } finally {
        // Never leave a held HTTP route waiting if an assertion fails.
        releaseContact?.()
        try { await visitorPage?.close() } finally {
          await site?.close()
          await visitorCtx.close()
          await ownerCtx.close()
        }
      }
    })
  }

  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test('Free ' + surface + ': two actual buttons, one authorized POST, no duplicate and no history replay', async ({ browser }) => {
      test.setTimeout(120_000)
      const ownerCtx = await browser.newContext()
      const visitorCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'free-' + surface)
        await setAccessMode(owner, 'anonymous')
        await patch(owner, { quickReplies: { items: ['سلام', 'How much?'] } })
        site = await customer(visitorCtx, slug, surface)
        // Quick Replies belong to the OPEN chat panel, not the closed
        // launcher. Opening the actual widget is a required user action.
        await site.page.locator('.sk-launcher').click()
        await expect(site.page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
        const buttons = site.page.locator('.sk-quick-reply')
        await expect(buttons).toHaveCount(2, { timeout: 15_000 })
        for (const button of await buttons.all()) {
          const rect = await button.boundingBox()
          expect(rect).not.toBeNull()
          expect(rect!.x).toBeGreaterThanOrEqual(-0.5)
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(320.5)
        }
        await chooseQuickReply(site.page, slug, 0, 'سلام')
        await site.page.reload({ waitUntil: 'domcontentloaded' })
        if (surface === 'npm') {
          const ready = site.page.waitForResponse(res =>
            res.request().method() === 'POST' &&
            res.url().includes('/api/widget/' + slug + '/contact') &&
            res.status() === 200, { timeout: 20_000 })
          await site.page.evaluate(async (args) => {
            const widget = await import(window.location.origin + '/index.js')
            widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
          }, { slug, origin: BASE })
          await ready
        }
        await expect(site.page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
        await site.page.locator('.sk-launcher').click()
        await expect(site.page.locator('.sk-msg.sk-vis p').filter({ hasText: 'سلام' }))
          .toHaveCount(1, { timeout: 15_000 })
        await expect(site.page.locator('.sk-quick-reply')).toHaveCount(0)
      } finally {
        if (site) await site.close()
        await visitorCtx.close()
        await ownerCtx.close()
      }
    })
    test('Pro ' + surface + ': ten actual buttons, tenth sends via normal visitor message API', async ({ browser }) => {
      test.setTimeout(120_000)
      const ownerCtx = await browser.newContext()
      const visitorCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'paid-' + surface)
        await plan(owner, 'pro')
        await setAccessMode(owner, 'anonymous')
        await patch(owner, { quickReplies: { items: TEN } })
        site = await customer(visitorCtx, slug, surface)
        await site.page.locator('.sk-launcher').click()
        await expect(site.page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
        await expect(site.page.locator('.sk-quick-reply')).toHaveCount(10, { timeout: 15_000 })
        await chooseQuickReply(site.page, slug, 9, 'Talk to a person')
      } finally {
        if (site) await site.close()
        await visitorCtx.close()
        await ownerCtx.close()
      }
    })
  }

  test('XSS-looking quick reply stays text only, never creates HTML elements', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'xss')
      await setAccessMode(owner, 'anonymous')
      const raw = '<img src=x onerror=alert(1)>'
      await patch(owner, { quickReplies: { items: [raw] } })
      site = await customer(visitorCtx, slug, 'slug')
      await site.page.locator('.sk-launcher').click()
      await expect(site.page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
      const item = site.page.locator('.sk-quick-reply').first()
      await expect(item).toHaveText(raw)
      await expect(site.page.locator('.sk-quick-replies img, .sk-quick-replies script')).toHaveCount(0)
      await chooseQuickReply(site.page, slug, 0, raw)
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })
})
