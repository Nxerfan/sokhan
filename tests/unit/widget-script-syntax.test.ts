/// <reference types="bun-types" />
/**
 * Generated script syntax validation (requirement #46).
 *
 * Imports the `buildScript` function from BOTH script route handlers and
 * verifies the generated JavaScript PARSES successfully (no template-literal
 * syntax errors, no stray backticks / ${} / unbalanced braces). Uses
 * `new Function(body)` which throws SyntaxError on malformed JS without
 * executing it. Also asserts the generated body contains the identity
 * runtime hooks (window.SukhanWidget, __sk_bootstrap) so a wiring regression
 * is caught.
 */

import { test, expect, describe } from 'bun:test'
// Import the buildScript functions. The route modules import @/lib/db
// (server-only Prisma) — bun:test runs this fine with the env sourced.
// The bracketed [slug] path is a literal directory name.
import { buildScript as buildSlugScript } from '../../src/app/api/widget/[slug]/script/route'
import { buildScript as buildV1Script } from '../../src/app/api/widget/v1/sukhan.js/route'

/** Validate that a JS body parses (SyntaxError thrown otherwise). */
function assertParses(js: string, label: string): void {
  let parsed = false
  try {
    // eslint-disable-next-line no-new-func
    new Function(js)
    parsed = true
  } catch (e) {
    throw new Error(
      `[${label}] generated JS has a syntax error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  expect(parsed, `[${label}] generated JS should parse`).toBe(true)
}

describe('Generated script syntax — slug script', () => {
  test('docker/dev default (no Vercel, no realtime override) parses', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', false, '/?XTransformPort=3003', false)
    assertParses(js, 'slug docker')
    expect(js, 'slug script must include the identity runtime').toContain('window.SukhanWidget')
    expect(js).toContain('__sk_bootstrap')
    expect(js).toContain('verify-identity/start')
  })

  test('vercel (placeholder __API_URL__) parses', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', false, '__API_URL__', true)
    assertParses(js, 'slug vercel')
  })

  test('explicit realtime override parses', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', false, 'https://rt.example.com', false)
    assertParses(js, 'slug explicit-rt')
  })

  test('disablePolling (nopoll=1) parses', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', true, '/?XTransformPort=3003', false)
    assertParses(js, 'slug nopoll')
    expect(js).toContain('DISABLE_POLLING = true')
  })
})

describe('Generated script syntax — v1 script', () => {
  test('docker/dev default parses', () => {
    const js = buildV1Script(null, false)
    assertParses(js, 'v1 docker')
    expect(js, 'v1 script must include the identity runtime').toContain('window.SukhanWidget')
    expect(js).toContain('__sk_bootstrap')
    expect(js).toContain('data-identity-endpoint')
  })

  test('vercel (placeholder) parses', () => {
    const js = buildV1Script(null, true)
    assertParses(js, 'v1 vercel')
  })

  test('explicit realtime override parses', () => {
    const js = buildV1Script('https://rt.example.com', false)
    assertParses(js, 'v1 explicit-rt')
  })
})

describe('Generated script — no secrets / no per-user data baked in', () => {
  test('slug script body has NO integration secret / externalUserId / OTP', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', false, '/?XTransformPort=3003', false)
    expect(js, 'must not bake an integration secret').not.toContain('integration_secret')
    expect(js, 'must not bake an externalUserId').not.toContain('externalUserId:')
    expect(js, 'must not bake an OTP code').not.toContain('123456')
  })

  test('v1 script body has NO integration secret / externalUserId / OTP', () => {
    const js = buildV1Script(null, false)
    expect(js).not.toContain('integration_secret')
    expect(js).not.toContain('externalUserId:')
    expect(js).not.toContain('123456')
  })

  test('slug script has public Cache-Control-safe content (no per-user identity)', () => {
    const js = buildSlugScript('https://app.sukhan.chat', 'demo', false, '/?XTransformPort=3003', false)
    // The script must resolve all identity at RUNTIME (no baked literal
    // contactId UUID / realtime token). Runtime references like
    // `data.contactId` / `data.realtimeToken` are fine (they read the
    // server response) — assert no hardcoded UUID-shaped values are baked.
    expect(js).not.toMatch(/contactId['"]?\s*:\s*['"][0-9a-f-]{20}/i)
    expect(js).not.toMatch(/realtimeToken['"]?\s*:\s*['"][0-9a-f-]{20}/i)
    // The Cache-Control header is set on the response (server-side); the
    // script BODY must not contain a baked per-tenant secret.
    expect(js).not.toMatch(/Bearer\s+sk_/)
  })
})
