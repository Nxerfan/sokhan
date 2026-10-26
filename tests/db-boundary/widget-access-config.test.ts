/// <reference types="bun-types" />
/**
 * Widget access-config — STRICT behavioral route tests.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Exercises the REAL production route handler (GET/PATCH
 * /api/widget-config/access) against real PostgreSQL. mock.module replaces
 * @/lib/auth for THIS file only — a withSessionTenant stub that mirrors the
 * production logic (resolve session -> look up the CURRENT Membership
 * tenant-scoped -> refresh the role from the DB -> run fn in withTenant). This
 * proves the full GET/PATCH contract: strict parseAccessMode/parsePolicyVersion
 * (no coerceAccessMode), strict type validation (no String() coercion),
 * policyVersion transition atomicity, URL/path safety, failure atomicity,
 * tenant isolation, authorization.
 *
 * Written to the STRICT contract — the pre-fix route (coerceAccessMode,
 * String(...), .slice(...), no unknown-field rejection, no fail-closed-on-
 * corrupt-policy) is expected to FAIL several of these. The tests are NOT
 * weakened to accommodate the pre-fix implementation.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { db, globalDb, withTenant, hasRole, ROLE_RANK } from '@/lib/db'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

// === Test session injection (mocked @/lib/auth.withSessionTenant) ===
type TestSession = {
  user: { id: string; email: string; name?: string | null; workspaceId: string; role: string }
  expires: string
}
let testSession: TestSession | null = null

mock.module('@/lib/auth', () => ({
  // Mirrors the production withSessionTenant: resolve session, look up the
  // CURRENT Membership (tenant-scoped) for the fresh role, run fn in withTenant.
  // Returns null if no session / no membership / membership not active.
  withSessionTenant: async <T>(fn: (ctx: { session: TestSession }) => Promise<T>): Promise<{ session: TestSession; result: T } | null> => {
    if (!testSession?.user?.workspaceId) return null
    const tid = testSession.user.workspaceId
    const membership = await withTenant(tid, async () =>
      db.membership.findFirst({ where: { userId: testSession!.user!.id } }),
    )
    if (!membership || membership.status !== 'active') return null
    const freshSession: TestSession = { ...testSession, user: { ...testSession.user, role: membership.role } }
    return withTenant(tid, async () => {
      const result = await fn({ session: freshSession })
      return { session: freshSession, result }
    })
  },
  hasRole,
  ROLE_RANK,
}))

const { GET, PATCH } = await import('@/app/api/widget-config/access/route')

// === Fixtures ===
let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let adminA: { id: string; email: string }
let viewerA: { id: string; email: string }
let adminB: { id: string; email: string }

beforeAll(async () => {
  tenantA = await globalDb.tenant.create({
    data: { slug: `acc-a-${RUN_ID}`, name: `Acc A ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  tenantB = await globalDb.tenant.create({
    data: { slug: `acc-b-${RUN_ID}`, name: `Acc B ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantA.id, accessMode: 'anonymous', policyVersion: 4, greetingTexts: { fa: '', en: '' } },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  adminA = await globalDb.user.create({ data: { email: `admin-a-${RUN_ID}@x.test`, name: 'Admin A', passwordHash: 'x', locale: 'fa' }, select: { id: true, email: true } })
  viewerA = await globalDb.user.create({ data: { email: `viewer-a-${RUN_ID}@x.test`, name: 'Viewer A', passwordHash: 'x', locale: 'fa' }, select: { id: true, email: true } })
  adminB = await globalDb.user.create({ data: { email: `admin-b-${RUN_ID}@x.test`, name: 'Admin B', passwordHash: 'x', locale: 'fa' }, select: { id: true, email: true } })
  await globalDb.membership.create({ data: { userId: adminA.id, tenantId: tenantA.id, role: 'admin', status: 'active' } })
  await globalDb.membership.create({ data: { userId: viewerA.id, tenantId: tenantA.id, role: 'viewer', status: 'active' } })
  await globalDb.membership.create({ data: { userId: adminB.id, tenantId: tenantB.id, role: 'admin', status: 'active' } })
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } })
  await globalDb.user.deleteMany({ where: { id: { in: [adminA.id, viewerA.id, adminB.id] } } })
})

function uniq(s: string): string {
  return `${RUN_ID}-${s}-${Math.random().toString(36).slice(2, 8)}`
}

function asAdminA() { testSession = { user: { id: adminA.id, email: adminA.email, name: 'Admin A', workspaceId: tenantA.id, role: 'admin' }, expires: '2099-01-01' } }
function asViewerA() { testSession = { user: { id: viewerA.id, email: viewerA.email, name: 'Viewer A', workspaceId: tenantA.id, role: 'viewer' }, expires: '2099-01-01' } }
function asAdminB() { testSession = { user: { id: adminB.id, email: adminB.email, name: 'Admin B', workspaceId: tenantB.id, role: 'admin' }, expires: '2099-01-01' } }
function asNone() { testSession = null }

async function callGet() {
  const res = await GET()
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

async function callPatch(body: unknown) {
  const req = new NextRequest('http://localhost/api/widget-config/access', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await PATCH(req)
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

async function getConfig(tenantId: string) {
  return withTenant(tenantId, async () =>
    db.widgetConfig.findUnique({
      where: { tenantId },
      select: { accessMode: true, policyVersion: true, loginUrl: true, loginButtonLabel: true, loginReturnUrlParam: true, identityEndpointPath: true, integrationSecretHash: true, integrationSecretRotatedAt: true },
    }),
  )
}

async function setConfig(tenantId: string, patch: Record<string, unknown>) {
  await withTenant(tenantId, async () => db.widgetConfig.update({ where: { tenantId }, data: patch }))
}

// Reset tenantA config to the canonical baseline before each test that mutates.
async function resetA() {
  await setConfig(tenantA.id, { accessMode: 'anonymous', policyVersion: 4, loginUrl: null, loginButtonLabel: null, loginReturnUrlParam: null, identityEndpointPath: null })
}

/** Drop the WidgetConfig_accessMode_check to allow a corrupt accessMode for
 *  testing the GET/PATCH fail-closed path (the CHECK normally prevents a
 *  corrupt value at the storage level; the route's parseAccessMode is
 *  defense-in-depth). Restored in finally. Uses globalDb (DDL is global). */
async function withCorruptAccessMode<T>(tenantId: string, corruptMode: string, fn: () => Promise<T>): Promise<T> {
  await globalDb.$executeRawUnsafe(`ALTER TABLE "WidgetConfig" DROP CONSTRAINT IF EXISTS "WidgetConfig_accessMode_check"`)
  try {
    await setConfig(tenantId, { accessMode: corruptMode })
    return await fn()
  } finally {
    try {
      await globalDb.$executeRawUnsafe(`ALTER TABLE "WidgetConfig" ADD CONSTRAINT "WidgetConfig_accessMode_check" CHECK ("accessMode" IN ('anonymous','verified_visitor','site_user_only'))`)
    } catch { /* already exists — ignore */ }
    await resetA()
  }
}

// === GET ===

describe('access-config GET', () => {
  test('valid config: exact accessMode/policyVersion/login fields/integration status; no raw/hash secret', async () => {
    asAdminA()
    await resetA()
    await setConfig(tenantA.id, { accessMode: 'verified_visitor', policyVersion: 7, loginUrl: '/login', loginButtonLabel: 'Sign in', loginReturnUrlParam: 'next', identityEndpointPath: '/api/sukhan-identity' })
    const r = await callGet()
    expect(r.status).toBe(200)
    expect(r.data.accessMode).toBe('verified_visitor')
    expect(r.data.policyVersion).toBe(7)
    expect(r.data.loginUrl).toBe('/login')
    expect(r.data.loginButtonLabel).toBe('Sign in')
    expect(r.data.loginReturnUrlParam).toBe('next')
    expect(r.data.identityEndpointPath).toBe('/api/sukhan-identity')
    expect(r.data.integrationSecret).toEqual({ hasSecret: false, rotatedAt: null })
    // NEVER return the raw secret or the hash.
    expect(r.data.integrationSecretHash).toBeUndefined()
    expect(r.data.integrationSecret.rawSecret).toBeUndefined()
    expect(Object.keys(r.data).join(',')).not.toContain('integrationSecretHash')
  })

  test('corrupt DB accessMode -> 503 policy_unavailable (never silently anonymous)', async () => {
    asAdminA()
    // The DB CHECK normally prevents a corrupt accessMode; drop it to prove the
    // route's parseAccessMode fail-closes (defense-in-depth) — never silently 'anonymous'.
    await withCorruptAccessMode(tenantA.id, 'corrupt_mode', async () => {
      const r = await callGet()
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
    })
  })

  test('invalid policyVersion -> 503 policy_unavailable', async () => {
    asAdminA()
    await setConfig(tenantA.id, { accessMode: 'anonymous', policyVersion: -1 })
    const r = await callGet()
    expect(r.status).toBe(503)
    expect(r.data.error).toBe('policy_unavailable')
    await resetA()
  })

  test('unauthenticated -> 401', async () => {
    asNone()
    const r = await callGet()
    expect(r.status).toBe(401)
  })
})

// === PATCH accessMode + policyVersion transition ===

describe('access-config PATCH — accessMode + policyVersion transition', () => {
  test('valid transition: new mode persisted + policyVersion increments exactly once', async () => {
    asAdminA()
    await resetA() // anonymous / pv=4
    const r = await callPatch({ accessMode: 'verified_visitor' })
    expect(r.status).toBe(200)
    expect(r.data.accessMode).toBe('verified_visitor')
    expect(r.data.policyVersion).toBe(5) // 4 -> 5 (exactly once)
    expect(r.data.accessModeChanged).toBe(true)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('verified_visitor')
    expect(cfg!.policyVersion).toBe(5)
  })

  test('same-mode PATCH: policyVersion unchanged', async () => {
    asAdminA()
    await resetA() // anonymous / pv=4
    const r = await callPatch({ accessMode: 'anonymous' })
    expect(r.status).toBe(200)
    expect(r.data.policyVersion).toBe(4) // unchanged
    expect(r.data.accessModeChanged).toBe(false)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.policyVersion).toBe(4)
  })

  test('non-mode PATCH (loginUrl): policyVersion unchanged', async () => {
    asAdminA()
    await resetA() // anonymous / pv=4
    const r = await callPatch({ loginUrl: '/account/login' })
    expect(r.status).toBe(200)
    expect(r.data.policyVersion).toBe(4) // unchanged (no accessMode change)
    expect(r.data.accessModeChanged).toBe(false)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.loginUrl).toBe('/account/login')
    expect(cfg!.policyVersion).toBe(4)
  })

  test('invalid accessMode string -> rejected, DB unchanged', async () => {
    asAdminA()
    await resetA() // anonymous / pv=4
    const r = await callPatch({ accessMode: ' anonymous ' }) // whitespace -> must reject (no trim/coerce)
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('invalid_access_mode')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('anonymous') // unchanged
    expect(cfg!.policyVersion).toBe(4)
  })

  test('wrong-type accessMode (number/boolean/object/array) -> rejected, DB unchanged', async () => {
    asAdminA()
    for (const bad of [1, true, {}, []]) {
      await resetA() // anonymous / pv=4
      const r = await callPatch({ accessMode: bad })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_access_mode')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.accessMode).toBe('anonymous')
      expect(cfg!.policyVersion).toBe(4)
    }
  })
})

// === PATCH no coercion (wrong types for each field) ===

describe('access-config PATCH — no coercion (wrong types reject)', () => {
  test('loginUrl wrong types -> invalid_login_url', async () => {
    asAdminA()
    for (const bad of [1, true, {}, []]) {
      await resetA()
      const r = await callPatch({ loginUrl: bad })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_url')
    }
  })

  test('loginButtonLabel wrong types -> invalid_login_button_label', async () => {
    asAdminA()
    for (const bad of [1, true, {}, []]) {
      await resetA()
      const r = await callPatch({ loginButtonLabel: bad })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_button_label')
    }
  })

  test('loginReturnUrlParam wrong types -> invalid_login_return_url_param', async () => {
    asAdminA()
    for (const bad of [1, true, {}, []]) {
      await resetA()
      const r = await callPatch({ loginReturnUrlParam: bad })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_return_url_param')
    }
  })

  test('identityEndpointPath wrong types -> invalid_identity_endpoint_path', async () => {
    asAdminA()
    for (const bad of [1, true, {}, []]) {
      await resetA()
      const r = await callPatch({ identityEndpointPath: bad })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_identity_endpoint_path')
    }
  })

  test('array as top-level PATCH body -> rejected', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch([{ accessMode: 'anonymous' }])
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('invalid_body')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('anonymous')
  })

  test('unknown field -> rejected (no silent ignore of typos)', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ accesMode: 'verified_visitor' }) // typo
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('unknown_field')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('anonymous') // unchanged
  })

  test('client-supplied policyVersion -> rejected (never accepted)', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ accessMode: 'verified_visitor', policyVersion: 99 })
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('unknown_field')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.policyVersion).toBe(4) // unchanged
  })

  test('client-supplied integrationSecretHash -> rejected', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ integrationSecretHash: 'pwned' })
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('unknown_field')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.integrationSecretHash).toBeNull()
  })
})

// === PATCH URL/path safety ===

describe('access-config PATCH — loginUrl safety', () => {
  test('accepts safe relative + http(s) URLs', async () => {
    asAdminA()
    for (const url of ['/login', '/account/login', 'http://example.com/login', 'https://example.com/login']) {
      await resetA()
      const r = await callPatch({ loginUrl: url })
      expect(r.status).toBe(200)
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.loginUrl).toBe(url)
    }
  })

  test('rejects protocol-relative / javascript / data / malformed / backslash / oversized', async () => {
    asAdminA()
    const bad = [
      '//evil.example', // protocol-relative
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ht!tp://example.com', // malformed
      '/\\evil', // backslash confusion (browser may normalize to //evil)
      'http://example.com/\\evil', // backslash in absolute
      'x'.repeat(501), // oversized
    ]
    for (const url of bad) {
      await resetA()
      const r = await callPatch({ loginUrl: url })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_url')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.loginUrl).toBeNull() // unchanged
    }
  })

  test('accepts null loginUrl', async () => {
    asAdminA()
    await setConfig(tenantA.id, { loginUrl: '/login' })
    const r = await callPatch({ loginUrl: null })
    expect(r.status).toBe(200)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.loginUrl).toBeNull()
    await resetA()
  })
})

describe('access-config PATCH — identityEndpointPath safety', () => {
  test('accepts same-origin relative path', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ identityEndpointPath: '/api/sukhan-identity' })
    expect(r.status).toBe(200)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.identityEndpointPath).toBe('/api/sukhan-identity')
  })

  test('rejects absolute / protocol-relative / backslash / query-hash-only / oversized', async () => {
    asAdminA()
    const bad = [
      'https://example.com/api/identity', // absolute URL
      '//example.com/api/identity', // protocol-relative
      '/\\api/identity', // backslash confusion
      '/api/identity?foo=bar', // query-only is OK actually? user says reject query/hash-only — but a path WITH query... the user says reject "query/hash-only input". Let me reject any path containing ? or # to be safe.
      '/api/identity#frag', // hash
      '/?', // query/hash-only
      'x'.repeat(501), // oversized
    ]
    for (const p of bad) {
      await resetA()
      const r = await callPatch({ identityEndpointPath: p })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_identity_endpoint_path')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.identityEndpointPath).toBeNull()
    }
  })

  test('accepts null identityEndpointPath', async () => {
    asAdminA()
    await setConfig(tenantA.id, { identityEndpointPath: '/api/sukhan-identity' })
    const r = await callPatch({ identityEndpointPath: null })
    expect(r.status).toBe(200)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.identityEndpointPath).toBeNull()
    await resetA()
  })
})

describe('access-config PATCH — loginReturnUrlParam safety', () => {
  test('accepts safe parameter names', async () => {
    asAdminA()
    for (const p of ['return', 'returnUrl', 'next', 'redirect_to', 'redirect-to']) {
      await resetA()
      const r = await callPatch({ loginReturnUrlParam: p })
      expect(r.status).toBe(200)
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.loginReturnUrlParam).toBe(p)
    }
  })

  test('rejects URL-structure chars / whitespace / oversized', async () => {
    asAdminA()
    const bad = [
      're&turn', // &
      're?turn', // ?
      're=turn', // =
      're#turn', // #
      're turn', // whitespace
      're\tturn', // control (tab)
      'x'.repeat(101), // oversized
    ]
    for (const p of bad) {
      await resetA()
      const r = await callPatch({ loginReturnUrlParam: p })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_return_url_param')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.loginReturnUrlParam).toBeNull()
    }
  })

  test('accepts null loginReturnUrlParam', async () => {
    asAdminA()
    await setConfig(tenantA.id, { loginReturnUrlParam: 'next' })
    const r = await callPatch({ loginReturnUrlParam: null })
    expect(r.status).toBe(200)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.loginReturnUrlParam).toBeNull()
    await resetA()
  })
})

describe('access-config PATCH — loginButtonLabel safety', () => {
  test('accepts null + unicode string', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ loginButtonLabel: 'ورود' }) // Persian unicode
    expect(r.status).toBe(200)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.loginButtonLabel).toBe('ورود')
    // null
    const r2 = await callPatch({ loginButtonLabel: null })
    expect(r2.status).toBe(200)
    const cfg2 = await getConfig(tenantA.id)
    expect(cfg2!.loginButtonLabel).toBeNull()
  })

  test('rejects empty/whitespace-only (non-null) + oversized', async () => {
    asAdminA()
    const bad = ['', '   ', '\t\n', 'x'.repeat(201)]
    for (const label of bad) {
      await resetA()
      const r = await callPatch({ loginButtonLabel: label })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('invalid_login_button_label')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.loginButtonLabel).toBeNull()
    }
  })
})

// === Failure atomicity ===

describe('access-config PATCH — failure atomicity', () => {
  test('an invalid field leaves ALL existing configuration unchanged', async () => {
    asAdminA()
    await setConfig(tenantA.id, { accessMode: 'verified_visitor', policyVersion: 9, loginUrl: '/orig-login', loginButtonLabel: 'Orig', loginReturnUrlParam: 'orig', identityEndpointPath: '/orig-api' })
    const before = await getConfig(tenantA.id)
    // PATCH with a valid loginUrl BUT an invalid accessMode -> whole PATCH rejected.
    const r = await callPatch({ accessMode: 'bogus', loginUrl: '/should-not-apply' })
    expect(r.status).toBe(400)
    const after = await getConfig(tenantA.id)
    expect(after).toEqual(before) // NOTHING changed (atomic)
    await resetA()
  })
})

// === Tenant isolation ===

describe('access-config PATCH — tenant isolation', () => {
  test('PATCH in tenant A does not modify tenant B', async () => {
    asAdminA()
    await resetA() // A: anonymous / pv=4
    await setConfig(tenantB.id, { accessMode: 'anonymous', policyVersion: 1 })
    const r = await callPatch({ accessMode: 'site_user_only' })
    expect(r.status).toBe(200)
    const cfgA = await getConfig(tenantA.id)
    const cfgB = await getConfig(tenantB.id)
    expect(cfgA!.accessMode).toBe('site_user_only')
    expect(cfgA!.policyVersion).toBe(5)
    expect(cfgB!.accessMode).toBe('anonymous') // B unchanged
    expect(cfgB!.policyVersion).toBe(1)
  })
})

// === Authorization ===

describe('access-config PATCH — authorization', () => {
  test('unauthenticated -> 401', async () => {
    asNone()
    await resetA()
    const r = await callPatch({ accessMode: 'verified_visitor' })
    expect(r.status).toBe(401)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('anonymous') // unchanged
  })

  test('insufficient role (viewer) -> 403', async () => {
    asViewerA()
    await resetA()
    const r = await callPatch({ accessMode: 'verified_visitor' })
    expect(r.status).toBe(403)
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.accessMode).toBe('anonymous') // unchanged
  })

  test('admin PATCH succeeds', async () => {
    asAdminA()
    await resetA()
    const r = await callPatch({ accessMode: 'verified_visitor' })
    expect(r.status).toBe(200)
  })
})

// === Fail closed on current corrupt policy (PATCH is NOT a repair path) ===

describe('access-config PATCH — fail closed on corrupt current policy', () => {
  test('corrupt current accessMode -> 503 policy_unavailable (PATCH does NOT repair)', async () => {
    asAdminA()
    await withCorruptAccessMode(tenantA.id, 'corrupt_mode', async () => {
      const r = await callPatch({ accessMode: 'verified_visitor' }) // even a VALID new mode is rejected
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
      const cfg = await getConfig(tenantA.id)
      expect(cfg!.accessMode).toBe('corrupt_mode') // NOT repaired
    })
  })

  test('corrupt current policyVersion -> 503 policy_unavailable (PATCH does NOT repair)', async () => {
    asAdminA()
    await setConfig(tenantA.id, { accessMode: 'anonymous', policyVersion: 0 }) // 0 is invalid
    const r = await callPatch({ loginUrl: '/login' }) // even a non-mode PATCH is rejected
    expect(r.status).toBe(503)
    expect(r.data.error).toBe('policy_unavailable')
    const cfg = await getConfig(tenantA.id)
    expect(cfg!.policyVersion).toBe(0) // NOT repaired
    await resetA()
  })
})
