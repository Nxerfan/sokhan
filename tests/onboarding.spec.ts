import { test, expect, type Page } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Widget Installation & Onboarding UX — behavioral browser regression.
 *
 * This test exercises the REAL authenticated dashboard UI (not just
 * static source-string assertions). It covers the onboarding scenarios
 * required by PR #7:
 *
 *   1.  Navigate to Widget.
 *   2.  Installation tab is visible by default.
 *   3.  Customization tab can be switched to and back.
 *   4.  Widget Key displayed in the UI corresponds to the authenticated
 *       tenant slug.
 *   5.  Generated HTML snippet contains the correct Sukhan origin +
 *       tenant slug.
 *   6.  NPM instructions render with the real tenant identifier.
 *   7.  Add an allowed domain through the UI.
 *   8.  Invalid domain shows a user-visible failure.
 *   9.  Existing website/domain plan limit behavior remains enforced
 *       (free plan = 1 domain; the 2nd add must fail).
 *   10. Delete an allowed domain through the UI where permitted.
 *   11. Backend-check behavior is exercised in the browser (the
 *       authenticated /api/widget-status endpoint returns "ready" and
 *       the UI shows the truthful "Backend ready" label — NOT
 *       "Verified"/"Verify Installation").
 *   12. Stale Module-2 wording is not displayed in the relevant UI.
 *
 * The test is part of BOTH the Full and Lite Docker regression suites.
 */

const BASE = 'http://127.0.0.1:81'        // Sukhan origin via gateway
const DASHBOARD = 'http://127.0.0.1:3000'  // Next.js direct — signup API

function creds(label: string) {
  const stamp = `${process.pid}-${Date.now()}-${label}`
  return {
    email: `onb-${stamp}@test.com`,
    workspace: `Onb ${stamp}`,
  }
}

async function signupAndGetSlug(page: Page, email: string, workspace: string): Promise<string> {
  await otpSignupPlaywright(page.request, DASHBOARD, email, workspace)
  const csrfRes = await page.request.get(`${DASHBOARD}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${DASHBOARD}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })
  // Navigate to the dashboard via the gateway so window.location.origin
  // is the Sukhan origin the HTML snippet will reference.
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
  const tenantRes = await page.request.get(`${DASHBOARD}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  expect(slug, `slug should be set (tenant data: ${JSON.stringify(tenantData)})`).toBeTruthy()
  return slug as string
}

test.describe('Widget Installation & Onboarding UX', () => {
  test('authenticated dashboard UI: tabs, Widget Key, snippets, domain CRUD, plan limit, backend check, no Module-2 wording', async ({ browser }) => {
    const { email, workspace } = creds('main')
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const slug = await signupAndGetSlug(page, email, workspace)

    // 1. Navigate to the Widget panel via the primary nav.
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()

    // 2. Installation tab is visible by default. The tab switcher is a
    //    row of two buttons; the active one has the "bg-background"
    //    class. The Installation card content (Widget Key) must be
    //    visible without any tab click.
    const installationTab = page.getByRole('button', { name: /^نصب$|^Installation$/ })
    const customizationTab = page.getByRole('button', { name: /^سفارشی‌سازی$|^Customization$/ })
    await expect(installationTab).toBeVisible({ timeout: 10_000 })
    await expect(customizationTab).toBeVisible({ timeout: 10_000 })

    // The Widget Key card is on the Installation tab — its presence
    // proves the Installation tab is the default view.
    const widgetKeyCard = page.getByText(/Widget Key|کلید ویجت/).first()
    await expect(widgetKeyCard).toBeVisible({ timeout: 10_000 })

    // 3. Switch to Customization tab and back. The accent-color input
    //    lives on the Customization tab; switching to it must reveal
    //    that input. Switching back to Installation must reveal the
    //    Widget Key card again.
    await customizationTab.click()
    await expect(page.locator('input[type=color]').first()).toBeVisible({ timeout: 10_000 })
    await installationTab.click()
    await expect(widgetKeyCard).toBeVisible({ timeout: 10_000 })

    // 4. Widget Key displayed in the UI corresponds to the
    //    authenticated tenant slug. The slug is rendered inside a
    //    <code> element with dir="ltr".
    const widgetKeyCode = page.locator('code.font-mono').filter({ hasText: slug }).first()
    await expect(widgetKeyCode).toBeVisible({ timeout: 10_000 })

    // 5. Generated HTML snippet contains the correct Sukhan origin +
    //    tenant slug. The snippet is the only <pre> element containing
    //    both the Sukhan origin and the slug + /script path.
    const htmlSnippetPre = page.locator('pre').filter({ hasText: `/api/widget/${slug}/script` }).first()
    await expect(htmlSnippetPre).toBeVisible({ timeout: 10_000 })
    // The snippet must reference the Sukhan origin (the page's own
    // origin via window.location.origin). BASE is the page origin.
    const snippetText = (await htmlSnippetPre.textContent()) ?? ''
    expect(
      snippetText,
      `HTML snippet must reference the Sukhan origin (${BASE}) and the tenant slug (${slug}); got: ${snippetText}`,
    ).toContain(BASE)
    expect(
      snippetText,
      `HTML snippet must contain the tenant slug; got: ${snippetText}`,
    ).toContain(slug)
    expect(
      snippetText,
      `HTML snippet must be a <script> tag pointing at /api/widget/<slug>/script; got: ${snippetText}`,
    ).toMatch(/<script\s+async\s+defer\s+src=.*\/api\/widget\/[^/]+\/script/)

    // 6. NPM instructions render with the real tenant identifier. The
    //    install command (`bun add sukhan-widget`) is in its own <pre>;
    //    the init snippet (with the apiKey) is in another <pre>.
    const npmInstallPre = page.locator('pre').filter({ hasText: 'bun add sukhan-widget' }).first()
    await expect(npmInstallPre).toBeVisible({ timeout: 10_000 })
    const npmInstallText = (await npmInstallPre.textContent()) ?? ''
    expect(
      npmInstallText,
      `NPM install snippet must contain the sukhan-widget package; got: ${npmInstallText}`,
    ).toContain('bun add sukhan-widget')

    const npmInitPre = page.locator('pre').filter({ hasText: 'initSukhan' }).first()
    await expect(npmInitPre).toBeVisible({ timeout: 10_000 })
    const npmInitText = (await npmInitPre.textContent()) ?? ''
    expect(
      npmInitText,
      `NPM init snippet must reference the tenant slug as apiKey; got: ${npmInitText}`,
    ).toContain(`apiKey: '${slug}'`)

    // 7. Add an allowed domain through the UI. Use a unique, clearly
    //    valid hostname so the strict domain validator accepts it.
    const uniqueDomain = `onb-${Date.now()}.example.com`
    const domainInput = page.getByPlaceholder('example.com')
    await expect(domainInput).toBeVisible({ timeout: 10_000 })
    await domainInput.fill(uniqueDomain)
    await page.getByRole('button', { name: /^افزودن$|^Add$/ }).click()
    // The domain must appear in the list.
    await expect(
      page.locator('span.font-medium').filter({ hasText: uniqueDomain }).first(),
      `added domain ${uniqueDomain} must appear in the authorized-domains list`,
    ).toBeVisible({ timeout: 10_000 })

    // 8. Invalid domain shows a user-visible failure. The strict
    //    domain validator rejects strings with paths, schemes, control
    //    chars, etc. A path-bearing string like "bad.example.com/path"
    //    must be rejected and the user must see a visible error.
    await domainInput.fill('bad.example.com/path')
    await page.getByRole('button', { name: /^افزودن$|^Add$/ }).click()
    // The error toast must be visible (English or Persian).
    await expect(
      page.getByText(/Invalid domain|دامنه نامعتبر است/).first(),
      `invalid domain must produce a user-visible error toast`,
    ).toBeVisible({ timeout: 10_000 })

    // 9. Existing website/domain plan limit behavior remains enforced.
    //    The signup plan is Free (limit = 1 domain). The first add
    //    succeeded above; attempting to add a SECOND distinct domain
    //    must fail with the limit_reached error toast.
    const secondDomain = `onb-second-${Date.now()}.example.com`
    await domainInput.fill(secondDomain)
    await page.getByRole('button', { name: /^افزودن$|^Add$/ }).click()
    await expect(
      page.getByText(/Domain limit reached|حداکثر دامنه‌های مجاز استفاده شده/).first(),
      `second domain on Free plan must hit the plan limit`,
    ).toBeVisible({ timeout: 10_000 })
    // The second domain must NOT have been added to the list.
    await expect(
      page.locator('span.font-medium').filter({ hasText: secondDomain }),
      `second domain must not be added past the plan limit`,
    ).toHaveCount(0)

    // 10. Delete an allowed domain through the UI where permitted.
    //     The trash button next to the previously-added domain removes
    //     it. The list must no longer contain it.
    const domainRow = page.locator('li').filter({ hasText: uniqueDomain }).first()
    await domainRow.locator('button').last().click()
    await expect(
      page.getByText(/Deleted|حذف شد/).first(),
      `delete must produce a user-visible confirmation toast`,
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.locator('span.font-medium').filter({ hasText: uniqueDomain }),
      `deleted domain must be removed from the list`,
    ).toHaveCount(0)

    // 11. Verification / backend-check behavior is exercised in the
    //     browser. Click the "Check Widget Backend" button (NOT
    //     "Verify Installation"). The authenticated internal
    //     /api/widget-status endpoint must return ready=true, and the
    //     UI must display the truthful "Backend ready" label (NOT
    //     "Verified").
    const checkBackendButton = page.getByRole('button', { name: /^بررسی بک‌اند$|^Check backend$/ }).first()
    await expect(checkBackendButton).toBeVisible({ timeout: 10_000 })
    await checkBackendButton.click()
    // The button label transitions to "Backend ready" (English) or
    // "بک‌اند آماده" (Persian) on success.
    await expect(
      page.getByRole('button', { name: /^بک‌اند آماده$|^Backend ready$/ }).first(),
      `Check Widget Backend must succeed and show the truthful "Backend ready" label`,
    ).toBeVisible({ timeout: 10_000 })
    // The truthful explanation copy must be displayed — explicitly
    // stating that this check does NOT prove the script is installed
    // on the customer website.
    await expect(
      page.getByText(/does NOT prove the script is installed|وجود اسکریپت در سایت مشتری را اثبات نمی‌کند/).first(),
      `the UI must explicitly explain the backend-check limitation`,
    ).toBeVisible({ timeout: 10_000 })

    // 12. Stale Module-2 wording is not displayed in the relevant UI.
    //     The widget panel must not contain any "Module 2" / "ماژول 2"
    //     text. (fa-IR locale is the default per playwright.config.ts.)
    const widgetPanelText = await page.locator('main').first().textContent()
    expect(
      widgetPanelText,
      `widget panel must not contain stale Module-2 wording`,
    ).not.toMatch(/Module\s*2|ماژول\s*2/)

    await ctx.close()
  })
})
