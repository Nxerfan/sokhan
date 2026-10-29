import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'
import { setAccessMode } from './helpers/set-access'

/**
 * Widget Customization — behavioral regression (stabilization audit,
 * journeys 9 + 10; defects CUST-A/B/C/D/E/F).
 *
 * Test 1 (PAID flow — plan with customization, via dev/set-plan 'pro'):
 *   edit accent/shape/position/greetings/avatar/logo in the REAL dashboard
 *   -> save -> reload -> values persist -> GET /api/widget-config returns
 *   stored + effective + isLocked:false -> PUBLIC widget config returns
 *   the effective values -> the REAL external-origin script-tag widget
 *   (customer HTTP server on :8085) renders them: accent color on the
 *   header, launcher shape class, position side, greeting text, avatar
 *   and logo images.
 *
 * Test 2 (FREE locked flow — truthful plan gating):
 *   the customization tab shows the lock banner, every control is
 *   disabled (no fake editability), a direct PATCH is rejected with
 *   402 customization_locked (no misleading "Saved"), the preview shows
 *   the EFFECTIVE locked values, the public config serves the locked
 *   Sukhan-brand defaults (isLocked/poweredBy true), and the rendered
 *   external-origin widget shows the locked look + the "Powered by"
 *   badge and NO avatar/logo images.
 *
 * Test 3 (validation + canonical defaults, API level):
 *   a fresh tenant's stored position default is the canonical
 *   'bottom-end'; stored explicit positions are never rewritten; the
 *   PATCH strictly validates (hex accent, enums, http(s) avatar/logo
 *   URLs — javascript:/data: rejected, greeting bounds) and uses
 *   true-patch semantics (absent fields keep their values).
 *
 * This spec runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000' // Next.js direct — signup API
const SUKHAN_ORIGIN = BASE
const CUSTOMER_PORT = 8085
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`
const WIDGET_SCRIPT_URL = (slug: string) => `${SUKHAN_ORIGIN}/api/widget/${slug}/script`

// Well-known 1x1 transparent PNG — actually served by the customer
// server so the avatar/logo images really load (the logo swap happens
// on load; a dead URL would exercise the onerror path instead).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const ACCENT = '#0066FF'                  // rgb(0, 102, 255)
const LOCKED_ACCENT = '#E09A2B'           // rgb(224, 154, 43)
const FA_GREETING = 'سلام! پیام خوش‌آمد سفارشی تست'
const AVATAR_URL = `${CUSTOMER_ORIGIN}/avatar.png`
const LOGO_URL = `${CUSTOMER_ORIGIN}/logo.png`

let customerServer: Server | null = null
let currentSlug = ''

test.beforeAll(async () => {
  customerServer = createServer((req, res) => {
    if (req.url === '/avatar.png' || req.url === '/logo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      res.end(TINY_PNG)
      return
    }
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Customer Website</title></head><body><h1>Customer Website</h1><script async defer src="${WIDGET_SCRIPT_URL(currentSlug)}"></script></body></html>`
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

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return { email: `cust-${stamp}@test.com`, workspace: `Cust ${stamp}` }
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
  // Anonymous widget-flow regression requires the tenant to be in the
  // historical `anonymous` access mode (a fresh OTP signup now defaults
  // to `verified_visitor`). Switch it before the widget script loads
  // and the test's main flow begins.
  await setAccessMode(page, 'anonymous')
  return slug as string
}

async function devSetPlan(page: Page, plan: string): Promise<void> {
  const res = await page.request.post(`${BASE}/api/invitations/dev/set-plan`, {
    data: { plan },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`dev/set-plan(${plan}) failed: ${res.status()}`)
}

async function openCustomizationTab(page: Page) {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
  await expect(page.getByTestId('customization-save')).toBeVisible({ timeout: 15_000 })
}

test.describe('Widget customization — truthful plan-gated contract', () => {
  test('PAID plan: edit → save → persist → public config → rendered external-origin widget', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('paid')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Upgrade to a plan with customization (pro).
    await devSetPlan(page, 'pro')

    // 1-2. Open Dashboard Widget > Customization — controls enabled, no lock banner.
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await expect(page.getByTestId('customization-locked-banner')).toHaveCount(0)
    await expect(page.getByTestId('customization-accent')).toBeEnabled()
    await expect(page.getByTestId('customization-save')).toBeEnabled()

    // 3-6. Change accent, shape, position, greetings, avatar, logo.
    await page.getByTestId('customization-accent').fill(ACCENT)
    await page.getByTestId('customization-shape').click()
    await page.getByRole('option', { name: /^قرص$|^Pill$/ }).click()
    await page.getByTestId('customization-position').click()
    await page.getByRole('option', { name: /Bottom start|پایین — آغاز/ }).click()
    await page.getByTestId('customization-avatar').fill(AVATAR_URL)
    await page.getByTestId('customization-logo').fill(LOGO_URL)
    await page.getByTestId('customization-greeting-fa').fill(FA_GREETING)

    // 7. Save — must succeed.
    await page.getByTestId('customization-save').click()
    await expect(
      page.getByText(/Saved|ذخیره شد/).first(),
      'save must produce a success toast',
    ).toBeVisible({ timeout: 10_000 })

    // 8-9. Reload the dashboard — values persist.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await expect(page.getByTestId('customization-accent')).toHaveValue(ACCENT)
    await expect(page.getByTestId('customization-avatar')).toHaveValue(AVATAR_URL)
    await expect(page.getByTestId('customization-logo')).toHaveValue(LOGO_URL)
    await expect(page.getByTestId('customization-greeting-fa')).toHaveValue(FA_GREETING)

    // 10. Dashboard config API returns stored + effective + isLocked:false.
    const cfgRes = await page.request.get(`${BASE}/api/widget-config`)
    expect(cfgRes.ok()).toBeTruthy()
    const cfg = await cfgRes.json()
    expect(cfg.isLocked).toBe(false)
    expect(cfg.config.accentColor).toBe(ACCENT)
    expect(cfg.config.launcherShape).toBe('pill')
    expect(cfg.config.position).toBe('bottom-start')
    expect(cfg.config.avatarUrl).toBe(AVATAR_URL)
    expect(cfg.config.logoUrl).toBe(LOGO_URL)
    expect(cfg.effective.accentColor).toBe(ACCENT)
    expect(cfg.effective.isLocked).toBe(false)
    expect(cfg.effective.poweredBy).toBe(false)

    // 11. Public widget config returns the EFFECTIVE values.
    const pubRes = await page.request.get(`${BASE}/api/widget/${slug}/config`)
    expect(pubRes.ok()).toBeTruthy()
    const pub = await pubRes.json()
    expect(pub.accentColor).toBe(ACCENT)
    expect(pub.launcherShape).toBe('pill')
    expect(pub.position).toBe('bottom-start')
    expect(pub.avatarUrl).toBe(AVATAR_URL)
    expect(pub.logoUrl).toBe(LOGO_URL)
    expect(pub.greetingTexts.fa).toBe(FA_GREETING)
    expect(pub.isLocked).toBe(false)
    expect(pub.poweredBy).toBe(false)

    // 12. The REAL external-origin widget renders the configuration.
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.goto(CUSTOMER_ORIGIN)
    await expect(widgetPage.locator('.sk-launcher')).toBeVisible({ timeout: 20_000 })
    await widgetPage.locator('.sk-launcher').click()
    const header = widgetPage.locator('.sk-header')
    await expect(header).toBeVisible({ timeout: 10_000 })
    // accent applied to the header
    await expect(header).toHaveCSS('background-color', 'rgb(0, 102, 255)')
    // launcher shape class (pill)
    await expect(widgetPage.locator('.sk-launcher.sk-pill')).toBeVisible()
    // position bottom-start with the default rtl direction -> right side
    await expect(widgetPage.locator('.sk-root')).toHaveCSS('right', '20px')
    // greeting text rendered
    await expect(widgetPage.getByText(FA_GREETING).first()).toBeVisible({ timeout: 10_000 })
    // avatar image actually rendered in the header (alt is a fixed
    // locale string — the avatar is the header img WITH an alt; the logo
    // img inside .sk-logo has an empty alt)
    const avatarImg = widgetPage.locator('.sk-header img[alt="کارشناس"], .sk-header img[alt="Agent"]')
    await expect(avatarImg).toHaveAttribute('src', AVATAR_URL)
    // logo image actually rendered (loads from the customer server; the
    // swap into .sk-logo happens on load)
    await expect(widgetPage.locator('.sk-logo img')).toHaveAttribute('src', LOGO_URL)
    // paid plan -> NO "Powered by" badge
    await expect(widgetPage.locator('.sk-powered')).toHaveCount(0)

    await widgetCtx.close()
    await ctx.close()
  })

  test('FREE plan: truthful locked flow — banner, disabled controls, 402 on PATCH, locked effective state', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('free')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Open the customization tab — locked banner + disabled controls.
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await expect(page.getByTestId('customization-locked-banner')).toBeVisible()
    await expect(page.getByTestId('customization-accent')).toBeDisabled()
    await expect(page.getByTestId('customization-shape')).toBeDisabled()
    await expect(page.getByTestId('customization-position')).toBeDisabled()
    await expect(page.getByTestId('customization-avatar')).toBeDisabled()
    await expect(page.getByTestId('customization-logo')).toBeDisabled()
    await expect(page.getByTestId('customization-greeting-fa')).toBeDisabled()
    await expect(page.getByTestId('customization-greeting-en')).toBeDisabled()
    await expect(page.getByTestId('customization-save')).toBeDisabled()

    // The dashboard config API reports the truthful lock state.
    const cfgRes = await page.request.get(`${BASE}/api/widget-config`)
    const cfg = await cfgRes.json()
    expect(cfg.isLocked).toBe(true)
    expect(cfg.effective.accentColor).toBe(LOCKED_ACCENT)
    expect(cfg.effective.launcherShape).toBe('tab')
    expect(cfg.effective.position).toBe('bottom-end')
    expect(cfg.effective.avatarUrl).toBeNull()
    expect(cfg.effective.logoUrl).toBeNull()
    expect(cfg.effective.isLocked).toBe(true)
    expect(cfg.effective.poweredBy).toBe(true)

    // A direct PATCH is REJECTED — no misleading "saved and applied".
    const patchRes = await page.request.patch(`${BASE}/api/widget-config`, {
      data: { accentColor: '#FF0000' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(patchRes.status()).toBe(402)
    expect((await patchRes.json()).error).toBe('customization_locked')

    // Public config serves the LOCKED Sukhan-brand defaults.
    const pubRes = await page.request.get(`${BASE}/api/widget/${slug}/config`)
    const pub = await pubRes.json()
    expect(pub.accentColor).toBe(LOCKED_ACCENT)
    expect(pub.launcherShape).toBe('tab')
    expect(pub.position).toBe('bottom-end')
    expect(pub.avatarUrl).toBeNull()
    expect(pub.logoUrl).toBeNull()
    expect(pub.isLocked).toBe(true)
    expect(pub.poweredBy).toBe(true)

    // The rendered external-origin widget shows the locked look + badge.
    const widgetCtx = await browser.newContext()
    const widgetPage = await widgetCtx.newPage()
    await widgetPage.goto(CUSTOMER_ORIGIN)
    await expect(widgetPage.locator('.sk-launcher')).toBeVisible({ timeout: 20_000 })
    await widgetPage.locator('.sk-launcher').click()
    const header = widgetPage.locator('.sk-header')
    await expect(header).toBeVisible({ timeout: 10_000 })
    await expect(header).toHaveCSS('background-color', 'rgb(224, 154, 43)')
    await expect(widgetPage.locator('.sk-launcher.sk-tab')).toBeVisible()
    // bottom-end with the default rtl direction -> left side
    await expect(widgetPage.locator('.sk-root')).toHaveCSS('left', '20px')
    // free plan -> "Powered by" badge IS rendered
    await expect(widgetPage.locator('.sk-powered')).toBeVisible()
    // no avatar/logo images on the locked brand look
    await expect(widgetPage.locator('.sk-header img')).toHaveCount(0)

    await widgetCtx.close()
    await ctx.close()
  })

  test('Validation + canonical position default + true-patch semantics (API level)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('validation')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // CUST-C: a fresh tenant's stored position is the canonical 'bottom-end'
    // (the signup row-creation default), and the public config serves it.
    const freshRes = await page.request.get(`${BASE}/api/widget-config`)
    const fresh = await (freshRes as { json: () => Promise<{ config: { position: string } }> }).json()
    expect(fresh.config.position).toBe('bottom-end')
    const freshPub = await (await page.request.get(`${BASE}/api/widget/${slug}/config`)).json()
    expect(freshPub.position).toBe('bottom-end')

    // Upgrade to a customization-enabled plan for the validation matrix.
    await devSetPlan(page, 'pro')

    const patch = async (body: Record<string, unknown>) =>
      page.request.patch(`${BASE}/api/widget-config`, {
        data: body,
        headers: { 'Content-Type': 'application/json' },
      })

    // Strict validation — no silent coercion (CUST-E).
    expect((await patch({ accentColor: 'not-a-color' })).status()).toBe(400)
    expect((await patch({ accentColor: '#12345' })).status()).toBe(400)
    expect((await patch({ launcherShape: 'diamond' })).status()).toBe(400)
    expect((await patch({ position: 'middle' })).status()).toBe(400)
    expect((await patch({ defaultLocale: 'fr' })).status()).toBe(400)
    expect((await patch({ greetingTexts: { fa: 'x'.repeat(201) } })).status()).toBe(400)
    expect((await patch({ greetingTexts: 'garbage' })).status()).toBe(400)

    // CUST-B security: unsafe avatar/logo URL schemes are REJECTED.
    expect((await patch({ avatarUrl: 'javascript:alert(1)' })).status()).toBe(400)
    expect((await patch({ avatarUrl: 'data:image/png;base64,AAAA' })).status()).toBe(400)
    expect((await patch({ logoUrl: 'javascript:alert(1)' })).status()).toBe(400)
    expect((await patch({ logoUrl: 'ftp://example.com/l.png' })).status()).toBe(400)
    expect((await patch({ avatarUrl: '/relative/path.png' })).status()).toBe(400)

    // Valid values are accepted; stored explicit position is preserved.
    const okRes = await patch({
      accentColor: '#123456',
      position: 'bottom-start',
      avatarUrl: 'https://example.com/avatar.png',
      greetingTexts: { fa: 'سلام', en: 'Hello' },
    })
    expect(okRes.status()).toBe(200)

    // True-patch semantics: a partial PATCH keeps the other fields.
    const partialRes = await patch({ accentColor: '#654321' })
    expect(partialRes.status()).toBe(200)
    const after = await (await page.request.get(`${BASE}/api/widget-config`)).json()
    expect(after.config.accentColor).toBe('#654321')
    expect(after.config.position).toBe('bottom-start')      // kept
    expect(after.config.avatarUrl).toBe('https://example.com/avatar.png') // kept (NOT reset)
    expect(after.config.greetingTexts.fa).toBe('سلام')      // kept

    // The public config serves the STORED explicit position (never coerced
    // to the default).
    const pub = await (await page.request.get(`${BASE}/api/widget/${slug}/config`)).json()
    expect(pub.position).toBe('bottom-start')

    await ctx.close()
  })
})
