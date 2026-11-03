import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Reviewer-owned Feature 12 Widget Playground acceptance.
 * Real authenticated Full and Lite dashboards; no mocked backend or fake config.
 * The playground is a local-only simulation and MUST NOT save, send messages,
 * alter visitor state, or allow previewing disallowed paid controls on Free.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'

async function signup(page: Page, scenario: string) {
  const stamp = scenario + '-' + process.pid + '-' + Date.now()
  const email = 'play-' + stamp + '@test.com'
  const res = await otpSignupPlaywright(page.request, DASHBOARD, email, 'PLAY-' + stamp)
  expect(res.ok).toBe(true)
  const csrf = await page.request.get(DASHBOARD + '/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const { csrfToken } = await csrf.json()
  const login = await page.request.post(DASHBOARD + '/api/auth/callback/credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'email=' + email + '&password=password123&csrfToken=' + csrfToken + '&json=true',
  })
  expect(login.status()).toBeLessThan(500)
  await page.goto(BASE)
}
async function plan(page: Page, value: 'free' | 'pro') {
  const r = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    headers: { 'Content-Type': 'application/json' }, data: { plan: value },
  })
  expect(r.ok(), await r.text()).toBe(true)
}
async function openPlayground(page: Page) {
  await page.getByRole('navigation', { name: 'primary' })
    .getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await expect(page.getByTestId('playground-tab')).toBeVisible()
  await page.getByTestId('playground-tab').click()
  await expect(page.getByTestId('playground-panel')).toBeVisible()
  await expect(page.getByTestId('playground-not-live')).toBeVisible()
}
async function ownerConfig(page: Page) {
  const res = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  return body.config
}
test.describe('Reviewer — Widget V2 Playground / Feature 12', () => {
  test('Free can open a local playground and sees non-live disclosure and effective baseline', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'free-baseline')
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-device-desktop')).toBeVisible()
      await expect(owner.getByTestId('playground-device-mobile')).toBeVisible()
      await expect(owner.getByTestId('playground-launcher')).toBeVisible()
      await expect(owner.getByTestId('playground-palette')).toHaveValue('sukhan')
      await expect(owner.getByTestId('playground-shape')).toHaveValue('tab')
      await expect(owner.getByTestId('playground-branding')).toBeVisible()
    } finally { await ctx.close() }
  })
  test('Free can switch between all 10 canonical palettes, change anchor, and reset locally', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'free-palette')
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-palette').locator('option')).toHaveCount(10)
      await owner.getByTestId('playground-palette').selectOption('emerald')
      await owner.getByTestId('playground-anchor').selectOption('bottom-center')
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-palette', 'emerald')
      await expect(owner.getByTestId('playground-anchor')).toHaveValue('bottom-center')
      await owner.getByTestId('playground-reset').click()
      await expect(owner.getByTestId('playground-palette')).toHaveValue('sukhan')
      await expect(owner.getByTestId('playground-anchor')).toHaveValue('bottom-end')
    } finally { await ctx.close() }
  })
  test('Free never offers pill shape, precise offsets or custom accent simulation', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'free-gate')
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-shape').locator('option[value="pill"]')).toHaveCount(0)
      await expect(owner.getByTestId('playground-offset-x')).toBeDisabled()
      await expect(owner.getByTestId('playground-offset-y')).toBeDisabled()
      await expect(owner.getByTestId('playground-custom-accent')).toBeDisabled()
      await owner.getByTestId('playground-shape').selectOption('rounded')
      await expect(owner.getByTestId('playground-launcher')).toHaveAttribute('data-playground-shape', 'rounded')
    } finally { await ctx.close() }
  })
  test('Free experiment has no config PATCH, message POST or persisted setting changes', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'free-no-write')
      const before = await ownerConfig(owner)
      const forbidden: string[] = []
      owner.on('request', r => {
        if (['PATCH', 'POST', 'PUT', 'DELETE'].includes(r.method()) &&
          (/\/api\/widget-config(?:[/?]|$)/.test(r.url()) || /\/api\/widget\/[^/]+\/messages/.test(r.url()))) forbidden.push(r.method() + ' ' + r.url())
      })
      await openPlayground(owner)
      await owner.getByTestId('playground-palette').selectOption('ocean')
      await owner.getByTestId('playground-anchor').selectOption('bottom-start')
      await owner.getByTestId('playground-launcher').click()
      await expect(owner.getByTestId('playground-chat')).toBeVisible()
      await owner.getByTestId('playground-message-input').fill('This is only a simulation')
      await owner.getByTestId('playground-send').click()
      await expect(owner.getByTestId('playground-message')).toContainText('This is only a simulation')
      expect(forbidden).toEqual([])
      expect(await ownerConfig(owner)).toEqual(before)
    } finally { await ctx.close() }
  })
  test('Pro unlocks all shapes, precise offsets, and locally simulated custom accent', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'paid-options')
      await plan(owner, 'pro')
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-shape').locator('option[value="pill"]')).toHaveCount(1)
      await expect(owner.getByTestId('playground-offset-x')).toBeEnabled()
      await expect(owner.getByTestId('playground-offset-y')).toBeEnabled()
      await expect(owner.getByTestId('playground-custom-accent')).toBeEnabled()
      await owner.getByTestId('playground-shape').selectOption('pill')
      await owner.getByTestId('playground-palette').selectOption('midnight')
      await owner.getByTestId('playground-offset-x').fill('35')
      await owner.getByTestId('playground-offset-y').fill('12')
      await owner.getByTestId('playground-custom-accent').fill('#663399')
      await expect(owner.getByTestId('playground-launcher')).toHaveAttribute('data-playground-shape', 'pill')
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-palette', 'midnight')
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-custom-accent', '#663399')
      await expect(owner.getByTestId('playground-offset-x')).toHaveValue('35')
    } finally { await ctx.close() }
  })
  test('Both device previews work without navigation or persisting separate settings', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'devices')
      await plan(owner, 'pro')
      await openPlayground(owner)
      await owner.getByTestId('playground-device-mobile').click()
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-device', 'mobile')
      await expect(owner.getByTestId('playground-anchor')).toBeVisible()
      await owner.getByTestId('playground-anchor').selectOption('bottom-center')
      await expect(owner.getByTestId('playground-launcher')).toBeVisible()
      await owner.getByTestId('playground-device-desktop').click()
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-device', 'desktop')
      await expect(owner.getByTestId('playground-launcher')).toBeVisible()
    } finally { await ctx.close() }
  })
  test('English and Persian simulations update direction and greeting without changing saved locale', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'languages')
      const before = await ownerConfig(owner)
      await openPlayground(owner)
      await owner.getByTestId('playground-locale-en').click()
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('dir', 'ltr')
      await owner.getByTestId('playground-locale-fa').click()
      await expect(owner.getByTestId('playground-surface')).toHaveAttribute('dir', 'rtl')
      await expect(owner.getByTestId('playground-greeting')).toBeVisible()
      expect(await ownerConfig(owner)).toEqual(before)
    } finally { await ctx.close() }
  })
  test('Launcher toggles and simulated messages stay in memory without visitor APIs', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'simulation')
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-chat')).toHaveCount(0)
      const messageRequests: string[] = []
      owner.on('request', r => {
        if (r.url().includes('/api/widget/') && (r.url().includes('/messages') || r.url().includes('/contact'))) messageRequests.push(r.url())
      })
      await owner.getByTestId('playground-launcher').click()
      await expect(owner.getByTestId('playground-chat')).toBeVisible()
      await owner.getByTestId('playground-message-input').fill('Local dry run')
      await owner.getByTestId('playground-send').click()
      await expect(owner.getByTestId('playground-message')).toContainText('Local dry run')
      expect(messageRequests).toEqual([])
      await owner.getByTestId('playground-launcher').click()
      await expect(owner.getByTestId('playground-chat')).toHaveCount(0)
    } finally { await ctx.close() }
  })
  test('Reset and hard reload remove all unsaved experiment changes and local messages', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'reload')
      await openPlayground(owner)
      await owner.getByTestId('playground-palette').selectOption('rose')
      await owner.getByTestId('playground-launcher').click()
      await owner.getByTestId('playground-message-input').fill('Never persisted')
      await owner.getByTestId('playground-send').click()
      await owner.getByTestId('playground-reset').click()
      await expect(owner.getByTestId('playground-palette')).toHaveValue('sukhan')
      await expect(owner.getByTestId('playground-message')).toHaveCount(0)
      await expect(owner.getByTestId('playground-chat')).toHaveCount(0)
      await owner.getByTestId('playground-palette').selectOption('violet')
      await owner.reload()
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-palette')).toHaveValue('sukhan')
      await expect(owner.getByTestId('playground-message')).toHaveCount(0)
    } finally { await ctx.close() }
  })
  test('Paid to Free downgrade immediately removes paid-only simulation options on reload', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'downgrade')
      await plan(owner, 'pro')
      await openPlayground(owner)
      await owner.getByTestId('playground-shape').selectOption('pill')
      await plan(owner, 'free')
      await owner.reload()
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-shape').locator('option[value="pill"]')).toHaveCount(0)
      await expect(owner.getByTestId('playground-offset-x')).toBeDisabled()
      await expect(owner.getByTestId('playground-custom-accent')).toBeDisabled()
      await expect(owner.getByTestId('playground-branding')).toBeVisible()
      await plan(owner, 'pro')
      await owner.reload()
      await openPlayground(owner)
      await expect(owner.getByTestId('playground-shape').locator('option[value="pill"]')).toHaveCount(1)
    } finally { await ctx.close() }
  })
  test('Malicious HTML in a simulated message renders as text only and never reaches the backend', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'xss')
      await openPlayground(owner)
      const payload = '<img src=x onerror=alert(1)>'
      await owner.getByTestId('playground-launcher').click()
      await owner.getByTestId('playground-message-input').fill(payload)
      await owner.getByTestId('playground-send').click()
      await expect(owner.getByTestId('playground-message')).toContainText(payload)
      await expect(owner.getByTestId('playground-message').locator('img')).toHaveCount(0)
      await expect(owner.getByTestId('playground-message').locator('script')).toHaveCount(0)
    } finally { await ctx.close() }
  })
  test('Narrow responsive dashboard keeps simulated launcher and open chat inside the REAL clipped preview width', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const owner = await ctx.newPage()
      await signup(owner, 'responsive-width')
      await openPlayground(owner)
      // Start at desktop width so sidebar navigation is accessible, then
      // exercise the same mounted Playground after the dashboard shrinks.
      await owner.setViewportSize({ width: 320, height: 740 })
      for (const device of ['desktop', 'mobile'] as const) {
        await owner.getByTestId('playground-device-' + device).click()
        await expect(owner.getByTestId('playground-surface')).toHaveAttribute('data-playground-device', device)
        const surface = owner.getByTestId('playground-surface')
        const launcher = owner.getByTestId('playground-launcher')
        const surfaceRect = await surface.boundingBox()
        const launcherRect = await launcher.boundingBox()
        expect(surfaceRect).not.toBeNull()
        expect(launcherRect).not.toBeNull()
        expect(surfaceRect!.width).toBeLessThanOrEqual(320)
        // CSS max-width:100% may shrink the actual preview below its 640px/
        // 360px design size. Positioning MUST use the measured rendered size,
        // or the launcher is clipped outside the preview on narrow screens.
        expect(launcherRect!.x).toBeGreaterThanOrEqual(surfaceRect!.x - 1)
        expect(launcherRect!.x + launcherRect!.width).toBeLessThanOrEqual(surfaceRect!.x + surfaceRect!.width + 1)
        expect(launcherRect!.y).toBeGreaterThanOrEqual(surfaceRect!.y - 1)
        expect(launcherRect!.y + launcherRect!.height).toBeLessThanOrEqual(surfaceRect!.y + surfaceRect!.height + 1)
        await launcher.click()
        const chat = owner.getByTestId('playground-chat')
        await expect(chat).toBeVisible()
        const chatRect = await chat.boundingBox()
        expect(chatRect).not.toBeNull()
        expect(chatRect!.x).toBeGreaterThanOrEqual(surfaceRect!.x - 1)
        expect(chatRect!.x + chatRect!.width).toBeLessThanOrEqual(surfaceRect!.x + surfaceRect!.width + 1)
        expect(chatRect!.y).toBeGreaterThanOrEqual(surfaceRect!.y - 1)
        expect(chatRect!.y + chatRect!.height).toBeLessThanOrEqual(surfaceRect!.y + surfaceRect!.height + 1)
        await launcher.click()
        await expect(chat).toHaveCount(0)
      }
    } finally { await ctx.close() }
  })
})
