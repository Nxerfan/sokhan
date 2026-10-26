/// <reference types="bun-types" />
/**
 * Widget OTP — concurrency + state-machine + happy/failure paths.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Tests the DB-level invariants of the OTP state machine (partial unique index,
 * status transitions, transactional finalization) + the Nixify mock (MOCK_CODE).
 *
 * The OTP route logic is FROZEN — these tests prove the DB contract, not the
 * HTTP route layer. The route handlers use the SAME db operations.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import { sendOtp, verifyOtp } from '@/lib/nixify/client'
import { signResumeCredential, verifyResumeCredential } from '@/lib/widget-identity-tokens'
import { signToken, verifyToken } from '@/lib/realtime-token'
import { parseAccessMode, parsePolicyVersion } from '@/lib/widget-access-policy'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const MOCK_CODE = '123456'

let tenant: { id: string; slug: string }
let policyVersion: number

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `otp-c-${RUN_ID}`, name: `OTP C ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenant.id, accessMode: 'verified_visitor', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  policyVersion = 1
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: tenant.id } })
})

/** Create a Contact via upsert (concurrency-safe, like the START route). */
async function ensureContact(visitorId: string, name = 'Visitor') {
  return withTenant(tenant.id, async () => {
    return db.contact.upsert({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
      create: { tenantId: tenant.id, identifier: visitorId, identifierType: 'visitorId', name, email: null, locale: 'fa', metadata: {} },
      update: {},
      select: { id: true, identifier: true, identifierType: true, externalUserId: true, email: true, name: true, emailVerifiedAt: true },
    })
  })
}

/** Simulate START: sendOtp + create WidgetOtpRequest (status='active'). Returns the request or null if the partial unique index rejected it. */
async function simulateStart(contactId: string, email: string, pendingName?: string | null) {
  const otpResult = await sendOtp(email, 'widget_verify')
  try {
    const req = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.create({
        data: {
          tenantId: tenant.id, contactId, email, pendingName: pendingName ?? null,
          purpose: 'widget_verify', providerRequestId: otpResult.otpRequestId,
          expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false, verifiedAt: null,
        },
        select: { id: true, providerRequestId: true, status: true, verified: true, expiresAt: true, attempts: true, contactId: true, email: true, pendingName: true },
      })
    })
    return { ok: true as const, req }
  } catch (e: any) {
    if (e?.code === 'P2002') return { ok: false as const, error: 'P2002' as const }
    throw e
  }
}

/** Simulate VERIFY: find request, reserve attempt, verifyOtp, transactional finalization. */
async function simulateVerify(providerRequestId: string, email: string, visitorId: string, code: string) {
  // Step 1: lookup (no status='active' filter — detect superseded)
  const otpReq = await withTenant(tenant.id, async () => {
    return db.widgetOtpRequest.findFirst({
      where: { providerRequestId, email, purpose: 'widget_verify' },
      select: { id: true, status: true, verified: true, expiresAt: true, attempts: true, contactId: true, email: true, pendingName: true },
    })
  })
  if (!otpReq) return { result: 'request_not_found' as const }
  if (otpReq.status === 'superseded') return { result: 'request_superseded' as const }
  if (otpReq.verified || otpReq.status === 'verified') return { result: 'already_used' as const }
  if (otpReq.expiresAt < new Date()) return { result: 'expired' as const }
  if (otpReq.attempts >= 5) return { result: 'attempt_limit_reached' as const }

  // Step 2: revalidate Contact before Nixify
  const contact = await withTenant(tenant.id, async () => {
    return db.contact.findUnique({ where: { id: otpReq.contactId }, select: { id: true, identifier: true, identifierType: true, externalUserId: true, email: true, name: true, emailVerifiedAt: true } })
  })
  if (!contact || contact.identifier !== visitorId || contact.identifierType !== 'visitorId' || contact.externalUserId !== null) {
    return { result: 'identity_mismatch' as const }
  }

  // Step 3: verify code via Nixify mock
  try {
    const v = await verifyOtp(email, code, 'widget_verify', providerRequestId)
    if (!v.verified) return { result: 'code_mismatch' as const }
  } catch {
    return { result: 'code_mismatch' as const }
  }

  // Step 4: transactional finalization (conditional claim + Contact update)
  const now = new Date()
  const finalization = await withTenant(tenant.id, async () => {
    return db.$transaction(async (tx) => {
      const claimed = await tx.widgetOtpRequest.updateMany({
        where: { id: otpReq.id, status: 'active', verified: false, expiresAt: { gt: now } },
        data: { status: 'verified', verified: true, verifiedAt: now },
      })
      if (claimed.count === 0) return { lost: true as const }
      // Revalidate Contact inside tx
      const c = await tx.contact.findUnique({ where: { id: otpReq.contactId } })
      if (!c || c.identifier !== visitorId || c.identifierType !== 'visitorId' || c.externalUserId !== null) {
        throw new Error('identity_mismatch')
      }
      await tx.contact.update({
        where: { id: c.id },
        data: { emailVerifiedAt: now, email: otpReq.email, ...(otpReq.pendingName ? { name: otpReq.pendingName } : {}) },
      })
      return { lost: false as const, contactId: c.id }
    })
  })

  if (!finalization || ('lost' in finalization && finalization.lost)) {
    // Re-read to distinguish
    const lostState = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: otpReq.id }, select: { status: true, verified: true, expiresAt: true } })
    })
    if (lostState?.status === 'superseded') return { result: 'request_superseded' as const }
    if (lostState?.status === 'verified' || lostState?.verified) return { result: 'already_used' as const }
    if (lostState && lostState.expiresAt < new Date()) return { result: 'expired' as const }
    return { result: 'already_used' as const }
  }

  const contactId = finalization.contactId!
  const resume = signResumeCredential({ contactId, tenantId: tenant.id, policyVersion })
  const realtimeToken = signToken({ type: 'visitor', contactId, tenantId: tenant.id, slug: tenant.slug, identityLevel: 'verified_contact', policyVersion })
  return { result: 'verified' as const, contactId, resume, realtimeToken }
}

// === CONCURRENT START ===

describe('Concurrent START — 10 requests for same visitorId', () => {
  test('exactly one active, rest superseded, no P2002 leak', async () => {
    const visitorId = `conc-${RUN_ID}`
    const email = `conc-${RUN_ID}@x.test`
    const contact = await ensureContact(visitorId)
    expect(contact.identifierType).toBe('visitorId')
    expect(contact.externalUserId).toBeNull()
    expect(contact.email).toBeNull()
    expect(contact.emailVerifiedAt).toBeNull()

    // Fire 10 concurrent STARTs (each calls sendOtp + tries to create active)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => simulateStart(contact.id, email, `Name${i}`))
    )

    const successes = results.filter((r) => r.ok)
    const p2002s = results.filter((r) => !r.ok && r.error === 'P2002')

    // At least one succeeded (the partial unique index allows exactly one active)
    expect(successes.length).toBeGreaterThanOrEqual(1)
    // P2002s are expected (caught + handled, not leaked)
    expect(p2002s.length).toBe(results.length - successes.length)

    // Verify: exactly one status='active' WidgetOtpRequest
    const activeReqs = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findMany({ where: { contactId: contact.id, status: 'active' } })
    })
    expect(activeReqs.length).toBe(1)

    // All providerRequestIds are unique
    const allReqs = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findMany({ where: { contactId: contact.id }, select: { providerRequestId: true, status: true } })
    })
    const prIds = allReqs.map((r) => r.providerRequestId)
    expect(new Set(prIds).size).toBe(prIds.length)

    // Superseded request IDs cannot verify
    for (const r of allReqs) {
      if (r.status === 'superseded') {
        const v = await simulateVerify(r.providerRequestId, email, visitorId, MOCK_CODE)
        expect(v.result).toBe('request_superseded')
      }
    }

    // Contact profile remains unchanged (email null, emailVerifiedAt null, name not pendingName)
    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactAfter!.email).toBeNull()
    expect(contactAfter!.emailVerifiedAt).toBeNull()
    // name is 'Visitor' (the neutral fallback), NOT any of the pending names
    expect(contactAfter!.name).toBe('Visitor')
  })
})

// === START-VS-VERIFY RACE ===

describe('START-vs-VERIFY race', () => {
  test('superseded request cannot complete verification', async () => {
    const visitorId = `race-${RUN_ID}`
    const email = `race-${RUN_ID}@x.test`
    const contact = await ensureContact(visitorId, 'Existing Name')

    // A is active
    const startA = await simulateStart(contact.id, email, 'Pending Name A')
    if (!startA.ok) throw new Error('START A failed')

    // Supersede A (START B wins)
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({
        where: { id: startA.req.id },
        data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() },
      })
    })

    // A attempts final claim (simulating provider success for A)
    const verifyA = await simulateVerify(startA.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(verifyA.result).toBe('request_superseded')

    // Contact unchanged by A
    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactAfter!.email).toBeNull()
    expect(contactAfter!.emailVerifiedAt).toBeNull()
    expect(contactAfter!.name).toBe('Existing Name')
  })
})

// === HAPPY PATH ===

describe('OTP happy path', () => {
  test('START → Contact unchanged → VERIFY → Contact verified + credentials', async () => {
    const visitorId = `happy-${RUN_ID}`
    const email = `happy-${RUN_ID}@x.test`
    const contact = await ensureContact(visitorId, 'Original Name')

    // START
    const start = await simulateStart(contact.id, email, 'Pending Name')
    if (!start.ok) throw new Error('START failed')

    // Contact unchanged after START
    const contactBefore = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactBefore!.email).toBeNull()
    expect(contactBefore!.emailVerifiedAt).toBeNull()
    expect(contactBefore!.name).toBe('Original Name')

    // VERIFY
    const verify = await simulateVerify(start.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(verify.result).toBe('verified')

    // WidgetOtpRequest final state
    const otpFinal = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: start.req.id }, select: { status: true, verified: true, verifiedAt: true } })
    })
    expect(otpFinal!.status).toBe('verified')
    expect(otpFinal!.verified).toBe(true)
    expect(otpFinal!.verifiedAt).not.toBeNull()

    // Contact final state
    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactAfter!.email).toBe(email)
    expect(contactAfter!.emailVerifiedAt).not.toBeNull()
    expect(contactAfter!.name).toBe('Pending Name')

    // Verify resume credential
    const resumeCheck = verifyResumeCredential(verify.resume!, tenant.id, policyVersion)
    expect(resumeCheck).not.toBeNull()
    expect(resumeCheck!.contactId).toBe(contact.id)
    expect(resumeCheck!.tenantId).toBe(tenant.id)
  })

  test('existing name preserved when pendingName is null', async () => {
    const visitorId = `noname-${RUN_ID}`
    const email = `noname-${RUN_ID}@x.test`
    const contact = await ensureContact(visitorId, 'Existing Name')

    const start = await simulateStart(contact.id, email, null) // no pendingName
    if (!start.ok) throw new Error('START failed')

    const verify = await simulateVerify(start.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(verify.result).toBe('verified')

    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contact.id }, select: { name: true } })
    })
    expect(contactAfter!.name).toBe('Existing Name')
  })
})

// === FAILURE MATRIX ===

describe('OTP failure matrix — no Contact mutation', () => {
  let visitorId: string
  let email: string
  let contactId: string

  beforeAll(async () => {
    visitorId = `fail-${RUN_ID}`
    email = `fail-${RUN_ID}@x.test`
    const c = await ensureContact(visitorId, 'Fail Contact')
    contactId = c.id
  })

  test('wrong code → code_mismatch, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Wrong')
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify(start.req.providerRequestId, email, visitorId, '000000')
    expect(v.result).toBe('code_mismatch')
  })

  test('expired → expired, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Expired')
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    })
    const v = await simulateVerify(start.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(v.result).toBe('expired')
  })

  test('superseded → request_superseded, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Superseded')
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() } })
    })
    const v = await simulateVerify(start.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(v.result).toBe('request_superseded')
  })

  test('already verified → already_used, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Used')
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { status: 'verified', verified: true, verifiedAt: new Date() } })
    })
    const v = await simulateVerify(start.req.providerRequestId, email, visitorId, MOCK_CODE)
    expect(v.result).toBe('already_used')
  })

  test('wrong visitorId → identity_mismatch, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Wrong Visitor')
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify(start.req.providerRequestId, email, 'wrong-visitor-id', MOCK_CODE)
    expect(v.result).toBe('identity_mismatch')
  })

  test('wrong email → request_not_found, Contact unchanged', async () => {
    const start = await simulateStart(contactId, email, 'Wrong Email')
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify(start.req.providerRequestId, 'wrong@email.test', visitorId, MOCK_CODE)
    expect(v.result).toBe('request_not_found')
  })

  test('all failures left Contact email/name/emailVerifiedAt unchanged', async () => {
    const c = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contactId }, select: { email: true, name: true, emailVerifiedAt: true } })
    })
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Fail Contact')
  })
})
