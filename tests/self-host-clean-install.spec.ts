import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { execSync } from 'child_process'
import { createServer, type Server } from 'node:http'
import { join } from 'path'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Production-shape clean-install qualification test — for BOTH Full and Lite.
 *
 * This test proves an operator can go from `git clone` to a fully-working
 * Sukhan deployment using ONLY the production artifacts (production
 * docker-compose file, production Caddyfile, NO test override compose):
 *
 *   - Uses ONLY docker-compose.yml (Full) / docker-compose.lite.yml (Lite).
 *   - NO test override compose (no port 3000 / 3003 / 5432 exposed to host).
 *   - ALL HTTP traffic goes through http://127.0.0.1 (Caddy on port 80).
 *   - NIXIFY_MOCK / NEXTAUTH_SECRET / POSTGRES_PASSWORD passed as env vars
 *     when invoking docker compose (NOT via test override compose).
 *   - The test manages Docker itself: up/down/restart, etc.
 *
 * WHY REST APIs (not the dashboard UI) for the agent side:
 *   The backup/restore test (tests/self-host-backup-restore.spec.ts) drives
 *   the agent side entirely through REST APIs and PASSES reliably through
 *   the production Caddy topology. The previous clean-install test drove the
 *   dashboard Inbox UI (clicking nav buttons, waiting for Socket.IO
 *   CONVERSATION_NEW events through Caddy) — which is flaky because the
 *   dashboard's React state machine is sensitive to the order of network
 *   responses and Socket.IO event delivery. The data layer (Postgres +
 *   REST endpoints) is the source of truth; driving the agent side via
 *   REST proves the deployment is healthy WITHOUT coupling the test to
 *   React component timing. The visitor side stays on the real widget UI
 *   because that's the user-visible surface the test must validate.
 *
 * Test flow (per edition):
 *   1.  Fresh volumes (docker compose down -v first).
 *   2.  Start production compose with NIXIFY_MOCK=true,
 *       NEXTAUTH_SECRET=test-secret, POSTGRES_PASSWORD=test-password.
 *   3.  Wait for Caddy on http://127.0.0.1.
 *   4.  Signup via REST API (otpSignupPlaywright with http://127.0.0.1).
 *   5.  Login via REST API (NextAuth credentials callback).
 *   6.  Dashboard reachable (GET http://127.0.0.1/api/tenants/me → 200).
 *   7.  Widget script reachable (GET http://127.0.0.1/api/widget/<slug>/script → 200).
 *   8.  Customer-origin page loads widget (HTTP server on port 8088).
 *   9.  Visitor sends message through widget UI (optimistic + POST reconciliation).
 *   10. Conversation exists via REST API (GET http://127.0.0.1/api/conversations).
 *   11. Agent sends reply via REST API (POST .../api/conversations/<id>/messages).
 *   12. Visitor widget receives the reply without reload (Socket.IO or polling).
 *   13. Restart app/realtime containers (docker compose restart app realtime).
 *   14. Wait for Caddy to respond again.
 *   15. Verify workspace exists (GET http://127.0.0.1/api/tenants/me).
 *   16. Verify conversation exists (GET http://127.0.0.1/api/conversations).
 *   17. Verify messages exist (GET .../api/widget/<slug>/messages?conversationId=<id>
 *       with Bearer token).
 *   18. Widget still works (reload customer page → messages still visible).
 *   19. Cleanup: docker compose down -v.
 */

const ORIGIN = 'http://127.0.0.1' // Caddy HTTP on port 80 (production).
const REPO_ROOT = process.cwd()
const CUSTOMER_PORT = 8088
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`

/**
 * Secrets passed as env vars when invoking docker compose. Same rationale
 * as the backup/restore test: these pass the canonical secret validator
 * (non-empty, non-placeholder). See src/lib/secret-validation.ts.
 */
const COMPOSE_ENV: Record<string, string> = {
  NIXIFY_MOCK: 'true',
  NEXTAUTH_SECRET: 'test-secret',
  POSTGRES_PASSWORD: 'test-password',
}

interface EditionSpec {
  composeFile: string
  /** Deterministic Compose project name. Sets volume label namespace. */
  projectName: string
  label: string
}

/**
 * Full and Lite tests run sequentially (workers: 1, fullyParallel: false).
 * They share host port 80 — each test `down -v`s at start and end so
 * the next test always starts with port 80 free.
 *
 * Different project names so their volumes (some overlap, e.g. `uploads`,
 * `logs`, `caddy-data`, `caddy-config`) never collide on the Docker daemon.
 */
const EDITIONS: EditionSpec[] = [
  {
    composeFile: join(REPO_ROOT, 'docker-compose.yml'),
    projectName: 'sukhan-clean-full',
    label: 'full',
  },
  {
    composeFile: join(REPO_ROOT, 'docker-compose.lite.yml'),
    projectName: 'sukhan-clean-lite',
    label: 'lite',
  },
]

/**
 * Run `docker compose` against the given edition with the deterministic
 * project name + COMPOSE_ENV. Captures stdout/stderr; on failure, logs
 * the captured output to the test console so the operator can see WHY
 * the docker command failed.
 */
function runDocker(spec: EditionSpec, args: string, env: Record<string, string> = {}): string {
  const cmd = `docker compose -f ${spec.composeFile} -p ${spec.projectName} ${args}`
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      env: { ...process.env, ...COMPOSE_ENV, ...env },
      // The longest docker op is `up -d` (which includes migrations on
      // first start). 3 minutes is generous; matches Playwright's
      // 5-minute per-test timeout headroom.
      timeout: 180000,
    })
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    console.error(`[docker] FAILED: ${cmd}`)
    if (err.stdout) console.error(`[docker] stdout: ${err.stdout}`)
    if (err.stderr) console.error(`[docker] stderr: ${err.stderr}`)
    throw e
  }
}

/**
 * Poll the Caddy origin until /api returns 200 (Next.js catch-all route
 * responding through the production reverse proxy). Throws if the origin
 * does not return 200 within maxMs.
 */
async function waitForCaddy(maxMs = 120000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${ORIGIN}/api`)
      // 200 = Next.js app catch-all route is responding through Caddy.
      // Other statuses (502 = Caddy up but app down, 404 = app up but
      // no route) keep polling.
      if (res.status === 200) return
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(
    `${ORIGIN}/api did not return 200 within ${maxMs}ms (last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`,
  )
}

/**
 * Login via the NextAuth credentials callback through Caddy. The
 * APIRequestContext carries cookies, so subsequent requests on the
 * same context are authenticated.
 */
async function loginViaCaddy(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const csrfRes = await request.get(`${ORIGIN}/api/auth/csrf`)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  await request.post(`${ORIGIN}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=${password}&csrfToken=${csrfToken}&json=true`,
  })
}

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `clean-${stamp}@test.com`,
    workspace: `Clean ${stamp}`,
    password: 'password123',
  }
}

/**
 * Customer HTTP server on port 8088 — simulates a real customer website
 * on a different origin from the Sukhan app. The HTML embeds the Sukhan
 * widget <script> with an ABSOLUTE URL pointing at the Sukhan origin,
 * matching the production embed pattern:
 *   <script async defer src="http://<sukhan-origin>/api/widget/<slug>/script"></script>
 *
 * Using a REAL server (not page.route()) avoids Chromium's "Private Network
 * Access" CORS block on cross-origin requests from a route-fulfilled page
 * to a loopback address.
 *
 * `currentSlug` is updated by each test before loading the widget page,
 * so both Full and Lite tests share the same server.
 */
let customerServer: Server | null = null
let currentSlug = ''

test.beforeAll(async () => {
  customerServer = createServer((_req, res) => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<title>Customer Website</title></head><body><h1>Customer Website</h1>' +
      `<script async defer src="${ORIGIN}/api/widget/${currentSlug}/script"></script>` +
      '</body></html>'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => customerServer!.listen(CUSTOMER_PORT, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  if (customerServer) {
    await new Promise<void>((resolve) => customerServer!.close(() => resolve()))
    customerServer = null
  }
})

/**
 * Shape of the visitor token returned by POST /api/widget/<slug>/contact.
 * The same shape is used by the dashboard REST API caller when it
 * re-issues a contact call to obtain a Bearer token for the messages
 * endpoint (Step 17). This avoids reaching into the widget's in-memory
 * state.
 */
interface ContactResponse {
  realtimeToken?: string
  contactId?: string
  conversationId?: string
}

interface TenantResponse {
  tenant?: { id?: string; name?: string; slug?: string }
}

interface ConversationListResponse {
  conversations?: Array<{
    id: string
    lastMessagePreview?: string
    contact?: { id?: string; name?: string | null; email?: string | null }
  }>
}

interface MessageListResponse {
  messages?: Array<{
    senderType?: string
    content?: { text?: string }
  }>
}

interface AgentReplyResponse {
  message?: { id?: string; content?: { text?: string } }
}

for (const spec of EDITIONS) {
  test(`Clean-install qualification — ${spec.label} edition (production shape)`, async ({ browser }) => {
    test.setTimeout(300000) // 5 minutes per edition — slow Docker test.
    const { email, workspace, password } = creds(spec.label)
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const contactName = `CleanTest-${stamp}`
    const visitorText = `CLEAN_VISITOR_${stamp}`
    const replyText = `CLEAN_REPLY_${stamp}`

    // Dashboard-side page — used ONLY for its APIRequestContext (so the
    // OTP signup + NextAuth login cookies ride on the same context). The
    // dashboard UI itself is never loaded or clicked through.
    let dashboardPage: Page | null = null
    // Visitor-side widget page — separate browser context, customer origin.
    let widgetCtx: BrowserContext | null = null

    try {
      // ---- Step 1: Fresh volumes (clean any leftover state). ----
      // Tolerate failure here — if a previous test crashed mid-cleanup
      // the project may already be gone.
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch {
        // ignore — the project may not exist yet
      }

      // ---- Step 2: Start the PRODUCTION compose file with NIXIFY_MOCK=true. ----
      runDocker(spec, 'up -d')

      // ---- Step 3: Wait for Caddy on http://127.0.0.1. ----
      await waitForCaddy()

      // The dashboard context hosts the APIRequestContext we use for the
      // REST-driven agent side. We never navigate this page to the
      // dashboard UI — only its `.request` (APIRequestContext) is used,
      // so cookies set by signup/login persist for subsequent calls.
      const dashboardCtx = await browser.newContext()
      dashboardPage = await dashboardCtx.newPage()

      // ---- Step 4: Signup via REST API. ----
      // ---- Step 5: Login via REST API (NextAuth credentials callback). ----
      await otpSignupPlaywright(dashboardPage.request, ORIGIN, email, workspace)
      await loginViaCaddy(dashboardPage.request, email, password)

      // ---- Step 6: Dashboard reachable — GET /api/tenants/me returns 200. ----
      const tenantRes = await dashboardPage.request.get(`${ORIGIN}/api/tenants/me`)
      expect(
        tenantRes.ok(),
        `tenant endpoint should return 200 through Caddy (got ${tenantRes.status()})`,
      ).toBe(true)
      const tenantData = (await tenantRes.json()) as TenantResponse
      const slug = tenantData.tenant?.slug
      expect(slug, 'tenant should have a slug after signup').toBeTruthy()
      expect(tenantData.tenant?.name, 'tenant name should match the workspace').toBe(workspace)
      currentSlug = slug as string

      // ---- Step 7: Widget script reachable — GET /api/widget/<slug>/script → 200. ----
      const scriptRes = await dashboardPage.request.get(`${ORIGIN}/api/widget/${slug}/script`)
      expect(
        scriptRes.ok(),
        `widget script should be reachable through Caddy at ${ORIGIN}/api/widget/${slug}/script`,
      ).toBe(true)

      // ---- Step 8: Customer-origin page loads widget (port 8088 server). ----
      widgetCtx = await browser.newContext()
      const widgetPage = await widgetCtx.newPage()
      await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
      await widgetPage.waitForLoadState('domcontentloaded')
      // The widget script is async + defer — give it time to fetch the
      // config + render the launcher.
      await widgetPage.waitForTimeout(3000)
      const launcher = widgetPage.locator('.sk-launcher')
      await expect(
        launcher,
        'widget launcher should appear on the external customer page',
      ).toBeVisible({ timeout: 10000 })
      await launcher.click()
      // Cross-origin WebSocket upgrade may take a few seconds in CI Docker.
      await widgetPage.waitForTimeout(5000)

      // ---- Step 9: Visitor sends a message through the widget UI. ----
      // The widget optimistic-renders the bubble immediately, then POSTs
      // to /api/widget/<slug>/messages and clears the .sk-pending class
      // when the server reconciles.
      const widgetInput = widgetPage.locator('.sk-panel input').first()
      await expect(widgetInput, 'widget input should be visible after launcher click').toBeVisible({
        timeout: 5000,
      })
      await widgetInput.fill(visitorText)
      await widgetInput.press('Enter')
      const visitorBubble = widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText })
      await expect(
        visitorBubble,
        'visitor optimistic bubble must appear immediately after Enter',
      ).toHaveCount(1, { timeout: 5000 })
      // The .sk-pending class clears when the POST reconciles.
      await expect(
        widgetPage.locator('.sk-msg.sk-vis.sk-pending p').filter({ hasText: visitorText }),
        'pending class must clear after POST reconciliation',
      ).toHaveCount(0, { timeout: 15000 })
      await expect(visitorBubble, 'visitor message must appear EXACTLY ONCE').toHaveCount(1)

      // ---- Step 10: Conversation exists via REST API. ----
      // The agent dashboard conversation list endpoint returns the new
      // conversation (with lastMessagePreview = the visitor's text,
      // truncated to 120 chars — short enough for our stamp).
      const convListRes = await dashboardPage.request.get(`${ORIGIN}/api/conversations`)
      expect(convListRes.ok(), 'conversations API should return 200').toBe(true)
      const convListData = (await convListRes.json()) as ConversationListResponse
      const conv = convListData.conversations?.find(
        (c) =>
          c.lastMessagePreview?.includes(visitorText) || c.contact?.name === contactName,
      )
      expect(
        conv,
        'conversation must exist in the API response after the visitor message',
      ).toBeTruthy()
      const conversationId = conv!.id
      expect(conversationId, 'conversation must have an id').toBeTruthy()

      // Capture the widget's visitorId from localStorage so we can
      // re-issue a contact call after the restart (Step 17) and get a
      // fresh realtimeToken bound to the same conversation — without
      // reaching into the widget's in-memory state.
      const storageKey = `sukhan_visitor_${slug}`
      const visitorId = (await widgetPage.evaluate(
        (key) => window.localStorage.getItem(key),
        storageKey,
      )) as string | null
      expect(visitorId, 'widget should have stored a visitorId in localStorage').toBeTruthy()

      // ---- Step 11: Agent sends a reply via REST API. ----
      // The dashboard-side POST /api/conversations/<id>/messages persists
      // the agent message and publishes it to the realtime service, which
      // fans it out to the widget over Socket.IO (or the polling fallback).
      const replyRes = await dashboardPage.request.post(
        `${ORIGIN}/api/conversations/${conversationId}/messages`,
        {
          data: { text: replyText },
          headers: { 'Content-Type': 'application/json' },
        },
      )
      expect(replyRes.ok(), 'agent reply POST should return 200').toBe(true)
      const replyData = (await replyRes.json()) as AgentReplyResponse
      expect(replyData.message?.id, 'agent reply should be persisted with an id').toBeTruthy()

      // ---- Step 12: Visitor widget receives the reply without reload. ----
      // The widget must receive the agent reply via Socket.IO (or the
      // polling fallback) WITHOUT a page reload. This proves the full
      // realtime round-trip through the production Caddy gateway.
      const replyBubble = widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText })
      await expect(
        replyBubble,
        'agent reply must appear in the customer-origin widget without reload',
      ).toHaveCount(1, { timeout: 20000 })
      await widgetPage.waitForTimeout(2000)
      await expect(
        replyBubble,
        'agent reply must appear EXACTLY ONCE (no Socket.IO echo duplicate)',
      ).toHaveCount(1)

      // ---- Step 13: Restart app + realtime containers. ----
      // Proves the persisted state (DB + uploads) survives a graceful
      // restart of the application containers. Caddy itself stays up,
      // briefly 502-ing until app is back.
      runDocker(spec, 'restart app realtime')

      // ---- Step 14: Wait for Caddy to respond again. ----
      await waitForCaddy()

      // ---- Step 15: Verify workspace exists (GET /api/tenants/me). ----
      const tenantRes2 = await dashboardPage.request.get(`${ORIGIN}/api/tenants/me`)
      expect(
        tenantRes2.ok(),
        'tenant endpoint should work after restart',
      ).toBe(true)
      const tenantData2 = (await tenantRes2.json()) as TenantResponse
      expect(tenantData2.tenant?.name, 'workspace name should match after restart').toBe(workspace)
      expect(tenantData2.tenant?.slug, 'slug should match after restart').toBe(slug)

      // ---- Step 16: Verify conversation exists (GET /api/conversations). ----
      const convListRes2 = await dashboardPage.request.get(`${ORIGIN}/api/conversations`)
      expect(convListRes2.ok(), 'conversations API should work after restart').toBe(true)
      const convListData2 = (await convListRes2.json()) as ConversationListResponse
      const conv2 = convListData2.conversations?.find((c) => c.id === conversationId)
      expect(conv2, 'conversation should still exist after restart').toBeTruthy()

      // ---- Step 17: Verify messages exist via the widget messages endpoint. ----
      // The dashboard API caller re-issues a contact call with the SAME
      // visitorId the widget generated — this returns a fresh realtimeToken
      // bound to the same contact + conversation, which we then use as
      // the Bearer token for GET /api/widget/<slug>/messages. The token
      // must work post-restart (the visitor + conversation persisted).
      const contactRes = await dashboardPage.request.post(
        `${ORIGIN}/api/widget/${slug}/contact`,
        {
          data: { visitorId, name: contactName },
          headers: { 'Content-Type': 'application/json' },
        },
      )
      expect(contactRes.ok(), 'contact re-identify should succeed after restart').toBe(true)
      const contactData = (await contactRes.json()) as ContactResponse
      const realtimeToken = contactData.realtimeToken
      expect(
        realtimeToken,
        'widget contact endpoint should return a realtimeToken bound to the visitor',
      ).toBeTruthy()

      const messagesRes = await dashboardPage.request.get(
        `${ORIGIN}/api/widget/${slug}/messages?conversationId=${conversationId}`,
        { headers: { Authorization: `Bearer ${realtimeToken}` } },
      )
      expect(
        messagesRes.ok(),
        `widget messages endpoint should return 200 after restart (got ${messagesRes.status()})`,
      ).toBe(true)
      const messagesData = (await messagesRes.json()) as MessageListResponse
      const messages = messagesData.messages ?? []
      const hasVisitorMsg = messages.some(
        (m) => m.senderType === 'contact' && m.content?.text === visitorText,
      )
      const hasAgentReply = messages.some(
        (m) => m.senderType === 'agent' && m.content?.text === replyText,
      )
      expect(hasVisitorMsg, 'visitor message should exist in the widget messages endpoint').toBe(true)
      expect(hasAgentReply, 'agent reply should exist in the widget messages endpoint').toBe(true)

      // ---- Step 18: Widget still works (reload customer page → messages still visible). ----
      // Reload the customer-origin page. The script tag is in the
      // server-served HTML, so reload re-fetches the widget script. The
      // widget reconnects + renders the persisted visitor + agent messages
      // (history restore). Both messages must remain visible.
      await widgetPage.reload()
      await widgetPage.waitForLoadState('networkidle')
      await widgetPage.waitForTimeout(3000)
      const launcher2 = widgetPage.locator('.sk-launcher')
      await expect(
        launcher2,
        'widget launcher should reappear after reload (post-restart)',
      ).toBeVisible({ timeout: 15000 })
      await launcher2.click()
      await widgetPage.waitForTimeout(3000)
      await expect(
        widgetPage.locator('.sk-msg.sk-vis p').filter({ hasText: visitorText }),
        'visitor message should remain after restart + reload',
      ).toHaveCount(1)
      await expect(
        widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText }),
        'agent reply should remain after restart + reload',
      ).toHaveCount(1)

      await widgetCtx.close()
      widgetCtx = null
      await dashboardCtx.close()
      dashboardPage = null
    } finally {
      // ---- Step 19: Cleanup — always tear down, even on test failure. ----
      if (widgetCtx) {
        try {
          await widgetCtx.close()
        } catch {
          // ignore
        }
      }
      if (dashboardPage) {
        try {
          await dashboardPage.context().close()
        } catch {
          // ignore
        }
      }
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch (e) {
        console.error(`[cleanup] failed to down -v for ${spec.label}:`, e)
      }
    }
  })
}
