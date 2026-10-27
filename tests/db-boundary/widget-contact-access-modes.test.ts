/// <reference types="bun-types" />
/**
 * Widget contact/bootstrap — THREE-MODE access-policy route tests.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Exercises the REAL contact route handler (POST /api/widget/[slug]/contact)
 * against real PostgreSQL. Proves the three-mode bootstrap contract:
 *   - anonymous: historical visitor bootstrap (visitorId identity) + NEW tokens
 *     carry identityLevel=anonymous + policyVersion. identity_conflict on an
 *     incompatible existing Contact.
 *   - verified_visitor: resume credential required + DB-revalidated (visitorId,
 *     externalUserId=null, emailVerifiedAt!=null) + no profile mutation + token
 *     identityLevel=verified_contact.
 *   - site_user_only: external identity token required + contactId/externalUserId
 *     DB-revalidated (externalUser, externalUserId match) + token
 *     identityLevel=external_user.
 * Cross-credential rejection (mode-authoritative), policy transitions at
 * bootstrap, corrupt-policy 503, + token-claim verification (verifyToken).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db, globalDb, withTenant } from '@/lib/db'
import { POST as contactRoute } from '@/app/api/widget/[slug]/contact/route'
import { signResumeCredential, signExternalIdentityToken, tamperToken } from '@/lib/widget-identity-tokens'
import { verifyToken } from '@/lib/realtime-token'
import crypto from 'crypto'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const MOCK_CODE = '123456'

let tenant: { id: string; slug: string; defaultLocale: string; defaultDirection: string }
let tenantB: { id: string; slug: string }

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `contact-${RUN_ID}`, name: `Contact ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true, defaultLocale: true, defaultDirection: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenant.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  // A second tenant for cross-tenant-credential tests.
  tenantB = await globalDb.tenant.create({
    data: { slug: `contact-b-${RUN_ID}`, name: `Contact B ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'verified_visitor', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenant.id, tenantB.id] } } })
})

function uniq(s: string): string {
  return `${RUN_ID}-${s}-${Math.random().toString(36).slice(2, 8)}`
}

/** Set the tenant's accessMode + policyVersion. */
async function setMode(accessMode: string, policyVersion: number) {
  await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: { accessMode, policyVersion } })
}

/** Invoke the REAL contact route handler. */
async function callContact(body: Record<string, unknown> | null, bearer?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  const req = new NextRequest(`http://localhost/api/widget/${tenant.slug}/contact`, {
    method: 'POST',
    headers,
    body: body === null ? 'not-json' : JSON.stringify(body),
  })
  const res = await contactRoute(req, { params: Promise.resolve({ slug: tenant.slug }) })
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

/** Verify a realtime token + assert the full claim set. */
function assertTokenClaims(token: string, expected: { contactId: string; identityLevel: 'anonymous' | 'verified_contact' | 'external_user'; policyVersion: number }) {
  const claims = verifyToken(token)
  expect(claims, 'realtime token should verify').not.toBeNull()
  if (!claims || claims.type !== 'visitor') throw new Error('expected visitor realtime token')
  expect(claims.type).toBe('visitor')
  expect(claims.contactId).toBe(expected.contactId)
  expect(claims.tenantId).toBe(tenant.id)
  expect(claims.slug).toBe(tenant.slug)
  expect(claims.identityLevel).toBe(expected.identityLevel)
  expect(claims.policyVersion).toBe(expected.policyVersion)
}

/** Create a visitorId Contact with emailVerifiedAt set (for verified_visitor). */
async function createVerifiedContact(visitorId: string, email: string) {
  return withTenant(tenant.id, async () => {
    return db.contact.create({
      data: { tenantId: tenant.id, identifier: visitorId, identifierType: 'visitorId', name: 'Verified', email, emailVerifiedAt: new Date(), locale: 'fa', metadata: {} },
      select: { id: true, identifier: true, identifierType: true, externalUserId: true, email: true, name: true, emailVerifiedAt: true },
    })
  })
}

/** Create an externalUser Contact (for site_user_only). */
async function createExternalContact(externalUserId: string) {
  return withTenant(tenant.id, async () => {
    return db.contact.create({
      data: { tenantId: tenant.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId, name: 'External', locale: 'fa', metadata: {} },
      select: { id: true, externalUserId: true, identifierType: true },
    })
  })
}

/** Drop the WidgetConfig_accessMode_check to allow a corrupt accessMode for
 *  testing the route's parseAccessMode fail-closed path (defense-in-depth).
 *  Restored in finally. (bun runs db-boundary files sequentially — no global
 *  CHECK-drop race with widget-access-config.test.ts's withCorruptAccessMode.) */
async function withCorruptAccessMode<T>(corruptMode: string, fn: () => Promise<T>): Promise<T> {
  await globalDb.$executeRawUnsafe(`ALTER TABLE "WidgetConfig" DROP CONSTRAINT IF EXISTS "WidgetConfig_accessMode_check"`)
  try {
    await setMode(corruptMode, 4)
    return await fn()
  } finally {
    try {
      await globalDb.$executeRawUnsafe(`ALTER TABLE "WidgetConfig" ADD CONSTRAINT "WidgetConfig_accessMode_check" CHECK ("accessMode" IN ('anonymous','verified_visitor','site_user_only'))`)
    } catch { /* already exists */ }
    await setMode('anonymous', 1)
  }
}

// === anonymous mode ===

describe('contact — anonymous mode', () => {
  test('no credential -> success; Contact visitorId/null externalUserId; token identityLevel=anonymous + policyVersion', async () => {
    await setMode('anonymous', 3)
    const vid = uniq('anon')
    const r = await callContact({ visitorId: vid, email: `${uniq('anon')}@x.test`, name: 'Anon' })
    expect(r.status).toBe(200)
    expect(r.data.contactId).toBeTruthy()
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: r.data.contactId }, select: { identifierType: true, externalUserId: true, identifier: true } }))
    expect(c!.identifierType).toBe('visitorId')
    expect(c!.externalUserId).toBeNull()
    expect(c!.identifier).toBe(vid)
    assertTokenClaims(r.data.realtimeToken, { contactId: r.data.contactId, identityLevel: 'anonymous', policyVersion: 3 })
  })

  test('same visitorId -> same Contact; same email + different visitorId -> different Contact', async () => {
    await setMode('anonymous', 1)
    const email = `${uniq('shared')}@x.test`
    const vid1 = uniq('sv1'), vid2 = uniq('sv2')
    const r1 = await callContact({ visitorId: vid1, email })
    const r1b = await callContact({ visitorId: vid1, email })
    expect(r1.data.contactId).toBe(r1b.data.contactId) // same visitorId -> same Contact
    const r2 = await callContact({ visitorId: vid2, email })
    expect(r2.data.contactId).not.toBe(r1.data.contactId) // different visitorId -> different Contact (even same email)
  })

  test('existing open conversation returned; historical profile update behavior', async () => {
    await setMode('anonymous', 1)
    const vid = uniq('conv')
    // First bootstrap creates the Contact + no conversation (conversationId null).
    const r1 = await callContact({ visitorId: vid, name: 'First' })
    expect(r1.data.conversationId).toBeNull()
    // Create an open conversation for this Contact.
    const conv = await withTenant(tenant.id, async () => {
      return db.conversation.create({ data: { tenantId: tenant.id, contactId: r1.data.contactId, status: 'open', tags: [], lastMessagePreview: '' }, select: { id: true } })
    })
    // Second bootstrap returns the EXISTING open conversation.
    const r2 = await callContact({ visitorId: vid, name: 'Second' })
    expect(r2.data.conversationId).toBe(conv.id)
  })

  test('identity_conflict: existing external-user Contact with a colliding identifier -> 403', async () => {
    await setMode('anonymous', 1)
    const vid = uniq('collide')
    // Pre-create an external-user Contact whose identifier == the visitorId.
    await withTenant(tenant.id, async () => {
      await db.contact.create({ data: { tenantId: tenant.id, identifier: vid, identifierType: 'externalUser', externalUserId: `ext_${uniq('c')}`, locale: 'fa', metadata: {} } })
    })
    const r = await callContact({ visitorId: vid })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_conflict')
  })
})

// === verified_visitor mode ===

describe('contact — verified_visitor mode', () => {
  test('no credential -> verification_required (no token, no new Contact)', async () => {
    await setMode('verified_visitor', 5)
    const r = await callContact({ visitorId: uniq('vv'), email: `${uniq('vv')}@x.test` })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
    expect(r.data.realtimeToken).toBeUndefined()
  })

  test('malformed bearer -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    const r = await callContact({ visitorId: uniq('vv') }, 'not-a-valid-token')
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('external identity token -> verification_required (cross-credential)', async () => {
    await setMode('verified_visitor', 5)
    const ext = await createExternalContact(`ext_${uniq('cross')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 5 })
    const r = await callContact({ visitorId: uniq('vv') }, extToken)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('wrong-tenant resume -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    const contact = await createVerifiedContact(uniq('wt'), `${uniq('wt')}@x.test`)
    // Sign the resume for tenantB (wrong tenant).
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenantB.id, policyVersion: 5 })
    const r = await callContact({ visitorId: uniq('wt') }, resume)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('stale-policy resume -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    const contact = await createVerifiedContact(uniq('sp'), `${uniq('sp')}@x.test`)
    // Sign a resume with policyVersion=1 (stale — current is 5).
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 1 })
    const r = await callContact({ visitorId: uniq('sp') }, resume)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('tampered resume -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    const contact = await createVerifiedContact(uniq('tp'), `${uniq('tp')}@x.test`)
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 5 })
    const r = await callContact({ visitorId: uniq('tp') }, tamperToken(resume))
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('valid resume -> success; profile NOT mutated by frontend name/email; token verified_contact + policyVersion', async () => {
    await setMode('verified_visitor', 7)
    const contact = await createVerifiedContact(uniq('vr'), `orig-${uniq('vr')}@x.test`)
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 7 })
    // Frontend supplies a DIFFERENT name/email — must NOT mutate the Contact.
    const r = await callContact({ visitorId: uniq('vr'), email: `different-${uniq('vr')}@x.test`, name: 'Different Name' }, resume)
    expect(r.status).toBe(200)
    expect(r.data.contactId).toBe(contact.id)
    // Contact profile UNCHANGED (no mutation during resume).
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contact.id }, select: { email: true, name: true, emailVerifiedAt: true, externalUserId: true, identifierType: true } }))
    expect(c!.email).toBe(contact.email) // NOT mutated
    expect(c!.name).toBe(contact.name) // NOT mutated
    expect(c!.emailVerifiedAt).not.toBeNull()
    assertTokenClaims(r.data.realtimeToken, { contactId: contact.id, identityLevel: 'verified_contact', policyVersion: 7 })
  })

  test('Contact wrong identity class -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    // Create an externalUser Contact (wrong identity class) + sign a resume for it
    // (the resume signer doesn't check identity class — the route does).
    const ext = await createExternalContact(`ext_${uniq('wic')}`)
    const resume = signResumeCredential({ contactId: ext.id, tenantId: tenant.id, policyVersion: 5 })
    const r = await callContact({ visitorId: uniq('wic') }, resume)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })

  test('Contact without emailVerifiedAt -> verification_required', async () => {
    await setMode('verified_visitor', 5)
    // Create a visitorId Contact WITHOUT emailVerifiedAt.
    const c = await withTenant(tenant.id, async () => db.contact.create({ data: { tenantId: tenant.id, identifier: uniq('nev'), identifierType: 'visitorId', name: 'Unverified', locale: 'fa', metadata: {} }, select: { id: true } }))
    const resume = signResumeCredential({ contactId: c.id, tenantId: tenant.id, policyVersion: 5 })
    const r = await callContact({ visitorId: uniq('nev') }, resume)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
  })
})

// === site_user_only mode ===

describe('contact — site_user_only mode', () => {
  test('no credential -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    const r = await callContact({ visitorId: uniq('su'), email: `${uniq('su')}@x.test`, name: 'Site' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
    expect(r.data.realtimeToken).toBeUndefined()
  })

  test('malformed bearer -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    const r = await callContact({ visitorId: uniq('su') }, 'not-a-valid-token')
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('resume credential -> website_login_required (cross-credential)', async () => {
    await setMode('site_user_only', 9)
    const contact = await createVerifiedContact(uniq('rc'), `${uniq('rc')}@x.test`)
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 9 })
    const r = await callContact({ visitorId: uniq('rc') }, resume)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('stale external token -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    const ext = await createExternalContact(`ext_${uniq('se')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 1 })
    const r = await callContact({ visitorId: uniq('se') }, extToken)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('wrong-tenant external token -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    const ext = await createExternalContact(`ext_${uniq('wt2')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenantB.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 9 })
    const r = await callContact({ visitorId: uniq('wt2') }, extToken)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('tampered external token -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    const ext = await createExternalContact(`ext_${uniq('tt')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 9 })
    const r = await callContact({ visitorId: uniq('tt') }, tamperToken(extToken))
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('missing-contactId external token -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    // Sign an external token WITHOUT contactId (contactId?: string | null).
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: `ext_${uniq('mc')}`, policyVersion: 9 })
    const r = await callContact({ visitorId: uniq('mc') }, extToken)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })

  test('valid external token -> success; DB binding externalUserId matches; frontend cannot switch Contact; token external_user + policyVersion', async () => {
    await setMode('site_user_only', 11)
    const ext = await createExternalContact(`ext_${uniq('ok')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 11 })
    // Frontend supplies visitorId/email/name — must NOT switch the Contact.
    const r = await callContact({ visitorId: uniq('ok'), email: `${uniq('ok')}@x.test`, name: 'Frontend Name' }, extToken)
    expect(r.status).toBe(200)
    expect(r.data.contactId).toBe(ext.id) // the EXTERNAL Contact (not a new anonymous one)
    assertTokenClaims(r.data.realtimeToken, { contactId: ext.id, identityLevel: 'external_user', policyVersion: 11 })
  })

  test('Contact externalUserId mismatch -> website_login_required', async () => {
    await setMode('site_user_only', 9)
    // Create an externalUser Contact with externalUserId X.
    const ext = await createExternalContact(`ext_${uniq('mm')}`)
    // Sign an external token with a DIFFERENT externalUserId (but the same contactId).
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: `different_${uniq('mm')}`, contactId: ext.id, policyVersion: 9 })
    const r = await callContact({ visitorId: uniq('mm') }, extToken)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
  })
})

// === policy transitions at bootstrap ===

describe('contact — policy transitions at bootstrap', () => {
  test('anonymous -> verified_visitor: old anonymous bootstrap DENIED; current resume ALLOWED', async () => {
    // anonymous bootstrap succeeds.
    await setMode('anonymous', 1)
    const vid = uniq('tr1')
    const r1 = await callContact({ visitorId: vid })
    expect(r1.status).toBe(200)
    // Transition to verified_visitor + policyVersion increment.
    await setMode('verified_visitor', 2)
    // Old anonymous bootstrap (visitorId only) now DENIED.
    const r2 = await callContact({ visitorId: vid })
    expect(r2.status).toBe(403)
    expect(r2.data.error).toBe('verification_required')
    // A current resume credential ALLOWED.
    const contact = await createVerifiedContact(uniq('tr1v'), `${uniq('tr1v')}@x.test`)
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 2 })
    const r3 = await callContact({ visitorId: uniq('tr1v') }, resume)
    expect(r3.status).toBe(200)
  })

  test('verified_visitor -> site_user_only: verified resume DENIED; current external token ALLOWED', async () => {
    await setMode('verified_visitor', 3)
    const contact = await createVerifiedContact(uniq('tr2'), `${uniq('tr2')}@x.test`)
    const resume = signResumeCredential({ contactId: contact.id, tenantId: tenant.id, policyVersion: 3 })
    // Transition to site_user_only + policyVersion increment.
    await setMode('site_user_only', 4)
    // Verified resume now DENIED (cross-credential + stale policy).
    const r1 = await callContact({ visitorId: uniq('tr2') }, resume)
    expect(r1.status).toBe(403)
    expect(r1.data.error).toBe('website_login_required')
    // A current external identity token ALLOWED.
    const ext = await createExternalContact(`ext_${uniq('tr2e')}`)
    const extToken = signExternalIdentityToken({ tenantId: tenant.id, externalUserId: ext.externalUserId!, contactId: ext.id, policyVersion: 4 })
    const r2 = await callContact({ visitorId: uniq('tr2e') }, extToken)
    expect(r2.status).toBe(200)
  })
})

// === corrupt policy 503 ===

describe('contact — corrupt policy 503', () => {
  test('missing WidgetConfig -> 503 policy_unavailable', async () => {
    await setMode('anonymous', 1)
    // Delete the WidgetConfig.
    await withTenant(tenant.id, async () => db.widgetConfig.delete({ where: { tenantId: tenant.id } }))
    try {
      const r = await callContact({ visitorId: uniq('miss') })
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
    } finally {
      await globalDb.widgetConfig.create({ data: { tenantId: tenant.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } } })
    }
  })

  test('invalid accessMode -> 503 (DDL dance — DB CHECK normally prevents it)', async () => {
    await withCorruptAccessMode('corrupt_mode', async () => {
      const r = await callContact({ visitorId: uniq('cam') })
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
    })
  })

  test('invalid policyVersion -> 503', async () => {
    await setMode('anonymous', 0)
    const r = await callContact({ visitorId: uniq('ipv') })
    expect(r.status).toBe(503)
    expect(r.data.error).toBe('policy_unavailable')
    await setMode('anonymous', 1)
  })
})
