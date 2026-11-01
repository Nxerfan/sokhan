import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Feature 4 — reviewer-owned real browser qualification.
 * Run ONLY in Full and Lite. Real HTTP customer origin; no fake launcher
 * DOM, no injected CSS, no production test hooks, no arbitrary sleeps.
 * The NPM server serves actual emitted ESM modules at their real filenames.
 */
const BASE = 'http://127.0.0.1:81'
const DASHBOARD = 'http://127.0.0.1:3000'
const DIST = resolve(process.cwd(), 'packages/widget-npm/dist')
let npmBuilt = false
type Animation = 'none' | 'pulse' | 'bounce' | 'shake' | 'glow'
type Surface = 'slug' | 'v1' | 'npm'

async function signup(page: Page, label: string) {
  const stamp = [process.pid, Date.now(), label].join('-')
  const email = 'attn-' + stamp + '@test.com'
  const workspace = 'Attn ' + stamp
  const registered = await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  expect(registered.ok).toBe(true)
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
async function setPlan(page: Page, plan: 'free' | 'pro') {
  const res = await page.request.post(BASE + '/api/invitations/dev/set-plan', {
    data: { plan }, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), await res.text()).toBe(true)
}
async function patch(page: Page, payload: unknown, expected = 200) {
  const res = await page.request.patch(BASE + '/api/widget-config', {
    data: payload, headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(expected)
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
async function openAttention(page: Page) {
  const nav = page.getByRole('navigation', { name: 'primary' })
  await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
  await page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ }).click()
  await expect(page.getByTestId('attention-panel')).toBeVisible({ timeout: 15_000 })
}

async function serve(html: string, npm = false) {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/customer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const name = req.url?.slice(1) ?? ''
    if (npm && /^[A-Za-z0-9_-]+\.js$/.test(name)) {
      const filename = join(DIST, name) // never remap widget.js -> index.js
      if (existsSync(filename)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(readFileSync(filename))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>(resolveStart => server.listen(0, '127.0.0.1', resolveStart))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('No local HTTP address')
  return {
    url: 'http://127.0.0.1:' + addr.port,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}

async function verifyRender(ctx: BrowserContext, slug: string, animation: Animation, surface: Surface, reduced = false) {
  if (surface === 'npm' && !npmBuilt) {
    execSync('bun run build', { cwd: resolve(process.cwd(), 'packages/widget-npm'), stdio: 'pipe' })
    npmBuilt = true
  }
  const html = surface === 'slug'
    ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
    : surface === 'v1'
      ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
      : '<!doctype html><html><body></body></html>'
  const site = await serve(html, surface === 'npm')
  try {
    const page = await ctx.newPage()
    await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
    if (surface === 'npm') {
      await page.evaluate(async (args) => {
        const mod = await import(window.location.origin + '/index.js')
        mod.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
      }, { slug, origin: BASE })
    }
    const launcher = page.locator('.sk-launcher')
    await expect(launcher).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sk-root')).toHaveAttribute('data-sk-attention-animation', animation)
    const css = await launcher.evaluate((el: HTMLElement) => {
      const computed = getComputedStyle(el)
      return { name: computed.animationName, duration: computed.animationDuration }
    })
    const times = css.duration.split(',').map(x => Number.parseFloat(x))
    if (animation === 'none' || reduced) {
      expect(css.name === 'none' || times.every(x => x === 0)).toBe(true)
    } else {
      expect(css.name).toContain('sk-attention-' + animation)
      expect(times.some(x => x > 0)).toBe(true)
    }
    await page.close()
  } finally {
    await site.close()
  }
}

test.describe('Widget V2 Attention Animations — PR #19 only', () => {
  for (const planName of ['free', 'pro'] as const) {
    for (const surface of ['slug', 'v1', 'npm'] as const) {
      test(planName + ': real ' + surface + ' launcher receives correct CSS animation', async ({ browser }) => {
        test.setTimeout(150_000)
        const ctx = await browser.newContext()
        try {
          const page = await ctx.newPage()
          const slug = await signup(page, planName + '-' + surface)
          if (planName === 'pro') await setPlan(page, 'pro')
          const animation = planName === 'free' ? 'pulse' : 'glow'
          await patch(page, { attention: { animation } })
          expect((await publicConfig(page, slug)).attention).toEqual({ animation })
          await verifyRender(ctx, slug, animation, surface)
        } finally {
          await ctx.close()
        }
      })
    }
  }

  test('Pro renders all four real attention animations, not just Glow', async ({ browser }) => {
    test.setTimeout(150_000)
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'four-paid-motions')
      await setPlan(page, 'pro')
      for (const animation of ['pulse', 'bounce', 'shake', 'glow'] as const) {
        await patch(page, { attention: { animation } })
        expect((await publicConfig(page, slug)).attention.animation).toBe(animation)
        await verifyRender(ctx, slug, animation, 'slug')
      }
    } finally {
      await ctx.close()
    }
  })

  test('Free UI enables none/pulse, locks paid choices, enforces PATCH restrictions', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'free-ui')
      await openAttention(page)
      await expect(page.getByTestId('attention-animation-none')).toBeEnabled()
      await expect(page.getByTestId('attention-animation-pulse')).toBeEnabled()
      for (const id of ['bounce', 'shake', 'glow']) {
        await expect(page.getByTestId('attention-animation-' + id)).toBeDisabled()
      }
      await expect(page.getByTestId('attention-discard')).toBeDisabled()
      await patch(page, { attention: { animation: 'glow' } }, 403)
      await patch(page, { attention: { animation: 'pulse' }, avatarUrl: 'https://example.org/a.png' }, 402)
      await page.getByTestId('attention-animation-pulse').click()
      await expect(page.getByTestId('attention-save')).toBeEnabled()
      await page.getByTestId('attention-save').click()
      await expect.poll(async () => (await publicConfig(page, slug)).attention.animation).toBe('pulse')
      await page.reload()
      await openAttention(page)
      await expect(page.getByTestId('attention-animation-pulse')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('attention-discard')).toBeDisabled()
      // Discard must revert an actual unsaved change, not just look disabled.
      await page.getByTestId('attention-animation-none').click()
      await expect(page.getByTestId('attention-discard')).toBeEnabled()
      await page.getByTestId('attention-discard').click()
      await expect(page.getByTestId('attention-animation-pulse')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('attention-discard')).toBeDisabled()
      expect((await publicConfig(page, slug)).attention.animation).toBe('pulse')
    } finally {
      await ctx.close()
    }
  })

  test('Pro paid motion -> Free basic -> Pro restored -> explicit Pro override removes paid preference', async ({ browser }) => {
    test.setTimeout(150_000)
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'paid-restore')
      await setPlan(page, 'pro')
      await patch(page, { attention: { animation: 'glow' } })
      expect((await publicConfig(page, slug)).attention.animation).toBe('glow')
      await setPlan(page, 'free')
      expect((await publicConfig(page, slug)).attention.animation).toBe('none')
      await patch(page, { attention: { animation: 'pulse' } })
      expect((await publicConfig(page, slug)).attention.animation).toBe('pulse')
      const savedFree = await dashboardConfig(page)
      expect(savedFree.attention.stored).toEqual({ animation: 'pulse', paidAnimation: 'glow' })
      await setPlan(page, 'pro')
      expect((await publicConfig(page, slug)).attention.animation).toBe('glow')
      await page.reload()
      await openAttention(page)
      await expect(page.getByTestId('attention-animation-glow')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('attention-discard')).toBeDisabled()
      await page.getByTestId('attention-animation-pulse').click()
      await expect(page.getByTestId('attention-save')).toBeEnabled()
      await page.getByTestId('attention-save').click()
      await expect.poll(async () => (await publicConfig(page, slug)).attention.animation).toBe('pulse')
      const saved = await dashboardConfig(page)
      expect(saved.config.appearanceV2.attention).toEqual({ animation: 'pulse' })
      await page.reload()
      await openAttention(page)
      await expect(page.getByTestId('attention-animation-pulse')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('attention-discard')).toBeDisabled()
    } finally {
      await ctx.close()
    }
  })

  test('editing Attention and other V2 features never erases neighboring settings', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'cross-patch')
      await setPlan(page, 'pro')
      await patch(page, { colors: { mode: 'preset', presetId: 'emerald' } })
      await patch(page, { launcher: { shape: 'pill' } })
      await patch(page, { positioning: { desktop: { anchor: 'bottom-center', offsetX: 20 } } })
      await patch(page, { positioning: { mobile: { anchor: 'bottom-start', offsetY: 10 } } })
      await patch(page, { attention: { animation: 'bounce' } })
      let cfg = await publicConfig(page, slug)
      expect(cfg.attention.animation).toBe('bounce')
      expect(cfg.launcher.shape).toBe('pill')
      expect(cfg.colors.presetId).toBe('emerald')
      expect(cfg.positioning.desktop.offsetX).toBe(20)
      expect(cfg.positioning.mobile.offsetY).toBe(10)
      await patch(page, { colors: { mode: 'preset', presetId: 'sunset' } })
      await patch(page, { launcher: { shape: 'rounded' } })
      await patch(page, { positioning: { mobile: { anchor: 'bottom-center' } } })
      cfg = await publicConfig(page, slug)
      expect(cfg.attention.animation).toBe('bounce')
      expect(cfg.launcher.shape).toBe('rounded')
      expect(cfg.colors.presetId).toBe('sunset')
      expect(cfg.positioning.desktop.offsetX).toBe(20)
      expect(cfg.positioning.mobile.anchor).toBe('bottom-center')
    } finally {
      await ctx.close()
    }
  })


  test('animated launcher remains entirely on-screen at clamped mobile positioning extremes', async ({ browser }) => {
    // Attention keyframes change transform, but V2 Positioning clamps the
    // UNTRANSFORMED launcher to the viewport. Probe the actual animated
    // bounding box at the keyframe extrema, not just CSS class/duration.
    test.setTimeout(180_000)
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 640 },
      reducedMotion: 'no-preference',
    })
    try {
      const owner = await ctx.newPage()
      const slug = await signup(owner, 'attention-boundary')
      await setPlan(owner, 'pro')

      for (const probe of [
        { animation: 'shake' as const, offsetX: 2000, offsetY: -2000, phase: 0.75 },
        { animation: 'bounce' as const, offsetX: 0, offsetY: 2000, phase: 0.5 },
        { animation: 'pulse' as const, offsetX: 2000, offsetY: -2000, phase: 0.5 },
      ]) {
        await patch(owner, { attention: { animation: probe.animation } })
        await patch(owner, {
          positioning: { mobile: {
            anchor: 'bottom-end', offsetX: probe.offsetX, offsetY: probe.offsetY,
          } },
        })
        const effective = await publicConfig(owner, slug)
        expect(effective.attention.animation).toBe(probe.animation)
        expect(effective.positioning.mobile.offsetX).toBe(probe.offsetX)
        expect(effective.positioning.mobile.offsetY).toBe(probe.offsetY)

        for (const surface of ['slug', 'v1', 'npm'] as const) {
          if (surface === 'npm' && !npmBuilt) {
            execSync('bun run build', {
              cwd: resolve(process.cwd(), 'packages/widget-npm'), stdio: 'pipe',
            })
            npmBuilt = true
          }
          const html = surface === 'slug'
            ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/' + slug + '/script"></script></body></html>'
            : surface === 'v1'
              ? '<!doctype html><html><body><script async defer src="' + BASE + '/api/widget/v1/sukhan.js" data-api-key="' + slug + '"></script></body></html>'
              : '<!doctype html><html><body></body></html>'
          const site = await serve(html, surface === 'npm')
          const page = await ctx.newPage()
          try {
            await page.goto(site.url + '/customer.html', { waitUntil: 'domcontentloaded' })
            if (surface === 'npm') {
              await page.evaluate(async (args) => {
                const pkg = await import(window.location.origin + '/index.js')
                pkg.initSukhan({ apiKey: args.slug, apiUrl: args.origin })
              }, { slug, origin: BASE })
            }
            const launcher = page.locator('.sk-launcher')
            await expect(launcher).toBeVisible({ timeout: 15_000 })
            await expect(page.locator('.sk-root')).toHaveAttribute(
              'data-sk-attention-animation', probe.animation,
            )
            const actual = await launcher.evaluate((node, args) => {
              const cssAnimation = node.getAnimations().find(a =>
                (a as CSSAnimation).animationName === 'sk-attention-' + args.animation
              )
              if (!cssAnimation) throw new Error('Expected real CSS attention animation')
              const duration = cssAnimation.effect?.getComputedTiming().duration
              if (typeof duration !== 'number' || duration <= 0) {
                throw new Error('Missing positive CSS animation duration')
              }
              cssAnimation.pause()
              cssAnimation.currentTime = duration * args.phase
              const r = node.getBoundingClientRect()
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                width: innerWidth, height: innerHeight }
            }, { animation: probe.animation, phase: probe.phase })

            // Geometric containment must hold throughout the configured
            // attention motion, including at the sampled maximum displacement.
            expect(actual.left, surface + '/' + probe.animation + ' overflows left').toBeGreaterThanOrEqual(-0.5)
            expect(actual.top, surface + '/' + probe.animation + ' overflows top').toBeGreaterThanOrEqual(-0.5)
            expect(actual.right, surface + '/' + probe.animation + ' overflows right').toBeLessThanOrEqual(actual.width + 0.5)
            expect(actual.bottom, surface + '/' + probe.animation + ' overflows bottom').toBeLessThanOrEqual(actual.height + 0.5)
          } finally {
            await page.close()
            await site.close()
          }
        }
      }
    } finally {
      await ctx.close()
    }
  })


  test('Glow preview uses the authorized effective V2 accent, not hardcoded gold', async ({ browser }) => {
    test.setTimeout(120_000)
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'glow-effective-accent')
      await setPlan(page, 'pro')
      // Emerald has accent #10B981 rather than the Sukhan gold #E09A2B.
      // Choose it through the real API to prove the dashboard's Glow
      // derives from effective V2 Colors instead of a hardcoded preview.
      await patch(page, { colors: { mode: 'preset', presetId: 'emerald' } })
      await patch(page, { attention: { animation: 'glow' } })
      const config = await publicConfig(page, slug)
      expect(config.colors.tokens.accent).toBe('#10B981')
      expect(config.accentColor).toBe('#10B981')
      expect(config.attention).toEqual({ animation: 'glow' })

      await page.reload()
      await openAttention(page)
      const preview = page.getByTestId('attention-preview-button')
      await expect(preview).toHaveClass(/sk-attention-glow/)
      const shadow = await preview.evaluate((button) => {
        // Probe an actual running CSS animation at its 50% keyframe;
        // no fake styles or manually inserted preview DOM.
        const animation = button.getAnimations().find(a =>
          (a as CSSAnimation).animationName === 'sk-attention-glow'
        )
        if (!animation) throw new Error('Glow preview CSS animation missing')
        const duration = animation.effect?.getComputedTiming().duration
        if (typeof duration !== 'number' || duration <= 0) {
          throw new Error('Invalid Glow preview CSS duration')
        }
        animation.pause()
        animation.currentTime = duration / 2
        return getComputedStyle(button).boxShadow
      })
      expect(shadow).toMatch(/rgba?\(16,\s*185,\s*129(?:,|\s*\/)/)
      expect(shadow).not.toMatch(/rgba?\(224,\s*154,\s*43(?:,|\s*\/)/)
    } finally {
      await ctx.close()
    }
  })

  test('Reduce Motion disables paid animation on real slug and NPM renderers', async ({ browser }) => {
    const ownerCtx = await browser.newContext()
    try {
      const page = await ownerCtx.newPage()
      const slug = await signup(page, 'reduced')
      await setPlan(page, 'pro')
      await patch(page, { attention: { animation: 'shake' } })
      expect((await publicConfig(page, slug)).attention.animation).toBe('shake')
      const reduceCtx = await browser.newContext({ reducedMotion: 'reduce' })
      try {
        await verifyRender(reduceCtx, slug, 'shake', 'slug', true)
        await verifyRender(reduceCtx, slug, 'shake', 'npm', true)
      } finally {
        await reduceCtx.close()
      }
    } finally {
      await ownerCtx.close()
    }
  })

  test('downgraded Free never renders previously paid animation on external site', async ({ browser }) => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      const slug = await signup(page, 'downgrade')
      await setPlan(page, 'pro')
      await patch(page, { attention: { animation: 'bounce' } })
      await setPlan(page, 'free')
      expect((await publicConfig(page, slug)).attention).toEqual({ animation: 'none' })
      await verifyRender(ctx, slug, 'none', 'slug')
      await verifyRender(ctx, slug, 'none', 'npm')
    } finally {
      await ctx.close()
    }
  })
})
