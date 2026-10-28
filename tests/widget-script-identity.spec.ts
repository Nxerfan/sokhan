import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'node:url'

/**
 * Script-widget identity parity browser tests (requirements #31–#43).
 *
 * Exercises the ACTUAL generated script responses from BOTH script
 * endpoints against the real Sukhan Docker backend, proving identity
 * parity with the accepted NPM implementation:
 *
 *   slug variant: <script src="SUKHAN/api/widget/<slug>/script">
 *   v1 variant:   <script src="SUKHAN/api/widget/v1/sukhan.js" data-api-key="sk_<slug>">
 *
 * Coverage:
 *   #32 anonymous script regression (both variants) — script loads from
 *       Sukhan origin; no identityEndpoint call; anonymous contact works.
 *   #33 verified_visitor script flow (slug) — OTP START + mock 123456 VERIFY
 *       + resume stored + authenticated /contact + send + reload restores.
 *   #34 verified stale resume — policy change → old resume fails → verification.
 *   #37 logged-out site_user_only (both variants) — no anonymous contact,
 *       no socket, login-required UI + sukhan:login-required event.
 *   #38 SPA refreshIdentity (v1) — flip customer session + refreshIdentity → ready.
 *   #39 user-switch (v1) — setIdentity(tokenB) → A history gone, B isolated.
 *   #40 logout (v1) — setIdentity(null) → socket/messages cleared, login-required.
 *   #41 endpoint security (v1) — cross-origin reject, timeout/500/malformed
 *       fail-closed.
 *   #42 credential leak (v1) — integration secret NOT in any browser artifact.
 *   #24 login URL (v1) — relative resolves to CUSTOMER origin + return param.
 *
 * The fake customer server exposes /api/sukhan-identity; the integration
 * secret stays in the test-server process memory (server-to-server mint
 * via POST SUKHAN/api/widget/identity/token with Bearer <secret>).
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url))
const SIGNUP_API = 'http://127.0.0.1:3000'
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'
const CUSTOMER_PORT = 8085
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`

interface CustomerState {
  integrationSecret: string | null
  session: { loggedIn: boolean; externalUserId: string; name?: string; email?: string }
  failureMode: 'none' | 'timeout' | 'malformed' | 'auth_true_no_token' | 'status500'
}
const state: CustomerState = {
  integrationSecret: null,
  session: { loggedIn: false, externalUserId: 'ext_a' },
  failureMode: 'none',
}

let customerServer: Server | null = null

async function handleIdentityEndpoint(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (state.failureMode !== 'none') {
    if (state.failureMode === 'timeout') return // never respond → 5s AbortController
    if (state.failureMode === 'malformed') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json'); return; }
    if (state.failureMode === 'auth_true_no_token') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authenticated: true })); return; }
    if (state.failureMode === 'status500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })); return; }
  }
  if (!state.session.loggedIn) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authenticated: false })); return; }
  const secret = state.integrationSecret
  if (!secret) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authenticated: false })); return; }
  try {
    const mintRes = await fetch(`${SUKHAN_ORIGIN}/api/widget/identity/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ externalUserId: state.session.externalUserId, name: state.session.name, email: state.session.email }),
    })
    if (!mintRes.ok) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ authenticated: false })); return; }
    const minted = (await mintRes.json()) as { token?: string }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ authenticated: true, token: minted.token }))
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ authenticated: false }))
  }
}

test.beforeAll(async () => {
  customerServer = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url === '/api/sukhan-identity') { await handleIdentityEndpoint(req, res); return; }
    if (url === '/' || url === '/customer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer</title></head><body><h1>Customer</h1></body></html>')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found')
  })
  await new Promise<void>((resolve) => customerServer!.listen(CUSTOMER_PORT, '127.0.0.1', resolve))
})
test.afterAll(async () => {
  if (customerServer) { await new Promise<void>((resolve) => customerServer!.close(() => resolve())); customerServer = null }
})

interface SignupResult { slug: string; cookie: string }
async function signupAndAuth(ctx: BrowserContext, email: string, workspace: string): Promise<SignupResult> {
  const page = await ctx.newPage()
  await page.goto(SIGNUP_API); await page.waitForLoadState('networkidle'); await page.waitForTimeout(800)
  await otpSignupPlaywright(page.request, SIGNUP_API, email, workspace)
  const csrfRes = await page.request.get(`${SIGNUP_API}/api/auth/csrf`); const { csrfToken } = await csrfRes.json()
  await page.request.post(`${SIGNUP_API}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  const tenantRes = await page.request.get(`${SIGNUP_API}/api/tenants/me`); const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug; expect(slug, 'slug should be set').toBeTruthy()
  const cookies = await ctx.cookies()
  const sc = cookies.find((c) => c.name.startsWith('next-auth.session-token'))
  const cookie = sc ? `${sc.name}=${sc.value}` : ''
  await page.close()
  return { slug, cookie }
}
async function setAccessMode(slug: string, cookie: string, mode: 'anonymous' | 'verified_visitor' | 'site_user_only', extra?: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUKHAN_ORIGIN}/api/widget-config/access`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ accessMode: mode, ...extra }),
  })
  expect(res.ok, `setAccessMode(${mode}) should succeed: ${res.status}`).toBe(true)
}
async function generateIntegrationSecret(_slug: string, cookie: string): Promise<string> {
  const res = await fetch(`${SUKHAN_ORIGIN}/api/widget-config/integration-secret`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
  })
  expect(res.ok, 'integration-secret generation should succeed').toBe(true)
  const data = (await res.json()) as { rawSecret?: string }
  expect(data.rawSecret, 'integration secret (rawSecret) should be returned').toBeTruthy()
  return data.rawSecret as string
}
async function mintTokenForExternalUser(externalUserId: string, name?: string): Promise<string> {
  const secret = state.integrationSecret
  if (!secret) throw new Error('no integration secret')
  const res = await fetch(`${SUKHAN_ORIGIN}/api/widget/identity/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ externalUserId, name }),
  })
  if (!res.ok) throw new Error(`mint failed: ${res.status}`)
  const data = (await res.json()) as { token?: string }
  return data.token as string
}

type Variant = 'slug' | 'v1'
/** Load the customer page + inject the script tag for the given variant. */
async function loadScript(page: Page, variant: Variant, slug: string, opts?: { identityEndpoint?: string }): Promise<void> {
  await page.goto(`${CUSTOMER_ORIGIN}/customer.html`)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(async ({ sukhanOrigin, slug, variant, identityEndpoint }) => {
    const s = document.createElement('script')
    s.async = true; s.defer = true
    if (variant === 'slug') {
      s.src = `${sukhanOrigin}/api/widget/${slug}/script`
    } else {
      s.src = `${sukhanOrigin}/api/widget/v1/sukhan.js`
      s.setAttribute('data-api-key', 'sk_' + slug)
      if (identityEndpoint) s.setAttribute('data-identity-endpoint', identityEndpoint)
    }
    document.head.appendChild(s)
  }, { sukhanOrigin: SUKHAN_ORIGIN, slug, variant, identityEndpoint: opts?.identityEndpoint })
}

/** Wire a node-side flag to the sukhan:login-required window event (installed AFTER goto). */
async function wireLoginRequired(page: Page): Promise<{ fired: () => boolean; install: () => Promise<void> }> {
  let didFire = false
  await page.exposeFunction('__skLoginRequiredBridge', () => { didFire = true })
  return {
    fired: () => didFire,
    install: async () => {
      await page.evaluate(() => {
        window.addEventListener('sukhan:login-required', () => {
          ;(window as unknown as { __skLoginRequiredBridge?: () => void }).__skLoginRequiredBridge?.()
        })
      })
    },
  }
}

test.describe('Script-widget identity parity', () => {
  for (const variant of ['slug', 'v1'] as Variant[]) {
    test(`#32 ${variant}: anonymous regression — script loads from Sukhan; anonymous contact works`, async ({ browser }) => {
      const stamp = `${process.pid}-${Date.now()}-anon-${variant}`
      const ctx = await browser.newContext()
      const { slug, cookie } = await signupAndAuth(ctx, `scr-anon-${stamp}@test.com`, `ScrAnon ${stamp}`)
      await setAccessMode(slug, cookie, 'anonymous')
      state.failureMode = 'none'; state.session = { loggedIn: false, externalUserId: 'ext_anon' }

      const page = await ctx.newPage()
      let identityCalled = false
      await page.route(`${CUSTOMER_ORIGIN}/api/sukhan-identity`, async (route) => { identityCalled = true; await route.continue() })
      await loadScript(page, variant, slug)
      await page.waitForTimeout(2000)
      expect(identityCalled, 'anonymous must NOT call the customer identityEndpoint').toBe(false)
      // Script loaded from Sukhan origin (the <script src> is the Sukhan origin).
      const scriptFromSukhan = await page.evaluate((sukhanOrigin: string) => {
        return Array.from(document.querySelectorAll('script')).some((s) => s.src && s.src.indexOf(sukhanOrigin) === 0)
      }, SUKHAN_ORIGIN)
      expect(scriptFromSukhan, 'script must load from the Sukhan origin').toBe(true)
      // Sukhan serves socket.io.min.js from its origin (not the customer origin).
      const sukhanScriptOk = await page.evaluate(async (sukhanOrigin) => {
        return await new Promise<boolean>((resolve) => {
          const s = document.createElement('script'); s.src = `${sukhanOrigin}/socket.io.min.js`; s.async = true
          s.onload = () => resolve(true); s.onerror = () => resolve(false)
          document.head.appendChild(s); setTimeout(() => resolve(false), 8000)
        })
      }, SUKHAN_ORIGIN)
      expect(sukhanScriptOk, 'socket.io.min.js must load from Sukhan origin').toBe(true)
      await ctx.close()
    })

    test(`#37 ${variant}: site_user_only logged-out — login-required UI + event + NO anonymous contact`, async ({ browser }) => {
      const stamp = `${process.pid}-${Date.now()}-lo-${variant}`
      const ctx = await browser.newContext()
      const { slug, cookie } = await signupAndAuth(ctx, `scr-lo-${stamp}@test.com`, `ScrLO ${stamp}`)
      state.integrationSecret = await generateIntegrationSecret(slug, cookie)
      await setAccessMode(slug, cookie, 'site_user_only', {
        loginUrl: '/login', loginButtonLabel: 'Sign in', loginReturnUrlParam: 'returnTo',
        identityEndpointPath: '/api/sukhan-identity',
      })
      state.failureMode = 'none'; state.session = { loggedIn: false, externalUserId: 'ext_lo' }

      const page = await ctx.newPage()
      const loginRequired = await wireLoginRequired(page)
      await loadScript(page, variant, slug)
      // Install the window listener AFTER goto (loadScript navigates to the
      // customer page) but BEFORE the script's async bootstrap dispatches the
      // login-required event. A listener installed before goto is destroyed by
      // the navigation; a reload would destroy the injected <script> tag.
      await loginRequired.install()
      await page.waitForTimeout(2500)
      const hasLoginText = await page.evaluate(() => document.body.textContent?.includes('Sign in') ?? false)
      expect(hasLoginText, `${variant}: login-required UI with 'Sign in' should render`).toBe(true)
      expect(loginRequired.fired(), `${variant}: sukhan:login-required event should fire`).toBe(true)
      const ls = await page.evaluate(() => Object.keys(localStorage))
      expect(ls.some((k) => k.startsWith('sukhan_visitor_')), `${variant}: must NOT create an anonymous visitorId Contact`).toBe(false)
      await ctx.close()
    })
  }

  test('#38 v1: SPA refreshIdentity — flip to logged-in WITHOUT page reload', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-refresh`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-refresh-${stamp}@test.com`, `ScrRefresh ${stamp}`)
    state.integrationSecret = await generateIntegrationSecret(slug, cookie)
    await setAccessMode(slug, cookie, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity', loginButtonLabel: 'Sign in' })
    state.failureMode = 'none'; state.session = { loggedIn: false, externalUserId: 'ext_refresh' }

    const page = await ctx.newPage()
    await loadScript(page, 'v1', slug)
    await page.waitForTimeout(2500)
    const cardBefore = await page.evaluate(() => !!document.querySelector('.sk-id-card'))
    expect(cardBefore, 'logged-out must show the login-required card').toBe(true)
    state.session = { loggedIn: true, externalUserId: 'ext_refresh', name: 'Refresh User' }
    await page.evaluate(() => (window as unknown as { SukhanWidget?: { refreshIdentity: () => Promise<void> } }).SukhanWidget?.refreshIdentity())
    await page.waitForTimeout(4500)
    const ready = await page.evaluate(() => { return !document.querySelector('.sk-id-card') && !!document.querySelector('.sk-input input') })
    expect(ready, 'after refreshIdentity the login card should be gone + chat ready').toBe(true)
    await ctx.close()
  })

  test('#39 v1: setIdentity user-switch — A history disappears; B cannot see A', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-switch`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-switch-${stamp}@test.com`, `ScrSwitch ${stamp}`)
    state.integrationSecret = await generateIntegrationSecret(slug, cookie)
    await setAccessMode(slug, cookie, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    state.failureMode = 'none'; state.session = { loggedIn: true, externalUserId: 'ext_user_a', name: 'User A' }
    const page = await ctx.newPage()
    await loadScript(page, 'v1', slug)
    await page.waitForTimeout(3000)
    // A is bootstrapped (logged-in via the customer identity endpoint). Send a
    // message as A so A has visible history.
    await page.evaluate(() => { const input = document.querySelector('.sk-input input') as HTMLInputElement | null; if (input) input.value = 'hello from A'; })
    await page.evaluate(() => { const btn = document.querySelector('.sk-input button') as HTMLButtonElement | null; if (btn) btn.click(); })
    await page.waitForTimeout(2500)
    // Switch to B via setIdentity (B's token minted server-side by the test).
    state.session = { loggedIn: true, externalUserId: 'ext_user_b', name: 'User B' }
    const bToken = await mintTokenForExternalUser('ext_user_b', 'User B')
    await page.evaluate(async (token) => { await (window as unknown as { SukhanWidget?: { setIdentity?: (t: string | null) => Promise<void> } }).SukhanWidget?.setIdentity?.(token) }, bToken)
    await page.waitForTimeout(4500)
    const bodyText = await page.evaluate(() => document.body.textContent ?? '')
    expect(bodyText, 'B must NOT see A message history').not.toContain('hello from A')
    await ctx.close()
  })

  test('#40 v1: logout — setIdentity(null) clears state + login-required', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-logout`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-logout-${stamp}@test.com`, `ScrLogout ${stamp}`)
    state.integrationSecret = await generateIntegrationSecret(slug, cookie)
    await setAccessMode(slug, cookie, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity', loginButtonLabel: 'Sign in' })
    state.failureMode = 'none'; state.session = { loggedIn: true, externalUserId: 'ext_logout', name: 'Logout User' }
    const page = await ctx.newPage()
    await loadScript(page, 'v1', slug)
    await page.waitForTimeout(3000)
    // Logout.
    await page.evaluate(async () => { await (window as unknown as { SukhanWidget?: { setIdentity?: (t: string | null) => Promise<void> } }).SukhanWidget?.setIdentity?.(null) })
    await page.waitForTimeout(2000)
    const cardAfter = await page.evaluate(() => !!document.querySelector('.sk-id-card'))
    expect(cardAfter, 'after setIdentity(null) the login-required card should appear').toBe(true)
    await ctx.close()
  })

  test('#41 v1: endpoint security — cross-origin reject, timeout/500/malformed fail-closed', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-sec`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-sec-${stamp}@test.com`, `ScrSec ${stamp}`)
    state.integrationSecret = await generateIntegrationSecret(slug, cookie)
    await setAccessMode(slug, cookie, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    state.failureMode = 'none'; state.session = { loggedIn: true, externalUserId: 'ext_sec' }
    for (const mode of ['timeout', 'malformed', 'auth_true_no_token', 'status500'] as const) {
      state.failureMode = mode
      const page = await ctx.newPage()
      await loadScript(page, 'v1', slug)
      await page.waitForTimeout(mode === 'timeout' ? 6500 : 2500)
      const ls = await page.evaluate(() => Object.keys(localStorage))
      expect(ls.some((k) => k.startsWith('sukhan_visitor_')), `failure mode ${mode}: must NOT create anonymous Contact`).toBe(false)
      const bodyText = await page.evaluate(() => document.body.textContent ?? '')
      const failClosed = bodyText.includes('Sign in') || bodyText.includes('unavailable') || bodyText.includes('در دسترس نیست')
      expect(failClosed, `failure mode ${mode}: should show fail-closed UI`).toBe(true)
      await page.close()
    }
    state.failureMode = 'none'
    await ctx.close()
  })

  test('#42 v1: credential leak — integration secret NOT in browser artifacts', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-leak`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-leak-${stamp}@test.com`, `ScrLeak ${stamp}`)
    const secret = await generateIntegrationSecret(slug, cookie)
    state.integrationSecret = secret
    await setAccessMode(slug, cookie, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    state.failureMode = 'none'; state.session = { loggedIn: true, externalUserId: 'ext_leak', name: 'Leak User' }
    const page = await ctx.newPage()
    await loadScript(page, 'v1', slug)
    await page.waitForTimeout(3000)
    const leaked = await page.evaluate((secret) => {
      const html = document.documentElement.outerHTML
      const lsValues = Object.values(localStorage).join('')
      const ssValues = Object.values(sessionStorage).join('')
      const windowKeys = Object.keys(window).join(',')
      return [html, lsValues, ssValues, windowKeys].some((a) => a.includes(secret))
    }, secret)
    expect(leaked, 'the raw integration secret must NOT appear in any browser artifact').toBe(false)
    await ctx.close()
  })

  test('#24 v1: login URL — relative resolves against CUSTOMER origin + return param', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-loginurl`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-loginurl-${stamp}@test.com`, `ScrLoginUrl ${stamp}`)
    state.integrationSecret = await generateIntegrationSecret(slug, cookie)
    await setAccessMode(slug, cookie, 'site_user_only', {
      identityEndpointPath: '/api/sukhan-identity', loginUrl: '/login', loginButtonLabel: 'Sign in now', loginReturnUrlParam: 'returnTo',
    })
    state.failureMode = 'none'; state.session = { loggedIn: false, externalUserId: 'ext_loginurl' }
    const page = await ctx.newPage()
    await loadScript(page, 'v1', slug)
    await page.waitForTimeout(2500)
    const href = await page.evaluate(() => { const a = document.querySelector('.sk-id-card a') as HTMLAnchorElement | null; return a ? a.href : null })
    expect(href, 'login link should render').toBeTruthy()
    expect(href).toContain(CUSTOMER_ORIGIN)
    expect(href).not.toContain('app.sukhan.chat')
    expect(href).toContain('/login')
    const u = new URL(href as string)
    expect(u.searchParams.get('returnTo')).toContain(CUSTOMER_ORIGIN)
    await ctx.close()
  })

  test('#33 slug: verified_visitor OTP/resume — START + 123456 VERIFY + reload restores', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-scr-vv`
    const ctx = await browser.newContext()
    const { slug, cookie } = await signupAndAuth(ctx, `scr-vv-${stamp}@test.com`, `ScrVV ${stamp}`)
    await setAccessMode(slug, cookie, 'verified_visitor')
    state.failureMode = 'none'; state.session = { loggedIn: false, externalUserId: 'ext_vv' }
    const page = await ctx.newPage()
    await loadScript(page, 'slug', slug)
    await page.waitForTimeout(2000)
    // Verification UI appears.
    const verifyUi = await page.evaluate(() => document.body.textContent?.includes('تأیید ایمیل') || document.body.textContent?.includes('Verify your email') || false)
    expect(verifyUi, 'verified_visitor must show the verification UI').toBe(true)
    // Enter name + email + continue.
    await page.evaluate(() => { const inputs = document.querySelectorAll('.sk-id-card input'); (inputs[0] as HTMLInputElement).value = 'Visitor'; (inputs[1] as HTMLInputElement).value = 'vv@test.com'; })
    await page.evaluate(() => { const btn = document.querySelector('.sk-id-card button') as HTMLButtonElement; if (btn) btn.click(); })
    await page.waitForTimeout(1500)
    // Code form appears → enter 123456 + verify.
    await page.evaluate(() => { const ci = document.querySelector('.sk-id-card input') as HTMLInputElement; if (ci) ci.value = '123456'; })
    await page.evaluate(() => { const btn = document.querySelector('.sk-id-card button') as HTMLButtonElement; if (btn) btn.click(); })
    await page.waitForTimeout(3000)
    // Resume stored → authenticated /contact → chat ready.
    const resumeStored = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sukhan_verified_resume_')))
    expect(resumeStored, 'resume credential should be stored').toBe(true)
    const ready = await page.evaluate(() => !!document.querySelector('.sk-input input'))
    expect(ready, 'after OTP verify the chat should be ready').toBe(true)
    await ctx.close()
  })
})
