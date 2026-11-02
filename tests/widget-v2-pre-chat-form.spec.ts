import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/** Reviewer-owned Feature 7 browser qualification. Real visitor identities, real server persistence; never fake success. */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
let npmBuilt = false
const BASIC = [{ key: 'name', required: true }, { key: 'email', required: false }]
const ADVANCED = [...BASIC, { key: 'phone', required: true }, { key: 'company', required: false }]
type Surface = 'slug' | 'v1' | 'npm'
const TEN = [
  'Pricing', 'Features', 'Support', 'Billing', 'Availability',
  'Training', 'Installation', 'Cancel', 'Account', 'Talk to a person',
]
async function signup(page: Page, label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  const email = 'prechat-' + stamp + '@test.com'
  const workspace = 'PreChat ' + stamp
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
  await expect(page.getByTestId('pre-chat-form-panel')).toBeVisible({ timeout: 15_000 })
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
    const identity = await contactResponse.json()
    expect(typeof identity.realtimeToken).toBe('string')
    await expect(page.locator('.sk-launcher')).toBeVisible({ timeout: 15_000 })
    return {
      page,
      token: identity.realtimeToken as string,
      close: async () => { try { await page.close() } finally { await site.close() } },
    }
  } catch (e) {
    try { await page.close() } finally { await site.close() }
    throw e
  }
}

async function openChat(page: Page) {
  await page.locator('.sk-launcher').click()
  await expect(page.locator('.sk-panel')).toHaveCSS('pointer-events', 'auto')
}
async function submitPreChat(page: Page, slug: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values))
    await page.locator('.sk-pre-chat-field-' + key).fill(value)
  const response = page.waitForResponse(res =>
    res.request().method() === 'POST' &&
    res.url().includes('/api/widget/' + slug + '/pre-chat'), { timeout: 20_000 })
  await page.locator('.sk-pre-chat-submit').click()
  const result = await response
  expect(result.status(), 'Pre-chat data should persist through authenticated server endpoint: ' +
    (await result.text())).toBe(200)
  await expect(page.locator('.sk-pre-chat-form')).toBeHidden()
}
async function sendFirstMessage(page: Page, slug: string, text: string) {
  const input = page.locator('.sk-input input').first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(text)
  const response = page.waitForResponse(res =>
    res.request().method() === 'POST' &&
    res.url().includes('/api/widget/' + slug + '/messages'), { timeout: 20_000 })
  await input.press('Enter')
  const result = await response
  expect(result.status(), 'first message should persist only AFTER pre-chat completion: ' +
    (await result.text())).toBe(200)
  await expect(page.locator('.sk-msg.sk-vis p').filter({ hasText: text }))
    .toHaveCount(1, { timeout: 15_000 })
}
test.describe('Widget V2 Pre-chat Form — Feature 7 independent browser tests', () => {
  test('Free basic fields, Pro advanced, no raw paidFields leak in public config', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'plans')
      expect((await publicConfig(owner, slug)).preChatForm).toEqual({ fields: [] })
      await patch(owner, { preChatForm: { fields: BASIC } })
      expect((await publicConfig(owner, slug)).preChatForm).toEqual({ fields: BASIC })
      await patch(owner, { preChatForm: { fields: ADVANCED } }, 403)
      await plan(owner, 'pro')
      await patch(owner, { preChatForm: { fields: ADVANCED } })
      expect((await publicConfig(owner, slug)).preChatForm).toEqual({ fields: ADVANCED })
      await plan(owner, 'free')
      expect((await publicConfig(owner, slug)).preChatForm).toEqual({ fields: BASIC })
      const stored = (await dashboardConfig(owner)).config.appearanceV2.preChatForm
      expect(stored.fields).toEqual(ADVANCED)
      expect((await publicConfig(owner, slug)).preChatForm.paidFields).toBeUndefined()
    } finally { await ctx.close() }
  })

  test('downgrade edit basic preserves advanced fields, upgrade restores, explicit paid edit clears stale preference', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'downgrade')
      await plan(owner, 'pro')
      await patch(owner, { preChatForm: { fields: ADVANCED } })
      await plan(owner, 'free')
      const changed = [{ key: 'name', required: false }]
      await patch(owner, { preChatForm: { fields: changed } })
      expect((await publicConfig(owner, slug)).preChatForm.fields).toEqual(changed)
      expect((await dashboardConfig(owner)).config.appearanceV2.preChatForm)
        .toEqual({ fields: changed, paidFields: ADVANCED })
      await plan(owner, 'pro')
      expect((await publicConfig(owner, slug)).preChatForm.fields).toEqual(ADVANCED)
      // Explicitly reselect the stored Free list on paid: MUST clear paidFields.
      await patch(owner, { preChatForm: { fields: changed } })
      expect((await dashboardConfig(owner)).config.appearanceV2.preChatForm).toEqual({ fields: changed })
      expect((await publicConfig(owner, slug)).preChatForm.fields).toEqual(changed)
    } finally { await ctx.close() }
  })

  test('invalid and mixed PATCH payloads never overwrite previous V2 features', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'invalid')
      await plan(owner, 'pro')
      await patch(owner, { colors: { mode: 'preset', presetId: 'emerald' } })
      await patch(owner, { quickReplies: { items: ['Help'] } })
      await patch(owner, { preChatForm: { fields: BASIC } })
      for (const preChatForm of [
        null, true, {}, [], { fields: ['name'] },
        { fields: [{ key: 'name', required: 'true' }] },
        { fields: [BASIC[0], BASIC[0]] },
        { fields: BASIC, paidFields: ADVANCED },
        { fields: [{ key: 'script', required: true }] },
      ]) {
        const res = await owner.request.patch(BASE + '/api/widget-config', { data: { preChatForm } })
        expect(res.status()).toBeGreaterThanOrEqual(400)
      }
      const cfg = await publicConfig(owner, slug)
      expect(cfg.preChatForm.fields).toEqual(BASIC)
      expect(cfg.colors.presetId).toBe('emerald')
      expect(cfg.quickReplies.items).toEqual(['Help'])
    } finally { await ctx.close() }
  })

  test('dashboard Free Save, Discard, required toggle and reload; paid-only fields locked', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'dashboard')
      await panel(owner)
      await expect(owner.getByTestId('pre-chat-form-enabled-phone')).toBeDisabled()
      await expect(owner.getByTestId('pre-chat-form-enabled-company')).toBeDisabled()
      const name = owner.getByTestId('pre-chat-form-enabled-name')
      await name.click()
      await expect(owner.getByTestId('pre-chat-form-save')).toBeEnabled()
      await owner.getByTestId('pre-chat-form-discard').click()
      await expect(owner.getByTestId('pre-chat-form-save')).toBeDisabled()
      expect((await publicConfig(owner, slug)).preChatForm).toEqual({ fields: [] })
      await name.click()
      await owner.getByTestId('pre-chat-form-required-name').click()
      await owner.getByTestId('pre-chat-form-save').click()
      await expect.poll(async () => (await publicConfig(owner, slug)).preChatForm.fields)
        .toEqual([{ key: 'name', required: true }])
      await owner.reload()
      await panel(owner)
      await expect(owner.getByTestId('pre-chat-form-save')).toBeDisabled()
      await expect(owner.getByTestId('pre-chat-form-enabled-name')).toHaveAttribute('aria-checked', 'true')
    } finally { await ctx.close() }
  })

  // Real visitor lifecycle for all three delivery surfaces.
  for (const surface of ['slug', 'v1', 'npm'] as const) {
    test('Free ' + surface + ': form before first send, server submission, history reload does not replay', async ({ browser }) => {
      test.setTimeout(140_000)
      const ownerCtx = await browser.newContext()
      const visitorCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
      let site: Awaited<ReturnType<typeof customer>> | undefined
      try {
        const owner = await ownerCtx.newPage()
        const slug = await signup(owner, 'customer-' + surface)
        await setAccessMode(owner, 'anonymous')
        await patch(owner, { preChatForm: { fields: BASIC } })
        site = await customer(visitorCtx, slug, surface)
        await openChat(site.page)
        const form = site.page.locator('.sk-pre-chat-form')
        await expect(form).toBeVisible({ timeout: 15_000 })
        await expect(site.page.locator('.sk-pre-chat-field-name')).toBeVisible()
        await expect(site.page.locator('.sk-pre-chat-field-email')).toBeVisible()
        await expect(site.page.locator('.sk-pre-chat-field-phone')).toHaveCount(0)
        await expect(site.page.locator('.sk-input input')).toBeHidden()
        const name = 'Visitor ' + surface
        await submitPreChat(site.page, slug, { name, email: name.replaceAll(' ', '').toLowerCase() + '@example.test' })
        const message = 'PRE_CHAT_FIRST_' + surface + '_' + Date.now()
        await sendFirstMessage(site.page, slug, message)
        await site.page.reload({ waitUntil: 'domcontentloaded' })
        if (surface === 'npm') {
          const ready = site.page.waitForResponse(res =>
            res.request().method() === 'POST' &&
            res.url().includes('/api/widget/' + slug + '/contact') &&
            res.status() === 200, { timeout: 20_000 })
          await site.page.evaluate(async args => {
            const widget = await import(window.location.origin + '/index.js')
            widget.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
          }, { slug, origin: BASE })
          await ready
        }
        await expect(site.page.locator('.sk-launcher')).toBeVisible()
        await openChat(site.page)
        await expect(site.page.locator('.sk-pre-chat-form')).toBeHidden()
        await expect(site.page.locator('.sk-msg.sk-vis p').filter({ hasText: message }))
          .toHaveCount(1, { timeout: 20_000 })
      } finally {
        if (site) await site.close()
        await visitorCtx.close()
        await ownerCtx.close()
      }
    })
  }

  test('Pro real NPM widget: advanced required phone validated before first message', async ({ browser }) => {
    test.setTimeout(140_000)
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext({ viewport: { width: 320, height: 640 } })
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'advanced')
      await plan(owner, 'pro')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: ADVANCED } })
      site = await customer(visitorCtx, slug, 'npm')
      await openChat(site.page)
      for (const key of ['name', 'email', 'phone', 'company'])
        await expect(site.page.locator('.sk-pre-chat-field-' + key)).toBeVisible()
      const denied = await site.page.request.post(BASE + '/api/widget/' + slug + '/pre-chat', {
        headers: { Authorization: 'Bearer ' + site.token },
        data: { values: { name: 'Customer' } },
      })
      expect(denied.status()).toBe(422)
      await submitPreChat(site.page, slug, {
        name: 'Customer', email: 'customer@example.test',
        phone: '+49 30 1234567', company: 'Example GmbH',
      })
      await sendFirstMessage(site.page, slug, 'ADVANCED_PRECHAT_FIRST_MESSAGE')
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })

  test('server rejects first visitor message until REQUIRED form completed, even if client bypasses UI', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'server-gate')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: [{ key: 'name', required: true }] } })
      site = await customer(visitorCtx, slug, 'slug')
      const token = site.token // obtained from REAL /contact 200, not invented
      const denied = await site.page.evaluate(async ({ base, slug, token }) => {
        const res = await fetch(base + '/api/widget/' + slug + '/messages', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Cannot bypass pre-chat' }),
        })
        return { status: res.status, body: await res.json() }
      }, { base: BASE, slug, token })
      expect(denied.status).toBe(403)
      expect(denied.body.error).toBe('pre_chat_required')
      await openChat(site.page)
      await expect(site.page.locator('.sk-pre-chat-form')).toBeVisible()
      await submitPreChat(site.page, slug, { name: 'Customer' })
      await sendFirstMessage(site.page, slug, 'AUTHORIZED_AFTER_PRE_CHAT')
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })

  test('completed form survives reload BEFORE any visitor message without asking twice', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'pre-message-reload')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: [{ key: 'name', required: true }] } })
      site = await customer(visitorCtx, slug, 'slug')
      await openChat(site.page)
      await expect(site.page.locator('.sk-pre-chat-form')).toBeVisible()
      await submitPreChat(site.page, slug, { name: 'Persisted Form User' })
      await expect(site.page.locator('.sk-input input')).toBeVisible()
      // Crucially, NO /messages POST has occurred. The server must remember
      // pre-chat completion for the SAME visitor identity after page reload.
      const ready = site.page.waitForResponse(res =>
        res.request().method() === 'POST' &&
        res.url().includes('/api/widget/' + slug + '/contact') &&
        res.status() === 200, { timeout: 20_000 })
      await site.page.reload({ waitUntil: 'domcontentloaded' })
      const response = await ready
      await response.finished()
      await expect(site.page.locator('.sk-launcher')).toBeVisible()
      await openChat(site.page)
      await expect(site.page.locator('.sk-pre-chat-form')).toBeHidden()
      await expect(site.page.locator('.sk-input input')).toBeVisible()
      // A real first message must now be accepted without resubmission.
      await sendFirstMessage(site.page, slug, 'FIRST_MESSAGE_AFTER_COMPLETED_FORM_RELOAD')
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })

  test('new required field invalidates incomplete old pre-chat metadata before first message', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'requirements-change')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: [{ key: 'name', required: true }] } })
      site = await customer(visitorCtx, slug, 'slug')
      await openChat(site.page)
      await submitPreChat(site.page, slug, { name: 'Only Name' })

      // No visitor message has been persisted. Owner strengthens the form
      // requirement after the first form submission (still Free-allowed).
      await patch(owner, { preChatForm: { fields: [
        { key: 'name', required: true }, { key: 'email', required: true },
      ] } })
      const unauthorized = await site.page.request.post(BASE + '/api/widget/' + slug + '/messages', {
        headers: { Authorization: 'Bearer ' + site.token },
        data: { text: 'Must supply newly required email first' },
      })
      expect(unauthorized.status(), 'pre-chat completion must satisfy CURRENT required fields').toBe(403)
      expect((await unauthorized.json()).error).toBe('pre_chat_required')

      // A real updated submission with both required values must unlock
      // the first message without fabricating authentication or verification.
      const update = await site.page.request.post(BASE + '/api/widget/' + slug + '/pre-chat', {
        headers: { Authorization: 'Bearer ' + site.token },
        data: { values: { name: 'Only Name', email: 'customer@example.test' } },
      })
      expect(update.status()).toBe(200)
      const nowAllowed = await site.page.request.post(BASE + '/api/widget/' + slug + '/messages', {
        headers: { Authorization: 'Bearer ' + site.token },
        data: { text: 'VALID_AFTER_CURRENT_REQUIRED_FIELDS' },
      })
      expect(nowAllowed.status()).toBe(200)
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })

  test('stale anonymous token cannot submit pre-chat after access policy becomes verified_visitor', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'stale-policy')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: [{ key: 'name', required: true }] } })
      site = await customer(visitorCtx, slug, 'slug')
      const oldToken = site.token // real anonymous token issued by /contact
      // Change the live tenant authorization policy AFTER the visitor
      // obtained this token. Only current-policy authorization can reject it.
      await setAccessMode(owner, 'verified_visitor')
      const deniedMessage = await site.page.request.post(BASE + '/api/widget/' + slug + '/messages', {
        headers: { Authorization: 'Bearer ' + oldToken },
        data: { text: 'stale identity must not send' },
      })
      expect(deniedMessage.status()).toBe(403)
      expect((await deniedMessage.json()).error).not.toBe('pre_chat_required')

      // The Pre-chat endpoint writes Contact.metadata; it MUST enforce the
      // same CURRENT identity/access-policy boundary as /messages. A signed
      // anonymous token that is no longer authorized cannot modify metadata.
      const staleSubmit = await site.page.request.post(BASE + '/api/widget/' + slug + '/pre-chat', {
        headers: { Authorization: 'Bearer ' + oldToken },
        data: { values: { name: 'Unauthorized overwrite' } },
      })
      expect(staleSubmit.status(), 'old anonymous token must not mutate Contact metadata after verified policy switch').toBe(403)
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })

  test('pre-chat endpoint rejects missing/foreign bearer and malformed values, no profile spoofing', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const otherOwnerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'auth-security')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: BASIC } })
      site = await customer(visitorCtx, slug, 'slug')
      const url = BASE + '/api/widget/' + slug + '/pre-chat'
      const missing = await site.page.request.post(url, { data: { values: { name: 'Alice' } } })
      expect(missing.status()).toBe(401)
      // A genuinely server-issued token for DIFFERENT tenant B must never
      // be usable against tenant A's pre-chat route, even with valid fields.
      const otherOwner = await otherOwnerCtx.newPage()
      const otherSlug = await signup(otherOwner, 'foreign')
      await setAccessMode(otherOwner, 'anonymous')
      const identifyOther = await otherOwner.request.post(BASE + '/api/widget/' + otherSlug + '/contact', {
        data: { visitorId: 'foreign-visitor-' + Date.now() },
      })
      expect(identifyOther.status()).toBe(200)
      const otherIdentity = await identifyOther.json()
      const crossTenant = await site.page.request.post(url, {
        headers: { Authorization: 'Bearer ' + otherIdentity.realtimeToken },
        data: { values: { name: 'Alice' } },
      })
      expect(crossTenant.status()).toBe(403)
      const malformed = [
        { values: { name: ' ' } },
        { values: { name: 'Alice', isVerified: true } },
        { values: { name: 'Alice', emailVerifiedAt: '2026-01-01' } },
        { values: { name: 'Alice', email: 'not-email' } },
      ]
      for (const body of malformed) {
        const res = await site.page.request.post(url, {
          headers: { Authorization: 'Bearer ' + site.token }, data: body,
        })
        expect(res.status()).toBeGreaterThanOrEqual(400)
      }
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await otherOwnerCtx.close()
      await ownerCtx.close()
    }
  })

  test('form rendering treats submitted HTML-looking text as text, not executable HTML', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    const visitorCtx = await browser.newContext()
    let site: Awaited<ReturnType<typeof customer>> | undefined
    try {
      const owner = await ownerCtx.newPage()
      const slug = await signup(owner, 'xss')
      await setAccessMode(owner, 'anonymous')
      await patch(owner, { preChatForm: { fields: [{ key: 'name', required: true }] } })
      site = await customer(visitorCtx, slug, 'slug')
      await openChat(site.page)
      const raw = '<img src=x onerror=alert(1)>'
      await submitPreChat(site.page, slug, { name: raw })
      await expect(site.page.locator('.sk-pre-chat-form img, .sk-pre-chat-form script, .sk-pre-chat-form iframe'))
        .toHaveCount(0)
      await sendFirstMessage(site.page, slug, 'SAFE_FORM_SUBMITTED')
    } finally {
      if (site) await site.close()
      await visitorCtx.close()
      await ownerCtx.close()
    }
  })
})
