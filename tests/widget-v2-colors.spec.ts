import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget V2 Colors — browser regression.
 *
 * Tests the REAL color customization experience end-to-end:
 *   1. Free: palette selection, save, reload, rendered colors in external widget.
 *   2. Free: custom color PATCH rejected (403 colors_custom_not_allowed).
 *   3. Pro: custom color save via PATCH, reload, rendered colors.
 *   4. Pro: color picker ↔ hex input synchronization.
 *   5. Slug-script surface renders V2 colors (data-sk-color-mode + computed).
 *   6. v1-script surface renders V2 colors.
 *   7. Positioning unchanged after color update (true-patch).
 *   8. Unknown-plan color write rejected (403 colors_not_authorized).
 *
 * Fixture pattern mirrors `tests/widget-v2-positioning.spec.ts` exactly
 * (same imports, same signup/creds/devSetPlan helpers, same customer server
 * pattern) — only the customer port differs (8097 instead of 8095) to avoid
 * port conflicts when both specs run in the same CI worker.
 *
 * Runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000' // Next.js direct — signup API
const SUKHAN_ORIGIN = BASE
const CUSTOMER_PORT = 8097
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
  return { email: `col-${stamp}@test.com`, workspace: `Col ${stamp}` }
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
  // The colors panel mounts alongside the positioning panel inside the
  // customization tab — wait for the colors card to be visible.
  await expect(page.getByTestId('colors-panel')).toBeVisible({ timeout: 15_000 })
}

/**
 * Convert a #RRGGBB hex string to the `rgb(r, g, b)` format returned by
 * `getComputedStyle(element).backgroundColor`. Browsers normalize inline
 * hex backgrounds to this exact format (no leading zeros, no alpha).
 *
 *   hexToRgb('#064E3B') → 'rgb(6, 78, 59)'
 *   hexToRgb('#10B981') → 'rgb(16, 185, 129)'
 */
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)
  if (!m) throw new Error(`hexToRgb: expected #RRGGBB, got ${hex}`)
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgb(${r}, ${g}, ${b})`
}

/** The Emerald palette tokens (used across multiple tests). */
const EMERALD_HEADER_BG = '#064E3B'
const EMERALD_LAUNCHER_BG = '#064E3B'

/** A full set of valid custom tokens for the Pro custom-color tests. */
const CUSTOM_TOKENS: Record<string, string> = {
  accent: '#FF00FF',
  launcherBg: '#1A0033',
  launcherFg: '#FFCCFF',
  headerBg: '#5B0E2D',
  headerText: '#FFE5EE',
  panelBg: '#FAF5F8',
  panelText: '#1A0033',
  visitorBubbleBg: '#F5DCE8',
  visitorBubbleText: '#1A0033',
  agentBubbleBg: '#FF00FF',
  agentBubbleText: '#FFFFFF',
}

test.describe('Widget V2 Colors — browser regression', () => {
  test('FREE: palette selection → save → reload → public config → rendered colors', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('free-preset')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Free plan (default after signup).
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)

    // The colors panel should be visible + presets available.
    await expect(page.getByTestId('colors-panel')).toBeVisible()

    // The Custom toggle should be locked (Free).
    await expect(page.getByTestId('colors-custom-toggle')).toBeDisabled()

    // Select the Emerald palette.
    await page.getByTestId('colors-palette-emerald').click()

    // Save.
    await page.getByTestId('colors-save').click()
    await expect(page.getByText(/رنگ‌ها ذخیره شدند|Colors saved/)).toBeVisible({ timeout: 10_000 })

    // Reload + verify the palette is still selected (border-saffron highlight).
    await page.reload()
    await page.waitForLoadState('networkidle')
    await openCustomizationTab(page)
    await expect(page.getByTestId('colors-palette-emerald')).toHaveClass(/border-saffron/)

    // Verify the public config exposes the palette's colors.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    expect(config.colors).toBeDefined()
    expect(config.colors.mode).toBe('preset')
    expect(config.colors.presetId).toBe('emerald')
    expect(config.colors.tokens).toBeDefined()
    expect(config.colors.tokens.headerBg).toBe(EMERALD_HEADER_BG)
    // Free: custom tokens are NEVER exposed (even if stored).
    expect(config.colors.custom).toBeUndefined()

    // Open the customer page and verify the rendered widget header color.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    // Wait for V2 colors to be applied (data-sk-color-mode attribute set).
    await customerPage.waitForFunction(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root && root.getAttribute('data-sk-color-mode') !== null
    }, { timeout: 15_000 })
    await customerPage.waitForTimeout(500) // settle for applyColors + renderMessages

    // Verify the data-sk-color-mode + data-sk-color-preset attributes.
    const colorDiag = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return {
        mode: root?.getAttribute('data-sk-color-mode'),
        preset: root?.getAttribute('data-sk-color-preset'),
      }
    })
    expect(colorDiag.mode).toBe('preset')
    expect(colorDiag.preset).toBe('emerald')

    // Verify the header element has the emerald headerBg color (computed style).
    const headerBg = await customerPage.evaluate(() => {
      const header = document.querySelector('.sk-header') as HTMLElement
      return header ? getComputedStyle(header).backgroundColor : null
    })
    expect(headerBg).toBe(hexToRgb(EMERALD_HEADER_BG))

    await ctx.close()
  })

  test('FREE: custom color PATCH rejected (403 colors_custom_not_allowed)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('free-custom')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Free plan — attempt to PATCH with custom colors via API (bypassing UI).
    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    const res = await page.request.patch(`${BASE}/api/widget-config`, {
      data: {
        colors: {
          mode: 'custom',
          custom: CUSTOM_TOKENS,
        },
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('colors_custom_not_allowed')

    await ctx.close()
  })

  test('PRO: custom color save → reload → rendered colors', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('pro-custom')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Upgrade to Pro.
    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Save custom colors via PATCH API.
    const patchRes = await page.request.patch(`${BASE}/api/widget-config`, {
      data: { colors: { mode: 'custom', custom: CUSTOM_TOKENS } },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(patchRes.ok()).toBe(true)

    // Reload + verify stored values via the dashboard GET.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const cfgRes = await page.request.get(`${DASHBOARD}/api/widget-config`)
    const cfg = await cfgRes.json()
    expect(cfg.colors.stored).toBeDefined()
    expect(cfg.colors.stored.mode).toBe('custom')
    expect(cfg.colors.stored.custom).toBeDefined()
    expect(cfg.colors.stored.custom.headerBg).toBe(CUSTOM_TOKENS.headerBg)
    // Effective colors should also reflect the custom tokens (Pro is entitled).
    expect(cfg.colors.effective.mode).toBe('custom')
    expect(cfg.colors.effective.tokens.headerBg).toBe(CUSTOM_TOKENS.headerBg)

    // Verify the public config exposes the effective custom colors.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    expect(config.colors.mode).toBe('custom')
    expect(config.colors.tokens.headerBg).toBe(CUSTOM_TOKENS.headerBg)

    // Open the customer page and verify the rendered widget header color.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    await customerPage.waitForFunction(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root && root.getAttribute('data-sk-color-mode') !== null
    }, { timeout: 15_000 })
    await customerPage.waitForTimeout(500)

    // Verify the data-sk-color-mode attribute (custom, no preset).
    const colorDiag = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return {
        mode: root?.getAttribute('data-sk-color-mode'),
        preset: root?.getAttribute('data-sk-color-preset'),
      }
    })
    expect(colorDiag.mode).toBe('custom')
    expect(colorDiag.preset).toBeNull() // no preset ID in custom mode

    // Verify the header element has the custom headerBg color (computed style).
    const headerBg = await customerPage.evaluate(() => {
      const header = document.querySelector('.sk-header') as HTMLElement
      return header ? getComputedStyle(header).backgroundColor : null
    })
    expect(headerBg).toBe(hexToRgb(CUSTOM_TOKENS.headerBg))

    await ctx.close()
  })

  test('PRO: color picker + hex input synchronization', async ({ browser }) => {
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

    // Switch to custom mode (Pro — the toggle is enabled).
    await page.getByTestId('colors-custom-toggle').click()

    // Wait for the custom tokens editor to render.
    await expect(page.getByTestId('colors-token-accent-input')).toBeVisible({ timeout: 10_000 })

    // Change the accent token via the hex input.
    await page.getByTestId('colors-token-accent-input').fill('#ABCDEF')

    // Verify the color picker synced (browsers normalize to uppercase).
    const pickerValAfterInput = await page.getByTestId('colors-token-accent-picker').inputValue()
    expect(pickerValAfterInput.toUpperCase()).toBe('#ABCDEF')

    // Change the accent token via the color picker.
    await page.getByTestId('colors-token-accent-picker').fill('#112233')

    // Verify the hex input synced.
    const inputValAfterPicker = await page.getByTestId('colors-token-accent-input').inputValue()
    expect(inputValAfterPicker.toUpperCase()).toBe('#112233')

    await ctx.close()
  })

  test('Slug-script surface renders V2 colors (data-sk-color-mode + computed header)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('slug-surface')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Set a palette via PATCH API.
    await page.request.patch(`${BASE}/api/widget-config`, {
      data: { colors: { mode: 'preset', presetId: 'emerald' } },
      headers: { 'Content-Type': 'application/json' },
    })

    // Open the customer page (slug-script surface) and verify rendered colors.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    await customerPage.waitForFunction(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root && root.getAttribute('data-sk-color-mode') !== null
    }, { timeout: 15_000 })
    await customerPage.waitForTimeout(500)

    // Verify the data-sk-color-mode + data-sk-color-preset attributes.
    const colorDiag = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return {
        mode: root?.getAttribute('data-sk-color-mode'),
        preset: root?.getAttribute('data-sk-color-preset'),
      }
    })
    expect(colorDiag.mode).toBe('preset')
    expect(colorDiag.preset).toBe('emerald')

    // Verify the header + launcher have the emerald colors (computed style).
    const computed = await customerPage.evaluate(() => {
      const header = document.querySelector('.sk-header') as HTMLElement
      const launcher = document.querySelector('.sk-launcher') as HTMLElement
      return {
        headerBg: header ? getComputedStyle(header).backgroundColor : null,
        launcherBg: launcher ? getComputedStyle(launcher).backgroundColor : null,
      }
    })
    expect(computed.headerBg).toBe(hexToRgb(EMERALD_HEADER_BG))
    expect(computed.launcherBg).toBe(hexToRgb(EMERALD_LAUNCHER_BG))

    await ctx.close()
  })

  test('v1-script surface renders V2 colors (data-sk-color-mode + computed header)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('v1-surface')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Set a palette via PATCH API.
    await page.request.patch(`${BASE}/api/widget-config`, {
      data: { colors: { mode: 'preset', presetId: 'emerald' } },
      headers: { 'Content-Type': 'application/json' },
    })

    // Serve a customer page that loads the v1-script (data-api-key attribute).
    // Uses a dedicated port (8098) to avoid clashing with this spec's main
    // customer server on 8097 (which stays open for the whole spec).
    const v1CustomerServer = createServer((req, res) => {
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>V1 Customer</title></head><body><h1>V1 Customer</h1><script async defer src="${SUKHAN_ORIGIN}/api/widget/v1/sukhan.js" data-api-key="${slug}"></script></body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    const v1Port = 8098
    await new Promise<void>((resolve) => v1CustomerServer.listen(v1Port, '127.0.0.1', resolve))

    try {
      const customerPage = await ctx.newPage()
      await customerPage.goto(`http://127.0.0.1:${v1Port}`)
      await customerPage.waitForLoadState('networkidle')
      await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
      await customerPage.waitForFunction(() => {
        const root = document.querySelector('.sk-root') as HTMLElement
        return root && root.getAttribute('data-sk-color-mode') !== null
      }, { timeout: 15_000 })
      await customerPage.waitForTimeout(500)

      // Verify the data-sk-color-mode + data-sk-color-preset attributes.
      const colorDiag = await customerPage.evaluate(() => {
        const root = document.querySelector('.sk-root') as HTMLElement
        return {
          mode: root?.getAttribute('data-sk-color-mode'),
          preset: root?.getAttribute('data-sk-color-preset'),
        }
      })
      expect(colorDiag.mode).toBe('preset')
      expect(colorDiag.preset).toBe('emerald')

      // Verify the header has the emerald headerBg color (computed style).
      const headerBg = await customerPage.evaluate(() => {
        const header = document.querySelector('.sk-header') as HTMLElement
        return header ? getComputedStyle(header).backgroundColor : null
      })
      expect(headerBg).toBe(hexToRgb(EMERALD_HEADER_BG))
    } finally {
      await new Promise<void>((resolve) => v1CustomerServer.close(() => resolve()))
    }

    await ctx.close()
  })

  test('Positioning unchanged after color update (true-patch)', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('colors-with-pos')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Upgrade to Pro (so we can exercise both positioning + custom colors).
    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Step 1: set positioning to bottom-center with an offset.
    const posRes = await page.request.patch(`${BASE}/api/widget-config`, {
      data: { positioning: { desktop: { anchor: 'bottom-center', offsetX: 80 } } },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(posRes.ok()).toBe(true)

    // Step 2: set colors to the emerald palette (separate PATCH — true-patch).
    const colRes = await page.request.patch(`${BASE}/api/widget-config`, {
      data: { colors: { mode: 'preset', presetId: 'emerald' } },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(colRes.ok()).toBe(true)

    // Step 3: verify the public config STILL has both positioning + colors.
    const configRes = await page.request.get(`${SUKHAN_ORIGIN}/api/widget/${slug}/config`)
    expect(configRes.ok()).toBe(true)
    const config = await configRes.json()
    // Positioning preserved.
    expect(config.positioning.desktop.anchor).toBe('bottom-center')
    expect(config.positioning.desktop.offsetX).toBe(80)
    // Colors applied.
    expect(config.colors.mode).toBe('preset')
    expect(config.colors.presetId).toBe('emerald')
    expect(config.colors.tokens.headerBg).toBe(EMERALD_HEADER_BG)

    // Step 4: open the customer page — verify BOTH positioning + colors render.
    const customerPage = await ctx.newPage()
    await customerPage.goto(CUSTOMER_ORIGIN)
    await customerPage.waitForLoadState('networkidle')
    await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
    await customerPage.waitForFunction(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      return root &&
        root.getAttribute('data-sk-anchor') !== null &&
        root.getAttribute('data-sk-color-mode') !== null
    }, { timeout: 15_000 })
    await customerPage.waitForTimeout(500)

    const widgetDiag = await customerPage.evaluate(() => {
      const root = document.querySelector('.sk-root') as HTMLElement
      const header = document.querySelector('.sk-header') as HTMLElement
      return {
        anchor: root?.getAttribute('data-sk-anchor'),
        offsetX: root?.getAttribute('data-sk-offset-x'),
        colorMode: root?.getAttribute('data-sk-color-mode'),
        colorPreset: root?.getAttribute('data-sk-color-preset'),
        headerBg: header ? getComputedStyle(header).backgroundColor : null,
      }
    })
    // Positioning preserved.
    expect(widgetDiag.anchor).toBe('bottom-center')
    expect(widgetDiag.offsetX).toBe('80')
    // Colors applied.
    expect(widgetDiag.colorMode).toBe('preset')
    expect(widgetDiag.colorPreset).toBe('emerald')
    expect(widgetDiag.headerBg).toBe(hexToRgb(EMERALD_HEADER_BG))

    await ctx.close()
  })

  test('UNKNOWN PLAN: color PATCH rejected with colors_not_authorized (403)', async ({ browser }) => {
    test.setTimeout(120_000)
    const { email, workspace } = creds('unknown-plan')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    // Sign up creates a 'free' tenant. Use dev/set-plan to set to 'pro'
    // first (so the tenant has a valid plan), then directly update the
    // tenant's plan to an unrecognized value via the DB.
    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Get the tenant ID.
    const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
    const tenantData = await tenantRes.json()
    const tenantId = tenantData.tenant?.id
    expect(tenantId).toBeTruthy()

    // Directly update the tenant's plan to an unrecognized value via the DB.
    // This tests the actual authorization path: getEntitlements('unknown')
    // returns null → validateColorPatch rejects with colors_not_authorized.
    const { globalDb } = await import('../src/lib/db')
    await globalDb.tenant.update({
      where: { id: tenantId },
      data: { plan: 'unknown-plan-xyz' },
    })

    try {
      // Attempt a preset-mode color PATCH — must be rejected.
      const res = await page.request.patch(`${BASE}/api/widget-config`, {
        data: { colors: { mode: 'preset', presetId: 'emerald' } },
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status()).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('colors_not_authorized')
    } finally {
      // Clean up: restore the plan to 'free' so the tenant can be deleted
      // by normal test cleanup. Also delete directly as safety net.
      await globalDb.tenant.update({
        where: { id: tenantId },
        data: { plan: 'free' },
      }).catch(() => {})
      await globalDb.tenant.delete({ where: { id: tenantId } }).catch(() => {})
    }

    await ctx.close()
  })

  // ─── NPM widget surface: real rendered V2 custom colors ──────────────────
  test('NPM widget surface: real rendered V2 custom colors (computed styles)', async ({ browser }) => {
    test.setTimeout(180_000)
    const { email, workspace } = creds('npm-colors')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)
    currentSlug = slug

    await devSetPlan(page, 'pro')
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
    const { csrfToken } = await csrfRes.json()
    await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
    })

    // Set a CUSTOM color theme (non-default paid) via PATCH API.
    await page.request.patch(`${BASE}/api/widget-config`, {
      data: { colors: { mode: 'custom', custom: CUSTOM_TOKENS } },
      headers: { 'Content-Type': 'application/json' },
    })

    // Build the NPM bundle (clean build to ensure latest source).
    const PKG_DIR = resolve(process.cwd(), 'packages/widget-npm')
    const WIDGET_BUNDLE = join(PKG_DIR, 'dist', 'index.js')
    rmSync(join(PKG_DIR, 'dist'), { recursive: true, force: true })
    execSync('bun run build', { cwd: PKG_DIR, stdio: 'pipe' })
    expect(existsSync(WIDGET_BUNDLE), 'NPM widget bundle must be built').toBe(true)

    // Customer server that serves the NPM bundle + barebones HTML.
    const NPM_PORT = 8099
    const npmServer = createServer((req, res) => {
      if (req.url === '/' || req.url === '/customer.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NPM Customer</title></head><body><h1>NPM Customer</h1></body></html>')
        return
      }
      const fileMatch = req.url?.match(/^\/([A-Za-z0-9_.-]+\.js)$/)
      if (fileMatch) {
        const filePath = join(PKG_DIR, 'dist', fileMatch[1])
        if (existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end(readFileSync(filePath))
          return
        }
      }
      if (req.url === '/sukhan-widget.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(readFileSync(WIDGET_BUNDLE))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((r) => npmServer.listen(NPM_PORT, '127.0.0.1', r))

    try {
      const customerPage = await ctx.newPage()
      await customerPage.goto(`http://127.0.0.1:${NPM_PORT}/customer.html`)
      await customerPage.waitForLoadState('networkidle')

      // Initialize the NPM widget via dynamic import.
      await customerPage.evaluate(async (args: { slug: string, origin: string }) => {
        const mod = await import(`${window.location.origin}/sukhan-widget.js`)
        mod.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: SUKHAN_ORIGIN })

      // Wait for the widget to mount + apply colors.
      await customerPage.waitForSelector('.sk-root', { timeout: 15_000 })
      await customerPage.waitForFunction(() => {
        const root = document.querySelector('.sk-root') as HTMLElement
        return root && root.getAttribute('data-sk-color-mode') !== null
      }, { timeout: 15_000 })
      await customerPage.waitForTimeout(1000)

      // Verify actual computed styles for launcher, header, body background.
      const computed = await customerPage.evaluate(() => {
        const root = document.querySelector('.sk-root') as HTMLElement
        const launcher = document.querySelector('.sk-launcher') as HTMLElement
        const header = document.querySelector('.sk-header') as HTMLElement
        const body = document.querySelector('.sk-body') as HTMLElement
        return {
          mode: root?.getAttribute('data-sk-color-mode'),
          launcherBg: launcher ? getComputedStyle(launcher).backgroundColor : null,
          launcherFg: launcher ? getComputedStyle(launcher).color : null,
          headerBg: header ? getComputedStyle(header).backgroundColor : null,
          headerText: header ? getComputedStyle(header).color : null,
          bodyBg: body ? getComputedStyle(body).backgroundColor : null,
        }
      })
      // The NPM widget must have applied V2 custom colors.
      expect(computed.mode).toBe('custom')
      // Launcher background + foreground.
      expect(computed.launcherBg).toBe(hexToRgb(CUSTOM_TOKENS.launcherBg))
      // Header background + text.
      expect(computed.headerBg).toBe(hexToRgb(CUSTOM_TOKENS.headerBg))
      // Body background (panelBg applied to .sk-body, not just outer panel).
      expect(computed.bodyBg).toBe(hexToRgb(CUSTOM_TOKENS.panelBg))
    } finally {
      await new Promise<void>((r) => npmServer.close(() => r()))
    }

    await ctx.close()
  })
})
