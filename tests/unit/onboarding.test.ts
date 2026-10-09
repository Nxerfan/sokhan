/// <reference types="bun-types" />
/**
 * Widget installation + onboarding UX regression tests.
 *
 * These are STATIC invariant tests — supplementary to the behavioral
 * Playwright browser coverage in tests/onboarding.spec.ts. They verify
 * source-level invariants that are awkward to assert from a browser
 * (e.g. "no Module-2 wording in i18n"). The behavioral coverage in
 * tests/onboarding.spec.ts verifies the real authenticated dashboard UI.
 *
 * Verifies:
 *   - Widget panel renders with Installation + Customization tabs
 *   - Public widget identifier (Widget Key) is shown, not a secret API key
 *   - HTML snippet points to the Sukhan backend, not the customer page origin
 *   - NPM instructions match the actual package API
 *   - Stale Module 2 text is removed from i18n
 *   - Integrations is labeled "coming soon" (not Module 2)
 *   - No secret values in installation snippets
 *   - Truthful labels: "Installation code copied" (NOT "Install widget"),
 *     "Backend ready" (NOT "Verify widget"/"Verified"), and the
 *     authenticated /api/widget-status endpoint (NOT the public
 *     WidgetDomain-validated /api/widget/<slug>/config).
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import json_fa from '../../src/messages/fa.json'
import json_en from '../../src/messages/en.json'

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf-8')
}

test('widget-panel.tsx has Installation + Customization tabs', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain("'installation'")
  expect(src).toContain("'customization'")
  expect(src).toContain('Installation')
  expect(src).toContain('Customization')
  // Installation is the default tab.
  expect(src).toMatch(/useState<'installation' \| 'customization'>\('installation'\)/)
})

test('widget-panel.tsx shows Widget Key (not secret API key)', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('Widget Key')
  expect(src).toContain('public')
  expect(src).toContain('Does NOT grant dashboard access')
  // Must NOT present it as a secret
  expect(src).not.toMatch(/secret.*key/i)
})

test('widget-panel.tsx HTML snippet points to the Sukhan backend origin', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  // The snippet must use the Sukhan origin, not the customer page origin
  expect(src).toContain('apiUrl')
  expect(src).toContain('/api/widget/')
  expect(src).toContain('/script')
  // Must NOT hardcode a customer origin
  expect(src).not.toContain('your-domain')
})

test('widget-panel.tsx NPM instructions match the actual package API', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('bun add sukhan-widget')
  expect(src).toContain('initSukhan')
  expect(src).toContain('apiKey')
  // For self-hosted, apiUrl is documented
  expect(src).toContain('apiUrl')
})

test('widget-panel.tsx includes domain management in the installation flow', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('Authorized Domains')
  expect(src).toContain('addDomain')
  expect(src).toContain('deleteDomain')
  // Domain limit enforcement
  expect(src).toContain('domainLimit')
})

test('widget-panel.tsx uses the authenticated internal /api/widget-status endpoint (NOT the public WidgetDomain-validated widget config)', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  // The dashboard calls the authenticated internal endpoint
  expect(src).toContain('/api/widget-status')
  // The internal check function is named to reflect its truthful purpose
  expect(src).toContain('checkWidgetBackend')
  // The UI label is "Check Widget Backend" / "Backend ready" — NOT
  // "Verify Installation" or "Verified" (which would imply the script
  // is installed on the customer website, which the check cannot prove).
  expect(src).toMatch(/Check Widget Backend|بررسی بک‌اند ویجت/)
  expect(src).toMatch(/Backend ready|بک‌اند آماده/)
  // Must NOT display the misleading "Verify Installation" label
  expect(src).not.toContain('Verify Installation')
  expect(src).not.toMatch(/'تایید نصب'/)
  // Must NOT call the public widget-config endpoint from the dashboard
  // (that endpoint performs WidgetDomain validation against the request
  // Origin/Referer — a Sukhan-dashboard-origin request would be
  // incorrectly rejected as `domain_not_allowed`).
  expect(src).not.toMatch(/fetch\(['"`]\/api\/widget\/\$\{slug\}\/config['"`]/)
  // Must NOT make an actual fetch() call to a customer URL (no SSRF).
  // The pattern requires `fetch(...)` with a customer/website URL inside
  // the call — comments mentioning "fetch customer URLs" do NOT match.
  expect(src).not.toMatch(/fetch\([^)]*customer/i)
  expect(src).not.toMatch(/fetch\([^)]*website.*url/i)
})

test('widget-panel.tsx has the new /api/widget-status route', () => {
  const src = readSrc('src/app/api/widget-status/route.ts')
  // Authenticated (NOT public — no WidgetDomain validation)
  expect(src).toContain('withSessionTenant')
  // Does NOT consult WidgetDomain at all
  expect(src).not.toContain('isDomainAllowed')
  expect(src).not.toContain('getRequestDomain')
  // Does NOT fetch arbitrary customer URLs (no SSRF)
  expect(src).not.toMatch(/fetch\(.*customer/i)
  // Returns the same realtime config the public endpoint returns
  expect(src).toContain('resolveRealtimeConfig')
  // Reports readiness based on the tenant's own WidgetConfig row
  expect(src).toContain('db.widgetConfig.findUnique')
  // Reads the tenant's slug internally — does NOT accept a user-supplied slug
  expect(src).toContain('db.tenant.findUnique')
})

test('widget-panel.tsx checklist labels are truthful (NOT "Install widget" / "Verify widget")', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('checklistItems')
  expect(src).toContain('Workspace created')
  // TRUTHFUL: "Installation code copied" reflects the actual user action
  // (clicking Copy on the HTML/NPM snippet) — NOT that the widget was
  // installed on a customer website.
  expect(src).toMatch(/Installation code copied|کد نصب کپی شد/)
  // Must NOT display the misleading "Install widget" label
  expect(src).not.toContain("'Install widget'")
  // TRUTHFUL: "Backend ready" reflects that the authenticated internal
  // Sukhan-side readiness check succeeded — NOT that installation was
  // verified on the customer site.
  expect(src).toMatch(/Backend ready|بک‌اند ویجت آماده است/)
  // Must NOT display the misleading "Verify widget" label
  expect(src).not.toContain("'Verify widget'")
  // Must NOT use the localStorage "installed" key (which lied about
  // installation based on a Copy click)
  expect(src).not.toContain('sukhan_widget_installed_')
  // Must NOT use the localStorage "verified" key (which lied about
  // installation verification based on a backend-reachability check)
  expect(src).not.toContain('sukhan_widget_verified_')
  // The code-copied state IS tracked truthfully under a different key
  expect(src).toContain('sukhan_widget_code_copied_')
})

test('widget-panel.tsx derives "Reply from Inbox" from Conversation.firstResponseAt (NOT lastMessagePreview)', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  // Truthful derivation: an agent has actually replied only when
  // Conversation.firstResponseAt is non-null (set once on the first
  // agent message POST). NOT inferred from lastMessagePreview, which a
  // visitor message also populates.
  expect(src).toContain('firstResponseAt')
  expect(src).toMatch(/convs\.some\(\(c\) => c\.firstResponseAt != null\)/)
  // Must NOT use the incorrect preview-based inference
  expect(src).not.toMatch(/lastMessagePreview.*status.*closed/)
})

test('widget-panel.tsx does NOT send the unsupported ?take= query param', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  // The /api/conversations endpoint does not implement a `take` query
  // param. The dashboard must not send one in an actual fetch URL —
  // comments documenting the absence of the param are fine.
  expect(src).not.toMatch(/fetch\(['"`][^'"`]*\?take=/)
  expect(src).not.toMatch(/fetch\(['"`]\/api\/conversations\?take=/)
  // We read the existing response as-is — the conversations fetch uses
  // a bare /api/conversations URL (no query string).
  expect(src).toMatch(/fetch\(['"`]\/api\/conversations['"`]\)/)
})

test('widget-panel.tsx does NOT expose secrets in snippets', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).not.toContain('NEXTAUTH_SECRET')
  expect(src).not.toContain('DATABASE_URL')
  expect(src).not.toContain('POSTGRES_PASSWORD')
  expect(src).not.toContain('REDIS_URL')
})

test('fa.json does NOT contain stale Module 2 text', () => {
  const fa = json_fa as any
  expect(fa.dashboard.comingSoon).not.toContain('ماژول')
  expect(fa.dashboard.comingSoonHint).not.toContain('ماژول')
  // Real-time messaging and automation are already live
  expect(fa.dashboard.comingSoonHint).not.toContain('اضافه will be')
})

test('en.json does NOT contain stale Module 2 text', () => {
  const en = json_en as any
  expect(en.dashboard.comingSoon).not.toContain('Module 2')
  expect(en.dashboard.comingSoonHint).not.toContain('Module 2')
  expect(en.dashboard.comingSoonHint).not.toMatch(/land next/i)
})

test('fa.json + en.json label Integrations as coming soon (not Module 2)', () => {
  const fa = json_fa as any
  const en = json_en as any
  expect(fa.dashboard.integrationsHint).toBeTruthy()
  expect(en.dashboard.integrationsHint).toBeTruthy()
  // Must NOT reference Module 2
  expect(fa.dashboard.integrationsHint).not.toContain('ماژول')
  expect(en.dashboard.integrationsHint).not.toContain('Module 2')
})

test('placeholders.tsx does NOT contain ModuleStrip (stale Module 2 text)', () => {
  const src = readSrc('src/components/dashboard/views/placeholders.tsx')
  expect(src).not.toContain('ModuleStrip')
  // The ComingSoonView should NOT list automation/billing as "coming soon"
  // (they already exist)
  expect(src).not.toMatch(/comingSoon.*automation/i)
  expect(src).not.toMatch(/comingSoon.*billing/i)
})

test('dashboard-shell.tsx uses integrationsHint for the Integrations view', () => {
  const src = readSrc('src/components/dashboard/dashboard-shell.tsx')
  expect(src).toContain('integrationsHint')
})
