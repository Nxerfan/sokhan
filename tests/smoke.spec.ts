import { test, expect, type Page } from '@playwright/test'

/**
 * Smoke test — golden path that should have caught the signup-hang bug.
 *
 * Uses REAL Playwright clicks (trusted mouse events), NOT eval-based DOM
 * manipulation. This is the gap that masked the signup-hang bug in the prior
 * Agent Browser verification: agent-browser's synthetic clicks and eval-based
 * .click() calls do not exercise the same event-dispatch path as a real user
 * click, so a handler that "works in tests" can still hang for a real user.
 *
 * Coverage:
 *   1. Signup (real click) → dashboard renders with workspace name
 *   2. Nav rail click (real click) → view switches, department CRUD works
 *   3. Widget config: change accent color → save → verify persisted after reload
 *
 * Each test gets unique credentials (email/workspace) via a per-test stamp,
 * so they don't collide on the "email_taken" constraint.
 *
 * Nav rail buttons are icon-only with aria-label (no visible text), so we use
 * getByRole('button', { name: ... }) which matches the accessible name.
 */

// Use port 81 (Caddy gateway) for consistency — Socket.IO needs Caddy for XTransformPort
const BASE = 'http://localhost:81'

/** Unique credentials per test invocation. */
function creds(testTitle: string) {
  const stamp = `${process.pid}-${Date.now()}-${testTitle.replace(/\s/g, '')}`
  return {
    email: `smoke-${stamp}@test.com`,
    workspace: `Smoke ${stamp}`,
  }
}

async function signupAndLandOnDashboard(page: Page, email: string, workspace: string) {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')

  await page.getByLabel(/نام شما|Your name/).fill('Smoke Tester')
  await page.getByLabel(/ایمیل|Email/).fill(email)
  await page.getByLabel(/رمز عبور|Password/).fill('password123')
  await page.getByLabel(/نام فضای کاری|Workspace name/).fill(workspace)

  // Real click on the submit button (Playwright dispatches a trusted mouse event).
  await page.getByRole('button', { name: /ایجاد فضای کاری|Create workspace/ }).click()

  // The fix uses window.location.href = '/' which does a full page navigation.
  await page.waitForURL(BASE + '/', { timeout: 15000 })

  // Dashboard renders — workspace name appears in the top bar h2.
  // Wait for the tenant fetch to complete (starts as '—', updates to name).
  await expect(page.getByRole('heading', { name: workspace })).toBeVisible({ timeout: 15000 })
}

test.describe('Golden path smoke test', () => {
  test('1. signup → dashboard renders', async ({ page }) => {
    const { email, workspace } = creds('test1')
    await signupAndLandOnDashboard(page, email, workspace)
    await expect(page.getByRole('navigation', { name: 'primary' })).toBeVisible()
  })

  test('2. nav rail click switches view + department CRUD', async ({ page }) => {
    const { email, workspace } = creds('test2')
    await signupAndLandOnDashboard(page, email, workspace)

    // Click the "Departments" nav button with a real mouse click.
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /دپارتمان|Departments/ }).click()

    // Departments panel renders — department name input appears.
    await expect(page.getByPlaceholder(/نام دپارتمان|Department name/)).toBeVisible({ timeout: 5000 })

    // Add a department with real input + real click.
    await page.getByPlaceholder(/نام دپارتمان|Department name/).fill('Sales')
    await page.getByRole('button', { name: /^ایجاد$|^Create$/ }).click()

    // Verify it appears in the list.
    await expect(page.getByText('Sales')).toBeVisible({ timeout: 5000 })
  })

  test('3. widget config save persists', async ({ page }) => {
    const { email, workspace } = creds('test3')
    await signupAndLandOnDashboard(page, email, workspace)

    // Navigate to the Widget settings panel via real nav click.
    const nav = page.getByRole('navigation', { name: 'primary' })
    await nav.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()

    // Widget panel renders — accent color input (type=color) appears.
    const colorInput = page.locator('input[type=color]')
    await expect(colorInput).toBeVisible({ timeout: 5000 })

    // Change the accent color to turquoise.
    await colorInput.fill('#1f8f8f')

    // Click Save (real click).
    await page.getByRole('button', { name: /^ذخیره$|^Save$/ }).click()

    // Wait for the "Saved" toast.
    await expect(page.getByText(/ذخیره شد|Saved/)).toBeVisible({ timeout: 5000 })

    // Reload to verify persistence.
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Navigate back to widget panel and verify accent persisted.
    const nav2 = page.getByRole('navigation', { name: 'primary' })
    await nav2.getByRole('button', { name: /^ویجت$|^Widget$/ }).click()
    await expect(page.locator('input[type=color]')).toHaveValue(/#1f8f8f/i, { timeout: 5000 })
  })
})
