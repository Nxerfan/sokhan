import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * PR #18 ONLY. Launcher Styles real Full/Lite browser qualifications.
 * No legacy Positioning/Colors suites and no test-created style/DOM bubbles.
 * Actual launcher DOM and CSS come from the runtime for each delivery surface.
 * Browser failures are never swallowed; retries must remain zero in CI.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
let npmBuilt = false
function credentials(label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  return { email: 'launch-' + stamp + '@test.com', workspace: 'Launch ' + stamp }
}
async function signup(page: Page, label: string) {
  const { email, workspace } = credentials(label)
  const out = await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  expect(out.ok).toBe(true)
  const csrf = await page.request.get(DASHBOARD + '/api/auth/csrf')
  expect(csrf.ok()).toBe(true)
  const { csrfToken } = await csrf.json()
  const signIn = await page.request.post(DASHBOARD + '/api/auth/callback/credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'email=' + email + '&password=password123&csrfToken=' + csrfToken + '&json=true',
  })
  expect(signIn.status()).toBeLessThan(500)
  await page.goto(BASE)
  const tenant = await page.request.get(DASHBOARD + '/api/tenants/me')
  expect(tenant.ok()).toBe(true)
  const slug = (await tenant.json()).tenant?.slug as string | undefined
  expect(slug).toBeTruthy()
  return slug!
}
async function plan(page: Page, value: 'free' | 'pro') {
  const response = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan: value }, headers: { 'Content-Type': 'application/json' },
  })
  expect(response.ok(), 'set-plan should succeed').toBe(true)
}
async function patch(page: Page, body: unknown, expected = 200) {
  const response = await page.request.patch(BASE + '/api/widget-config', {
    data: body, headers: { 'Content-Type': 'application/json' },
  })
  expect(response.status(), await response.text()).toBe(expected)
  return response
}
async function publicConfig(page: Page, slug: string) {
  const res = await page.request.get(BASE + '/api/widget/' + slug + '/config')
  expect(res.ok()).toBe(true)
  return res.json()
}
async function dashboardConfig(page: Page) {
  const res = await page.request.get(DASHBOARD + '/api/widget-config')
  expect(res.ok()).toBe(true)
  return res.json()
}
async function openLauncherPanel(page: Page) {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
  await expect(page.getByTestId('launcher-panel')).toBeVisible({ timeout: 15_000 })
}
async function site(html: string, bundle = false): Promise<{ url: string, close: () => Promise<void> }> {
  const base = join(resolve(process.cwd(), 'packages/widget-npm'), 'dist')
  const server: Server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/customer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const filename = req.url?.slice(1) ?? ''
    if (bundle && /^[a-zA-Z0-9_-]+\.js$/.test(filename)) {
      const file = join(base, filename === 'widget.js' ? 'index.js' : filename)
      if (existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(readFileSync(file))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local HTTP address')
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}
type Shape = 'tab' | 'rounded' | 'pill'
type Surface = 'slug' | 'v1' | 'npm'
async function renderedShape(context: import('@playwright/test').BrowserContext, slug: string, shape: Shape, surface: Surface) {
  if (surface === 'npm' && !npmBuilt) {
    execSync('bun run build', { cwd: resolve(process.cwd(), 'packages/widget-npm'), stdio: 'pipe' })
    npmBuilt = true
  }
  const html = surface === 'slug'
    ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
    : surface === 'v1'
      ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
      : '<!doctype html><html><body></body></html>'
  const server = await site(html, surface === 'npm')
  try {
    const page = await context.newPage()
    await page.goto(server.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async (args) => {
        const mod = await import(window.location.origin + '/widget.js')
        mod.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    const launcher = page.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 15_000 })
    await expect(launcher).toHaveClass(new RegExp('sk-' + shape + '(\\s|$)'))
    const result = await launcher.evaluate((el: HTMLElement) => {
      const cs = getComputedStyle(el)
      return {
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
        radius: cs.borderTopLeftRadius,
      }
    })
    const expected = {
      tab: { width: 60, height: 52, radius: '14px' },
      rounded: { width: 52, height: 52, radius: '16px' },
      pill: { width: 64, height: 48, radius: '999px' },
    }[shape]
    expect(result).toEqual(expected)
    await page.close()
  } finally {
    await server.close()
  }
}

test.describe('Widget V2 Launcher Styles — PR #18 only', () => {
  for (const planSlug of ['free', 'pro'] as const) {
    for (const surface of ['slug', 'v1', 'npm'] as const) {
      test(planSlug.toUpperCase() + ': real ' + surface + ' launcher computed dimensions match effective V2 shape', async ({ browser }) => {
        test.setTimeout(150_000)
        const context = await browser.newContext()
        try {
          const page = await context.newPage()
          const slug = await signup(page, planSlug + '-' + surface)
          if (planSlug === 'pro') await plan(page, 'pro')
          const shape = planSlug === 'free' ? 'rounded' : 'pill'
          await patch(page, { launcher: { shape } })
          const config = await publicConfig(page, slug)
          expect(config.launcher).toEqual({ shape })
          expect(config.launcherShape).toBe(shape)
          await renderedShape(context, slug, shape, surface)
        } finally {
          await context.close()
        }
      })
    }
  }

  test('Free controls enforce tab/rounded, reject pill PATCH, and persist rounded', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'free-dashboard')
      await openLauncherPanel(page)
      await expect(page.getByTestId('launcher-shape-tab')).toBeEnabled()
      await expect(page.getByTestId('launcher-shape-rounded')).toBeEnabled()
      await expect(page.getByTestId('launcher-shape-pill')).toBeDisabled()
      await expect(page.getByTestId('launcher-discard')).toBeDisabled()
      await patch(page, { launcher: { shape: 'pill' } }, 403)
      await patch(page, { launcher: { shape: 'rounded' }, avatarUrl: 'https://example.org/icon.png' }, 402)
      await page.getByTestId('launcher-shape-rounded').click()
      await expect(page.getByTestId('launcher-save')).toBeEnabled()
      await page.getByTestId('launcher-save').click()
      await expect.poll(async () => (await publicConfig(page, slug)).launcher.shape).toBe('rounded')
      await page.reload()
      await openLauncherPanel(page)
      await expect(page.getByTestId('launcher-shape-rounded')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('launcher-discard')).toBeDisabled()
    } finally {
      await ctx.close()
    }
  })

  test('Pro pill -> Free safe default -> Free rounded -> Pro paid shape restored', async ({ browser }) => {
    test.setTimeout(170_000)
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'paid-restore')
      await plan(page, 'pro')
      await patch(page, { launcher: { shape: 'pill' } })
      expect((await publicConfig(page, slug)).launcher.shape).toBe('pill')
      await plan(page, 'free')
      expect((await publicConfig(page, slug)).launcher.shape).toBe('tab')
      const before = await dashboardConfig(page)
      expect(before.launcher.entitlements.launcherSelection).toBe('limited')
      await patch(page, { launcher: { shape: 'rounded' } })
      expect((await publicConfig(page, slug)).launcher.shape).toBe('rounded')
      await plan(page, 'pro')
      expect((await publicConfig(page, slug)).launcher.shape).toBe('pill')
      await page.reload()
      await openLauncherPanel(page)
      await expect(page.getByTestId('launcher-shape-pill')).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await ctx.close()
    }
  })

  test('launcher/color/position independent updates preserve each other in real public config', async ({ browser }) => {
    test.setTimeout(140_000)
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'true-patch')
      await plan(page, 'pro')
      await patch(page, { colors: { mode: 'preset', presetId: 'emerald' } })
      await patch(page, { positioning: { desktop: { anchor: 'bottom-center', offsetX: 25, offsetY: 12 } } })
      await patch(page, { launcher: { shape: 'pill' } })
      let config = await publicConfig(page, slug)
      expect(config.launcher.shape).toBe('pill')
      expect(config.colors.presetId).toBe('emerald')
      expect(config.positioning.desktop.anchor).toBe('bottom-center')
      expect(config.positioning.desktop.offsetX).toBe(25)
      await patch(page, { colors: { mode: 'preset', presetId: 'sunset' } })
      config = await publicConfig(page, slug)
      expect(config.launcher.shape).toBe('pill')
      expect(config.colors.presetId).toBe('sunset')
      await patch(page, { positioning: { mobile: { anchor: 'bottom-start' } } })
      config = await publicConfig(page, slug)
      expect(config.launcher.shape).toBe('pill')
      expect(config.colors.presetId).toBe('sunset')
    } finally {
      await ctx.close()
    }
  })

  test('pre-V2 Free legacy rounded preview matches public config without V2 selection', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'v1-legacy')
      await plan(page, 'pro')
      await patch(page, { launcherShape: 'rounded' })
      await plan(page, 'free')
      const config = await publicConfig(page, slug)
      expect(config.launcherShape).toBe('rounded')
      await page.reload()
      await openLauncherPanel(page)
      await expect(page.getByTestId('launcher-shape-rounded')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('launcher-discard')).toBeDisabled()
    } finally {
      await ctx.close()
    }
  })
})
