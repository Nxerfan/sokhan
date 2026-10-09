/// <reference types="bun-types" />
/**
 * Widget installation + onboarding UX regression tests.
 *
 * Verifies:
 *   - Widget panel renders with installation tabs
 *   - Public widget identifier (Widget Key) is shown, not a secret API key
 *   - HTML snippet points to the Sukhan backend, not the customer page origin
 *   - NPM instructions match the actual package API
 *   - Stale Module 2 text is removed from i18n
 *   - Integrations is labeled "coming soon" (not Module 2)
 *   - No secret values in installation snippets
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

test('widget-panel.tsx includes installation verification (safe, no SSRF)', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('verifyWidget')
  expect(src).toContain('Verify Installation')
  // Must fetch from the Sukhan backend (not customer URLs)
  expect(src).toContain('/api/widget/')
  expect(src).toContain('/config')
  // Must NOT fetch customer URLs
  expect(src).not.toMatch(/fetch.*customer/i)
  expect(src).not.toMatch(/fetch.*website.*url/i)
})

test('widget-panel.tsx includes an onboarding checklist', () => {
  const src = readSrc('src/components/dashboard/views/widget-panel.tsx')
  expect(src).toContain('checklistItems')
  expect(src).toContain('Workspace created')
  expect(src).toContain('Install widget')
  expect(src).toContain('Verify widget')
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
