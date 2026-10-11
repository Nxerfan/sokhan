import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { execSync } from 'child_process'
import { createServer, type Server } from 'node:http'
import { resolve, join } from 'path'
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
 *   - A real customer HTTP server on port 8088 hosts the widget from a
 *     genuinely different origin — proving the production embed case.
 *   - Real two-way chat (visitor widget ↔ agent dashboard) through the
 *     production Caddy reverse proxy + production realtime service.
 *   - App/realtime container restart proves persistence survives a
 *     graceful restart (DB + uploads volumes are durable).
 *
 * Steps per edition:
 *   1.  Fresh volumes (docker compose down -v first).
 *   2.  Start production compose with NIXIFY_MOCK=true.
 *   3.  Wait for Caddy on http://127.0.0.1.
 *   4.  Signup through Caddy.
 *   5.  Login through Caddy.
 *   6.  Dashboard loads through Caddy.
 *   7.  Navigate to Widget Installation tab.
 *   8.  Widget script reachable through Caddy.
 *   9.  External-origin widget loads (customer HTTP server on port 8088).
 *   10. Visitor sends a message through the widget.
 *   11. Conversation appears in Inbox.
 *   12. Agent sends a reply from the real Inbox UI.
 *   13. Visitor receives the reply without page reload (Socket.IO).
 *   14. Restart app + realtime containers (docker compose restart).
 *   15. Wait for Caddy to respond again.
 *   16. Verify workspace / conversation / messages still exist.
 *   17. Verify widget still works.
 *   18. Cleanup: docker compose down -v.
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
  /** Deterministic Compose project name. */
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

function runDocker(spec: EditionSpec, args: string, env: Record<string, string> = {}): string {
  const cmd = `docker compose -f ${spec.composeFile} -p ${spec.projectName} ${args}`
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      env: { ...process.env, ...COMPOSE_ENV, ...env },
      timeout: 180000,
    })
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string }
    console.error(`[docker] FAILED: ${cmd}`)
    if (err.stdout) console.error(`[docker] stdout: ${err.stdout}`)
    if (err.stderr) console.error(`[docker] stderr: ${err.stderr}`)
    throw e
  }
}

/**
 * Poll the Caddy origin until /api returns 200 (Next.js catch-all route
 * responding through the production reverse proxy).
 */
async function waitForCaddy(maxMs = 120000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${ORIGIN}/api`)
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
 * Login via the NextAuth credentials callback through Caddy.
 */
async function loginViaCaddy(request: APIRequestContext, email: string, password: string): Promise<void> {
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
 * Using a REAL server (not page.route()) avoids Chromium's
 * "Private Network Access" CORS block on cross-origin requests from a
 * route-fulfilled page to a loopback address.
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

// Shared password for the test accounts. Passed to signup AND login.
const password = 'password123'

/**
 * Sign up + login + navigate to dashboard, all through Caddy. Returns the
 * tenant slug (used to construct the widget script URL for the customer
 * page). Uses the provided page so the dashboard UI is already on the
 * right page when the caller continues.
 */
async function signupLoginAndGetSlug(
  page: Page,
  email: string,
  workspace: string,
): Promise<string> {
  await otpSignupPlaywright(page.request, ORIGIN, email, workspace)
  await loginViaCaddy(page.request, email, password)
  await page.goto(ORIGIN)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  const tenantRes = await page.request.get(`${ORIGIN}/api/tenants/me`)
  const tenantData = (await tenantRes.json()) as { tenant?: { slug?: string } }
  const slug = tenantData.tenant?.slug
  expect(slug, 'slug should be set after signup').toBeTruthy()
  return slug as string
}

for (const spec of EDITIONS) {
  test(`Clean-install qualification — ${spec.label} edition (production shape)`, async ({ browser }) => {
    test.setTimeout(300000) // 5 minutes per edition — slow Docker test.
    const { email, workspace } = creds(spec.label)
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Dashboard context (agent).
    const dashboardCtx = await browser.newContext()
    const dashboardPage = await dashboardCtx.newPage()

    // Widget context (visitor). Created lazily AFTER signup so the
    // customer server has the right slug baked into the HTML.
    let widgetCtx: BrowserContext | null = null

    try {
      // ---- Step 1: Fresh volumes. ----
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch {
        // ignore — project may not exist yet
      }

      // ---- Step 2: Start the PRODUCTION compose file with NIXIFY_MOCK=true. ----
      runDocker(spec, 'up -d')

      // ---- Step 3: Wait for Caddy on http://127.0.0.1. ----
      await waitForCaddy()

      // ---- Step 4: Signup through Caddy. ----
      // ---- Step 5: Login through Caddy. ----
      // ---- Step 6: Dashboard loads through Caddy. ----
      const slug = await signupLoginAndGetSlug(dashboardPage, email, workspace)
      currentSlug = slug // so the customer server serves the right script

      // ---- Step 7: Navigate to the Widget Installation tab. ----
      const nav = dashboardPage.getByRole('navigation', { name: 'primary' })
      await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
      // The Installation tab is the default view. The tab button is
      // visible (and so is the Widget Key card on the Installation view).
      const installationTab = dashboardPage.getByRole('button', { name: /^نصب$|^Installation$/ })
      await expect(installationTab, 'Installation tab button should be visible').toBeVisible({
        timeout: 10_000,
      })
      const widgetKeyCard = dashboardPage.getByText(/Widget Key|کلید ویجت/).first()
      await expect(widgetKeyCard, 'Widget Key card should be visible on the Installation tab').toBeVisible({
        timeout: 10_000,
      })

      // ---- Step 8: Widget script reachable through Caddy. ----
      const scriptRes = await dashboardPage.request.get(`${ORIGIN}/api/widget/${slug}/script`)
      expect(
        scriptRes.ok(),
        `widget script should be reachable through Caddy at ${ORIGIN}/api/widget/${slug}/script`,
      ).toBe(true)

      // Navigate to Inbox so the dashboard is ready to receive the
      // visitor's first message.
      await nav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
      // The realtime-token request signals the inbox view finished
      // loading (the dashboard connects to Socket.IO for live updates).
      await dashboardPage
        .waitForResponse(
          (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
          { timeout: 15000 },
        )
        .catch(() => {})
      await dashboardPage.waitForTimeout(2000)

      // ---- Step 9: External-origin widget loads (port 8088 customer server). ----
      widgetCtx = await browser.newContext()
      const widgetPage = await widgetCtx.newPage()
      await widgetPage.goto(`${CUSTOMER_ORIGIN}/customer.html`)
      await widgetPage.waitForLoadState('domcontentloaded')
      await widgetPage.waitForTimeout(3000)
      const launcher = widgetPage.locator('.sk-launcher')
      await expect(
        launcher,
        'widget launcher should appear on the external customer page',
      ).toBeVisible({ timeout: 10000 })
      await launcher.click()
      // Cross-origin WebSocket upgrade may take a few seconds in CI Docker.
      await widgetPage.waitForTimeout(5000)

      // ---- Step 10: Visitor sends a message through the widget. ----
      const visitorText = `CLEAN_VISITOR_${stamp}`
      const contactName = `CleanTest-${stamp}`
      const widgetInput = widgetPage.locator('.sk-panel input').first()
      await expect(widgetInput).toBeVisible({ timeout: 5000 })
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

      // ---- Step 11: Conversation appears in Inbox. ----
      // Verify via API first (the conversation exists in the DB), then
      // navigate to the Inbox tab + reload the conversation list.
      // The Socket.IO CONVERSATION_NEW event may not arrive through
      // the production Caddy in time — but the data is in the DB.
      const convListRes = await dashboardPage.request.get(`${ORIGIN}/api/conversations`)
      expect(convListRes.ok(), 'conversations API should return 200').toBe(true)
      const convListData = await convListRes.json()
      const conv = convListData.conversations?.find((c: any) =>
        c.lastMessagePreview?.includes(visitorText) || c.contact?.name === contactName
      )
      expect(conv, 'conversation must exist in the API response after visitor message').toBeTruthy()
      const conversationId = conv?.id
      expect(conversationId, 'conversation must have an id').toBeTruthy()

      // Navigate to the Inbox tab + reload the page to force a fresh
      // loadConversations() call. The initial InboxView mount may have
      // fetched the conversation list before the new conversation was
      // committed, or the Socket.IO CONVERSATION_NEW event may not have
      // arrived through the production Caddy topology. A reload forces
      // a fresh fetch that includes the new conversation.
      const inboxNav = dashboardPage.getByRole('navigation', { name: 'primary' })
      await inboxNav.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
      await dashboardPage.waitForTimeout(1000)
      await dashboardPage.reload()
      await dashboardPage.waitForLoadState('networkidle')
      await dashboardPage.waitForTimeout(3000)
      // The dashboard reloads into the Inbox view (default view = 'inbox').
      // Wait for the workspace name to confirm the dashboard is ready.
      await expect(
        dashboardPage.getByRole('heading', { name: workspace }),
        'dashboard should be ready after reload',
      ).toBeVisible({ timeout: 15000 })
      // Give the InboxView's loadConversations() time to complete.
      await dashboardPage.waitForTimeout(3000)
      const convItem = dashboardPage.locator('button').filter({ hasText: contactName }).first()
      await expect(
        convItem,
        'visitor conversation must appear in the agent inbox',
      ).toBeVisible({ timeout: 20000 })
      await convItem.click()
      await dashboardPage.waitForTimeout(500)
      await expect(
        dashboardPage.getByText(visitorText).first(),
        'visitor message must be visible in the inbox conversation view',
      ).toBeVisible({ timeout: 10000 })

      // ---- Step 12: Agent sends a reply from the real Inbox UI. ----
      const replyText = `CLEAN_REPLY_${stamp}`
      const replyInput = dashboardPage.locator('.border-t input[placeholder]').last()
      await expect(replyInput).toBeVisible({ timeout: 5000 })
      await replyInput.fill(replyText)
      const replyPostPromise = dashboardPage.waitForResponse(
        (res) =>
          res.url().includes('/api/conversations/') &&
          res.url().includes('/messages') &&
          res.request().method() === 'POST' &&
          res.status() === 200,
        { timeout: 10000 },
      )
      await replyInput.press('Enter')
      await replyPostPromise

      // ---- Step 13: Visitor receives the reply without page reload. ----
      // Socket.IO pushes the agent reply to the customer-origin widget.
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

      // ---- Step 14: Restart app + realtime containers. ----
      // Proves the persisted state (DB + uploads) survives a graceful
      // restart of the application containers. Caddy itself is not
      // restarted (it stays up, briefly 502-ing until app is back).
      runDocker(spec, 'restart app realtime')

      // ---- Step 15: Wait for Caddy to respond again. ----
      await waitForCaddy()

      // ---- Step 16: Verify workspace / conversation / messages still exist. ----
      const tenantRes2 = await dashboardPage.request.get(`${ORIGIN}/api/tenants/me`)
      expect(tenantRes2.ok(), 'tenant endpoint should work after restart').toBe(true)
      const tenantData2 = (await tenantRes2.json()) as {
        tenant?: { name?: string; slug?: string }
      }
      expect(tenantData2.tenant?.name, 'workspace name should match after restart').toBe(workspace)
      expect(tenantData2.tenant?.slug, 'slug should match after restart').toBe(slug)

      // Reload the dashboard so the inbox re-fetches the conversation
      // list. The conversation with the visitor message must still be
      // there. After reload, explicitly navigate to the Inbox tab
      // (the Zustand store resets to the default view on reload, which
      // IS 'inbox', but the conversation list fetch may not have
      // completed yet — clicking the Inbox button forces a re-fetch).
      await dashboardPage.reload()
      await dashboardPage.waitForLoadState('networkidle')
      await dashboardPage.waitForTimeout(3000)
      // Wait for the dashboard to be ready (workspace name visible).
      await expect(
        dashboardPage.getByRole('heading', { name: workspace }),
        'dashboard should be visible after restart',
      ).toBeVisible({ timeout: 15000 })
      // Navigate to the Inbox tab explicitly.
      const nav2 = dashboardPage.getByRole('navigation', { name: 'primary' })
      await nav2.getByRole('button', { name: /صندوق ورودی|Inbox/ }).click()
      // Wait for the realtime-token fetch (indicates socket setup started).
      await dashboardPage.waitForResponse(
        (res) => res.url().includes('/api/realtime-token') && res.status() === 200,
        { timeout: 15000 },
      ).catch(() => {})
      await dashboardPage.waitForTimeout(3000)
      const convItem2 = dashboardPage.locator('button').filter({ hasText: contactName }).first()
      await expect(
        convItem2,
        'visitor conversation should still be in the inbox after restart',
      ).toBeVisible({ timeout: 20000 })

      // ---- Step 17: Verify widget still works. ----
      // Reload the customer widget page (the script tag is in the
      // server-served HTML, so reload re-loads the widget). After the
      // reload, the widget should reconnect + render the persisted
      // visitor + agent messages (history restore).
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
        'visitor message should remain after restart',
      ).toHaveCount(1)
      await expect(
        widgetPage.locator('.sk-msg.sk-agt p').filter({ hasText: replyText }),
        'agent reply should remain after restart',
      ).toHaveCount(1)

      await widgetCtx.close()
      widgetCtx = null
      await dashboardCtx.close()
    } finally {
      // ---- Step 18: Cleanup — always tear down, even on test failure. ----
      if (widgetCtx) {
        try {
          await widgetCtx.close()
        } catch {
          // ignore
        }
      }
      try {
        await dashboardCtx.close()
      } catch {
        // ignore
      }
      try {
        runDocker(spec, 'down -v --remove-orphans')
      } catch (e) {
        console.error(`[cleanup] failed to down -v for ${spec.label}:`, e)
      }
    }
  })
}
