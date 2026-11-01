import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Independent Feature 5 acceptance tests. Real production HTTP origin,
 * real visitor identity and Inbox agent messages. No fake DOM/socket events.
 * Run ONLY this file in Full and Lite on this PR. No retries or sleeps.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
let npmBuilt = false
type Surface = 'slug' | 'v1' | 'npm'

async function signup(page: Page, label: string) {
  const key = [process.pid, Date.now(), label].join('-')
  const email = 'preview-' + key + '@test.com'
  const workspace = 'Preview ' + key
  const registered = await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
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
  await expect(page.getByTestId('message-preview-panel')).toBeVisible({ timeout: 15_000 })
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
      const file = join(DIST, filename) // Actual ESM graph; NEVER remap widget.js.
      if (existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(readFileSync(file))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('No local HTTP address')
  return {
    url: 'http://127.0.0.1:' + addr.port,
    close: () => new Promise<void>((ok, fail) => {
      server.closeAllConnections()
      server.close(e => e ? fail(e) : ok())
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
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async (args) => {
        const widget = await import(window.location.origin + '/index.js')
        widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
    return { page, close: async () => {
      try { await page.close() } finally { await site.close() }
    } }
  } catch (error) {
    try { await page.close() } finally { await site.close() }
    throw error
  }
}
async function sendVisitor(page: Page, text: string) {
  await page.locator('.sk-launcher').click()
  const input = page.locator('.sk-panel input').first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(text)
  await input.press('Enter')
  await expect(page.locator('.sk-msg.sk-vis p').filter({ hasText: text }))
    .toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: text }))
    .toHaveCount(0, { timeout: 20_000 })
  // Close before the agent replies, so the preview is eligible.
  await page.locator('.sk-launcher').click()
  await expect(page.locator('.sk-panel')).toHaveCSS('pointer-events', 'none')
}
async function answerFromInbox(page: Page, visitorText: string, reply: string, inInbox = false) {
  if (!inInbox) {
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
  }
  const conv = page.locator('button').filter({ hasText: visitorText }).first()
  await expect(conv).toBeVisible({ timeout: 20_000 })
  await conv.click()
  const input = page.locator('.border-t input[placeholder]').last()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(reply)
  const sent = page.waitForResponse(res =>
    res.url().includes('/api/conversations/') &&
    res.url().includes('/messages') &&
    res.request().method() === 'POST' &&
    res.status() === 200, { timeout: 20_000 })
  await input.press('Enter')
  await sent
}

test.describe('Widget V2 Message Preview — Feature 5 only', () => {
  test('Free cannot activate, Pro can enable/disable, downgrade hides without deleting paid choice', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'entitlements')
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: false })
      await patch(page, { messagePreview: { enabled: true } }, 403)
      await patch(page, { messagePreview: { enabled: false } }, 403)
      await panel(page)
      await expect(page.getByTestId('message-preview-enabled')).toBeDisabled()
      await plan(page, 'pro')
      await patch(page, { messagePreview: { enabled: true } })
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: true })
      await plan(page, 'free')
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: false })
      expect((await dashboardConfig(page)).config.appearanceV2.messagePreview).toEqual({ enabled: true })
      await plan(page, 'pro')
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: true })
      await patch(page, { messagePreview: { enabled: false } })
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: false })
    } finally { await ctx.close() }
  })

  test('Pro dashboard Save, Discard, reload and rejection of mixed unauthorized Free payloads', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'dashboard')
      await patch(page, { messagePreview: { enabled: true }, avatarUrl: 'https://example.org/a.png' }, 402)
      await plan(page, 'pro')
      await page.reload()
      await panel(page)
      const toggle = page.getByTestId('message-preview-enabled')
      await expect(toggle).toBeEnabled()
      await expect(page.getByTestId('message-preview-discard')).toBeDisabled()
      await toggle.click()
      await expect(page.getByTestId('message-preview-save')).toBeEnabled()
      await page.getByTestId('message-preview-discard').click()
      await expect(page.getByTestId('message-preview-save')).toBeDisabled()
      expect((await publicConfig(page, slug)).messagePreview).toEqual({ enabled: false })
      await toggle.click()
      await page.getByTestId('message-preview-save').click()
      await expect.poll(async () => (await publicConfig(page, slug)).messagePreview.enabled).toBe(true)
      await page.reload()
      await panel(page)
      await expect(page.getByTestId('message-preview-enabled')).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('message-preview-discard')).toBeDisabled()
    } finally { await ctx.close() }
  })

  test('strict PATCH rejects malformed and mixed fields without modifying previous V2 settings', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'invalid')
      await plan(page, 'pro')
      await patch(page, { colors: { mode: 'preset', presetId: 'emerald' } })
      for (const wrong of [null, {}, { enabled: 'true' }, { enabled: true, arbitrary: 1 }, []]) {
        const result = await page.request.patch(BASE + '/api/widget-config', { data: { messagePreview: wrong } })
        expect(result.status()).toBeGreaterThanOrEqual(400)
      }
      await patch(page, { messagePreview: { enabled: true } })
      await patch(page, { positioning: { mobile: { anchor: 'bottom-center' } } })
      await patch(page, { launcher: { shape: 'pill' } })
      await patch(page, { attention: { animation: 'glow' } })
      const publicCfg = await publicConfig(page, slug)
      expect(publicCfg.messagePreview).toEqual({ enabled: true })
      expect(publicCfg.colors.presetId).toBe('emerald')
      expect(publicCfg.positioning.mobile.anchor).toBe('bottom-center')
      expect(publicCfg.launcher.shape).toBe('pill')
      expect(publicCfg.attention.animation).toBe('glow')
    } finally { await ctx.close() }
  })

  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test('Pro REAL ' + surface + ': agent reply previews while closed, opens, dismisses and never replays history', async ({ browser }) => {
      test.setTimeout(180_000)
      const dashboardCtx = await browser.newContext()
      const widgetCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await dashboardCtx.newPage()
        const slug = await signup(owner, 'agent-' + surface)
        await plan(owner, 'pro')
        await setAccessMode(owner, 'anonymous')
        await patch(owner, { messagePreview: { enabled: true } })
        site = await customer(widgetCtx, slug, surface)
        const visitor = 'PREVIEW_VISITOR_' + surface + '_' + Date.now()
        await expect(site.page.locator('.sk-message-preview')).toBeHidden()
        await sendVisitor(site.page, visitor)

        const agentReply = 'PREVIEW_REPLY_' + surface + '_' + Date.now()
        await answerFromInbox(owner, visitor, agentReply)
        const bubble = site.page.locator('.sk-message-preview')
        await expect(bubble).toBeVisible({ timeout: 30_000 })
        await expect(bubble.locator('.sk-message-preview-text')).toHaveText(agentReply)
        await expect(site.page.locator('.sk-msg.sk-agt p').filter({ hasText: agentReply }))
          .toHaveCount(1, { timeout: 15_000 })
        const rect = await bubble.boundingBox()
        expect(rect).not.toBeNull()
        expect(rect!.x).toBeGreaterThanOrEqual(-0.5)
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(320.5)
        expect(rect!.y).toBeGreaterThanOrEqual(-0.5)
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(640.5)
        await bubble.locator('.sk-message-preview-text').click()
        await expect(bubble).toBeHidden()
        await expect(site.page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
        // Closing must not replay an already-seen agent message.
        await site.page.locator('.sk-launcher').click()
        await expect(bubble).toBeHidden()
        // Reload the REAL customer page, including its original embed.
        // History can be fetched again but must never create a NEW preview.
        await site.page.reload({ waitUntil: 'domcontentloaded' })
        if (surface === 'npm') {
          await site.page.evaluate(async (args) => {
            const widget = await import(window.location.origin + '/index.js')
            widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
          }, { slug, origin: BASE })
        }
        await expect(site.page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
        await expect(site.page.locator('.sk-message-preview')).toBeHidden()
        await site.page.locator('.sk-launcher').click()
        await expect(site.page.locator('.sk-msg.sk-agt p').filter({ hasText: agentReply }))
          .toHaveCount(1, { timeout: 20_000 })
        await site.page.locator('.sk-launcher').click()
        await expect(site.page.locator('.sk-message-preview')).toBeHidden()
      } finally {
        if (site) await site.close()
        await widgetCtx.close()
        await dashboardCtx.close()
      }
    })
  }

  test('Free real slug widget must not expose any agent message text as preview', async ({ browser }) => {
    test.setTimeout(140_000)
    const dashboardCtx = await browser.newContext()
    const widgetCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await dashboardCtx.newPage()
      const slug = await signup(owner, 'free-message')
      await setAccessMode(owner, 'anonymous')
      site = await customer(widgetCtx, slug, 'slug')
      const visitor = 'FREE_PREVIEW_VISITOR_' + Date.now()
      await sendVisitor(site.page, visitor)
      const reply = 'FREE_PREVIEW_AGENT_' + Date.now()
      await answerFromInbox(owner, visitor, reply)
      await expect(site.page.locator('.sk-msg.sk-agt p').filter({ hasText: reply }))
        .toHaveCount(1, { timeout: 30_000 })
      await expect(site.page.locator('.sk-message-preview')).toBeHidden()
    } finally {
      if (site) await site.close()
      await widgetCtx.close()
      await dashboardCtx.close()
    }
  })

  test('agent HTML is rendered as plain text, never inserted as markup; dismiss does not open widget', async ({ browser }) => {
    test.setTimeout(140_000)
    const dashboardCtx = await browser.newContext()
    const widgetCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await dashboardCtx.newPage()
      const slug = await signup(owner, 'xss')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { messagePreview: { enabled: true } })
      site = await customer(widgetCtx, slug, 'slug')
      const visitor = 'XSS_VISITOR_' + Date.now()
      await sendVisitor(site.page, visitor)
      const malicious = '<img src=x onerror=alert(1)>'
      await answerFromInbox(owner, visitor, malicious)
      const bubble = site.page.locator('.sk-message-preview')
      await expect(bubble).toBeVisible({ timeout: 30_000 })
      expect(await bubble.locator('.sk-message-preview-text').textContent()).toBe(malicious)
      await expect(bubble.locator('img,script,iframe')).toHaveCount(0)
      await bubble.locator('.sk-message-preview-dismiss').click()
      await expect(bubble).toBeHidden()
      await expect(site.page.locator('.sk-panel')).toHaveCSS('pointer-events', 'none')
    } finally {
      if (site) await site.close()
      await widgetCtx.close()
      await dashboardCtx.close()
    }
  })
})
