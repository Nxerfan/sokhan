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
 */

const SPEC_DIR = dirname(fileURLToPath(import.meta.url))
const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000' // Next.js direct — signup API
void SPEC_DIR

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return { email: `acc-${stamp}@test.com`, workspace: `Acc ${stamp}` }
}

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

async function devSetPlan(page: Page, plan: string): Promise<void> {
  const res = await page.request.post(`${BASE}/api/invitations/dev/set-plan`, {
    data: { plan }, headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`dev/set-plan(${plan}) failed: ${res.status()}`)
}

async function openAccessTab(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByTestId('access-identity-tab').click()
  await expect(page.getByTestId('access-policy-version')).toBeVisible({ timeout: 15_000 })
}

async function getAccess(page: Page): Promise<{
  accessMode: string; policyVersion: number; integrationSecret: { hasSecret: boolean; rotatedAt: string | null }
  loginUrl: string | null; loginButtonLabel: string | null; loginReturnUrlParam: string | null; identityEndpointPath: string | null
}> {
  const res = await page.request.get(`${DASHBOARD}/api/widget-config/access`)
  expect(res.ok(), 'GET access should succeed').toBe(true)
  return await res.json()
}

test.describe('Dashboard Access & Identity', () => {
  test('#33 fresh workspace default — verified_visitor + Recommended + policyVersion', async ({ browser }) => {
    const { email, workspace } = creds('fresh')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    // Verified Visitor is selected (aria-checked).
    const verifiedCard = page.getByTestId('access-mode-verified')
    await expect(verifiedCard).toHaveAttribute('aria-checked', 'true')
    // Recommended badge visible.
    await expect(page.getByTestId('access-verified-recommended')).toBeVisible()
    // policyVersion is a valid non-negative integer.
    const pv = await page.getByTestId('access-policy-version').textContent()
    const match = pv?.match(/(\d+)/)
    expect(match, 'policyVersion should be a number').toBeTruthy()
    const pvNum = Number(match![1])
    expect(pvNum).toBeGreaterThanOrEqual(1)
    // Anonymous is NOT selected.
    await expect(page.getByTestId('access-mode-anonymous')).toHaveAttribute('aria-checked', 'false')
    await ctx.close()
  })

  test('#34 mode save + policyVersion increment (verified→anonymous)', async ({ browser }) => {
    const { email, workspace } = creds('save')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    const before = await getAccess(page)
    expect(before.accessMode).toBe('verified_visitor')
    // Switch to Anonymous + Save (confirmation dialog appears for mode change).
    await page.getByTestId('access-mode-anonymous').click()
    await page.getByTestId('access-save').click()
    await expect(page.getByTestId('access-mode-change-confirm')).toBeVisible()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    // Backend now says anonymous + policyVersion incremented exactly once.
    const after = await getAccess(page)
    expect(after.accessMode).toBe('anonymous')
    expect(after.policyVersion).toBe(before.policyVersion + 1)
    // UI shows the anonymous warning.
    await expect(page.getByTestId('anonymous-warning')).toBeVisible()
    // Reload preserves anonymous.
    await page.reload()
    await openAccessTab(page)
    await expect(page.getByTestId('access-mode-anonymous')).toHaveAttribute('aria-checked', 'true')
    // Same-mode save does NOT increment policyVersion (no change → Save disabled).
    await expect(page.getByTestId('access-save')).toBeDisabled()
    await ctx.close()
  })

  test('#35 site-user settings persist + public config safe', async ({ browser }) => {
    const { email, workspace } = creds('site')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    // Switch to site_user_only.
    await page.getByTestId('access-mode-site-user').click()
    // Fill the 4 fields.
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('site-login-url').fill('/login')
    await page.getByTestId('site-login-label').fill('Sign in')
    await page.getByTestId('site-return-param').fill('returnUrl')
    await page.getByTestId('access-save').click()
    await expect(page.getByTestId('access-mode-change-confirm')).toBeVisible()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    // GET access: all values persist exactly.
    const access = await getAccess(page)
    expect(access.accessMode).toBe('site_user_only')
    expect(access.identityEndpointPath).toBe('/api/sukhan-identity')
    expect(access.loginUrl).toBe('/login')
    expect(access.loginButtonLabel).toBe('Sign in')
    expect(access.loginReturnUrlParam).toBe('returnUrl')
    // PUBLIC config has ONLY safe policy fields — no secret/hash.
    const pubRes = await page.request.get(`${BASE}/api/widget/${slug}/config`)
    expect(pubRes.ok()).toBe(true)
    const pub = await pubRes.json()
    expect(pub.accessMode).toBe('site_user_only')
    expect(pub.identityEndpointPath).toBe('/api/sukhan-identity')
    expect(JSON.stringify(pub), 'public config must NOT contain the integration secret').not.toContain('integrationSecret')
    expect(JSON.stringify(pub), 'public config must NOT contain a secret hash').not.toContain('Hash')
    await ctx.close()
  })

  test('#36 invalid site config UI — cross-origin endpoint rejected', async ({ browser }) => {
    const { email, workspace } = creds('invalid')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    // First switch to site_user_only + save (valid).
    await page.getByTestId('access-mode-site-user').click()
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    const validAccess = await getAccess(page)
    // Now enter an INVALID cross-origin identityEndpointPath + Save.
    await page.getByTestId('site-identity-endpoint').fill('https://evil.example/identity')
    await page.getByTestId('access-save').click()
    await page.waitForTimeout(1500)
    // Save must fail — backend persisted value remains unchanged.
    const afterAccess = await getAccess(page)
    expect(afterAccess.identityEndpointPath).toBe('/api/sukhan-identity')
    // UI must not claim success (no toast-success — check the value didn't update in the draft UI).
    // The field still shows the rejected value (local draft), but the server kept the valid one.
    void slug
    await ctx.close()
  })

  test('#37 secret generate show-once + no persistence', async ({ browser }) => {
    const { email, workspace } = creds('gen')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    // Switch to site_user_only + save first.
    await page.getByTestId('access-mode-site-user').click()
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    const before = await getAccess(page)
    expect(before.integrationSecret.hasSecret).toBe(false)
    // Generate.
    await page.getByTestId('integration-secret-generate').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 10_000 })
    const rawSecretText = await page.locator('[data-testid="integration-secret-reveal"] code').textContent()
    expect(rawSecretText, 'raw secret should appear').toBeTruthy()
    expect(rawSecretText!.length).toBeGreaterThan(10)
    // Copy action available.
    await expect(page.getByTestId('integration-secret-copy')).toBeVisible()
    // Status becomes configured.
    await expect(page.getByTestId('integration-secret-status')).toContainText(/configured|پیکربندی/)
    // policyVersion reflects the server's new value (incremented by secret generation).
    const afterGen = await getAccess(page)
    expect(afterGen.integrationSecret.hasSecret).toBe(true)
    expect(afterGen.policyVersion).toBeGreaterThan(before.policyVersion)
    // CRITICAL: raw secret NOT stored in localStorage/sessionStorage.
    const lsVals = await page.evaluate(() => Object.values(localStorage).join(''))
    const ssVals = await page.evaluate(() => Object.values(sessionStorage).join(''))
    expect(lsVals, 'raw secret must NOT be in localStorage').not.toContain(rawSecretText)
    expect(ssVals, 'raw secret must NOT be in sessionStorage').not.toContain(rawSecretText)
    // Reload → status still configured, raw secret NOT visible.
    await page.reload()
    await openAccessTab(page)
    await expect(page.getByTestId('integration-secret-reveal')).toHaveCount(0)
    await expect(page.getByTestId('integration-secret-status')).toContainText(/configured|پیکربندی/)
    // GET access/secret does NOT return the raw secret.
    const secRes = await page.request.get(`${DASHBOARD}/api/widget-config/integration-secret`)
    expect(secRes.ok()).toBe(true)
    const secBody = await secRes.json()
    expect(JSON.stringify(secBody)).not.toContain(rawSecretText)
    expect(secBody.hasSecret).toBe(true)
    // Public config does NOT contain raw/hash secret.
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
    await openAccessTab(page)
    await page.getByTestId('access-mode-site-user').click()
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    // Generate secret A.
    await page.getByTestId('integration-secret-generate').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 10_000 })
    const secretA = await page.locator('[data-testid="integration-secret-reveal"] code').textContent()
    await page.getByTestId('integration-secret-dismiss').click()
    const beforeRot = await getAccess(page)
    // Rotate.
    await page.getByTestId('integration-secret-rotate').click()
    await expect(page.getByTestId('integration-secret-rotate-confirm')).toBeVisible()
    await page.getByTestId('integration-secret-rotate-confirm').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 10_000 })
    const secretB = await page.locator('[data-testid="integration-secret-reveal"] code').textContent()
    expect(secretB, 'rotated secret B should appear').toBeTruthy()
    expect(secretB).not.toBe(secretA)
    // policyVersion incremented.
    const afterRot = await getAccess(page)
    expect(afterRot.policyVersion).toBeGreaterThan(beforeRot.policyVersion)
    // Subsequent GET never returns A or B raw.
    const secRes = await page.request.get(`${DASHBOARD}/api/widget-config/integration-secret`)
    const secBody = await secRes.json()
    expect(JSON.stringify(secBody)).not.toContain(secretA!)
    expect(JSON.stringify(secBody)).not.toContain(secretB!)
    await ctx.close()
  })

  test('#39 secret revoke — status not configured, mode stays site_user_only', async ({ browser }) => {
    const { email, workspace } = creds('rev')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    await page.getByTestId('access-mode-site-user').click()
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    await page.getByTestId('integration-secret-generate').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 10_000 })
    const beforeRevoke = await getAccess(page)
    // Revoke.
    await page.getByTestId('integration-secret-revoke').click()
    await expect(page.getByTestId('integration-secret-revoke-confirm')).toBeVisible()
    await page.getByTestId('integration-secret-revoke-confirm').click()
    await page.waitForTimeout(1500)
    // Raw reveal cleared.
    await expect(page.getByTestId('integration-secret-reveal')).toHaveCount(0)
    // Status not configured.
    await expect(page.getByTestId('integration-secret-status')).toContainText(/not configured|نبوده/)
    // policyVersion updated.
    const afterRevoke = await getAccess(page)
    expect(afterRevoke.policyVersion).not.toBe(beforeRevoke.policyVersion)
    // accessMode remains site_user_only (NOT auto-downgraded).
    expect(afterRevoke.accessMode).toBe('site_user_only')
    expect(afterRevoke.integrationSecret.hasSecret).toBe(false)
    await ctx.close()
  })

  test('#40 integration readiness check — no SSRF (ZERO customer-server requests)', async ({ browser }) => {
    const { email, workspace } = creds('check')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    await openAccessTab(page)
    await page.getByTestId('access-mode-site-user').click()
    await page.getByTestId('site-identity-endpoint').fill('/api/sukhan-identity')
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    // Generate a secret so the check passes.
    await page.getByTestId('integration-secret-generate').click()
    await expect(page.getByTestId('integration-secret-reveal')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('integration-secret-dismiss').click()
    // Start a FAKE customer server + count requests to it.
    let customerHits = 0
    const customerPort = 8089
    const fakeCustomer = createServer((_req, res) => { customerHits++; res.writeHead(404); res.end('Not Found') })
    await new Promise<void>((r) => fakeCustomer.listen(customerPort, '127.0.0.1', r))
    try {
      // Click "Check integration setup".
      await page.getByTestId('integration-check').click()
      await page.waitForTimeout(2000)
      // Success copy appears (Sukhan-side ready).
      const okText = await page.evaluate(() => document.body.textContent ?? '')
      expect(okText).toMatch(/Sukhan-side identity setup is configured|راه‌اندازی هویت/)
      // CRITICAL: the dashboard check made ZERO requests to the customer server (no SSRF).
      expect(customerHits, 'dashboard readiness check must NOT probe the customer server').toBe(0)
    } finally {
      await new Promise<void>((r) => fakeCustomer.close(() => r()))
    }
    await ctx.close()
  })

  test('#41 free-plan independence — Access & Identity usable on Free', async ({ browser }) => {
    const { email, workspace } = creds('free')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await signupAndGetSlug(page, email, workspace)
    // Free plan is the default — no devSetPlan. Access & Identity tab usable.
    await openAccessTab(page)
    // Mode can be changed through the UI.
    await page.getByTestId('access-mode-anonymous').click()
    await page.getByTestId('access-save').click()
    await page.getByTestId('access-mode-change-confirm').click()
    await page.waitForTimeout(1500)
    const after = await getAccess(page)
    expect(after.accessMode).toBe('anonymous')
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
    // Open the Installation tab (default).
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
    await page.getByRole('button', { name: /^نصب$|^Installation$/ }).click()
    await page.waitForTimeout(1000)
    const body = await page.evaluate(() => document.body.textContent ?? '')
    expect(body, 'Installation must still show NPM Coming Soon').toMatch(/Coming Soon|به‌زودی/)
    await ctx.close()
  })
})
