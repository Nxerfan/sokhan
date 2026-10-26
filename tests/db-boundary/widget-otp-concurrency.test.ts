/// <reference types="bun-types" />
/**
 * Widget OTP — concurrency + state-machine + happy/failure paths.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Tests the DB-level invariants of the OTP state machine (partial unique index,
 * status transitions, transactional finalization) + the Nixify mock (MOCK_CODE).
 *
 * The helpers below FAITHFULLY replicate the production START and VERIFY route
 * persistence logic (bounded P2002 retry + supersession, atomic attempt
 * reservation BEFORE Nixify, identity-class revalidation, transactional
 * finalization with conditional claim). They are test-only code. The production
 * routes (src/app/api/widget/[slug]/verify-identity/{start,verify}/route.ts)
 * use the SAME db operations. If a test reveals a production defect, the route
 * is the fix site — NOT this file.
 *
 * The OTP production logic is FROZEN. These tests prove the DB contract, not the
 * HTTP route layer. Test isolation: every test uses a UNIQUE visitorId / email
 * so the partial unique index (`WidgetOtpRequest_active_unique`) NEVER sees
 * leftover active state from a prior test. The partial unique index is NOT
 * weakened.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import { sendOtp, verifyOtp } from '@/lib/nixify/client'
import type { OtpPurpose, SendOtpResult, VerifyOtpResult } from '@/lib/nixify/client'
import { signResumeCredential, verifyResumeCredential } from '@/lib/widget-identity-tokens'
import { signToken, verifyToken } from '@/lib/realtime-token'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const MOCK_CODE = '123456'
const MAX_VERIFY_ATTEMPTS = 5
const MAX_RESENDS = 3
// Test-harness gate: the provider barrier / onReserved hooks are test-only and
// must NEVER activate outside the docker-regression test stack.
const TEST_HARNESS = process.env.SUKHAN_TEST_HARNESS === 'true'

let tenant: { id: string; slug: string; defaultLocale: string }
let policyVersion: number

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `otp-c-${RUN_ID}`, name: `OTP C ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true, defaultLocale: true },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenant.id, accessMode: 'verified_visitor', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  policyVersion = 1
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: tenant.id } })
})

// ─── types ──────────────────────────────────────────────────────
type SendOtpFn = (email: string, purpose: OtpPurpose) => Promise<SendOtpResult>
type VerifyOtpFn = (email: string, code: string, purpose: OtpPurpose, expectedOtpRequestId: string) => Promise<VerifyOtpResult>

interface OtpRow {
  id: string
  providerRequestId: string
  status: string
  verified: boolean
  expiresAt: Date
  attempts: number
  contactId: string
  email: string
  pendingName: string | null
}

type StartResult =
  | { ok: true; contactId: string; req: OtpRow }
  | { ok: false; error: 'identity_conflict' | 'verification_conflict' }

type VerifyResultKind =
  | 'verified'
  | 'request_not_found'
  | 'request_superseded'
  | 'already_used'
  | 'expired'
  | 'resend_limit'
  | 'attempt_limit_reached'
  | 'identity_mismatch'
  | 'identity_conflict'
  | 'code_mismatch'

type VerifyResult =
  | { result: 'verified'; contactId: string; resume: string; realtimeToken: string }
  | { result: Exclude<VerifyResultKind, 'verified'> }

interface VerifyOptions {
  /** test-harness only — await before calling Nixify (models provider latency). */
  providerBarrier?: Promise<void>
  /** test-harness only — invoked immediately after the attempt reservation succeeds. */
  onReserved?: () => void
  /** inject a counting wrapper to prove Nixify is/isn't called. */
  verifyOtpFn?: VerifyOtpFn
}

// ─── test-only faithful helpers (mirror the production routes) ────

/**
 * Faithful replica of the START route's persistence block.
 *
 *   sendOtp ONCE (before the retry loop — NOT repeated by local retry)
 *   bounded P2002 retry (3 attempts):
 *     dedup providerRequestId re-check
 *     transaction: supersede current active row(s) + create new active row
 *
 * Never returns a raw P2002 to the caller. On exhausted retries returns
 * `verification_conflict` (a safe 409-class application result, matching the
 * route). On Contact identity-class mismatch returns `identity_conflict`.
 */
async function simulateStart(opts: {
  visitorId: string
  email: string
  name?: string
  sendOtpFn?: SendOtpFn
}): Promise<StartResult> {
  const send: SendOtpFn = opts.sendOtpFn ?? sendOtp

  // Contact resolution by (tenant, visitorId) — NO profile mutation (update:{}).
  // + identity-class check (identifierType='visitorId', externalUserId=null).
  // Mirrors the production START route: Prisma upsert on the COMPOUND unique
  // (tenantId, identifier) does NOT emit INSERT ... ON CONFLICT, so concurrent
  // first-time STARTs for the SAME visitorId race on the create branch -> P2002.
  // Bounded retry: on P2002, another concurrent START won the create -- re-read
  // the contact by (tenantId, visitorId) + re-check the identity class. Never
  // leak raw P2002. Exhausted retries -> verification_conflict (stable safe
  // conflict). This helper is aligned with the production route (no divergent
  // semantics).
  const contactResult = await withTenant(tenant.id, async () => {
    let c: { id: string; identifierType: string; externalUserId: string | null } | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        c = await db.contact.upsert({
          where: { tenantId_identifier: { tenantId: tenant.id, identifier: opts.visitorId } },
          create: {
            tenantId: tenant.id,
            identifier: opts.visitorId,
            identifierType: 'visitorId',
            name: 'Visitor',
            email: null,
            locale: tenant.defaultLocale,
            metadata: {},
          },
          update: {}, // NO Contact profile mutation at START
          select: { id: true, identifierType: true, externalUserId: true },
        })
        break
      } catch (e: any) {
        if (e?.code === 'P2002' && attempt < 2) {
          const existing = await db.contact.findUnique({
            where: { tenantId_identifier: { tenantId: tenant.id, identifier: opts.visitorId } },
            select: { id: true, identifierType: true, externalUserId: true },
          })
          if (existing) { c = existing; break }
          continue // row vanished between the P2002 and the re-read -- retry
        }
        throw e
      }
    }
    if (!c || c.identifierType !== 'visitorId' || c.externalUserId !== null) {
      return { ok: false as const, reason: 'identity_conflict' as const }
    }
    return { ok: true as const, contactId: c.id }
  })
  if (!contactResult.ok) return { ok: false, error: 'identity_conflict' }
  const contactId = contactResult.contactId

  // sendOtp ONCE — before the bounded retry loop. Local retry does NOT re-call
  // sendOtp (the same providerRequestId is re-used + dedup-checked).
  const result = await send(opts.email, 'widget_verify')

  // Bounded P2002 retry (3 attempts): dedup re-check + transactional supersede+create.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Dedup: if this providerRequestId already exists, verify the BINDING.
      // Mirrors production: idempotent success ONLY if the existing row is
      // bound to the SAME contactId + email + purpose='widget_verify' AND
      // status='active'. Any binding mismatch (different contact/email) OR a
      // non-active status -> verification_conflict (no rebind, no new row).
      const existing = await withTenant(tenant.id, async () => {
        return db.widgetOtpRequest.findUnique({
          where: { providerRequestId: result.otpRequestId },
          select: { id: true, status: true, contactId: true, email: true, purpose: true },
        })
      })
      if (existing) {
        const bindingMatch =
          existing.contactId === contactId &&
          existing.email === opts.email &&
          existing.purpose === 'widget_verify'
        if (bindingMatch && existing.status === 'active') break // idempotent success
        return { ok: false, error: 'verification_conflict' as const }
      }
      // One transaction: supersede prior active flows + install the new active.
      await withTenant(tenant.id, async () => {
        await db.$transaction(async (tx) => {
          await tx.widgetOtpRequest.updateMany({
            where: { contactId, status: 'active' },
            data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() },
          })
          await tx.widgetOtpRequest.create({
            data: {
              tenantId: tenant.id,
              contactId,
              email: opts.email,
              pendingName: opts.name ?? null,
              purpose: 'widget_verify',
              providerRequestId: result.otpRequestId,
              expiresAt: new Date(result.expiresAt),
              status: 'active',
              verified: false,
              verifiedAt: null,
            },
          })
        })
      })
      break
    } catch (e: any) {
      // P2002 = partial unique index contention (another concurrent START won).
      // Absorb it and retry (up to 3). Never leak raw P2002 to the caller.
      if (e?.code === 'P2002' && attempt < 2) continue
      if (e?.code === 'P2002') return { ok: false, error: 'verification_conflict' as const }
      throw e
    }
  }

  // Re-fetch the installed request (test-only convenience to return the row).
  const req = await withTenant(tenant.id, async () => {
    return db.widgetOtpRequest.findUnique({
      where: { providerRequestId: result.otpRequestId },
      select: { id: true, providerRequestId: true, status: true, verified: true, expiresAt: true, attempts: true, contactId: true, email: true, pendingName: true },
    })
  })
  if (!req || req.status !== 'active') {
    // Extreme race: another START superseded this one between install + re-fetch.
    return { ok: false, error: 'verification_conflict' as const }
  }
  return { ok: true, contactId, req }
}

/**
 * Faithful replica of the VERIFY route's state machine.
 *
 *   lookup (no status='active' filter — detects superseded)
 *   atomic attempt reservation BEFORE Nixify (updateMany WHERE attempts<MAX)
 *   re-read + classify on zero reservation
 *   Contact identity-class revalidation BEFORE Nixify (no Nixify call on mismatch)
 *   verifyOtp via Nixify (mock)
 *   transactional finalization (conditional claim + Contact update)
 *   credentials issued ONLY after commit
 */
async function simulateVerify(opts: {
  requestId: string
  email: string
  visitorId: string
  code: string
} & VerifyOptions): Promise<VerifyResult> {
  const verify: VerifyOtpFn = opts.verifyOtpFn ?? verifyOtp

  // Step 1: tenant-scoped lookup — detects superseded (no status='active' filter).
  const lookup = await withTenant(tenant.id, async () => {
    const otpReq = await db.widgetOtpRequest.findFirst({
      where: { providerRequestId: opts.requestId, email: opts.email, purpose: 'widget_verify' },
      select: { id: true, status: true, verified: true, expiresAt: true, attempts: true, resendCount: true, contactId: true, email: true, pendingName: true },
    })
    if (!otpReq) return { kind: 'not_found' as const }
    if (otpReq.status === 'superseded') return { kind: 'request_superseded' as const }
    if (otpReq.verified || otpReq.status === 'verified') return { kind: 'already_used' as const }
    if (otpReq.expiresAt < new Date()) return { kind: 'expired' as const }
    if (otpReq.resendCount > MAX_RESENDS) return { kind: 'resend_limit' as const }
    return { kind: 'ok' as const, otpReq }
  })
  if (lookup.kind !== 'ok') {
    const kindMap = {
      not_found: 'request_not_found',
      request_superseded: 'request_superseded',
      already_used: 'already_used',
      expired: 'expired',
      resend_limit: 'resend_limit',
    } as const
    return { result: kindMap[lookup.kind] }
  }
  const otpReq = lookup.otpReq

  // Step 2: atomic attempt reservation BEFORE Nixify.
  const now = new Date()
  const reservation = await withTenant(tenant.id, async () => {
    const r = await db.widgetOtpRequest.updateMany({
      where: { id: otpReq.id, status: 'active', verified: false, expiresAt: { gt: now }, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    })
    return r.count
  })
  if (reservation === 0) {
    // Slot NOT acquired — resolve the truthful reason by re-reading state.
    const state = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({
        where: { id: otpReq.id },
        select: { status: true, verified: true, expiresAt: true, attempts: true },
      })
    })
    if (!state) return { result: 'request_not_found' }
    if (state.status === 'superseded') return { result: 'request_superseded' }
    if (state.verified || state.status === 'verified') return { result: 'already_used' }
    if (state.expiresAt < now) return { result: 'expired' }
    if (state.attempts >= MAX_VERIFY_ATTEMPTS) return { result: 'attempt_limit_reached' }
    return { result: 'request_not_found' }
  }

  // Test-harness signal: attempt reserved (used by the START-vs-VERIFY race test).
  if (TEST_HARNESS && opts.onReserved) opts.onReserved()

  // Step 3: revalidate Contact identity-class BEFORE calling Nixify.
  // Prove: Contact exists, identifierType=visitorId, identifier==visitorId,
  // externalUserId=null. Nixify is NOT called on mismatch (no consumption).
  const contactCheck = await withTenant(tenant.id, async () => {
    const contact = await db.contact.findUnique({
      where: { id: otpReq.contactId },
      select: { id: true, identifier: true, identifierType: true, externalUserId: true },
    })
    if (!contact) return { ok: false as const, reason: 'identity_mismatch' as const }
    if (contact.identifierType !== 'visitorId') return { ok: false as const, reason: 'identity_conflict' as const }
    if (contact.identifier !== opts.visitorId) return { ok: false as const, reason: 'identity_mismatch' as const }
    if (contact.externalUserId !== null) return { ok: false as const, reason: 'identity_conflict' as const }
    return { ok: true as const, contact }
  })
  if (!contactCheck.ok) return { result: contactCheck.reason }

  // Step 4: Nixify verifyOtp (mock). Optional test-harness provider barrier
  // models provider latency for the START-vs-VERIFY race test.
  if (TEST_HARNESS && opts.providerBarrier) await opts.providerBarrier
  try {
    const v = await verify(opts.email, opts.code, 'widget_verify', opts.requestId)
    if (!v.verified) return { result: 'code_mismatch' }
  } catch {
    return { result: 'code_mismatch' }
  }

  // Step 5: transactional finalization — conditional claim + Contact update.
  // Credentials issued ONLY after the transaction commits.
  const finalization = await withTenant(tenant.id, async () => {
    return db.$transaction(async (tx) => {
      const claimed = await tx.widgetOtpRequest.updateMany({
        where: { id: otpReq.id, status: 'active', verified: false, expiresAt: { gt: new Date() } },
        data: { status: 'verified', verified: true, verifiedAt: new Date() },
      })
      if (claimed.count === 0) return { lost: true as const }
      // Defense-in-depth: revalidate Contact inside the transaction.
      const c = await tx.contact.findUnique({ where: { id: otpReq.contactId } })
      if (!c || c.identifierType !== 'visitorId' || c.identifier !== opts.visitorId || c.externalUserId !== null) {
        throw new Error('identity_mismatch')
      }
      await tx.contact.update({
        where: { id: c.id },
        data: {
          emailVerifiedAt: new Date(),
          email: otpReq.email,
          ...(otpReq.pendingName ? { name: otpReq.pendingName } : {}),
        },
      })
      return { lost: false as const, contactId: c.id }
    })
  })

  if (!finalization || ('lost' in finalization && finalization.lost)) {
    // Claim lost — re-read to distinguish supersession from already_used.
    const lostState = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({
        where: { id: otpReq.id },
        select: { status: true, verified: true, expiresAt: true },
      })
    })
    if (lostState?.status === 'superseded') return { result: 'request_superseded' }
    if (lostState?.status === 'verified' || lostState?.verified) return { result: 'already_used' }
    if (lostState && lostState.expiresAt < new Date()) return { result: 'expired' }
    return { result: 'already_used' }
  }

  const contactId = finalization.contactId
  const resume = signResumeCredential({ contactId, tenantId: tenant.id, policyVersion })
  const realtimeToken = signToken({
    type: 'visitor',
    contactId,
    tenantId: tenant.id,
    slug: tenant.slug,
    identityLevel: 'verified_contact',
    policyVersion,
  })
  return { result: 'verified', contactId, resume, realtimeToken }
}

// ─── test fixture helpers ────────────────────────────────────────

/** Pre-create a visitorId Contact with a specific name (for tests that need a
 *  pre-existing profile to prove START does not mutate it). */
async function ensureContact(visitorId: string, name = 'Visitor') {
  return withTenant(tenant.id, async () => {
    return db.contact.upsert({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: visitorId } },
      create: { tenantId: tenant.id, identifier: visitorId, identifierType: 'visitorId', name, email: null, locale: 'fa', metadata: {} },
      update: { name },
      select: { id: true, identifier: true, identifierType: true, externalUserId: true, email: true, name: true, emailVerifiedAt: true },
    })
  })
}

/** Create a Contact with a NON-visitorId identity class (for the identity_conflict tests).
 *  Bypasses simulateStart (which would reject identity_conflict at START). */
async function createContactWithIdentityClass(visitorId: string, identifierType: string, externalUserId: string | null, name = 'Custom') {
  return globalDb.contact.create({
    data: { tenantId: tenant.id, identifier: visitorId, identifierType, externalUserId, name, email: null, locale: 'fa', metadata: {} },
    select: { id: true, identifier: true, identifierType: true, externalUserId: true },
  })
}

/** Manually create an active WidgetOtpRequest for a contact (for the identity_conflict
 *  tests, where simulateStart cannot install a flow for a wrong-identity-class contact). */
async function createActiveOtp(contactId: string, email: string, pendingName: string | null = null): Promise<OtpRow> {
  return globalDb.widgetOtpRequest.create({
    data: {
      tenantId: tenant.id,
      contactId,
      email,
      pendingName,
      purpose: 'widget_verify',
      providerRequestId: `manual-${RUN_ID}-${Math.random().toString(36).slice(2, 10)}`,
      expiresAt: new Date(Date.now() + 600000),
      status: 'active',
      verified: false,
      verifiedAt: null,
    },
    select: { id: true, providerRequestId: true, status: true, verified: true, expiresAt: true, attempts: true, contactId: true, email: true, pendingName: true },
  })
}

function uniq(suffix: string): string {
  return `${RUN_ID}-${suffix}-${Math.random().toString(36).slice(2, 10)}`
}

// === CONCURRENT START ===

describe('Concurrent START — 10 requests for same visitorId', () => {
  test('exactly one active, competing flows superseded, no P2002 leak, sendOtp once each', async () => {
    const vid = uniq('conc')
    const em = `${uniq('conc')}@x.test`

    // Counting wrapper: proves sendOtp is called exactly once per simulateStart
    // (the bounded local retry does NOT re-call sendOtp).
    let sendCalls = 0
    const countingSend: SendOtpFn = async (...a) => {
      sendCalls++
      return sendOtp(...a)
    }

    // Fire 10 concurrent STARTs for the SAME visitorId.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => simulateStart({ visitorId: vid, email: em, name: `Name${i}`, sendOtpFn: countingSend })),
    )

    // Every result is a SAFE application result — NO raw P2002, NO throw, NO 500.
    for (const r of results) {
      expect(r.ok === true || r.error === 'verification_conflict').toBe(true)
    }

    // sendOtp called exactly once per simulateStart (10 total). The bounded
    // local retry does NOT repeat sendOtp — it re-uses the same providerRequestId.
    expect(sendCalls).toBe(10)

    // Resolve the (single) Contact for this visitorId.
    const contact = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({
        where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid } },
        select: { id: true, identifierType: true, externalUserId: true, email: true, name: true, emailVerifiedAt: true },
      })
    })
    expect(contact).not.toBeNull()
    expect(contact!.identifierType).toBe('visitorId')
    expect(contact!.externalUserId).toBeNull()

    // Exactly ONE active flow (the partial unique index guarantees this).
    const active = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findMany({ where: { contactId: contact!.id, status: 'active' } })
    })
    expect(active.length).toBe(1)

    // All persisted rows: unique providerRequestIds, none verified, every
    // non-active row is superseded (no zombie states).
    const allReqs = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findMany({
        where: { contactId: contact!.id },
        select: { providerRequestId: true, status: true, verified: true },
      })
    })
    const prIds = allReqs.map((r) => r.providerRequestId)
    expect(new Set(prIds).size).toBe(prIds.length) // all unique
    expect(allReqs.filter((r) => r.verified || r.status === 'verified')).toHaveLength(0) // none verified
    for (const r of allReqs) {
      if (r.status !== 'active') expect(r.status).toBe('superseded') // every non-active is superseded
    }

    // START never mutates the Contact profile (email null, emailVerifiedAt null,
    // name is the neutral 'Visitor' fallback — NOT any of the pending names).
    expect(contact!.email).toBeNull()
    expect(contact!.emailVerifiedAt).toBeNull()
    expect(contact!.name).toBe('Visitor')

    // Superseded flows are unusable for verification.
    for (const r of allReqs) {
      if (r.status === 'superseded') {
        const v = await simulateVerify({ requestId: r.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
        expect(v.result).toBe('request_superseded')
      }
    }
  })
})

// === START-VS-VERIFY RACE ===

describe('START-vs-VERIFY race', () => {
  test('VERIFY loses when START supersedes mid-flight (provider success arrives after supersession)', async () => {
    const vid = uniq('race')
    const em = `${uniq('race')}@x.test`

    // A is active.
    const startA = await simulateStart({ visitorId: vid, email: em, name: 'Pending A' })
    if (!startA.ok) throw new Error('START A failed')
    const contactId = startA.contactId

    // Deterministic race barrier: A's VERIFY pauses after reserving an attempt
    // (before calling Nixify), START B supersedes A, then the provider returns
    // success for A. A's conditional final claim must lose (status no longer
    // active) → request_superseded. Contact untouched. No credentials.
    let resolveBarrier!: () => void
    let resolveReserved!: () => void
    const barrier = new Promise<void>((r) => { resolveBarrier = r })
    const reserved = new Promise<void>((r) => { resolveReserved = r })

    const verifyAPromise = simulateVerify({
      requestId: startA.req.providerRequestId,
      email: em,
      visitorId: vid,
      code: MOCK_CODE,
      providerBarrier: barrier,
      onReserved: () => resolveReserved(),
    })

    // Wait until A has RESERVED an attempt (lookup ok + updateMany succeeded).
    await reserved

    // START B supersedes A (status='active' → 'superseded') + installs B.
    const startB = await simulateStart({ visitorId: vid, email: em, name: 'Pending B' })
    if (!startB.ok) throw new Error('START B failed')

    // Release the provider barrier — Nixify returns success for A.
    resolveBarrier()

    const verifyA = await verifyAPromise
    // A's final claim loses because A is no longer active → request_superseded.
    expect(verifyA.result).toBe('request_superseded')

    // Contact untouched by A's failed finalization.
    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contactId }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactAfter!.email).toBeNull()
    expect(contactAfter!.emailVerifiedAt).toBeNull()
    expect(contactAfter!.name).toBe('Visitor') // START never mutates Contact name

    // B is the single active flow now.
    const activeReqs = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findMany({ where: { contactId, status: 'active' } })
    })
    expect(activeReqs).toHaveLength(1)
    expect(activeReqs[0].providerRequestId).toBe(startB.req.providerRequestId)

    // A is superseded (not verified, not active).
    const aFinal = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: startA.req.id }, select: { status: true, verified: true, attempts: true } })
    })
    expect(aFinal!.status).toBe('superseded')
    expect(aFinal!.verified).toBe(false)
    // A reserved exactly one attempt before losing.
    expect(aFinal!.attempts).toBe(1)
  })
})

// === HAPPY PATH ===

describe('OTP happy path', () => {
  test('START → Contact unchanged → VERIFY → Contact verified + resume + realtime token', async () => {
    const vid = uniq('happy')
    const em = `${uniq('happy')}@x.test`
    // Pre-create the contact with a distinct name to prove START does not mutate.
    await ensureContact(vid, 'Original Name')

    const start = await simulateStart({ visitorId: vid, email: em, name: 'Pending Name' })
    if (!start.ok) throw new Error('START failed')
    const contactId = start.contactId

    // Contact unchanged after START.
    const contactBefore = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contactId }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactBefore!.email).toBeNull()
    expect(contactBefore!.emailVerifiedAt).toBeNull()
    expect(contactBefore!.name).toBe('Original Name')

    // VERIFY.
    const verify = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
    expect(verify.result).toBe('verified')
    if (verify.result !== 'verified') throw new Error('expected verified')

    // WidgetOtpRequest final state.
    const otpFinal = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: start.req.id }, select: { status: true, verified: true, verifiedAt: true, attempts: true } })
    })
    expect(otpFinal!.status).toBe('verified')
    expect(otpFinal!.verified).toBe(true)
    expect(otpFinal!.verifiedAt).not.toBeNull()
    expect(otpFinal!.attempts).toBe(1)

    // Contact final state.
    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: contactId }, select: { email: true, emailVerifiedAt: true, name: true } })
    })
    expect(contactAfter!.email).toBe(em)
    expect(contactAfter!.emailVerifiedAt).not.toBeNull()
    expect(contactAfter!.name).toBe('Pending Name')

    // Resume credential — complete claim verification.
    const resumeCheck = verifyResumeCredential(verify.resume, tenant.id, policyVersion)
    expect(resumeCheck).not.toBeNull()
    expect(resumeCheck!.contactId).toBe(contactId)
    expect(resumeCheck!.tenantId).toBe(tenant.id)

    // Realtime token — full claim verification (narrow to the visitor payload).
    const rt = verifyToken(verify.realtimeToken)
    expect(rt).not.toBeNull()
    if (!rt || rt.type !== 'visitor') throw new Error('expected visitor realtime token')
    expect(rt.type).toBe('visitor')
    expect(rt.contactId).toBe(contactId)
    expect(rt.tenantId).toBe(tenant.id)
    expect(rt.slug).toBe(tenant.slug)
    expect(rt.identityLevel).toBe('verified_contact')
    expect(rt.policyVersion).toBe(policyVersion)
  })

  test('existing name preserved when pendingName is null', async () => {
    const vid = uniq('noname')
    const em = `${uniq('noname')}@x.test`
    await ensureContact(vid, 'Existing Name')

    const start = await simulateStart({ visitorId: vid, email: em }) // no name → pendingName=null
    if (!start.ok) throw new Error('START failed')

    const verify = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
    expect(verify.result).toBe('verified')

    const contactAfter = await withTenant(tenant.id, async () => {
      return db.contact.findUnique({ where: { id: start.contactId }, select: { name: true, email: true, emailVerifiedAt: true } })
    })
    expect(contactAfter!.name).toBe('Existing Name')
    expect(contactAfter!.email).toBe(em)
    expect(contactAfter!.emailVerifiedAt).not.toBeNull()
  })
})

// === FAILURE MATRIX (isolated fixtures — unique visitorId per test) ===

describe('OTP failure matrix — no Contact mutation', () => {
  test('wrong code → code_mismatch, Contact unchanged', async () => {
    const vid = uniq('wc'), em = `${uniq('wc')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Wrong' })
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: '000000' })
    expect(v.result).toBe('code_mismatch')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })

  test('expired → expired, Contact unchanged', async () => {
    const vid = uniq('exp'), em = `${uniq('exp')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Expired' })
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    })
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
    expect(v.result).toBe('expired')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })

  test('superseded → request_superseded, Contact unchanged', async () => {
    const vid = uniq('sup'), em = `${uniq('sup')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Superseded' })
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() } })
    })
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
    expect(v.result).toBe('request_superseded')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })

  test('already verified → already_used, Contact unchanged', async () => {
    const vid = uniq('used'), em = `${uniq('used')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Used' })
    if (!start.ok) throw new Error('START failed')
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start.req.id }, data: { status: 'verified', verified: true, verifiedAt: new Date() } })
    })
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE })
    expect(v.result).toBe('already_used')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })

  test('wrong visitorId → identity_mismatch, Contact unchanged', async () => {
    const vid = uniq('wv'), em = `${uniq('wv')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Wrong Visitor' })
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: em, visitorId: 'wrong-visitor-id', code: MOCK_CODE })
    expect(v.result).toBe('identity_mismatch')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })

  test('wrong email → request_not_found, Contact unchanged', async () => {
    const vid = uniq('we'), em = `${uniq('we')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Wrong Email' })
    if (!start.ok) throw new Error('START failed')
    const v = await simulateVerify({ requestId: start.req.providerRequestId, email: 'wrong@email.test', visitorId: vid, code: MOCK_CODE })
    expect(v.result).toBe('request_not_found')
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: start.contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Visitor')
  })
})

// === ATTEMPT-LIMIT ===

describe('OTP attempt limit', () => {
  test('attempts exhausted → attempt_limit_reached, Nixify NOT called for rejected attempt, Contact unchanged', async () => {
    const vid = uniq('lim'), em = `${uniq('lim')}@x.test`
    const start = await simulateStart({ visitorId: vid, email: em, name: 'Limit' })
    if (!start.ok) throw new Error('START failed')
    const contactId = start.contactId
    const prId = start.req.providerRequestId

    let verifyCalls = 0
    const countingVerify: VerifyOtpFn = async (...a) => {
      verifyCalls++
      return verifyOtp(...a)
    }

    // Reserve all MAX attempts with wrong codes — each reserves an attempt,
    // Nixify is called + fails (code_mismatch). Attempts increment to MAX.
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      const v = await simulateVerify({ requestId: prId, email: em, visitorId: vid, code: '000000', verifyOtpFn: countingVerify })
      expect(v.result).toBe('code_mismatch')
    }
    expect(verifyCalls).toBe(MAX_VERIFY_ATTEMPTS) // Nixify called for each wrong attempt

    // 6th attempt — reservation fails (attempts >= MAX). Nixify is NOT called
    // (proven by passing the CORRECT code: if Nixify were called it would verify,
    // but the gate returns attempt_limit_reached before reaching Nixify).
    verifyCalls = 0
    const v = await simulateVerify({ requestId: prId, email: em, visitorId: vid, code: MOCK_CODE, verifyOtpFn: countingVerify })
    expect(v.result).toBe('attempt_limit_reached')
    expect(verifyCalls).toBe(0) // Nixify NOT called for the rejected attempt

    // attempts unchanged (the rejected attempt's reservation did not fire).
    const otpFinal = await withTenant(tenant.id, async () => {
      return db.widgetOtpRequest.findUnique({ where: { id: start.req.id }, select: { attempts: true, status: true, verified: true } })
    })
    expect(otpFinal!.attempts).toBe(MAX_VERIFY_ATTEMPTS)
    expect(otpFinal!.status).toBe('active')
    expect(otpFinal!.verified).toBe(false)

    // Contact unchanged.
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contactId }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
  })
})

// === IDENTITY-CLASS CONFLICT ===

describe('OTP identity-class conflict', () => {
  test('Contact identifierType != visitorId → identity_conflict, Nixify NOT called, Contact unchanged', async () => {
    const vid = uniq('ext1'), em = `${uniq('ext1')}@x.test`
    // Contact with identifierType='external_user' (wrong identity class). The
    // identifier is set to the visitorId so the ONLY failure cause is the
    // identifierType check (which fires before the identifier match).
    const contact = await createContactWithIdentityClass(vid, 'external_user', `ext_${uniq('ext1')}`, 'External')
    const otp = await createActiveOtp(contact.id, em, 'Ext Name')

    let verifyCalls = 0
    const countingVerify: VerifyOtpFn = async (...a) => {
      verifyCalls++
      return verifyOtp(...a)
    }
    // Pass the CORRECT code — if Nixify were called it would verify, but the
    // identity-class gate returns identity_conflict before reaching Nixify.
    const v = await simulateVerify({ requestId: otp.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE, verifyOtpFn: countingVerify })
    expect(v.result).toBe('identity_conflict')
    expect(verifyCalls).toBe(0) // Nixify NOT called

    // Contact profile NOT mutated.
    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true, identifierType: true, externalUserId: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('External')
    expect(c!.identifierType).toBe('external_user')

    // OTP request: the attempt was reserved (attempts=1) but no verification.
    const otpFinal = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { id: otp.id }, select: { status: true, verified: true, attempts: true } }))
    expect(otpFinal!.status).toBe('active')
    expect(otpFinal!.verified).toBe(false)
    expect(otpFinal!.attempts).toBe(1)
  })

  test('Contact externalUserId set → identity_conflict, Nixify NOT called', async () => {
    const vid = uniq('ext2'), em = `${uniq('ext2')}@x.test`
    // Contact with identifierType='visitorId' (passes) + identifier==vid (passes)
    // + externalUserId set (fails the last check) → identity_conflict.
    const contact = await createContactWithIdentityClass(vid, 'visitorId', `ext2_${uniq('ext2')}`, 'Migrated')
    const otp = await createActiveOtp(contact.id, em, null)

    let verifyCalls = 0
    const countingVerify: VerifyOtpFn = async (...a) => {
      verifyCalls++
      return verifyOtp(...a)
    }
    const v = await simulateVerify({ requestId: otp.providerRequestId, email: em, visitorId: vid, code: MOCK_CODE, verifyOtpFn: countingVerify })
    expect(v.result).toBe('identity_conflict')
    expect(verifyCalls).toBe(0)

    const c = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contact.id }, select: { email: true, emailVerifiedAt: true, name: true, externalUserId: true } }))
    expect(c!.email).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()
    expect(c!.name).toBe('Migrated')
  })
})

// === PROVIDERREQUESTID ADVERSARIAL BINDING (#1) ===
// Prove that a providerRequestId already bound to (contactId, email, purpose)
// CANNOT be rebound to a different contact/email by replaying it through
// START. The production START dedup now verifies the FULL binding (contactId +
// normalized email + purpose='widget_verify' + status='active') before treating
// an existing providerRequestId as idempotent. Any binding mismatch OR a
// non-active status -> verification_conflict (no rebind, no new row). This
// corrects the previous (insufficient) dedup which only checked status='active'.

describe('ProviderRequestId adversarial binding', () => {
  test('active providerRequestId replayed for a DIFFERENT contact/email -> verification_conflict (no rebind)', async () => {
    const vid1 = uniq('adv1'), em1 = `${uniq('adv1e')}@x.test`
    const vid2 = uniq('adv2'), em2 = `${uniq('adv2e')}@x.test`

    // 1. Install an active OTP P bound to (C1, E1) via a real sendOtp.
    const start1 = await simulateStart({ visitorId: vid1, email: em1, name: 'A' })
    if (!start1.ok) throw new Error('START 1 failed')
    const P = start1.req.providerRequestId
    const c1 = start1.contactId

    // 2. Adversary: a DIFFERENT visitor (C2, E2) calls START, but sendOtp
    //    returns the SAME providerRequestId P (replayed/captured provider
    //    response). The dedup must find the existing row bound to (C1, E1),
    //    detect the binding mismatch (contactId C2 != C1, email E2 != E1),
    //    and return verification_conflict — NO rebound row, NO new row.
    const replaySend: SendOtpFn = async () => ({ otpRequestId: P, expiresAt: new Date(Date.now() + 600000).toISOString() })
    const start2 = await simulateStart({ visitorId: vid2, email: em2, name: 'B', sendOtpFn: replaySend })
    expect(start2.ok).toBe(false)
    if (start2.ok) throw new Error('expected verification_conflict')
    expect(start2.error).toBe('verification_conflict')

    // P remains bound to exactly ONE row — the original (C1, E1), active.
    const rowsForP = await withTenant(tenant.id, async () => db.widgetOtpRequest.findMany({
      where: { providerRequestId: P },
      select: { contactId: true, email: true, status: true },
    }))
    expect(rowsForP).toHaveLength(1)
    expect(rowsForP[0].contactId).toBe(c1)
    expect(rowsForP[0].email).toBe(em1)
    expect(rowsForP[0].status).toBe('active')

    // C2 received NO usable OTP flow. C2 cannot verify using P (email mismatch
    // -> request_not_found). C2's Contact remains unverified.
    const c2Contact = await withTenant(tenant.id, async () => db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid2 } },
      select: { id: true },
    }))
    expect(c2Contact).not.toBeNull()
    const v = await simulateVerify({ requestId: P, email: em2, visitorId: vid2, code: MOCK_CODE })
    expect(v.result).toBe('request_not_found')
    const c2After = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: c2Contact!.id }, select: { email: true, emailVerifiedAt: true } }))
    expect(c2After!.email).toBeNull()
    expect(c2After!.emailVerifiedAt).toBeNull()

    // The original C1 flow remains unchanged (still active, bound to E1).
    const c1Row = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { id: start1.req.id }, select: { status: true, email: true, contactId: true } }))
    expect(c1Row!.status).toBe('active')
    expect(c1Row!.email).toBe(em1)
    expect(c1Row!.contactId).toBe(c1)
  })

  test('same providerRequestId replayed for the SAME contact but DIFFERENT email -> verification_conflict', async () => {
    const vid = uniq('adv-se'), em1 = `${uniq('se1')}@x.test`, em2 = `${uniq('se2')}@x.test`

    // Install P bound to (C, E1).
    const start1 = await simulateStart({ visitorId: vid, email: em1, name: 'A' })
    if (!start1.ok) throw new Error('START 1 failed')
    const P = start1.req.providerRequestId
    const c = start1.contactId

    // Replay P for the SAME contact but a DIFFERENT email. The dedup finds P
    // bound to (C, E1); the binding mismatches on email (E2 != E1) ->
    // verification_conflict (no rebind, no new row).
    const replaySend: SendOtpFn = async () => ({ otpRequestId: P, expiresAt: new Date(Date.now() + 600000).toISOString() })
    const start2 = await simulateStart({ visitorId: vid, email: em2, name: 'B', sendOtpFn: replaySend })
    expect(start2.ok).toBe(false)
    if (start2.ok) throw new Error('expected verification_conflict')
    expect(start2.error).toBe('verification_conflict')

    // P still bound to exactly one row (C, E1), active — NOT rebound to E2.
    const rowsForP = await withTenant(tenant.id, async () => db.widgetOtpRequest.findMany({
      where: { providerRequestId: P },
      select: { contactId: true, email: true, status: true },
    }))
    expect(rowsForP).toHaveLength(1)
    expect(rowsForP[0].contactId).toBe(c)
    expect(rowsForP[0].email).toBe(em1)
    expect(rowsForP[0].status).toBe('active')
  })

  test('same providerRequestId + SAME contact + SAME email + active -> idempotent success (no new row)', async () => {
    const vid = uniq('adv-id'), em = `${uniq('ide')}@x.test`

    // Install P bound to (C, E) active.
    const start1 = await simulateStart({ visitorId: vid, email: em, name: 'A' })
    if (!start1.ok) throw new Error('START 1 failed')
    const P = start1.req.providerRequestId
    const c = start1.contactId

    // Replay P for the SAME contact + SAME email. The dedup finds P bound to
    // (C, E) active with a full binding match -> idempotent success (break).
    // No new row is created; start2 returns ok with the EXISTING row.
    const replaySend: SendOtpFn = async () => ({ otpRequestId: P, expiresAt: new Date(Date.now() + 600000).toISOString() })
    const start2 = await simulateStart({ visitorId: vid, email: em, sendOtpFn: replaySend })
    expect(start2.ok).toBe(true)
    if (!start2.ok) throw new Error('expected idempotent success')

    // Exactly ONE row for P (the original), still active, bound to (C, E).
    const rowsForP = await withTenant(tenant.id, async () => db.widgetOtpRequest.findMany({
      where: { providerRequestId: P },
      select: { contactId: true, email: true, status: true },
    }))
    expect(rowsForP).toHaveLength(1)
    expect(rowsForP[0].contactId).toBe(c)
    expect(rowsForP[0].email).toBe(em)
    expect(rowsForP[0].status).toBe('active')
  })

  test('superseded providerRequestId cannot be rebound (verification_conflict, no new row)', async () => {
    const vid1 = uniq('adv3'), em1 = `${uniq('adv3e')}@x.test`
    const vid2 = uniq('adv4'), em2 = `${uniq('adv4e')}@x.test`

    // Install P bound to (C1, E1), then manually supersede it.
    const start1 = await simulateStart({ visitorId: vid1, email: em1, name: 'A' })
    if (!start1.ok) throw new Error('START 1 failed')
    const P = start1.req.providerRequestId
    await withTenant(tenant.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: start1.req.id }, data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() } })
    })

    // Adversary: (C2, E2) START with the same P. The dedup finds existing
    // NON-active P -> verification_conflict (no rebind, no new row).
    const replaySend: SendOtpFn = async () => ({ otpRequestId: P, expiresAt: new Date(Date.now() + 600000).toISOString() })
    const start2 = await simulateStart({ visitorId: vid2, email: em2, name: 'B', sendOtpFn: replaySend })
    expect(start2.ok).toBe(false)
    if (start2.ok) throw new Error('expected verification_conflict')
    expect(start2.error).toBe('verification_conflict')

    // No new row created; P still bound to (C1, E1) and superseded.
    const rowsForP = await withTenant(tenant.id, async () => db.widgetOtpRequest.findMany({
      where: { providerRequestId: P },
      select: { contactId: true, email: true, status: true },
    }))
    expect(rowsForP).toHaveLength(1)
    expect(rowsForP[0].contactId).toBe(start1.contactId)
    expect(rowsForP[0].email).toBe(em1)
    expect(rowsForP[0].status).toBe('superseded')

    // C2's contact was created by the upsert but has no OTP and is unverified.
    const c2 = await withTenant(tenant.id, async () => db.contact.findUnique({
      where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid2 } },
      select: { email: true, emailVerifiedAt: true },
    }))
    expect(c2!.email).toBeNull()
    expect(c2!.emailVerifiedAt).toBeNull()
  })
})
