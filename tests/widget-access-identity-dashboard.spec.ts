import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { dirname } from 'path'
import { fileURLToPath } from 'node:url'

/**
 * Dashboard Access & Identity UI browser tests (requirements #32–#43).
 *
 * Exercises the REAL dashboard Widget → Access & Identity tab against the
 * REAL backend APIs (no fetch mocking). Proves dashboard configuration +
 * secret UX — does NOT re-test the identity runtime (covered by the accepted
 * NPM/script/realtime suites).
 *
 * CRITICAL: a genuine fresh OTP signup now creates a WidgetConfig with the DB
 * default accessMode='verified_visitor' (policyVersion=1) — the FROZEN
 * contract. Tests that need a DIFFERENT mode explicitly configure it via the
 * real access API. Tests #33/#34/#35/#41 use the REAL fresh-signup state
 * (no pre-PATCH) to prove the new-workspace default.
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url))
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
void SPEC_DIR

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return { email: `acc-${stamp}@test.com`, workspace: `Acc ${stamp}` }
}

/** Real OTP signup → returns the slug. The new WidgetConfig defaults to
 *  accessMode='verified_visitor' (DB default), policyVersion=1. */
async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const slug = (await tenantRes.json()).tenant?.slug
  expect(slug, 'slug should be set').toBeTruthy()
  return slug as string
}

/** Explicitly configure a DIFFERENT access mode via the real API (test setup
 *  for scenarios that need a non-default mode). The default fresh-signup
 *  state is verified_visitor — do NOT call this to "set" the default. */
async function setAccessApi(page: Page, mode: string, extra?: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch(`${DASHBOARD}/api/widget-config/access`, {
    data: { accessMode: mode, ...extra }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `setAccessApi(${mode}) should succeed: ${res.status()}`).toBe(true)
}

async function getAccess(page: Page): Promise<{
  accessMode: string; policyVersion: number; integrationSecret: { hasSecret: boolean; rotatedAt: string | null }
  loginUrl: string | null; loginButtonLabel: string | null; loginReturnUrlParam: string | null; identityEndpointPath: string | null
}> {
  const res = await page.request.get(`${DASHBOARD}/api/widget-config/access`)
  expect(res.ok(), 'GET access should succeed').toBe(true)
  return await res.json()
}

async function generateSecretApi(page: Page): Promise<string> {
  const res = await page.request.post(`${DASHBOARD}/api/widget-config/integration-secret`, {
    data: {}, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), 'generateSecretApi should succeed').toBe(true)
  return (await res.json()).rawSecret as string
}

async function openAccessTab(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByTestId('access-identity-tab').click()
  await expect(page.getByTestId('access-policy-version')).toBeVisible({ timeout: 15_000 })
}

test.describe('Dashboard Access & Identity', () => {
  test('#33 fresh workspace default — verified_visitor (NO pre-PATCH; regresses if signup returns anonymous)', async ({ browser }) => {
    const { email, workspace } = creds('fresh')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    // NO access-policy PATCH. The fresh-signup WidgetConfig MUST default to
    // verified_visitor (the DB default) + policyVersion=1.
    const access = await getAccess(page)
    expect(access.accessMode, 'fresh workspace must default to verified_visitor').toBe('verified_visitor')
    expect(access.policyVersion, 'fresh workspace policyVersion must be 1').toBe(1)
    await openAccessTab(page)
    await expect(page.getByTestId('access-mode-verified')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('access-verified-recommended')).toBeVisible()
    await expect(page.getByTestId('access-mode-anonymous')).toHaveAttribute('aria-checked', 'false')
    const pv = await page.getByTestId('access-policy-version').textContent()
    expect(pv).toContain('1')
    await ctx.close()
  })

  test('#34 mode transition (verified→anonymous) from the real fresh default — policyVersion 1→2', async ({ browser }) => {
    const { email, workspace } = creds('save')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    // Real initial state: verified_visitor / policyVersion=1 (no pre-PATCH).
    const before = await getAccess(page)
    expect(before.accessMode).toBe('verified_visitor')
    expect(before.policyVersion).toBe(1)
    await openAccessTab(page)
    // Select Anonymous. Backend is still verified BEFORE Save.
    await page.getByTestId('access-mode-anonymous').click()
    expect((await getAccess(page)).accessMode, 'backend still verified before Save').toBe('verified_visitor')
    await page.getByTestId('access-save').click()
    await expect(page.getByTestId('access-mode-change-confirm')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(2000)
    const after = await getAccess(page)
    expect(after.accessMode).toBe('anonymous')
    expect(after.policyVersion, 'policyVersion must increment exactly once (1→2)').toBe(2)
    await expect(page.getByTestId('anonymous-warning')).toBeVisible()
    // Reload preserves anonymous.
    await page.reload()
    await openAccessTab(page)
    await expect(page.getByTestId('access-mode-anonymous')).toHaveAttribute('aria-checked', 'true')
    // Same-mode save: Save disabled (no draft change → no increment).
    await expect(page.getByTestId('access-save')).toBeDisabled()
    expect((await getAccess(page)).policyVersion, 'same-mode no increment').toBe(2)
    await ctx.close()
  })

  test('#35 site-user settings via real UI + post-Save full-config regression (catches the PATCH-response bug)', async ({ browser }) => {
    const { email, workspace } = creds('site')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    // Real fresh default: verified_visitor. Switch to site_user_only via the UI.
    await openAccessTab(page)
    await page.getByTestId('access-mode-site-user').click()
    await expect(page.getByTestId('site-identity-endpoint')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('site-login-url').fill('/login')
    await page.getByTestId('site-login-label').fill('Sign in')
    await page.getByTestId('site-return-param').fill('returnUrl')
    await page.getByTestId('access-save').click()
    await expect(page.getByTestId('access-mode-change-confirm')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(2500)
    // POST-SAVE FULL-CONFIG REGRESSION (catches Blocker 2: the PATCH response
    // is {accessMode,policyVersion,accessModeChanged} — NOT a full AccessConfig.
    // The dashboard MUST re-fetch GET + keep the UI functional with the full
    // config. Before the fix, the local config lost integrationSecret +
    // loginUrl/etc → the site-user UI crashed/rendered empty.)
    await expect(page.getByTestId('integration-secret-status'), 'integration-secret-status must be visible after Save').toBeVisible()
    await expect(page.getByTestId('integration-secret-generate'), 'generate button must be visible (no secret exists)').toBeVisible()
    await expect(page.getByTestId('site-identity-endpoint'), 'site-identity-endpoint must retain its value').toHaveValue('/api/sukhan-identity')
    await expect(page.getByTestId('site-login-url'), 'site-login-url must retain its value').toHaveValue('/login')
    await expect(page.getByTestId('site-login-label'), 'site-login-label must retain its value').toHaveValue('Sign in')
    await expect(page.getByTestId('site-return-param'), 'site-return-param must retain its value').toHaveValue('returnUrl')
    await expect(page.getByTestId('access-policy-version'), 'policyVersion must be visible').toBeVisible()
    // REAL GET persistence.
    const access = await getAccess(page)
    expect(access.accessMode).toBe('site_user_only')
    expect(access.identityEndpointPath).toBe('/api/sukhan-identity')
    expect(access.loginUrl).toBe('/login')
    expect(access.loginButtonLabel).toBe('Sign in')
    expect(access.loginReturnUrlParam).toBe('returnUrl')
    // PUBLIC config: only safe policy fields, no secret/hash.
    const pubRes = await page.request.get(`${BASE}/api/widget/${slug}/config`)
    expect(pubRes.ok()).toBe(true)
    const pub = await pubRes.json()
    expect(pub.accessMode).toBe('site_user_only')
    expect(pub.identityEndpointPath).toBe('/api/sukhan-identity')
    expect(JSON.stringify(pub)).not.toContain('integrationSecret')
    expect(JSON.stringify(pub)).not.toContain('Hash')
    await ctx.close()
  })

  test('#36 invalid site config UI — cross-origin endpoint rejected', async ({ browser }) => {
    const { email, workspace } = creds('invalid')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    // Set a valid site_user_only config via the API first.
    await setAccessApi(page, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    await openAccessTab(page)
    expect((await getAccess(page)).identityEndpointPath).toBe('/api/sukhan-identity')
    // Enter an INVALID cross-origin identityEndpointPath + Save (same-mode).
    await page.getByTestId('site-identity-endpoint').fill('https://evil.example/identity')
    await page.getByTestId('access-save').click()
    await page.waitForTimeout(2000)
    // Save failed — backend persisted value unchanged.
    expect((await getAccess(page)).identityEndpointPath).toBe('/api/sukhan-identity')
    await ctx.close()
  })

  test('#37 secret generate show-once + no persistence', async ({ browser }) => {
    const { email, workspace } = creds('gen')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    await setAccessApi(page, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    await openAccessTab(page)
    const before = await getAccess(page)
    expect(before.integrationSecret.hasSecret).toBe(false)
    await expect(page.getByTestId('integration-secret-generate')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-generate').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 15_000 })
    const rawSecretText = await page.locator('[data-testid="integration-secret-reveal"] code').textContent()
    expect(rawSecretText, 'raw secret should appear').toBeTruthy()
    expect(rawSecretText!.length).toBeGreaterThan(10)
    await expect(page.getByTestId('integration-secret-copy')).toBeVisible()
    await expect(page.getByTestId('integration-secret-status')).toContainText(/configured|پیکربندی/)
    const afterGen = await getAccess(page)
    expect(afterGen.integrationSecret.hasSecret).toBe(true)
    expect(afterGen.policyVersion).toBeGreaterThan(before.policyVersion)
    const lsVals = await page.evaluate(() => Object.values(localStorage).join(''))
    const ssVals = await page.evaluate(() => Object.values(sessionStorage).join(''))
    expect(lsVals).not.toContain(rawSecretText)
    expect(ssVals).not.toContain(rawSecretText)
    await page.reload()
    await openAccessTab(page)
    await expect(page.getByTestId('integration-secret-reveal')).toHaveCount(0)
    await expect(page.getByTestId('integration-secret-status')).toContainText(/configured|پیکربندی/)
    const secRes = await page.request.get(`${DASHBOARD}/api/widget-config/integration-secret`)
    const secBody = await secRes.json()
    expect(JSON.stringify(secBody)).not.toContain(rawSecretText)
    const pubRes = await page.request.get(`${BASE}/api/widget/${slug}/config`)
    const pub = await pubRes.json()
    expect(JSON.stringify(pub)).not.toContain(rawSecretText)
    expect(JSON.stringify(pub)).not.toContain('Hash')
    await ctx.close()
  })

  test('#38 secret rotation — B != A, policyVersion increments', async ({ browser }) => {
    const { email, workspace } = creds('rot')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await setAccessApi(page, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    const secretA = await generateSecretApi(page)
    await openAccessTab(page)
    const beforeRot = await getAccess(page)
    await expect(page.getByTestId('integration-secret-rotate')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-rotate').click()
    await expect(page.getByTestId('integration-secret-rotate-confirm')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-rotate-confirm').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 15_000 })
    const secretB = await page.locator('[data-testid="integration-secret-reveal"] code').textContent()
    expect(secretB, 'rotated secret B should appear').toBeTruthy()
    expect(secretB).not.toBe(secretA)
    const afterRot = await getAccess(page)
    expect(afterRot.policyVersion).toBeGreaterThan(beforeRot.policyVersion)
    const secRes = await page.request.get(`${DASHBOARD}/api/widget-config/integration-secret`)
    const secBody = await secRes.json()
    expect(JSON.stringify(secBody)).not.toContain(secretA)
    expect(JSON.stringify(secBody)).not.toContain(secretB!)
    await ctx.close()
  })

  test('#39 secret revoke — status not configured, mode stays site_user_only', async ({ browser }) => {
    const { email, workspace } = creds('rev')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await setAccessApi(page, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    await generateSecretApi(page)
    await openAccessTab(page)
    const beforeRevoke = await getAccess(page)
    await expect(page.getByTestId('integration-secret-revoke')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-revoke').click()
    await expect(page.getByTestId('integration-secret-revoke-confirm')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-revoke-confirm').click()
    await page.waitForTimeout(2000)
    await expect(page.getByTestId('integration-secret-reveal')).toHaveCount(0)
    await expect(page.getByTestId('integration-secret-status')).toContainText(/not configured|نبوده/)
    const afterRevoke = await getAccess(page)
    expect(afterRevoke.policyVersion).not.toBe(beforeRevoke.policyVersion)
    expect(afterRevoke.accessMode).toBe('site_user_only')
    expect(afterRevoke.integrationSecret.hasSecret).toBe(false)
    await ctx.close()
  })

  test('#40 integration readiness check — NO SSRF (zero requests to /api/sukhan-identity on any origin)', async ({ browser }) => {
    const { email, workspace } = creds('check')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await setAccessApi(page, 'site_user_only', { identityEndpointPath: '/api/sukhan-identity' })
    await generateSecretApi(page)
    await openAccessTab(page)
    // Strengthened no-SSRF: count browser-observed requests to /api/sukhan-identity
    // on ANY origin (route-intercept) AND a fake customer server's hits.
    let browserIdentityRequests = 0
    await page.route('**/api/sukhan-identity', (route) => {
      browserIdentityRequests++
      void route.continue()
    })
    let customerHits = 0
    const customerPort = 8089
    const fakeCustomer = createServer((_req, res) => { customerHits++; res.writeHead(404); res.end('Not Found') })
    await new Promise<void>((r) => fakeCustomer.listen(customerPort, '127.0.0.1', r))
    try {
      await page.getByTestId('integration-check').click()
      await page.waitForTimeout(2500)
      const okText = await page.evaluate(() => document.body.textContent ?? '')
      expect(okText).toMatch(/Sukhan-side identity setup is configured|راه‌اندازی هویت/)
      // CRITICAL: the dashboard readiness check must NOT probe the customer
      // identity endpoint on ANY browser-observed origin. It only re-reads
      // GET /api/widget-config/access (the trusted Sukhan-side state).
      expect(browserIdentityRequests, 'dashboard check must NOT request /api/sukhan-identity on any origin').toBe(0)
      expect(customerHits, 'dashboard check must NOT probe the fake customer server').toBe(0)
    } finally {
      await new Promise<void>((r) => fakeCustomer.close(() => r()))
    }
    await ctx.close()
  })

  test('#41 free-plan independence — fresh workspace starts verified; mode change persists', async ({ browser }) => {
    const { email, workspace } = creds('free')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    // Free plan is the default (no devSetPlan). A fresh workspace starts
    // verified_visitor (the DB default) — NOT anonymous.
    const before = await getAccess(page)
    expect(before.accessMode, 'fresh Free workspace must default to verified_visitor').toBe('verified_visitor')
    await openAccessTab(page)
    // Change mode via the real UI (verified→anonymous is a real change).
    await page.getByTestId('access-mode-anonymous').click()
    await page.getByTestId('access-save').click()
    await expect(page.getByTestId('access-mode-change-confirm')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(2000)
    const after = await getAccess(page)
    expect(after.accessMode).toBe('anonymous')
    expect(after.policyVersion).toBe(before.policyVersion + 1)
    await ctx.close()
  })

  test('#42 anonymous warning visible after selecting anonymous', async ({ browser }) => {
    const { email, workspace } = creds('warn')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    // Select anonymous (warning appears immediately on selection, before save).
    await page.getByTestId('access-mode-anonymous').click()
    await expect(page.getByTestId('anonymous-warning')).toBeVisible()
    await ctx.close()
  })

  test('#43 NPM publication truth — Installation tab still says Coming Soon', async ({ browser }) => {
    const { email, workspace } = creds('npm')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
    await page.getByRole('button', { name: /^نصب$|^Installation$/ }).click()
    await page.waitForTimeout(1000)
    const body = await page.evaluate(() => document.body.textContent ?? '')
    expect(body).toMatch(/Coming Soon|به‌زودی/)
    await ctx.close()
  })
})
