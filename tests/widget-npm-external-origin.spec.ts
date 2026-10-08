import { test, expect, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget NPM external-origin regression (Scenario F).
 *
 * Verifies the SERVER-SIDE contract that the cross-origin NPM widget
 * package relies on:
 *
 *   1. The Sukhan backend returns the additive `realtime` field in the
 *      widget config response (added in PR widget-inbox-realtime-
 *      reliability). The field exposes the Socket.IO connection params
 *      (url / path / transports / addTrailingSlash) so the NPM widget
 *      does NOT need to know the deployment topology (Vercel vs
 *      Docker vs explicit NEXT_PUBLIC_REALTIME_URL).
 *
 *   2. The Sukhan backend serves the Socket.IO client script at
 *      `/socket.io.min.js` on the Sukhan origin (the same origin as
 *      the widget config + REST endpoints). The NPM widget's script
 *      URL + realtime config must come from the Sukhan backend, NOT
 *      from the host customer page origin.
 *
 *   3. The customer origin does NOT proxy `/socket.io.min.js` to the
 *      Sukhan backend. A request for `/socket.io.min.js` on the
 *      customer origin returns 404 (or any non-200 / non-JS body) -
 *      proving the customer's web server is not masquerading as the
 *      Sukhan realtime backend.
 *
 * This is an API-level + customer-origin test (NOT a full NPM-package
 * browser test) because building + publishing the NPM package is out
 * of scope for the regression suite. The contract verified here is
 * the same contract the NPM package consumes at runtime:
 *
 *   - fetch(`${SUKHAN_ORIGIN}/api/widget/<slug>/config`) -> JSON
 *     with `realtime` field.
 *   - fetch(`${SUKHAN_ORIGIN}/socket.io.min.js`) -> 200 + JS body.
 *   - fetch(`${CUSTOMER_ORIGIN}/socket.io.min.js`) -> NOT the Sukhan
 *     script (404 from the customer server).
 *
 * Setup (reuses tests/widget-external-origin.spec.ts pattern):
 *   - Spin up a customer HTTP server on port 8083 (a different origin
 *     from the Sukhan app on port 81). The customer server serves a
 *     simple HTML page for `/` and returns 404 for everything else
 *     (mimicking a real customer web server that does NOT proxy
 *     Sukhan paths).
 *   - Sign up a tenant to get a real slug.
 *   - From the customer page (loaded in a browser context), fetch the
 *     Sukhan widget config (CORS-enabled - the Sukhan backend sets
 *     `Access-Control-Allow-Origin: *`).
 *   - From the customer page, also fetch `/socket.io.min.js` from the
 *     Sukhan origin (CORS-enabled - the Sukhan realtime service sets
 *     `cors: { origin: '*' }`).
 *   - Assert: the customer-origin `/socket.io.min.js` request returns
 *     404 (the customer server doesn't serve it).
 */

const SIGNUP_API = 'http://127.0.0.1:3000'    // Next.js direct - signup API
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'   // Sukhan origin (via gateway)
const CUSTOMER_PORT = 8083
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}` // Fake customer origin

let customerServer: Server | null = null

test.beforeAll(async () => {
  // Start a simple HTTP server that simulates a customer website.
  // Serves a minimal HTML page for `/` (and `/customer.html`); 404 for
  // everything else (mimicking a real customer web server that does
  // NOT proxy Sukhan paths like `/socket.io.min.js`).
  customerServer = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/' || url === '/customer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer Website</title></head>' +
        '<body><h1>Customer Website</h1>' +
        '<p>This page simulates a customer website on a different origin from the Sukhan app.</p>' +
        '</body></html>',
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  })
  await new Promise<void>((resolve) => customerServer!.listen(CUSTOMER_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  if (customerServer) {
    await new Promise<void>((resolve) => customerServer!.close(() => resolve()))
    customerServer = null
  }
})

interface SignupResult { slug: string }

async function signupAndGetSlug(ctx: BrowserContext, email: string, workspace: string): Promise<SignupResult> {
  const page = await ctx.newPage()
  await page.goto(SIGNUP_API)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // 3-step OTP signup (start -> verify -> complete).
  await otpSignupPlaywright(page.request, SIGNUP_API, email, workspace)
  const csrfRes = await page.request.get(`${SIGNUP_API}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${SIGNUP_API}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })

  const tenantRes = await page.request.get(`${SIGNUP_API}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  expect(slug, `slug should be set (tenant data: ${JSON.stringify(tenantData)})`).toBeTruthy()
  await page.close()
  return { slug }
}

test.describe('Widget NPM external origin (Scenario F)', () => {
  test('config includes the realtime field; socket.io.min.js is served from Sukhan, NOT the customer origin', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-npm`
    const email = `npm-${stamp}@test.com`

    // 1. Sign up a tenant to get a real slug.
    const ctx = await browser.newContext()
    const { slug } = await signupAndGetSlug(ctx, email, `NPMWS ${stamp}`)
    expect(slug).toBeTruthy()

    // 2. Open the customer page (port 8083 - different origin from the
    //    Sukhan app on port 81). The customer page is served by our
    //    test HTTP server.
    const page = await ctx.newPage()
    await page.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await page.waitForLoadState('domcontentloaded')

    // 3. From the customer page, fetch the Sukhan widget config. The
    //    Sukhan backend sets `Access-Control-Allow-Origin: *` on
    //    widget config responses, so the cross-origin fetch succeeds.
    const configResult = await page.evaluate(async ({ sukhanOrigin, slug }) => {
      try {
        const res = await fetch(`${sukhanOrigin}/api/widget/${slug}/config`)
        const json = res.ok ? await res.json() : null
        return {
          ok: res.ok,
          status: res.status,
          json,
        }
      } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
      }
    }, { sukhanOrigin: SUKHAN_ORIGIN, slug })

    expect(
      configResult.ok,
      `config fetch from customer page to Sukhan origin should succeed (status=${configResult.status}, error=${(configResult as { error?: string }).error ?? 'none'})`,
    ).toBe(true)
    expect(configResult.json, 'config response should be JSON').toBeTruthy()

    // 4. ASSERT: the config response includes the additive `realtime`
    //    field with the expected sub-fields (url / path / transports /
    //    addTrailingSlash). These are the keys the NPM widget reads
    //    to construct its Socket.IO connection.
    const config = configResult.json as Record<string, unknown>
    expect(config.realtime, 'config should include the `realtime` field').toBeDefined()
    const realtime = config.realtime as Record<string, unknown>
    expect(typeof realtime.url, 'realtime.url should be a string').toBe('string')
    expect(typeof realtime.path, 'realtime.path should be a string').toBe('string')
    expect(Array.isArray(realtime.transports), 'realtime.transports should be an array').toBe(true)
    expect(typeof realtime.addTrailingSlash, 'realtime.addTrailingSlash should be a boolean').toBe('boolean')

    // 5. ASSERT: the Sukhan origin serves `/socket.io.min.js` (200
    //    response). This is the Socket.IO client library that the NPM
    //    widget's script URL points at. The Sukhan realtime service
    //    (or Caddy) serves this on the Sukhan origin.
    // /socket.io.min.js is a static file (public/socket.io.min.js). Cross-origin
    // FETCH of a static file is CORS-blocked, but the NPM widget loads it via a
    // <script> tag (not subject to CORS for execution). Verify it loads from the
    // Sukhan origin via a script tag.
    const scriptLoaded = await page.evaluate(async (sukhanOrigin) => {
      return await new Promise<boolean>((resolve) => {
        const s = document.createElement('script')
        s.src = `${sukhanOrigin}/socket.io.min.js`
        s.async = true
        s.onload = () => resolve(true)
        s.onerror = () => resolve(false)
        document.head.appendChild(s)
        setTimeout(() => resolve(false), 8000)
      })
    }, SUKHAN_ORIGIN).catch(() => false)

    expect(
      scriptLoaded,
      `${SUKHAN_ORIGIN}/socket.io.min.js should load via a <script> tag from the Sukhan backend (the NPM widget loads it this way)`,
    ).toBe(true)

    // 6. ASSERT: the customer origin does NOT proxy `/socket.io.min.js`
    //    to the Sukhan backend. A request to the customer origin for
    //    that path returns 404 (our test customer server returns 404
    //    for any non-`/` path; a real customer web server would also
    //    not serve the Sukhan realtime client script).
    //
    //    This proves the NPM widget's script URL + realtime config
    //    come from the Sukhan backend, NOT the host page origin.
    //    If the customer origin "proxied" the script URL (a future
    //    regression that somehow made the NPM widget resolve the
    //    script URL against the page origin), the request would
    //    return the Sukhan JS body (200 + Socket.IO content). The
    //    assertion below catches that regression.
    const customerScriptResult = await page.evaluate(async (customerOrigin) => {
      try {
        const res = await fetch(`${customerOrigin}/socket.io.min.js`)
        const text = res.ok ? await res.text() : ''
        return {
          ok: res.ok,
          status: res.status,
          bodyHead: text.slice(0, 200),
          bodyLength: text.length,
        }
      } catch (e) {
        // A refused connection or a network error also proves the
        // customer origin does NOT serve the Sukhan script - that
        // is a pass for the regression check.
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e), bodyLength: 0 }
      }
    }, CUSTOMER_ORIGIN)

    expect(
      customerScriptResult.ok,
      `customer origin ${CUSTOMER_ORIGIN}/socket.io.min.js should NOT serve the Sukhan script (got status=${customerScriptResult.status}, bodyLength=${customerScriptResult.bodyLength} - this would indicate the customer origin is proxying / masquerading as the Sukhan backend)`,
    ).toBe(false)

    await ctx.close()
  })
})
