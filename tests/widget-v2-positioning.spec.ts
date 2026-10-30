import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget V2 Positioning — browser regression.
 *
 * Tests the REAL positioning experience end-to-end:
 *   1. Free: preset selection, save, reload, rendered position in external widget.
 *   2. Pro: numeric offset input, save, reload, rendered position.
 *   3. Desktop/mobile switching + device preview.
 *   4. V1 fallback (no V2 positioning → legacy position).
 *   5. Public config exposes effective positioning.
 *   6. Free cannot use offsets (403 on attempt).
 *
 * Runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000' // Next.js direct — signup API
const SUKHAN_ORIGIN = BASE
const CUSTOMER_PORT = 8095
const CUSTOMER_ORIGIN = `http://127.0.0.1:${CUSTOMER_PORT}`
const WIDGET_SCRIPT_URL = (slug: string) => `${SUKHAN_ORIGIN}/api/widget/${slug}/script`

let customerServer: Server | null = null
let currentSlug = ''

test.beforeAll(async () => {
  customerServer = createServer((req, res) => {
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
  return { email: `pos-${stamp}@test.com`, workspace: `Pos ${stamp}` }
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
    data: { plan },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`dev/set-plan(${plan}) failed: ${res.status()}`)
}

async function openCustomizationTab(page: Page) {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
  await expect(page.getByTestId('positioning-panel')).toBeVisible({ timeout: 15_000 })
}

test.describe('Widget V2 Positioning — browser regression', () => {
  test('FREE: preset selection → save → reload → public config → rendered position', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('free')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Free plan (default after signup).
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // The positioning panel should be visible + presets available.
    await expect(page.getByTestId('positioning-panel')).toBeVisible()

    // Select bottom-center for desktop.
    await page.getByTestId('positioning-device-desktop').click()
    await page.getByTestId('positioning-anchor-bottom-center').click()

    // Select bottom-start for mobile.
    await page.getByTestId('positioning-device-mobile').click()
    await page.getByTestId('positioning-anchor-bottom-start').click()

    // Save.
    await page.getByTestId('positioning-save').click()
    await expect(page.getByText(/موقعیت ذخیره شد|Positioning saved/)).toBeVisible({ timeout: 10_000 })

    // Reload + verify the stored values.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // Verify desktop is bottom-center.
    await page.getByTestId('positioning-device-desktop').click()
    await expect(page.getByTestId('positioning-anchor-bottom-center')).toHaveClass(/border-saffron/)

    // Verify mobile is bottom-start.
    await page.getByTestId('positioning-device-mobile').click()
    await expect(page.getByTestId('positioning-anchor-bottom-start')).toHaveClass(/border-saffron/)

    // Verify the public config exposes the effective positioning.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    expect(config.positioning).toBeDefined()
    expect(config.positioning.desktop.anchor).toBe('bottom-center')
    expect(config.positioning.mobile.anchor).toBe('bottom-start')
    // Free: no offsets in public config.
    expect(config.positioning.desktop.offsetX).toBe(0)
    expect(config.positioning.desktop.offsetY).toBe(0)

    // Verify the rendered external-origin widget uses the positioning.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    // The root element should be positioned (not at the default bottom-end).
    const rootLeft = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root ? parseInt(root.style.left || '0', 10) : -1
    })
    // bottom-center in a ~viewport width → left should be near center.
    expect(rootLeft).toBeGreaterThan(0)

    await ctx.close()
  })

  test('FREE: custom offset submission is rejected (403)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('free-offset')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Free plan — attempt to PATCH with offsets via API (bypassing UI).
    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    const res = await page.request.patch(`${BASE}/api/widget-config`, {
      data: {
        positioning: {
          desktop: { anchor: 'bottom-end', offsetX: 100 },
        },
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('positioning_offset_not_allowed')

    await ctx.close()
  })

  test('FREE: mixing positioning + forbidden customization is rejected (402)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('free-mix')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Attempt to send positioning + accentColor (forbidden for Free).
    const res = await page.request.patch(`${BASE}/api/widget-config`, {
      data: {
        positioning: { desktop: { anchor: 'bottom-center' } },
        accentColor: '#FF0000',
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(402)
    const body = await res.json()
    expect(body.error).toBe('customization_locked')

    await ctx.close()
  })

  test('PRO: numeric offset input → save → reload → rendered position', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('pro')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Upgrade to Pro.
    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // The positioning panel should show offset controls for Pro.
    await expect(page.getByTestId('positioning-offsetX-input')).toBeVisible()

    // Select bottom-start + set offsetX to 100.
    await page.getByTestId('positioning-device-desktop').click()
    await page.getByTestId('positioning-anchor-bottom-start').click()
    await page.getByTestId('positioning-offsetX-input').fill('100')

    // Save.
    await page.getByTestId('positioning-save').click()
    await expect(page.getByText(/موقعیت ذخیره شد|Positioning saved/)).toBeVisible({ timeout: 10_000 })

    // Reload + verify stored values.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await page.getByTestId('positioning-device-desktop').click()
    await expect(page.getByTestId('positioning-offsetX-input')).toHaveValue('100')

    // Verify the public config exposes the effective positioning with offsets.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    expect(config.positioning.desktop.anchor).toBe('bottom-start')
    expect(config.positioning.desktop.offsetX).toBe(100) // Pro: offsets exposed

    // Verify the rendered external-origin widget uses the custom position.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    const rootLeft = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root ? parseInt(root.style.left || '0', 10) : -1
    })
    // bottom-start + offsetX 100 → left should be ~120 (baseMargin + 100).
    expect(rootLeft).toBeGreaterThan(100)

    await ctx.close()
  })

  test('PRO: slider + numeric input synchronization', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('pro-sync')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    await page.getByTestId('positioning-device-desktop').click()
    await page.getByTestId('positioning-anchor-bottom-end').click()

    // Set via numeric input.
    await page.getByTestId('positioning-offsetX-input').fill('50')
    // Verify slider synced.
    const sliderVal = await page.getByTestId('positioning-offsetX-slider').inputValue()
    expect(sliderVal).toBe('50')

    // Set via slider.
    await page.getByTestId('positioning-offsetX-slider').fill('75')
    // Verify numeric input synced.
    const inputVal = await page.getByTestId('positioning-offsetX-input').inputValue()
    expect(inputVal).toBe('75')

    await ctx.close()
  })

  test('PRO: true-patch — editing mobile does NOT reset desktop', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('pro-patch')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // Set desktop to bottom-center with offsetX 100.
    await page.getByTestId('positioning-device-desktop').click()
    await page.getByTestId('positioning-anchor-bottom-center').click()
    await page.getByTestId('positioning-offsetX-input').fill('100')
    await page.getByTestId('positioning-save').click()
    await expect(page.getByText(/موقعیت ذخیره شد|Positioning saved/)).toBeVisible({ timeout: 10_000 })

    // Reload.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // Set mobile to bottom-start (should NOT reset desktop).
    await page.getByTestId('positioning-device-mobile').click()
    await page.getByTestId('positioning-anchor-bottom-start').click()
    await page.getByTestId('positioning-save').click()
    await expect(page.getByText(/موقعیت ذخیره شد|Positioning saved/)).toBeVisible({ timeout: 10_000 })

    // Reload + verify desktop is still bottom-center + offsetX 100.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await page.getByTestId('positioning-device-desktop').click()
    await expect(page.getByTestId('positioning-anchor-bottom-center')).toHaveClass(/border-saffron/)
    await expect(page.getByTestId('positioning-offsetX-input')).toHaveValue('100')

    // Verify mobile is bottom-start.
    await page.getByTestId('positioning-device-mobile').click()
    await expect(page.getByTestId('positioning-anchor-bottom-start')).toHaveClass(/border-saffron/)

    await ctx.close()
  })

  test('Public config: V1 fallback when no V2 positioning stored', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('v1-fallback')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Don't edit positioning — the widget should fall back to V1 position.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    // V1 position should be present (legacy field).
    expect(config.position).toBeDefined()
    expect(['bottom-start', 'bottom-end']).toContain(config.position)
    // V2 positioning should also be present (effective, derived from V1).
    expect(config.positioning).toBeDefined()
    expect(config.positioning.desktop.anchor).toBe(config.position)
    expect(config.positioning.desktop.offsetX).toBe(0)
    expect(config.positioning.desktop.offsetY).toBe(0)

    await ctx.close()
  })
})
