import type { Page } from '@playwright/test'

/**
 * Explicitly set the tenant's visitor access mode via the real
 * PATCH /api/widget-config/access API.
 *
 * A genuine fresh OTP signup now defaults to accessMode='verified_visitor'
 * (the DB default — the frozen contract). Tests whose scenario requires a
 * DIFFERENT mode (e.g. the historical anonymous widget-chat flow) MUST
 * explicitly configure it via this helper rather than relying on the
 * signup default. Tests that need the verified_visitor default do NOT call
 * this — they use the real fresh-signup state.
 *
 * The page must be authenticated (post-signup) before calling.
 */
export async function setAccessMode(page: Page, mode: 'anonymous' | 'verified_visitor' | 'site_user_only', extra?: Record<string, unknown>): Promise<void> {
  const res = await page.request.patch('http://127.0.0.1:3000/api/widget-config/access', {
    data: { accessMode: mode, ...extra },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) {
    throw new Error(`setAccessMode(${mode}) failed: ${res.status()} ${await res.text().catch(() => '')}`)
  }
}
