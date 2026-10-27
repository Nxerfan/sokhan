/// <reference types="bun-types" />
/**
 * Real-PostgreSQL boundary tests for the visitor CURRENT-policy access
 * verifiers — the internal endpoint + the Vercel adapter.
 *
 * Verifies:
 *   1. The internal endpoint `GET /api/realtime/verify-visitor-access`
 *      (used by the Docker realtime service) gates correctly.
 *   2. The Vercel adapter `verifyVisitorAccess` (used by api/realtime.ts
 *      in the io.use middleware + conversation:join revalidation) gates
 *      identically.
 *
 * PARITY: for every test case, the adapter function returns the SAME
 * decision as the endpoint. The endpoint and adapter share the pure
 * evaluator; this test proves the I/O plumbing around the evaluator
 * (loading tenant by slug, verifying tenantId binding, loading Contact)
 * behaves identically in both code paths.
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Cannot run locally without PostgreSQL — DB-boundary tests require a live DB.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { db, globalDb, withTenant } from '@/lib/db'
import { GET } from '@/app/api/realtime/verify-visitor-access/route'
import { verifyVisitorAccess } from '@/lib/realtime-visitor-auth'
import { signToken } from '@/lib/realtime-token'
import type { VisitorTokenPayload } from '@/lib/realtime-token-shared'
import crypto from 'crypto'

const SECRET = process.env.NEXTAUTH_SECRET || 'ci-docker-test-secret-not-production'
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

// Adapter receives a raw PrismaClient (the Vercel function runs outside the
// Next.js tenant context — the fail-closed `db` proxy is unsuitable here).
const adapterPrisma = new PrismaClient({ log: ['error'] })

let tenant: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let anonContact: { id: string }
let verifiedContact: { id: string }
let unverifiedContact: { id: string }
let externalContact: { id: string }

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `rt-va-${RUN_ID}`, name: `RT VA ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenant.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  tenantB = await globalDb.tenant.create({
    data: { slug: `rt-vb-${RUN_ID}`, name: `RT VB ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  await withTenant(tenant.id, async () => {
    anonContact = await db.contact.create({
      data: { tenantId: tenant.id, identifier: `anon-${RUN_ID}`, identifierType: 'visitorId', locale: 'fa', metadata: {} },
      select: { id: true },
    })
    verifiedContact = await db.contact.create({
      data: { tenantId: tenant.id, identifier: `vc-${RUN_ID}`, identifierType: 'visitorId', email: `vc-${RUN_ID}@x.com`, emailVerifiedAt: new Date(), locale: 'fa', metadata: {} },
      select: { id: true },
    })
    unverifiedContact = await db.contact.create({
      data: { tenantId: tenant.id, identifier: `unv-${RUN_ID}`, identifierType: 'visitorId', locale: 'fa', metadata: {} },
      select: { id: true },
    })
    externalContact = await db.contact.create({
      data: { tenantId: tenant.id, identifier: `ext-${RUN_ID}`, identifierType: 'externalUser', externalUserId: `ext-${RUN_ID}`, name: 'External', locale: 'fa', metadata: {} },
      select: { id: true },
    })
  })
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenant.id, tenantB.id] } } })
  await adapterPrisma.$disconnect()
})

async function setConfig(patch: { accessMode?: string; policyVersion?: number }) {
  await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: patch })
}

/** Build a visitor payload bound to the configured tenant (default). */
function makePayload(opts: { contactId: string; identityLevel?: string; policyVersion?: number; tenantId?: string; slug?: string }): VisitorTokenPayload {
  return {
    type: 'visitor',
    contactId: opts.contactId,
    tenantId: opts.tenantId ?? tenant.id,
    slug: opts.slug ?? tenant.slug,
    identityLevel: opts.identityLevel as VisitorTokenPayload['identityLevel'],
    policyVersion: opts.policyVersion,
  }
}

/** Call the REAL GET endpoint with X-Internal-Secret + query params. */
async function callVerifier(params: Record<string, string | undefined>, secret: string = SECRET): Promise<{ status: number; body: { ok?: true; error?: string } | null }> {
  const url = new URL('http://localhost/api/realtime/verify-visitor-access')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  const req = new NextRequest(url, { method: 'GET', headers: { 'X-Internal-Secret': secret } })
  const res = await GET(req)
  let body: { ok?: true; error?: string } | null = null
  try { body = await res.json() } catch { /* non-json */ }
  return { status: res.status, body }
}

/** Call the Vercel adapter directly with a PrismaClient. */
async function callAdapter(payload: VisitorTokenPayload): Promise<{ allowed: boolean; reason?: string }> {
  return verifyVisitorAccess(payload, adapterPrisma)
}

/** PARITY helper — both endpoint + adapter allow. */
async function expectBothAllow(payload: VisitorTokenPayload) {
  const ep = await callVerifier({
    contactId: payload.contactId,
    tenantId: payload.tenantId,
    slug: payload.slug,
    identityLevel: payload.identityLevel,
    policyVersion: payload.policyVersion === undefined ? undefined : String(payload.policyVersion),
  })
  expect(ep.status, `endpoint status`).toBe(200)
  expect(ep.body?.ok, `endpoint ok`).toBe(true)
  const ad = await callAdapter(payload)
  expect(ad.allowed, `adapter allowed`).toBe(true)
}

/** PARITY helper — both endpoint + adapter deny with the SAME reason. */
async function expectBothDenySameReason(payload: VisitorTokenPayload, reason: string, status: 403 | 503 = 403) {
  const ep = await callVerifier({
    contactId: payload.contactId,
    tenantId: payload.tenantId,
    slug: payload.slug,
    identityLevel: payload.identityLevel,
    policyVersion: payload.policyVersion === undefined ? undefined : String(payload.policyVersion),
  })
  expect(ep.status, `endpoint status for reason=${reason}`).toBe(status)
  expect(ep.body?.error, `endpoint reason`).toBe(reason)
  const ad = await callAdapter(payload)
  expect(ad.allowed, `adapter allowed for reason=${reason}`).toBe(false)
  if (!ad.allowed) expect(ad.reason, `adapter reason`).toBe(reason)
}

describe('internal auth', () => {
  test('missing X-Internal-Secret -> 403', async () => {
    await setConfig({ accessMode: 'anonymous', policyVersion: 1 })
    const url = new URL('http://localhost/api/realtime/verify-visitor-access')
    url.searchParams.set('contactId', anonContact.id)
    url.searchParams.set('tenantId', tenant.id)
    url.searchParams.set('slug', tenant.slug)
    url.searchParams.set('identityLevel', 'anonymous')
    url.searchParams.set('policyVersion', '1')
    const req = new NextRequest(url, { method: 'GET' }) // no secret header
    const res = await GET(req)
    expect(res.status).toBe(403)
  })
  test('wrong X-Internal-Secret -> 403 forbidden', async () => {
    const ep = await callVerifier({
      contactId: anonContact.id, tenantId: tenant.id, slug: tenant.slug,
      identityLevel: 'anonymous', policyVersion: '1',
    }, 'totally-wrong-secret')
    expect(ep.status).toBe(403)
    expect(ep.body?.error).toBe('forbidden')
  })
  test('correct X-Internal-Secret -> reaches evaluator (200)', async () => {
    await setConfig({ accessMode: 'anonymous', policyVersion: 1 })
    const ep = await callVerifier({
      contactId: anonContact.id, tenantId: tenant.id, slug: tenant.slug,
      identityLevel: 'anonymous', policyVersion: '1',
    })
    expect(ep.status).toBe(200)
  })
})

describe('tenant binding', () => {
  beforeAll(async () => await setConfig({ accessMode: 'anonymous', policyVersion: 1 }))
  test('wrong slug -> endpoint 403 forbidden; adapter deny policy_unavailable', async () => {
    const p = makePayload({ contactId: anonContact.id, slug: 'nonexistent-slug', identityLevel: 'anonymous', policyVersion: 1 })
    const ep = await callVerifier({
      contactId: p.contactId, tenantId: p.tenantId, slug: 'nonexistent-slug',
      identityLevel: p.identityLevel, policyVersion: '1',
    })
    expect(ep.status).toBe(403)
    expect(ep.body?.error).toBe('forbidden')
    const ad = await callAdapter(p)
    expect(ad.allowed).toBe(false)
    if (!ad.allowed) expect(ad.reason).toBe('policy_unavailable')
  })
  test('token tenant A + slug B -> endpoint 403 forbidden; adapter deny identity_token_invalid', async () => {
    const p: VisitorTokenPayload = {
      type: 'visitor', contactId: anonContact.id, tenantId: tenantB.id, slug: tenant.slug,
      identityLevel: 'anonymous', policyVersion: 1,
    }
    const ep = await callVerifier({
      contactId: p.contactId, tenantId: p.tenantId, slug: p.slug,
      identityLevel: p.identityLevel, policyVersion: '1',
    })
    expect(ep.status).toBe(403)
    expect(ep.body?.error).toBe('forbidden')
    const ad = await callAdapter(p)
    expect(ad.allowed).toBe(false)
    if (!ad.allowed) expect(ad.reason).toBe('identity_token_invalid')
  })
  test('nonexistent Contact -> both deny identity_token_invalid (parity)', async () => {
    const fakeContactId = 'c' + crypto.randomBytes(12).toString('hex')
    await expectBothDenySameReason(makePayload({ contactId: fakeContactId, identityLevel: 'anonymous', policyVersion: 1 }), 'identity_token_invalid')
  })
})

describe('anonymous mode', () => {
  beforeAll(async () => await setConfig({ accessMode: 'anonymous', policyVersion: 1 }))
  test('modern anonymous -> 200', async () => {
    await expectBothAllow(makePayload({ contactId: anonContact.id, identityLevel: 'anonymous', policyVersion: 1 }))
  })
  test('legacy (both omitted) -> 200', async () => {
    await expectBothAllow(makePayload({ contactId: anonContact.id }))
  })
  test('identityLevel only (no policyVersion) -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: anonContact.id, identityLevel: 'anonymous' }), 'identity_token_invalid')
  })
  test('policyVersion only (no identityLevel) -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: anonContact.id, policyVersion: 1 }), 'identity_token_invalid')
  })
  test('malformed identityLevel -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: anonContact.id, identityLevel: 'bogus', policyVersion: 1 }), 'identity_token_invalid')
  })
  test('invalid policyVersion (0) -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: anonContact.id, identityLevel: 'anonymous', policyVersion: 0 }), 'identity_token_invalid')
  })
  test('wrong Contact identity class (externalUser Contact for anonymous token) -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: externalContact.id, identityLevel: 'anonymous', policyVersion: 1 }), 'identity_token_invalid')
  })
})

describe('verified_visitor mode', () => {
  beforeAll(async () => await setConfig({ accessMode: 'verified_visitor', policyVersion: 1 }))
  test('anonymous -> verification_required', async () => {
    await expectBothDenySameReason(makePayload({ contactId: verifiedContact.id, identityLevel: 'anonymous', policyVersion: 1 }), 'verification_required')
  })
  test('legacy (both omitted) -> verification_required', async () => {
    await expectBothDenySameReason(makePayload({ contactId: verifiedContact.id }), 'verification_required')
  })
  test('current verified_contact -> 200', async () => {
    await expectBothAllow(makePayload({ contactId: verifiedContact.id, identityLevel: 'verified_contact', policyVersion: 1 }))
  })
  test('current external_user -> 200 (Contact matches)', async () => {
    await expectBothAllow(makePayload({ contactId: externalContact.id, identityLevel: 'external_user', policyVersion: 1 }))
  })
  test('stale policyVersion -> policy_changed', async () => {
    await expectBothDenySameReason(makePayload({ contactId: verifiedContact.id, identityLevel: 'verified_contact', policyVersion: 999 }), 'policy_changed')
  })
  test('Contact without emailVerifiedAt -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: unverifiedContact.id, identityLevel: 'verified_contact', policyVersion: 1 }), 'identity_token_invalid')
  })
})

describe('site_user_only mode', () => {
  beforeAll(async () => await setConfig({ accessMode: 'site_user_only', policyVersion: 1 }))
  test('anonymous -> website_login_required', async () => {
    await expectBothDenySameReason(makePayload({ contactId: anonContact.id, identityLevel: 'anonymous', policyVersion: 1 }), 'website_login_required')
  })
  test('verified_contact -> website_login_required', async () => {
    await expectBothDenySameReason(makePayload({ contactId: verifiedContact.id, identityLevel: 'verified_contact', policyVersion: 1 }), 'website_login_required')
  })
  test('current external_user -> 200', async () => {
    await expectBothAllow(makePayload({ contactId: externalContact.id, identityLevel: 'external_user', policyVersion: 1 }))
  })
  test('stale external_user -> policy_changed', async () => {
    await expectBothDenySameReason(makePayload({ contactId: externalContact.id, identityLevel: 'external_user', policyVersion: 999 }), 'policy_changed')
  })
  test('wrong Contact class (visitorId) -> identity_token_invalid', async () => {
    await expectBothDenySameReason(makePayload({ contactId: verifiedContact.id, identityLevel: 'external_user', policyVersion: 1 }), 'identity_token_invalid')
  })
})

describe('corrupt policy', () => {
  beforeAll(async () => await setConfig({ accessMode: 'anonymous', policyVersion: 1 }))
  test('missing WidgetConfig -> 503 policy_unavailable (parity)', async () => {
    const orphan = await globalDb.tenant.create({
      data: { slug: `rt-orphan-${RUN_ID}`, name: `Orphan ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
      select: { id: true, slug: true },
    })
    try {
      const p: VisitorTokenPayload = {
        type: 'visitor', contactId: anonContact.id, tenantId: orphan.id, slug: orphan.slug,
        identityLevel: 'anonymous', policyVersion: 1,
      }
      await expectBothDenySameReason(p, 'policy_unavailable', 503)
    } finally {
      await globalDb.tenant.delete({ where: { id: orphan.id } })
    }
  })
  test('invalid policyVersion (corrupt DB row, pv=0) -> 503 policy_unavailable (parity)', async () => {
    await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: { policyVersion: 0 } })
    try {
      const p = makePayload({ contactId: anonContact.id, identityLevel: 'anonymous', policyVersion: 1 })
      await expectBothDenySameReason(p, 'policy_unavailable', 503)
    } finally {
      await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: { policyVersion: 1 } })
    }
  })
})

describe('production path smoke', () => {
  beforeAll(async () => await setConfig({ accessMode: 'anonymous', policyVersion: 1 }))
  test('signToken -> decode -> payload passes adapter (production wiring)', async () => {
    const p = makePayload({ contactId: anonContact.id, identityLevel: 'anonymous', policyVersion: 1 })
    const token = signToken(p)
    const [encoded] = token.split('.')
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as VisitorTokenPayload & { iat: number; exp: number }
    expect(decoded.type).toBe('visitor')
    expect(decoded.contactId).toBe(anonContact.id)
    expect(decoded.identityLevel).toBe('anonymous')
    expect(decoded.policyVersion).toBe(1)
    const ad = await callAdapter(decoded)
    expect(ad.allowed).toBe(true)
  })
})
