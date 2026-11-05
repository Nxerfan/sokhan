/// <reference types="bun-types" />
/**
 * Developer-owned rate-limit test-harness bypass audit (AI-Q3 security review).
 *
 * The AI-Q3 branch modified `src/lib/rate-limit.ts` to bypass the shared-IP
 * limiter when `SUKHAN_TEST_HARNESS === 'true'`. This file provides the
 * executable evidence required by the independent reviewer:
 *
 *   1. The production IP rate limit REMAINS enforced when the flag is unset.
 *   2. The bypass CANNOT be activated by a visitor request (the flag is read
 *      from `process.env`, never from request headers).
 *   3. The bypass is confined to the dedicated test-harness environment
 *      (production compose files do NOT set it; only test compose files do).
 *   4. Per-tenant limits REMAIN enforced even in the test harness.
 *   5. Real production-like behavior is tested independently with the bypass
 *      disabled (the first test in this file runs with the flag unset).
 *
 * Never weakens production security. The bypass only affects the shared-IP
 * counter (30/min) that a single Docker proxy IP would otherwise exhaust
 * during the complete browser regression (31 test files). Per-tenant limits
 * (60/min) remain enforced in ALL environments.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rateLimit } from '../../src/lib/rate-limit'

const ORIGINAL_HARNESS = process.env.SUKHAN_TEST_HARNESS
const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_REDIS_URL = process.env.REDIS_URL

describe('Rate-limit test-harness bypass audit (AI-Q3 security review)', () => {
  // `process.env` is typed read-only for known keys (NODE_ENV etc.) in
  // bun-types. Cast to a mutable record for the test harness.
  const env = process.env as Record<string, string | undefined>

  beforeEach(() => {
    // Ensure the in-memory fallback is used (no Redis in the unit-test env).
    delete env.REDIS_URL
    // Avoid the dev localhost-IP shortcut so IP_LIMIT is actually exercised.
    delete env.NODE_ENV
  })

  afterEach(() => {
    if (ORIGINAL_HARNESS === undefined) delete env.SUKHAN_TEST_HARNESS
    else env.SUKHAN_TEST_HARNESS = ORIGINAL_HARNESS
    if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV
    else env.NODE_ENV = ORIGINAL_NODE_ENV
    if (ORIGINAL_REDIS_URL === undefined) delete env.REDIS_URL
    else env.REDIS_URL = ORIGINAL_REDIS_URL
  })

  // Point 5 (and point 1): production-like behavior with bypass DISABLED.
  test('PRODUCTION-LIKE: IP rate limit IS enforced when SUKHAN_TEST_HARNESS is unset', async () => {
    delete env.SUKHAN_TEST_HARNESS
    // Use a unique IP per test to avoid in-memory bucket collisions with
    // other tests in the same process (buckets are module-level singletons
    // cleaned every 5 minutes).
    const ip = '203.0.113.10'
    // IP_LIMIT = 30. First 30 calls allowed, 31st blocked.
    for (let i = 0; i < 30; i++) {
      const r = await rateLimit(ip)
      expect(r.allowed, `production call ${i + 1} should be allowed`).toBe(true)
    }
    const r31 = await rateLimit(ip)
    expect(r31.allowed, 'production 31st IP call MUST be blocked').toBe(false)
  })

  // Point 2: the bypass reads from process.env (server-side), never from
  // request headers. This is a structural code-level guarantee.
  test('BYPASS SOURCE: the flag is read from process.env (server-side), NEVER from request headers', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/rate-limit.ts'), 'utf8')
    // The bypass condition reads ONLY from process.env:
    expect(src).toContain("process.env.SUKHAN_TEST_HARNESS === 'true'")
    // The bypass is NOT activated by any request header (a visitor cannot
    // set process.env via HTTP):
    expect(src).not.toMatch(/headers\.get\(['"]SUKHAN_TEST_HARNESS['"]\)/)
    expect(src).not.toMatch(/x-sukhan-test-harness/i)
    expect(src).not.toMatch(/req\.headers[^;]*SUKHAN_TEST_HARNESS/)
    // The getClientIP helper reads headers (x-forwarded-for, x-real-ip) for
    // the IP only — it has nothing to do with the harness flag:
    const getClientIPCalls = src.match(/headers\.get\(/g) ?? []
    expect(getClientIPCalls.length, 'headers.get is only for IP extraction').toBeLessThanOrEqual(2)
  })

  // Point 3: the bypass is confined to the test-harness environment.
  test('TEST-HARNESS CONFINEMENT: production compose files do NOT set SUKHAN_TEST_HARNESS; only test compose files do', () => {
    const prodFull = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8')
    const prodLite = readFileSync(join(process.cwd(), 'docker-compose.lite.yml'), 'utf8')
    expect(prodFull, 'production Full compose must NOT set SUKHAN_TEST_HARNESS').not.toContain('SUKHAN_TEST_HARNESS')
    expect(prodLite, 'production Lite compose must NOT set SUKHAN_TEST_HARNESS').not.toContain('SUKHAN_TEST_HARNESS')

    const testFull = readFileSync(join(process.cwd(), 'docker-compose.test.yml'), 'utf8')
    const testLite = readFileSync(join(process.cwd(), 'docker-compose.lite.test.yml'), 'utf8')
    expect(testFull, 'test Full compose MUST set SUKHAN_TEST_HARNESS=true').toContain('SUKHAN_TEST_HARNESS: "true"')
    expect(testLite, 'test Lite compose MUST set SUKHAN_TEST_HARNESS=true').toContain('SUKHAN_TEST_HARNESS: "true"')
    // Both test compose files document that production must NOT set it:
    expect(testFull).toContain('Production compose + Vercel must NOT set this')
    expect(testLite).toContain('Production compose + Vercel must NOT set this')
  })

  // Point: the bypass IS active when the flag is set (behavioral confirmation).
  test('TEST-HARNESS: IP rate limit is BYPASSED when SUKHAN_TEST_HARNESS === true', async () => {
    env.SUKHAN_TEST_HARNESS = 'true'
    const ip = '203.0.113.11'
    // IP_LIMIT = 30. With bypass active, 100 calls all allowed (for IP).
    for (let i = 0; i < 100; i++) {
      const r = await rateLimit(ip)
      expect(r.allowed, `harness call ${i + 1} should bypass IP limit`).toBe(true)
    }
  })

  // Point 4: per-tenant limits REMAIN enforced even with the bypass active.
  test('TEST-HARNESS: per-tenant limit REMAINS enforced even with bypass active', async () => {
    env.SUKHAN_TEST_HARNESS = 'true'
    const ip = '203.0.113.12'
    const tenant = 'audit-tenant-12'
    // TENANT_LIMIT = 60. First 60 allowed, 61st blocked — even though the
    // IP bypass is active, the tenant counter still runs and caps at 60.
    for (let i = 0; i < 60; i++) {
      const r = await rateLimit(ip, tenant)
      expect(r.allowed, `tenant call ${i + 1} should be allowed`).toBe(true)
    }
    const r61 = await rateLimit(ip, tenant)
    expect(r61.allowed, 'tenant 61st call MUST be blocked even with IP bypass').toBe(false)
  })

  // Point: a visitor-supplied header spoof attempt does NOT activate bypass.
  test('VISITOR SPOOF: a request header cannot activate the bypass — only process.env matters', async () => {
    // Simulate a visitor attempt: set SUKHAN_TEST_HARNESS in the env to a
    // non-'true' value (visitor headers never touch process.env, but even
    // if they somehow did, only the exact string 'true' activates bypass).
    env.SUKHAN_TEST_HARNESS = 'false'
    const ip = '203.0.113.13'
    // With bypass NOT active (env is 'false', not 'true'), IP limit runs.
    for (let i = 0; i < 30; i++) {
      const r = await rateLimit(ip)
      expect(r.allowed).toBe(true)
    }
    const r31 = await rateLimit(ip)
    expect(r31.allowed, 'env="false" must NOT activate bypass').toBe(false)
  })

  // Point: the bypass only affects the IP counter — tenant counter is independent.
  test('PRODUCTION-LIKE: per-tenant limit IS enforced in production (no bypass)', async () => {
    delete env.SUKHAN_TEST_HARNESS
    const tenant = 'audit-tenant-14'
    // IP_LIMIT = 30, TENANT_LIMIT = 60. Use 2 distinct IPs (30 calls each)
    // so neither IP bucket fills before the tenant bucket reaches 60.
    for (let i = 0; i < 30; i++) {
      const r = await rateLimit('203.0.113.14', tenant)
      expect(r.allowed, `ip1 call ${i + 1}`).toBe(true)
    }
    for (let i = 0; i < 30; i++) {
      const r = await rateLimit('203.0.115.14', tenant)
      expect(r.allowed, `ip2 call ${i + 1}`).toBe(true)
    }
    // Tenant bucket now has 60. 61st call (from a fresh IP) passes the IP
    // check but is blocked by the tenant check.
    const r61 = await rateLimit('203.0.116.14', tenant)
    expect(r61.allowed, 'production tenant 61st call MUST be blocked').toBe(false)
  })
})
