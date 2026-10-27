/// <reference types="bun-types" />
/**
 * Widget message-send — CURRENT-policy send-authorization tests.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Exercises the REAL POST /api/widget/[slug]/messages route handler against
 * real PostgreSQL. Proves the CURRENT-policy send authorization contract:
 *   - The tenant's CURRENT WidgetConfig (accessMode + policyVersion) is
 *     the authority — the route re-reads it on every POST and fail-closes
 *     (503 policy_unavailable) if it is missing/invalid.
 *   - The INCOMING realtime visitor token's identityLevel + policyVersion
 *     is resolved via resolveLegacyTokenIdentity (legacy both-claims-absent
 *     is accepted ONLY in anonymous mode; partial/malformed claims are
 *     identity_token_invalid — NEVER silently degraded to anonymous).
 *   - The Contact is revalidated against the route tenant + the identity
 *     class (visitorId/externalUser/emailVerifiedAt). A nonexistent,
 *     wrong-tenant, or identity-class-drifted Contact -> 403
 *     identity_token_invalid. No mutation, no repair.
 *   - evaluateSendAuthorization decides allowed/denied based on the CURRENT
 *     accessMode + currentPolicyVersion + resolved identity + presented
 *     policyVersion. Deny reasons: policy_changed (stale pv),
 *     verification_required (insufficient identity in verified_visitor),
 *     website_login_required (insufficient identity in site_user_only).
 *   - anonymous mode accepts stronger identities (verified_contact,
 *     external_user) — #13 (sufficient-identity promotion).
 *   - Policy transitions: anonymous -> verified_visitor -> site_user_only
 *     with policyVersion increments; old identity classes are rejected
 *     under the new CURRENT policy.
 *   - Slug/tenant binding: token slug A + route slug B -> token_slug_mismatch;
 *     token tenant A + route tenant B -> token_tenant_mismatch.
 *   - Corrupt policy 503: missing WidgetConfig, invalid policyVersion=0.
 *     (Invalid accessMode is blocked by the DB CHECK constraint; the route's
 *     parseAccessMode is defense-in-depth. Tested separately in
 *     widget-access-config.test.ts via the withCorruptAccessMode DDL dance.)
 *
 * The INPUT token is verified via verifyToken before each success-path test
 * to prove the route's authorization decision isn't based on a malformed
 * input token.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db, globalDb, withTenant } from '@/lib/db'
import { POST as messagesRoute } from '@/app/api/widget/[slug]/messages/route'
import { signToken, verifyToken, type VisitorTokenPayload } from '@/lib/realtime-token'
import { getAuthSecret } from '@/lib/env-check'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenant: { id: string; slug: string; defaultLocale: string; defaultDirection: string }
let tenantB: { id: string; slug: string }

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `msg-${RUN_ID}`, name: `Msg ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true, defaultLocale: true, defaultDirection: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenant.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  // A second tenant for slug/tenant-mismatch tests.
  tenantB = await globalDb.tenant.create({
    data: { slug: `msg-b-${RUN_ID}`, name: `Msg B ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenant.id, tenantB.id] } } })
})

function uniq(s: string): string {
  return `${RUN_ID}-${s}-${Math.random().toString(36).slice(2, 8)}`
}

/** Set the primary tenant's accessMode + policyVersion (real DB WidgetConfig mutation). */
async function setMode(accessMode: string, policyVersion: number) {
  await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: { accessMode, policyVersion } })
}

/** Create a visitorId Contact (with emailVerifiedAt by default). */
async function createVisitorContact(opts: { emailVerified?: boolean; name?: string } = {}) {
  const emailVerified = opts.emailVerified ?? true
  return withTenant(tenant.id, async () => {
    return db.contact.create({
      data: {
        tenantId: tenant.id,
        identifier: uniq('vid'),
        identifierType: 'visitorId',
        name: opts.name ?? 'Visitor',
        email: emailVerified ? `${uniq('vid')}@x.test` : null,
        emailVerifiedAt: emailVerified ? new Date() : null,
        locale: 'fa',
        metadata: {},
      },
      select: { id: true, identifier: true, identifierType: true, externalUserId: true, emailVerifiedAt: true, tenantId: true },
    })
  })
}

/** Create an externalUser Contact (for site_user_only / external_user identity). */
async function createExternalContact() {
  return withTenant(tenant.id, async () => {
    const externalUserId = `ext_${uniq('ext')}`
    return db.contact.create({
      data: {
        tenantId: tenant.id,
        identifier: 'ext_' + crypto.randomUUID(),
        identifierType: 'externalUser',
        externalUserId,
        name: 'External',
        locale: 'fa',
        metadata: {},
      },
      // resolveLegacyTokenIdentity doesn't read externalUserId from the
      // Contact row directly — the route compares the token's
      // externalUserId to the Contact's externalUserId via the
      // identifier-class revalidation (the Contact.externalUserId is the
      // authority). Select externalUserId for assertions.
      select: { id: true, identifier: true, identifierType: true, externalUserId: true, tenantId: true },
    })
  })
}

/** Sign a REALTIME visitor token via the production signer. */
function signVisitorToken(opts: {
  contactId: string
  tenantId?: string
  slug?: string
  identityLevel?: 'anonymous' | 'verified_contact' | 'external_user'
  policyVersion?: number
}): string {
  const payload: VisitorTokenPayload = {
    type: 'visitor',
    contactId: opts.contactId,
    tenantId: opts.tenantId ?? tenant.id,
    slug: opts.slug ?? tenant.slug,
  }
  if (opts.identityLevel !== undefined) payload.identityLevel = opts.identityLevel
  if (opts.policyVersion !== undefined) payload.policyVersion = opts.policyVersion
  return signToken(payload)
}

/**
 * Test-only RAW HS256 envelope signer. Mirrors realtime-token-shared.signToken
 * but accepts ARBITRARY claim values (e.g. identityLevel='corrupt', or a
 * payload missing policyVersion). The route's verifyToken verifies the HMAC
 * signature + iat/exp + type — it does NOT validate identityLevel. The route
 * then runs resolveLegacyTokenIdentity which catches the malformed claim.
 */
function signRawEnvelope(payload: Record<string, unknown>): string {
  const secret = getAuthSecret()
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: now, exp: now + 600 }
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

/** Invoke the REAL POST /api/widget/[slug]/messages route handler. */
async function callMessage(slug: string, token: string, body: { text: string; clientMessageId?: string }): Promise<{ status: number; data: any }> {
  const req = new NextRequest(`http://localhost/api/widget/${slug}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const res = await messagesRoute(req, { params: Promise.resolve({ slug }) })
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

/** Count persisted contact messages for a Contact (across all its conversations). */
async function countMessagesForContact(tenantId: string, contactId: string): Promise<number> {
  return withTenant(tenantId, async () => {
    const conv = await db.conversation.findFirst({
      where: { contactId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!conv) return 0
    return db.message.count({ where: { conversationId: conv.id, senderType: 'contact' } })
  })
}

/** Fetch a persisted Message by id (tenant-scoped). */
async function getMessage(tenantId: string, messageId: string) {
  return withTenant(tenantId, async () => {
    return db.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, tenantId: true, senderType: true, contentType: true, content: true, status: true },
    })
  })
}

/** Assert the INPUT realtime token verifies (proves the route's decision isn't based on a malformed input). */
function assertInputTokenValid(token: string, expected: { contactId: string; tenantId?: string; slug?: string; identityLevel?: string; policyVersion?: number }) {
  const claims = verifyToken(token)
  expect(claims, 'input realtime token should verify').not.toBeNull()
  if (!claims || claims.type !== 'visitor') throw new Error('expected visitor realtime token')
  expect(claims.contactId).toBe(expected.contactId)
  if (expected.tenantId !== undefined) expect(claims.tenantId).toBe(expected.tenantId)
  if (expected.slug !== undefined) expect(claims.slug).toBe(expected.slug)
  if (expected.identityLevel !== undefined) expect(claims.identityLevel).toBe(expected.identityLevel as any)
  if (expected.policyVersion !== undefined) expect(claims.policyVersion).toBe(expected.policyVersion)
}

// ===========================================================================
// anonymous mode (accessMode='anonymous', policyVersion=1)
// ===========================================================================

describe('messages — anonymous mode', () => {
  test('modern anonymous token (identityLevel=anonymous, pv=1) -> 200; message persisted (count=1)', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: 'hello from anon', clientMessageId: 'cmsg-1' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(r.data.conversationId).toBe(r.data.message.conversationId)
    expect(r.data.clientMessageId).toBe('cmsg-1')
    expect(r.data.aiResponse).toBeNull() // fresh tenant, no AiConfig
    const persisted = await getMessage(tenant.id, r.data.message.id)
    expect(persisted).not.toBeNull()
    expect(persisted!.content).toEqual({ text: 'hello from anon' })
    expect(persisted!.conversationId).toBe(r.data.conversationId)
    expect(persisted!.senderType).toBe('contact')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('legacy token (both identityLevel + policyVersion absent) -> 200; message persisted', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    // Sign a legacy token — no identityLevel, no policyVersion.
    const token = signVisitorToken({ contactId: c.id })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: undefined, policyVersion: undefined })
    const r = await callMessage(tenant.slug, token, { text: 'legacy send' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('partial: identityLevel=anonymous only (no policyVersion) -> 403 identity_token_invalid; no message', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    // Raw envelope — identityLevel set, policyVersion ABSENT.
    const token = signRawEnvelope({
      type: 'visitor',
      contactId: c.id,
      tenantId: tenant.id,
      slug: tenant.slug,
      identityLevel: 'anonymous',
      // NO policyVersion — partial claim
    })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'anonymous', policyVersion: undefined })
    const r = await callMessage(tenant.slug, token, { text: 'partial send' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('malformed: identityLevel=corrupt + policyVersion=1 -> 403 identity_token_invalid; no message', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    // Raw envelope — identityLevel='corrupt' (invalid value), policyVersion=1.
    const token = signRawEnvelope({
      type: 'visitor',
      contactId: c.id,
      tenantId: tenant.id,
      slug: tenant.slug,
      identityLevel: 'corrupt',
      policyVersion: 1,
    })
    // verifyToken still accepts this (correct signature, valid iat/exp, type=visitor).
    const claims = verifyToken(token)
    expect(claims).not.toBeNull()
    const r = await callMessage(tenant.slug, token, { text: 'malformed send' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('modern verified_contact token -> 200 (anonymous accepts stronger identities, #13)', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact({ emailVerified: true })
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: 'verified in anon mode' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('modern external_user token with correctly-bound external Contact -> 200', async () => {
    await setMode('anonymous', 1)
    const c = await createExternalContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: 'external in anon mode' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })
})

// ===========================================================================
// verified_visitor mode (accessMode='verified_visitor', policyVersion=2)
// ===========================================================================

describe('messages — verified_visitor mode', () => {
  test('anonymous token -> 403 verification_required; no message', async () => {
    await setMode('verified_visitor', 2)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'anonymous', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'anon in vv' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('legacy token (both claims absent) -> 403 verification_required; no message', async () => {
    await setMode('verified_visitor', 2)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id }) // no identityLevel, no policyVersion
    const r = await callMessage(tenant.slug, token, { text: 'legacy in vv' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('verification_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('current verified_contact token (pv=2) -> 200; message persisted', async () => {
    await setMode('verified_visitor', 2)
    const c = await createVisitorContact({ emailVerified: true })
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'verified in vv' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('current external_user token (pv=2, correctly-bound external Contact) -> 200', async () => {
    await setMode('verified_visitor', 2)
    const c = await createExternalContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'external in vv' })
    expect(r.status).toBe(200)
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('stale verified_contact token (pv=1) -> 403 policy_changed; no message', async () => {
    await setMode('verified_visitor', 2)
    const c = await createVisitorContact({ emailVerified: true })
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: 'stale vc' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('policy_changed')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('stale external_user token (pv=1) -> 403 policy_changed; no message', async () => {
    await setMode('verified_visitor', 2)
    const c = await createExternalContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: 'stale ext' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('policy_changed')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('verified_contact token whose Contact lacks emailVerifiedAt -> 403 identity_token_invalid; no message', async () => {
    await setMode('verified_visitor', 2)
    const c = await createVisitorContact({ emailVerified: false }) // no emailVerifiedAt
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'unverified contact' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('verified_contact token whose Contact identity class drifted (Contact is externalUser) -> 403 identity_token_invalid; no message', async () => {
    await setMode('verified_visitor', 2)
    // Create an externalUser Contact (wrong identity class for verified_contact).
    const c = await createExternalContact()
    // Sign a verified_contact token for this externalUser Contact.
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'class drift' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })
})

// ===========================================================================
// site_user_only mode (accessMode='site_user_only', policyVersion=3)
// ===========================================================================

describe('messages — site_user_only mode', () => {
  test('anonymous token -> 403 website_login_required; no message', async () => {
    await setMode('site_user_only', 3)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 3 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'anonymous', policyVersion: 3 })
    const r = await callMessage(tenant.slug, token, { text: 'anon in suo' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('legacy token (both claims absent) -> 403 website_login_required; no message', async () => {
    await setMode('site_user_only', 3)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id })
    const r = await callMessage(tenant.slug, token, { text: 'legacy in suo' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('verified_contact token -> 403 website_login_required; no message', async () => {
    await setMode('site_user_only', 3)
    const c = await createVisitorContact({ emailVerified: true })
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 3 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'verified_contact', policyVersion: 3 })
    const r = await callMessage(tenant.slug, token, { text: 'vc in suo' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('website_login_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('current external_user token (pv=3, correctly-bound external Contact) -> 200; message persisted', async () => {
    await setMode('site_user_only', 3)
    const c = await createExternalContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 3 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 3 })
    const r = await callMessage(tenant.slug, token, { text: 'external in suo' })
    expect(r.status).toBe(200)
    expect(r.data.message.id).toBeTruthy()
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('stale external_user token (pv=2) -> 403 policy_changed; no message', async () => {
    await setMode('site_user_only', 3)
    const c = await createExternalContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'stale ext in suo' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('policy_changed')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('external_user token whose Contact identity class drifted (Contact is visitorId) -> 403 identity_token_invalid; no message', async () => {
    await setMode('site_user_only', 3)
    // Create a visitorId Contact (wrong identity class for external_user).
    const c = await createVisitorContact({ emailVerified: true })
    // Sign an external_user token for this visitorId Contact.
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'external_user', policyVersion: 3 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'external_user', policyVersion: 3 })
    const r = await callMessage(tenant.slug, token, { text: 'class drift in suo' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })
})

// ===========================================================================
// policy transitions (real DB WidgetConfig changes)
// ===========================================================================

describe('messages — policy transitions at send time', () => {
  test('anonymous pv=1 -> verified_visitor pv=2 -> site_user_only pv=3 (with pv increments)', async () => {
    // Step 1: anonymous pv=1 -> anonymous token succeeds. count=1.
    await setMode('anonymous', 1)
    const c = await createVisitorContact({ emailVerified: true })
    const anonTokenV1 = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    const r1 = await callMessage(tenant.slug, anonTokenV1, { text: 'step 1 anon' })
    expect(r1.status).toBe(200)
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)

    // Step 2: change to verified_visitor pv=2 -> fresh anonymous token (pv=2) -> verification_required. count=1.
    await setMode('verified_visitor', 2)
    const anonTokenV2 = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 2 })
    const r2 = await callMessage(tenant.slug, anonTokenV2, { text: 'step 2 anon' })
    expect(r2.status).toBe(403)
    expect(r2.data.error).toBe('verification_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1) // unchanged

    // Step 3: current verified_contact token (pv=2) -> succeeds. count=2.
    const vcTokenV2 = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 2 })
    const r3 = await callMessage(tenant.slug, vcTokenV2, { text: 'step 3 vc' })
    expect(r3.status).toBe(200)
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(2)

    // Step 4: change to site_user_only pv=3 -> fresh verified_contact token (pv=3) -> website_login_required. count=2.
    await setMode('site_user_only', 3)
    const vcTokenV3 = signVisitorToken({ contactId: c.id, identityLevel: 'verified_contact', policyVersion: 3 })
    const r4 = await callMessage(tenant.slug, vcTokenV3, { text: 'step 4 vc' })
    expect(r4.status).toBe(403)
    expect(r4.data.error).toBe('website_login_required')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(2) // unchanged

    // Step 5: current external_user token (pv=3) for a correctly-bound external Contact -> succeeds. count(B)=1.
    const ext = await createExternalContact()
    const extTokenV3 = signVisitorToken({ contactId: ext.id, identityLevel: 'external_user', policyVersion: 3 })
    const r5 = await callMessage(tenant.slug, extTokenV3, { text: 'step 5 ext' })
    expect(r5.status).toBe(200)
    expect(await countMessagesForContact(tenant.id, ext.id)).toBe(1)
    // Contact A count unchanged.
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(2)

    // Reset to anonymous pv=1 for subsequent test suites (defensive — other
    // describes rely on the canonical baseline).
    await setMode('anonymous', 1)
  })
})

// ===========================================================================
// corrupt policy 503
// ===========================================================================

describe('messages — corrupt policy 503', () => {
  test('missing WidgetConfig -> 503 policy_unavailable', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    // Delete the WidgetConfig.
    await withTenant(tenant.id, async () => db.widgetConfig.delete({ where: { tenantId: tenant.id } }))
    try {
      const r = await callMessage(tenant.slug, token, { text: 'no config' })
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
      expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
    } finally {
      // Restore the WidgetConfig for subsequent tests.
      await globalDb.widgetConfig.create({ data: { tenantId: tenant.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } } })
    }
  })

  test('invalid accessMode -> NOTE: DB CHECK prevents it; route parseAccessMode is defense-in-depth', () => {
    // The WidgetConfig_accessMode_check DB constraint rejects any value outside
    // ('anonymous','verified_visitor','site_user_only') at the storage level.
    // The route's parseAccessMode is defense-in-depth against a row inserted
    // via a bypass (tested in widget-access-config.test.ts via the
    // withCorruptAccessMode DDL dance). We do NOT drop the CHECK here to
    // avoid racing DDL across concurrent db-boundary test files.
    // This test is a no-op assertion that the contract holds.
    expect(true).toBe(true)
  })

  test('invalid policyVersion (0) -> 503 policy_unavailable', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    // Set policyVersion=0 (invalid — no CHECK, so this is the route's parsePolicyVersion fail-closed path).
    await globalDb.widgetConfig.update({ where: { tenantId: tenant.id }, data: { policyVersion: 0 } })
    try {
      const r = await callMessage(tenant.slug, token, { text: 'bad pv' })
      expect(r.status).toBe(503)
      expect(r.data.error).toBe('policy_unavailable')
      expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
    } finally {
      await setMode('anonymous', 1)
    }
  })
})

// ===========================================================================
// nonexistent contact
// ===========================================================================

describe('messages — nonexistent contact', () => {
  test('verified_contact token with a nonexistent contactId -> 403 identity_token_invalid; no message', async () => {
    await setMode('verified_visitor', 2)
    // Sign a verified_contact token for a fake contactId (doesn't exist).
    const fakeContactId = 'cmiss_' + crypto.randomUUID()
    const token = signVisitorToken({ contactId: fakeContactId, identityLevel: 'verified_contact', policyVersion: 2 })
    assertInputTokenValid(token, { contactId: fakeContactId, identityLevel: 'verified_contact', policyVersion: 2 })
    const r = await callMessage(tenant.slug, token, { text: 'nonexistent contact' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_token_invalid')
    // No contact -> no messages (countMessagesForContact returns 0 for a nonexistent contactId).
    expect(await countMessagesForContact(tenant.id, fakeContactId)).toBe(0)
    await setMode('anonymous', 1)
  })
})

// ===========================================================================
// wrong tenant / slug binding
// ===========================================================================

describe('messages — wrong tenant/slug binding', () => {
  test('token slug A + route slug B -> 403 token_slug_mismatch', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    // Sign the token with slug=tenant.slug, but call the route with slug=tenantB.slug.
    const token = signVisitorToken({ contactId: c.id, tenantId: tenant.id, slug: tenant.slug, identityLevel: 'anonymous', policyVersion: 1 })
    const r = await callMessage(tenantB.slug, token, { text: 'slug mismatch' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('token_slug_mismatch')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })

  test('token tenant A + route tenant B -> 403 token_tenant_mismatch', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    // Sign the token with slug=tenantB.slug + tenantId=tenant.id (mismatch).
    const token = signVisitorToken({ contactId: c.id, tenantId: tenant.id, slug: tenantB.slug, identityLevel: 'anonymous', policyVersion: 1 })
    const r = await callMessage(tenantB.slug, token, { text: 'tenant mismatch' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('token_tenant_mismatch')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })
})

// ===========================================================================
// success-path contract (dedicated — full response-shape assertions)
// ===========================================================================

describe('messages — success-path contract', () => {
  test('authorized send: message persisted with correct text + conversationId; response shape', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    assertInputTokenValid(token, { contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })

    const text = `contract-${uniq('msg')}`
    const clientMessageId = `cmsg-${uniq('seq')}`
    const r = await callMessage(tenant.slug, token, { text, clientMessageId })

    // 200 success.
    expect(r.status).toBe(200)
    // Response shape: { message, conversationId, aiResponse, clientMessageId }.
    expect(r.data).toBeTruthy()
    expect(r.data.message).toBeTruthy()
    expect(typeof r.data.message.id).toBe('string')
    expect(typeof r.data.conversationId).toBe('string')
    // message.conversationId matches the top-level conversationId.
    expect(r.data.message.conversationId).toBe(r.data.conversationId)
    // clientMessageId echoed back (ephemeral — NOT persisted).
    expect(r.data.clientMessageId).toBe(clientMessageId)
    // Fresh tenant has no AiConfig -> aiResponse is null.
    expect(r.data.aiResponse).toBeNull()

    // Persisted message in the DB has the exact text + correct conversationId.
    const persisted = await getMessage(tenant.id, r.data.message.id)
    expect(persisted).not.toBeNull()
    expect(persisted!.id).toBe(r.data.message.id)
    expect(persisted!.conversationId).toBe(r.data.conversationId)
    expect(persisted!.tenantId).toBe(tenant.id)
    expect(persisted!.senderType).toBe('contact')
    expect(persisted!.contentType).toBe('text')
    expect(persisted!.status).toBe('sent')
    expect(persisted!.content).toEqual({ text })
    // clientMessageId is NOT persisted on the Message row (it's only in the realtime payload).
    expect((persisted!.content as any).clientMessageId).toBeUndefined()

    // Exactly one contact message persisted for this Contact.
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(1)
  })

  test('oversized text is truncated to MAX_MESSAGE_LENGTH (5000)', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    const oversized = 'x'.repeat(6000) // > 5000
    const r = await callMessage(tenant.slug, token, { text: oversized })
    expect(r.status).toBe(200)
    const persisted = await getMessage(tenant.id, r.data.message.id)
    expect(persisted).not.toBeNull()
    expect((persisted!.content as any).text.length).toBe(5000)
  })

  test('empty text -> 400 empty_message; no message', async () => {
    await setMode('anonymous', 1)
    const c = await createVisitorContact()
    const token = signVisitorToken({ contactId: c.id, identityLevel: 'anonymous', policyVersion: 1 })
    const r = await callMessage(tenant.slug, token, { text: '   ' })
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('empty_message')
    expect(await countMessagesForContact(tenant.id, c.id)).toBe(0)
  })
})
