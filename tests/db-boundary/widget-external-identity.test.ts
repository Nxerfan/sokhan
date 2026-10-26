/// <reference types="bun-types" />
/**
 * Widget external identity — route-level mint tests (#4) + integration-secret
 * status contract (#5 API-level). (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Invokes the REAL production route handler
 * (`POST /api/widget/identity/token`) directly with constructed NextRequest
 * objects — proving the full server-to-server contract: Bearer integration-
 * secret auth, mode gate, concurrency-safe upsert, strict profile validation,
 * PII-minimized token, cross-tenant isolation, namespace collision, rotate/
 * revoke invalidation, and the integration-secret STATUS contract (never raw,
 * never hash on GET).
 *
 * The route logic is FROZEN. These tests prove the route contract end-to-end.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db, globalDb, withTenant } from '@/lib/db'
import { POST as mintIdentity } from '@/app/api/widget/identity/token/route'
import {
  generateIntegrationSecret,
  hashIntegrationSecret,
  getIntegrationSecretStatus,
} from '@/lib/widget-integration-credential'
import { verifyExternalIdentityToken } from '@/lib/widget-identity-tokens'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let tenantVV: { id: string; slug: string }
let rawA: string, rawB: string, rawVV: string

beforeAll(async () => {
  const mk = async (accessMode: 'site_user_only' | 'verified_visitor') => {
    const t = await globalDb.tenant.create({
      data: { slug: `ext-${accessMode}-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`, name: `Ext ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
      select: { id: true, slug: true },
    })
    const raw = generateIntegrationSecret()
    await globalDb.widgetConfig.create({
      data: { tenantId: t.id, accessMode, policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: hashIntegrationSecret(raw), integrationSecretRotatedAt: new Date() },
    })
    return { t, raw }
  }
  const a = await mk('site_user_only'); tenantA = a.t; rawA = a.raw
  const b = await mk('site_user_only'); tenantB = b.t; rawB = b.raw
  const vv = await mk('verified_visitor'); tenantVV = vv.t; rawVV = vv.raw
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id, tenantVV.id] } } })
})

function uniq(s: string): string {
  return `${RUN_ID}-${s}-${Math.random().toString(36).slice(2, 8)}`
}

/** Invoke the real mint route handler with a constructed NextRequest. */
async function mint(raw: string, body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/widget/identity/token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await mintIdentity(req)
  let data: any = null
  try { data = await res.json() } catch { /* non-json body */ }
  return { status: res.status, data }
}

describe('External identity mint — stable mapping + isolation', () => {
  test('same externalUserId → same Contact (stable mapping)', async () => {
    const ext = uniq('stable')
    const m1 = await mint(rawA, { externalUserId: ext })
    expect(m1.status).toBe(200)
    expect(m1.data.token).toBeTruthy()
    const c1 = verifyExternalIdentityToken(m1.data.token, tenantA.id, 1)
    expect(c1).not.toBeNull()
    expect(c1!.externalUserId).toBe(ext)
    expect(c1!.contactId).toBeTruthy()
    const contactId1 = c1!.contactId!

    const m2 = await mint(rawA, { externalUserId: ext })
    expect(m2.status).toBe(200)
    const c2 = verifyExternalIdentityToken(m2.data.token, tenantA.id, 1)
    expect(c2!.contactId).toBe(contactId1) // same contact

    // exactly one externalUser contact for this externalUserId
    const contacts = await withTenant(tenantA.id, async () => db.contact.findMany({ where: { externalUserId: ext }, select: { id: true } }))
    expect(contacts).toHaveLength(1)
  })

  test('same email + different externalUserIds → different Contacts (email is NOT identity)', async () => {
    const email = `${uniq('shared-email')}@x.test`
    const e1 = uniq('e1'), e2 = uniq('e2')
    const m1 = await mint(rawA, { externalUserId: e1, email })
    const m2 = await mint(rawA, { externalUserId: e2, email })
    expect(m1.status).toBe(200)
    expect(m2.status).toBe(200)
    const c1 = verifyExternalIdentityToken(m1.data.token, tenantA.id, 1)
    const c2 = verifyExternalIdentityToken(m2.data.token, tenantA.id, 1)
    expect(c1!.contactId).not.toBe(c2!.contactId)
    const contacts = await withTenant(tenantA.id, async () => db.contact.findMany({ where: { id: { in: [c1!.contactId!, c2!.contactId!] } }, select: { email: true } }))
    expect(contacts.every((c) => c.email === email)).toBe(true)
  })

  test('same externalUserId across tenants → isolated Contacts (cross-tenant)', async () => {
    const ext = uniq('cross')
    const mA = await mint(rawA, { externalUserId: ext })
    const mB = await mint(rawB, { externalUserId: ext })
    expect(mA.status).toBe(200)
    expect(mB.status).toBe(200)
    const cA = verifyExternalIdentityToken(mA.data.token, tenantA.id, 1)
    const cB = verifyExternalIdentityToken(mB.data.token, tenantB.id, 1)
    expect(cA!.contactId).not.toBe(cB!.contactId)
    const aContact = await withTenant(tenantA.id, async () => db.contact.findUnique({ where: { id: cA!.contactId! }, select: { tenantId: true } }))
    const bContact = await withTenant(tenantB.id, async () => db.contact.findUnique({ where: { id: cB!.contactId! }, select: { tenantId: true } }))
    expect(aContact!.tenantId).toBe(tenantA.id)
    expect(bContact!.tenantId).toBe(tenantB.id)
  })

  test('namespace collision: visitorId == externalUserId → TWO separate Contacts', async () => {
    const shared = uniq('ns-collision')
    // Pre-create an anonymous visitorId Contact whose identifier == the externalUserId.
    const anon = await withTenant(tenantA.id, async () => db.contact.create({ data: { tenantId: tenantA.id, identifier: shared, identifierType: 'visitorId', name: 'Anon', metadata: {} }, select: { id: true, identifierType: true, externalUserId: true } }))
    // Mint with externalUserId == shared → must NOT collide with the anon contact.
    const m = await mint(rawA, { externalUserId: shared })
    expect(m.status).toBe(200)
    const c = verifyExternalIdentityToken(m.data.token, tenantA.id, 1)
    expect(c!.contactId).not.toBe(anon.id) // separate contacts
    // The anon contact is untouched (still visitorId, no externalUserId).
    const anonAfter = await withTenant(tenantA.id, async () => db.contact.findUnique({ where: { id: anon.id }, select: { identifierType: true, externalUserId: true } }))
    expect(anonAfter!.identifierType).toBe('visitorId')
    expect(anonAfter!.externalUserId).toBeNull()
    // The minted contact is externalUser with externalUserId == shared.
    const extContact = await withTenant(tenantA.id, async () => db.contact.findUnique({ where: { id: c!.contactId! }, select: { identifierType: true, externalUserId: true } }))
    expect(extContact!.identifierType).toBe('externalUser')
    expect(extContact!.externalUserId).toBe(shared)
  })
})

describe('External identity mint — profile contract', () => {
  test('profile omission preserves existing values (omitted ≠ erased)', async () => {
    const ext = uniq('omit')
    // First mint with NO profile → contact created with fallback name.
    const m1 = await mint(rawA, { externalUserId: ext })
    expect(m1.status).toBe(200)
    const c1 = verifyExternalIdentityToken(m1.data.token, tenantA.id, 1)
    const before = await withTenant(tenantA.id, async () => db.contact.findUnique({ where: { id: c1!.contactId! }, select: { name: true, email: true, avatarUrl: true } }))
    expect(before!.name).toBe('Authenticated user') // display fallback
    expect(before!.email).toBeNull()
    expect(before!.avatarUrl).toBeNull()
    // Second mint with ONLY name (email + avatar omitted → preserved, not erased).
    const m2 = await mint(rawA, { externalUserId: ext, name: 'Real Name' })
    expect(m2.status).toBe(200)
    const after = await withTenant(tenantA.id, async () => db.contact.findUnique({ where: { id: c1!.contactId! }, select: { name: true, email: true, avatarUrl: true } }))
    expect(after!.name).toBe('Real Name') // updated
    expect(after!.email).toBeNull() // preserved (omitted)
    expect(after!.avatarUrl).toBeNull() // preserved (omitted)
  })

  test('malformed profile field (non-string) → 400 invalid_profile, no Contact created', async () => {
    const ext = uniq('malformed')
    const m = await mint(rawA, { externalUserId: ext, name: 123 })
    expect(m.status).toBe(400)
    expect(m.data.error).toBe('invalid_profile')
    // No contact created for this externalUserId.
    const contacts = await withTenant(tenantA.id, async () => db.contact.findMany({ where: { externalUserId: ext } }))
    expect(contacts).toHaveLength(0)
  })

  test('token carries NO PII (only externalUserId + contactId + tenantId + policyVersion)', async () => {
    const ext = uniq('pii')
    const m = await mint(rawA, { externalUserId: ext, email: `${uniq('pii')}@x.test`, name: 'PII User', avatarUrl: 'https://x.test/a.png' })
    expect(m.status).toBe(200)
    // Decode the token envelope payload (base64url) — the signer must NOT
    // embed email/name/avatarUrl (Blocker 5 — PII minimization).
    const payload = JSON.parse(Buffer.from(m.data.token.split('.')[0], 'base64url').toString())
    expect(payload.type).toBe('external_identity')
    expect(payload.aud).toBe('sukhan-external')
    expect(payload.externalUserId).toBe(ext)
    expect(payload.contactId).toBeTruthy()
    expect(payload.tenantId).toBe(tenantA.id)
    expect(payload.identityLevel).toBe('external_user')
    expect(payload.email).toBeUndefined()
    expect(payload.name).toBeUndefined()
    expect(payload.avatarUrl).toBeUndefined()
    expect(payload.username).toBeUndefined()
  })
})

describe('External identity mint — concurrency', () => {
  test('10 concurrent mints for the same NEW externalUserId → one Contact, no 500/P2002 leak', async () => {
    const ext = uniq('conc')
    const results = await Promise.all(Array.from({ length: 10 }, () => mint(rawA, { externalUserId: ext })))
    for (const r of results) expect(r.status).toBe(200)
    // All tokens resolve to the SAME contactId.
    const contactIds = results.map((r) => verifyExternalIdentityToken(r.data.token, tenantA.id, 1)!.contactId)
    expect(new Set(contactIds).size).toBe(1)
    // Exactly one externalUser contact row for this externalUserId.
    const contacts = await withTenant(tenantA.id, async () => db.contact.findMany({ where: { externalUserId: ext }, select: { id: true } }))
    expect(contacts).toHaveLength(1)
  })
})

describe('External identity mint — auth + mode gate', () => {
  test('no Bearer → 401 unauthorized', async () => {
    const req = new NextRequest('http://localhost/api/widget/identity/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalUserId: uniq('noauth') }),
    })
    const res = await mintIdentity(req)
    expect(res.status).toBe(401)
  })

  test('wrong secret → 401 unauthorized', async () => {
    const m = await mint('not-a-real-secret', { externalUserId: uniq('wrong') })
    expect(m.status).toBe(401)
  })

  test('verified_visitor tenant → 409 mode_mismatch (mint is site_user_only only)', async () => {
    const m = await mint(rawVV, { externalUserId: uniq('vv') })
    expect(m.status).toBe(409)
    expect(m.data.error).toBe('mode_mismatch')
  })
})

describe('Integration secret — rotate + revoke invalidate minting (#5 API-level)', () => {
  // Dedicated tenant so rotate/revoke does not interfere with the shared fixtures.
  let tRot: { id: string }
  let raw1: string, raw2: string

  beforeAll(async () => {
    tRot = await globalDb.tenant.create({ data: { slug: `ext-rot-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`, name: 'Rot', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true, slug: true } })
    raw1 = generateIntegrationSecret()
    await globalDb.widgetConfig.create({ data: { tenantId: tRot.id, accessMode: 'site_user_only', policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: hashIntegrationSecret(raw1), integrationSecretRotatedAt: new Date() } })
    raw2 = generateIntegrationSecret()
  })
  afterAll(async () => { await globalDb.tenant.deleteMany({ where: { id: tRot.id } }) })

  test('rotate: old secret can no longer mint, new secret can', async () => {
    // raw1 works before rotate.
    const mBefore = await mint(raw1, { externalUserId: uniq('rot-before') })
    expect(mBefore.status).toBe(200)
    // Rotate: replace hash with raw2's hash + bump policyVersion.
    await globalDb.widgetConfig.update({ where: { tenantId: tRot.id }, data: { integrationSecretHash: hashIntegrationSecret(raw2), integrationSecretRotatedAt: new Date(), policyVersion: { increment: 1 } } })
    // Old raw1 can no longer mint (hash no longer matches).
    const mOld = await mint(raw1, { externalUserId: uniq('rot-old') })
    expect(mOld.status).toBe(401)
    // New raw2 mints — and the token is bound to the NEW policyVersion (2).
    const mNew = await mint(raw2, { externalUserId: uniq('rot-new') })
    expect(mNew.status).toBe(200)
    const c = verifyExternalIdentityToken(mNew.data.token, tRot.id, 2)
    expect(c).not.toBeNull()
    // The old policyVersion (1) no longer verifies (rotation invalidated it).
    const cStale = verifyExternalIdentityToken(mNew.data.token, tRot.id, 1)
    expect(cStale).toBeNull()
  })

  test('revoke: no secret can mint; status reflects hasSecret=false', async () => {
    // Revoke: clear the hash.
    await globalDb.widgetConfig.update({ where: { tenantId: tRot.id }, data: { integrationSecretHash: null, integrationSecretRotatedAt: null, policyVersion: { increment: 1 } } })
    const mRevoked = await mint(raw2, { externalUserId: uniq('revoked') })
    expect(mRevoked.status).toBe(401)
    // Status (via the lib the GET route uses) — never raw, never hash.
    const status = await withTenant(tRot.id, async () => getIntegrationSecretStatus())
    expect(status.hasSecret).toBe(false)
    expect(status.rotatedAt).toBeNull()
    expect(status.rawSecret).toBeNull() // NEVER exposed on GET
  })

  test('status never returns the raw secret or the hash (PII/secret contract)', async () => {
    // Restore a secret on tenantA, then assert the status shape.
    const status = await withTenant(tenantA.id, async () => getIntegrationSecretStatus())
    expect(status.hasSecret).toBe(true)
    expect(status.rotatedAt).not.toBeNull()
    expect(status.rawSecret).toBeNull() // the raw secret is NEVER in a status read
    // The status object has no hash field at all.
    expect((status as unknown as Record<string, unknown>).integrationSecretHash).toBeUndefined()
  })
})
