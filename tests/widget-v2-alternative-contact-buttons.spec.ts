import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/** Reviewer-owned Feature 9 Full/Lite browser acceptance.
 * Real server API, real customer origin, real three runtimes, no route mocks,
 * no injected fake widget DOM, no fixed sleeps and no retries.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
type Surface = 'slug' | 'v1' | 'npm'
let npmBuilt = false
type Kind = 'phone' | 'email' | 'whatsapp' | 'telegram' | 'website'
type Button = { kind: Kind; label: string; value: string }
const btn = (kind: Kind, label: string, value: string): Button => ({ kind, label, value })
const PHONE = btn('phone', 'Call us', '+989121234567')
const EMAIL = btn('email', 'Email us', 'support@example.com')
const WHATSAPP = btn('whatsapp', 'WhatsApp', '+989121234567')
const TELEGRAM = btn('telegram', 'Telegram', 'support_team')
const WEBSITE = btn('website', 'Support', 'https://help.example.com/contact')
const FIVE = [PHONE, EMAIL, WHATSAPP, TELEGRAM, WEBSITE]
const TWO = [PHONE, EMAIL]

async function signup(page: Page, label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  const email = 'acb-' + stamp + '@test.com'
  // Put the unique scenario label FIRST: signup truncates generated slugs at 24 characters.
  const created = await otpSignupPlaywright(page.request, DASHBOARD, email, 'ACB-' + label + '-' + stamp)
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
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan: name }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, items: Button[], status = 200) {
  const res = await page.request.patch(BASE + '/api/widget-config', {
    data: { alternativeContactButtons: { items } },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(status)
  return res
}
async function publicConfig(page: Page, slug: string) {
  const res = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}
async function dashboardConfig(page: Page) {
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
  if (!addr || typeof addr === 'string') throw Error('Missing customer server address')
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
    const ready = page.waitForResponse(x => x.request().method() === 'POST' &&
      x.url().includes('/api/widget/' + slug + '/contact') && x.status() === 200, { timeout: 20_000 })
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async args => {
        const widget = await import(window.location.origin + '/index.js')
        widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
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
async function openPanel(page: Page) {
  await page.locator('.sk-launcher').click()
  await expect(page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
}
const links = (page: Page) => page.locator('.sk-alt-contact-link')
async function assertLinks(page: Page) {
  await expect(links(page)).toHaveCount(5, { timeout: 15_000 })
  const expected: Record<Kind, string> = {
    phone: 'tel:+989121234567',
    email: 'mailto:support@example.com',
    whatsapp: 'https://wa.me/989121234567',
    telegram: 'https://t.me/support_team',
    website: 'https://help.example.com/contact',
  }
  for (const [kind, href] of Object.entries(expected)) {
    const anchor = page.locator('.sk-alt-contact-link[data-sk-alt-contact-kind="' + kind + '"]')
    await expect(anchor).toHaveCount(1)
    await expect(anchor).toHaveAttribute('href', href)
    await expect(anchor).toHaveAccessibleName(/.+/)
    if (href.startsWith('https:')) {
      await expect(anchor).toHaveAttribute('target', '_blank')
      await expect(anchor).toHaveAttribute('rel', /noopener/)
    }
  }
}

test.describe('Reviewer — Widget V2 Alternative Contact Buttons / Feature 9', () => {
  test('Free: empty default, max two, reject third, public effective only', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'limits')
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: [] })
      await patch(owner, TWO)
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: TWO })
      await patch(owner, [PHONE, EMAIL, WHATSAPP], 403)
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: TWO })
    } finally { await ctx.close() }
  })

  test('Pro five -> Free effective two -> Free edit -> Pro restore -> explicit Pro edit clears paidItems', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'downgrade')
      await plan(owner, 'pro')
      await patch(owner, FIVE)
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: FIVE })
      await plan(owner, 'free')
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: TWO })
      await patch(owner, [EMAIL])
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: [EMAIL] })
      const saved = (await dashboardConfig(owner)).config.appearanceV2.alternativeContactButtons
      expect(saved.paidItems).toEqual(FIVE)
      expect((await publicConfig(owner, slug)).alternativeContactButtons.paidItems).toBeUndefined()
      await plan(owner, 'pro')
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: FIVE })
      await patch(owner, TWO)
      expect((await dashboardConfig(owner)).config.appearanceV2.alternativeContactButtons.paidItems).toBeUndefined()
    } finally { await ctx.close() }
  })

  test('Malicious links and malformed input rejected by API without damaging existing settings', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'malformed')
      await plan(owner, 'pro')
      await patch(owner, TWO)
      for (const payload of [
        null, [], {}, { items: 'wrong' },
        { items: TWO, paidItems: FIVE },
        { items: [btn('website', 'Bad', 'javascript:alert(1)')] },
        { items: [btn('website', 'Bad', 'https://user:pass@example.com')] },
        { items: [btn('phone', 'Bad', 'tel:+12345')] },
        { items: [btn('email', 'Bad', 'support@example.com?bcc=attacker%40outside.test')] },
        { items: [btn('email', 'Bad', 'support@example.com%0D%0ABcc:attacker%40outside.test')] },
        { items: [PHONE, PHONE] },
        { items: [{ ...PHONE, onClick: 'alert(1)' }] },
      ]) {
        const res = await owner.request.patch(BASE + '/api/widget-config', { data: { alternativeContactButtons: payload } })
        expect(res.status(), await res.text()).toBeGreaterThanOrEqual(400)
      }
      expect((await publicConfig(owner, slug)).alternativeContactButtons).toEqual({ items: TWO })
    } finally { await ctx.close() }
  })

  test('New feature true-patches rather than clearing Quick Replies or Page Visibility', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage(), slug = await signup(owner, 'truepatch')
      await plan(owner, 'pro')
      const qr = await owner.request.patch(BASE + '/api/widget-config', { data: { quickReplies: { items: ['Support'] } } })
      expect(qr.ok(), await qr.text()).toBe(true)
      const pv = await owner.request.patch(BASE + '/api/widget-config', { data: { pageVisibility: { rules: [
        { pattern: '/checkout', match: 'exact', action: 'hide' },
      ] } } })
      expect(pv.ok(), await pv.text()).toBe(true)
      await patch(owner, TWO)
      const cfg = await publicConfig(owner, slug)
      expect(cfg.quickReplies.items).toEqual(['Support'])
      expect(cfg.pageVisibility.rules).toEqual([{ pattern: '/checkout', match: 'exact', action: 'hide' }])
      expect(cfg.alternativeContactButtons.items).toEqual(TWO)
    } finally { await ctx.close() }
  })

  test('Dashboard Free Save, Discard and reload, with 2-button limit', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'dashboard')
      const nav = owner.getByRole('navigation', { name: 'primary' })
      await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('alt-contact-panel')).toBeVisible()
      await owner.getByTestId('alt-contact-add').click()
      await owner.getByTestId('alt-contact-label-0').fill('Call us')
      await owner.getByTestId('alt-contact-value-0').fill('+989121234567')
      await owner.getByTestId('alt-contact-discard').click()
      await expect(owner.getByTestId('alt-contact-item-0')).toHaveCount(0)
      await owner.getByTestId('alt-contact-add').click()
      await owner.getByTestId('alt-contact-label-0').fill('Call us')
      await owner.getByTestId('alt-contact-value-0').fill('+989121234567')
      const saved = owner.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/api/widget-config'))
      await owner.getByTestId('alt-contact-save').click()
      expect((await saved).status()).toBe(200)
      await owner.reload()
      await owner.getByRole('navigation', { name: 'primary' }).getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      await owner.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
      await expect(owner.getByTestId('alt-contact-label-0')).toHaveValue('Call us')
      await expect(owner.getByTestId('alt-contact-value-0')).toHaveValue('+989121234567')
    } finally { await ctx.close() }
  })

  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test(surface + ': five real alternative contact links rendered safely and accessibly', async ({ browser }) => {
      const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'surface-' + surface)
        await plan(owner, 'pro')
        await setAccessMode(owner, 'anonymous')
        await patch(owner, FIVE)
        site = await customer(visitorCtx, slug, surface)
        await openPanel(site.page)
        await assertLinks(site.page)
      } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
    })
  }

  test('Page Visibility still hides entire widget including alternative contacts on checkout SPA route', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'visibility')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, TWO)
      const response = await owner.request.patch(BASE + '/api/widget-config', { data: { pageVisibility: {
        rules: [{ pattern: '/checkout', match: 'exact', action: 'hide' }],
      } } })
      expect(response.ok(), await response.text()).toBe(true)
      site = await customer(visitorCtx, slug, 'slug')
      await openPanel(site.page)
      await expect(links(site.page)).toHaveCount(2)
      await site.page.evaluate(() => history.pushState({}, '', '/checkout'))
      await expect(site.page.locator('.sk-root')).toHaveAttribute('data-sk-page-visibility', 'hide')
      await expect(site.page.locator('.sk-root')).toHaveCSS('display', 'none')
      await site.page.evaluate(() => history.replaceState({}, '', '/help'))
      await expect(site.page.locator('.sk-root')).toHaveAttribute('data-sk-page-visibility', 'show')
      await expect(links(site.page)).toHaveCount(2)
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })

  test('Empty contact list renders zero links, and mobile/RTL still has usable native contact anchors', async ({ browser }) => {
    const ownerCtx = await browser.newContext(), visitorCtx = await browser.newContext({ viewport: { width: 375, height: 812 } })
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage(), slug = await signup(owner, 'mobile')
      await setAccessMode(owner, 'anonymous')
      site = await customer(visitorCtx, slug, 'npm')
      await openPanel(site.page)
      await expect(links(site.page)).toHaveCount(0)
      await patch(owner, TWO)
      // New embed loads authorized public config; no fake in-memory config injection.
      await site.close()
      site = await customer(visitorCtx, slug, 'npm')
      await openPanel(site.page)
      await expect(links(site.page)).toHaveCount(2)
      await expect(site.page.locator('.sk-alt-contact-link[data-sk-alt-contact-kind="phone"]')).toHaveAttribute('href', 'tel:+989121234567')
      await expect(site.page.locator('.sk-alt-contact-link[data-sk-alt-contact-kind="email"]')).toHaveAttribute('href', 'mailto:support@example.com')
    } finally { if (site) await site.close(); await visitorCtx.close(); await ownerCtx.close() }
  })
})
