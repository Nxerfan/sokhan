import { test, expect, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * External-origin slug widget regression test.
 *
 * Verifies that when the slug widget is embedded on a customer's website
 * (an origin DIFFERENT from the Sukhan app), ALL its traffic — REST
 * (config/contact/messages) AND realtime (Socket.IO) — is pointed at
 * the Sukhan origin, NOT the customer's origin.
 *
 * Before the fix: the slug widget used RELATIVE URLs for REST endpoints
 * (`/api/widget/<slug>/config` etc.) and a RELATIVE Socket.IO URL
 * (`/?XTransformPort=3003`). On a customer's website, the browser
 * resolves these against the PAGE origin — i.e., the customer's
 * website — so the requests would go to the WRONG server and fail.
 *
 * After the fix: the slug widget extracts the Sukhan origin from the
 * script's own `src` attribute (`document.currentScript.src.split('/api/widget/')[0]`)
 * and prefixes ALL its URLs with that origin — consistent with the v1
 * widget which already did this.
 *
 * Test setup:
 *   1. Sign up a tenant so we have a real slug.
 *   2. Use Playwright's route() to serve a fake customer page from a
 *      DIFFERENT port (port 8082 — "customer website") than the Sukhan
 *      app (port 81 — via the gateway). The page origin is
 *      http://127.0.0.1:82, distinct from the Sukhan origin
 *      http://127.0.0.1:81.
 *   3. Navigate to the fake customer page.
 *   4. Inject the Sukhan widget script with an ABSOLUTE URL pointing
 *      at the Sukhan origin (mimicking how a real customer would embed
 *      it: <script src="http://sukhan.app/api/widget/<slug>/script">).
 *   5. Intercept all network requests from the page.
 *   6. Open the widget (click the launcher) so the config + contact
 *      fetches fire.
 *   7. Verify:
 *      - The config fetch URL's origin is the Sukhan origin (port 81).
 *      - The contact fetch URL's origin is the Sukhan origin.
 *      - The socket.io.min.js script URL's origin is the Sukhan origin.
 *      - The Socket.IO connection's host is the Sukhan origin.
 *      - NO widget-related request goes to the customer origin (port 8082).
 */

const SIGNUP_API = 'http://127.0.0.1:3000'   // Next.js direct — signup API
const SUKHAN_ORIGIN = 'http://127.0.0.1:81'  // Sukhan origin (via gateway)
const CUSTOMER_PORT = 8082
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}` // Fake customer website origin
const WIDGET_SCRIPT_URL = (slug: string) => `${SUKHAN_ORIGIN}/api/widget/${slug}/script`

let customerServer: Server | null = null

test.beforeAll(async () => {
  // Start a simple HTTP server that serves a fake "customer website"
  // page. Using a REAL server (not page.route()) avoids Chromium's
  // "Private Network Access" CORS block, which prevents cross-origin
  // requests from a route-fulfilled page to a loopback address.
  customerServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer Website</title></head><body><h1>Customer Website</h1><p>This page simulates a customer website on a different origin from the Sukhan app.</p></body></html>')
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

  // 3-step OTP signup (start → verify → complete) — the legacy
  // /api/auth/signup endpoint is now deprecated (returns 410 Gone).
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

test.describe('External-origin slug widget', () => {
  test('all REST + realtime traffic points to Sukhan origin (not the customer origin)', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-ext`
    const email = `ext-${stamp}@test.com`

    // 1. Sign up a tenant so we have a real slug.
    const ctx = await browser.newContext()
    const { slug } = await signupAndGetSlug(ctx, email, `EXTWS ${stamp}`)
    expect(slug).toBeTruthy()

    // 2. A real HTTP server on port 8082 (started in beforeAll) serves
    //    the fake customer page. Using a REAL server avoids Chromium's
    //    "Private Network Access" CORS block.
    const page = await ctx.newPage()

    // 3. Intercept all requests from the page so we can assert on their
    //    URLs. We track widget-related requests (config, contact,
    //    messages, csat, socket.io.min.js, and the Socket.IO handshake).
    //    We also capture WebSocket connections (the socket.io client may
    //    upgrade directly to websocket, bypassing the HTTP polling
    //    handshake that page.on('request') would catch).
    const widgetRequests: string[] = []
    page.on('request', (req) => {
      const url = req.url()
      if (
        url.includes('/api/widget/') ||
        url.includes('/socket.io') ||
        url.includes('XTransformPort') ||
        url.includes('/socket.io.min.js') ||
        url.includes('engine.io')
      ) {
        widgetRequests.push(url)
      }
    })
    // Capture WebSocket creation too (the socket.io client may upgrade
    // to ws:// directly).
    page.on('websocket', (ws) => {
      const url = ws.url()
      widgetRequests.push(`[ws] ${url}`)
    })

    // 4. Navigate to the fake customer page (port 8082 — different origin
    //    from the Sukhan app on port 81).
    await page.goto(`${CUSTOMER_ORIGIN}/customer.html`)
    await page.waitForLoadState('domcontentloaded')

    // 5. Inject the Sukhan widget script with an ABSOLUTE URL — mimicking
    //    how a real customer would embed it:
    //      <script async defer src="https://sukhan.app/api/widget/<slug>/script"></script>
    await page.addScriptTag({ url: WIDGET_SCRIPT_URL(slug) })

    // 6. Wait for the script to load + the widget to mount + the config
    //    fetch to fire.
    await page.waitForTimeout(3000)

    // 7. Open the widget panel (click the launcher) — this triggers the
    //    contact identification flow (which fires the /contact POST).
    const launcher = page.locator('.sk-launcher')
    await expect(launcher, 'widget launcher should appear on the customer page').toBeVisible({ timeout: 10000 })
    await launcher.click()
    // Wait for the contact POST → connectSocket() → socket.io.min.js
    // load → io() connect → engine.io handshake. Give it generous time
    // since the socket connection is async.
    await page.waitForTimeout(5000)

    // 8. ASSERT: every widget-related request must be on the Sukhan
    //    origin (http://127.0.0.1:81), NOT on the customer's origin
    //    (http://127.0.0.1:82). A relative URL on the customer page
    //    would resolve to http://127.0.0.1:82/api/widget/... — which
    //    would either fail (port 8082 isn't serving the Sukhan app) or
    //    go to the WRONG server.
    expect(
      widgetRequests.length,
      `expected at least one widget request — got: ${JSON.stringify(widgetRequests)}`,
    ).toBeGreaterThan(0)

    // The Sukhan origin is http://127.0.0.1:81 — but WebSocket
    // connections use ws://127.0.0.1:81 (same host:port, different
    // scheme). We check the host:port portion only.
    const sukhanHostPort = '127.0.0.1:81'
    const offenders: string[] = []
    for (const url of widgetRequests) {
      // Strip any "[ws] " prefix (added to WebSocket URLs for clarity)
      // AND the protocol prefix (http://, https://, ws://, wss://).
      const stripped = url.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '')
      if (!stripped.startsWith(sukhanHostPort)) {
        offenders.push(url)
      }
    }
    expect(
      offenders,
      `all widget requests should be on the Sukhan origin (${sukhanHostPort}) — offending requests: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([])

    // 9. Specific assertions:
    //    a. The config fetch fired AND went to Sukhan origin.
    const configReq = widgetRequests.find((u) => u.includes(`/api/widget/${slug}/config`))
    expect(
      configReq,
      `config request should have fired (got requests: ${JSON.stringify(widgetRequests, null, 2)})`,
    ).toBeTruthy()
    expect(configReq!.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '').startsWith(sukhanHostPort), `config request should be on ${sukhanHostPort}`).toBe(true)

    //    b. The socket.io.min.js script load fired AND went to Sukhan origin.
    const socketIoJsReq = widgetRequests.find((u) => u.includes('/socket.io.min.js'))
    expect(
      socketIoJsReq,
      `socket.io.min.js script load should have fired`,
    ).toBeTruthy()
    expect(socketIoJsReq!.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '').startsWith(sukhanHostPort), `socket.io.min.js should be on ${sukhanHostPort}`).toBe(true)

    //    c. The contact POST fired AND went to Sukhan origin (the
    //       launcher click triggers visitor identification).
    const contactReq = widgetRequests.find((u) => u.includes(`/api/widget/${slug}/contact`))
    expect(
      contactReq,
      `contact request should have fired after launcher click (got: ${JSON.stringify(widgetRequests, null, 2)})`,
    ).toBeTruthy()
    expect(contactReq!.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '').startsWith(sukhanHostPort), `contact request should be on ${sukhanHostPort}`).toBe(true)

    // 10. ASSERT: the Socket.IO connection (engine.io handshake) goes to
    //     the Sukhan origin, NOT the customer's origin. The handshake
    //     URL contains `?XTransformPort=3003` (Docker mode) or
    //     `socket.io` (the engine.io path). The HOST must be Sukhan.
    const socketHandshake = widgetRequests.find(
      (u) => u.includes('XTransformPort=3003') || u.includes('/socket.io/') || u.includes('engine.io'),
    )
    expect(
      socketHandshake,
      `Socket.IO handshake should have fired (got: ${JSON.stringify(widgetRequests, null, 2)})`,
    ).toBeTruthy()
    expect(socketHandshake!.replace(/^\[ws\] /, '').replace(/^[a-z]+:\/\//, '').startsWith(sukhanHostPort), `socket handshake should be on ${sukhanHostPort}`).toBe(true)

    await ctx.close()
  })
})
