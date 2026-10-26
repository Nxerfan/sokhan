/// <reference types="bun-types" />
/**
 * Widget OTP resend — ACTUAL production-route tests (BLOCKER 2).
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Invokes the REAL production route handlers
 * (POST /api/widget/[slug]/verify-identity/{start,resend,verify}) directly with
 * constructed NextRequest objects — proving the resend contract end-to-end
 * (NOT just the simulateResend helper). mock.module replaces
 * @/lib/nixify/client for THIS file only — counting sendOtp/resendOtp/verifyOtp
 * proves provider-call bounding under concurrency (BLOCKER 1, at the route
 * level). Rate limiting does NOT interfere (localhost bypass in the
 * non-production/no-REDIS test runner; NOT globally weakened).
 */

import { test, expect, describe, beforeAll, afterAll, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { db, globalDb, withTenant } from '@/lib/db'
import crypto from 'crypto'

const MOCK_CODE = '123456'
const MAX_RESENDS = 3
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

// Counters + failure toggle for the mocked provider.
let sendOtpCount = 0
let resendOtpCount = 0
let resendShouldThrow = false
let resendThrowCode = 'rate_limited'
let resendThrowStatus = 429

mock.module('@/lib/nixify/client', () => {
  class NixifyError extends Error {
    code: string
    statusCode: number
    apiRequestId?: string
    retryAfterSeconds?: number
    constructor(code: string, message: string, statusCode: number = 400) {
      super(message)
      this.name = 'NixifyError'
      this.code = code
      this.statusCode = statusCode
    }
  }
  return {
    sendOtp: async (_email: string, _purpose: string) => {
      sendOtpCount++
      return { otpRequestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, expiresAt: new Date(Date.now() + 600000).toISOString() }
    },
    resendOtp: async (_email: string, _purpose: string) => {
      resendOtpCount++
      if (resendShouldThrow) throw new NixifyError(resendThrowCode, 'mock provider failure', resendThrowStatus)
      return { otpRequestId: `mock_req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, expiresAt: new Date(Date.now() + 600000).toISOString() }
    },
    verifyOtp: async (_email: string, code: string, _purpose: string, expected: string) => {
      if (code !== MOCK_CODE) throw new NixifyError('code_mismatch', 'Mock code mismatch', 400)
      return { verified: true, otpRequestId: expected }
    },
    NixifyError,
    getErrorMessage: (code: string) => ({ fa: code, en: code }),
    NIXIFY_ENDPOINTS: { send: '', verify: '', resend: '' },
    PURPOSE_MAP: { signup: 'signup', login: 'login', reset_password: 'reset', widget_verify: 'login' },
    REQUEST_TIMEOUT_MS: 15000,
  }
})

// Import the routes AFTER mock.module so they bind the mocked provider.
const startRouteImport = import('@/app/api/widget/[slug]/verify-identity/start/route')
const resendRouteImport = import('@/app/api/widget/[slug]/verify-identity/resend/route')
const verifyRouteImport = import('@/app/api/widget/[slug]/verify-identity/verify/route')
const { POST: startRoute } = await startRouteImport
const { POST: resendRoute } = await resendRouteImport
const { POST: verifyRoute } = await verifyRouteImport

let tenant: { id: string; slug: string }
let policyVersion: number

beforeAll(async () => {
  tenant = await globalDb.tenant.create({
    data: { slug: `resend-route-${RUN_ID}`, name: `Resend Route ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
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

function uniq(s: string): string {
  return `${RUN_ID}-${s}-${Math.random().toString(36).slice(2, 8)}`
}

async function callRoute(handler: typeof startRoute, body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/${tenant.slug}/x`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await handler(req, { params: Promise.resolve({ slug: tenant.slug }) })
  let data: any = null
  try { data = await res.json() } catch { /* non-json */ }
  return { status: res.status, data }
}

const start = (body: Record<string, unknown>) => callRoute(startRoute, body)
const resend = (body: Record<string, unknown>) => callRoute(resendRoute, body)
const verify = (body: Record<string, unknown>) => callRoute(verifyRoute, body)

describe('Actual resend route — happy path', () => {
  test('START -> resend: rotates providerRequestId, increments resendCount, resets attempts, preserves email/pendingName, Contact unchanged, old unusable, new verifies', async () => {
    const vid = uniq('rh'), em = `${uniq('rh')}@x.test`
    // START an active flow via the real route.
    const s = await start({ visitorId: vid, email: em, name: 'Pending Name' })
    expect(s.status).toBe(200)
    const oldPr = s.data.requestId
    expect(oldPr).toBeTruthy()

    // Burn an attempt to prove attempts resets on resend (via the real verify route).
    const wrongCode = await verify({ visitorId: vid, email: em, code: '000000', requestId: oldPr })
    expect(wrongCode.status).toBe(400) // code_mismatch
    const beforeResend = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { providerRequestId: oldPr }, select: { attempts: true, resendCount: true } }))
    expect(beforeResend!.attempts).toBe(1)

    // RESEND via the real route.
    resendOtpCount = 0
    const r = await resend({ visitorId: vid })
    expect(r.status).toBe(200)
    expect(r.data.requestId).not.toBe(oldPr)
    expect(resendOtpCount).toBe(1) // exactly one provider call for a single resend
    const newPr = r.data.requestId

    // State after resend.
    const after = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({
      where: { providerRequestId: newPr },
      select: { providerRequestId: true, resendCount: true, attempts: true, status: true, verified: true, email: true, pendingName: true, expiresAt: true },
    }))
    expect(after).not.toBeNull()
    expect(after!.resendCount).toBe(1)
    expect(after!.attempts).toBe(0) // reset
    expect(after!.status).toBe('active') // remain
    expect(after!.verified).toBe(false) // remain
    expect(after!.email).toBe(em) // persisted email unchanged
    expect(after!.pendingName).toBe('Pending Name') // preserved
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now()) // updated

    // Contact unchanged before final verification.
    const contact = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid } }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(contact!.email).toBeNull()
    expect(contact!.emailVerifiedAt).toBeNull()
    expect(contact!.name).toBe('Visitor')

    // Old providerRequestId cannot verify (rotated away -> request_not_found).
    const vOld = await verify({ visitorId: vid, email: em, code: MOCK_CODE, requestId: oldPr })
    expect(vOld.status).toBe(404)
    expect(vOld.data.error).toBe('request_not_found')

    // New providerRequestId can verify.
    const vNew = await verify({ visitorId: vid, email: em, code: MOCK_CODE, requestId: newPr })
    expect(vNew.status).toBe(200)
    expect(vNew.data.verified).toBe(true)
  })
})

describe('Actual resend route — correlation', () => {
  test('wrong email -> wrong_correlation (safe, no rotation)', async () => {
    const vid = uniq('rc1'), em = `${uniq('rc1')}@x.test`
    const s = await start({ visitorId: vid, email: em, name: 'C' })
    expect(s.status).toBe(200)
    const before = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { providerRequestId: s.data.requestId }, select: { providerRequestId: true, resendCount: true } }))

    const r = await resend({ visitorId: vid, email: 'wrong@x.test' })
    expect(r.status).toBe(409)
    expect(r.data.error).toBe('wrong_correlation')

    // No rotation.
    const after = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { providerRequestId: s.data.requestId }, select: { providerRequestId: true, resendCount: true } }))
    expect(after!.providerRequestId).toBe(before!.providerRequestId)
    expect(after!.resendCount).toBe(before!.resendCount)
  })

  test('stale requestId -> wrong_correlation (safe, no rotation)', async () => {
    const vid = uniq('rc2'), em = `${uniq('rc2')}@x.test`
    const s = await start({ visitorId: vid, email: em, name: 'C' })
    const r1 = await resend({ visitorId: vid })
    expect(r1.status).toBe(200)
    // Resend with the OLD (stale) requestId -> wrong_correlation.
    const r2 = await resend({ visitorId: vid, requestId: s.data.requestId })
    expect(r2.status).toBe(409)
    expect(r2.data.error).toBe('wrong_correlation')
  })
})

describe('Actual resend route — identity class', () => {
  test('non-visitorId Contact -> identity_conflict (safe, OTP untouched)', async () => {
    const vid = uniq('ric')
    // Create a Contact with identifierType='external_user' (wrong identity class)
    // whose identifier collides with the resend visitorId. Bypass the route
    // (which would reject identity_conflict at START).
    const c = await globalDb.contact.create({
      data: { tenantId: tenant.id, identifier: vid, identifierType: 'external_user', externalUserId: `ext_${crypto.randomUUID()}`, name: 'External', locale: 'fa', metadata: {} },
      select: { id: true },
    })
    // Manually install an active OTP for this contact (the route can't START for it).
    const otp = await globalDb.widgetOtpRequest.create({
      data: { tenantId: tenant.id, contactId: c.id, email: `${uniq('ric')}@x.test`, pendingName: null, purpose: 'widget_verify', providerRequestId: `manual-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false, verifiedAt: null },
      select: { id: true, providerRequestId: true, resendCount: true },
    })

    const r = await resend({ visitorId: vid })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('identity_conflict')

    // OTP untouched.
    const after = await withTenant(tenant.id, async () => db.widgetOtpRequest.findUnique({ where: { id: otp.id }, select: { providerRequestId: true, resendCount: true, status: true } }))
    expect(after!.providerRequestId).toBe(otp.providerRequestId)
    expect(after!.resendCount).toBe(0)
    expect(after!.status).toBe('active')
  })
})

describe('Actual resend route — resend limit', () => {
  test('MAX+1 resend -> resend_limit (state unchanged, provider NOT called)', async () => {
    const vid = uniq('rl2'), em = `${uniq('rl2')}@x.test`
    const s = await start({ visitorId: vid, email: em, name: 'L2' })
    const contact = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid } }, select: { id: true } }))

    for (let i = 0; i < MAX_RESENDS; i++) {
      const r = await resend({ visitorId: vid })
      expect(r.status).toBe(200)
    }
    const beforeLimit = await withTenant(tenant.id, async () => db.widgetOtpRequest.findFirst({ where: { contactId: contact!.id, purpose: 'widget_verify' }, orderBy: { createdAt: 'desc' }, select: { resendCount: true, providerRequestId: true } }))
    expect(beforeLimit!.resendCount).toBe(MAX_RESENDS)
    const currentPr = beforeLimit!.providerRequestId

    resendOtpCount = 0
    const r = await resend({ visitorId: vid })
    expect(r.status).toBe(429)
    expect(r.data.error).toBe('resend_limit')
    // Provider NOT called for the rejected resend.
    expect(resendOtpCount).toBe(0)

    // State unchanged.
    const after = await withTenant(tenant.id, async () => db.widgetOtpRequest.findFirst({ where: { contactId: contact!.id, purpose: 'widget_verify' }, orderBy: { createdAt: 'desc' }, select: { resendCount: true, providerRequestId: true, status: true, verified: true } }))
    expect(after!.resendCount).toBe(MAX_RESENDS)
    expect(after!.providerRequestId).toBe(currentPr) // NOT rotated
    expect(after!.status).toBe('active')
    expect(after!.verified).toBe(false)
  })
})

describe('Actual resend route — provider failure', () => {
  test('provider failure -> safe error, local OTP state unchanged', async () => {
    const vid = uniq('rpf'), em = `${uniq('rpf')}@x.test`
    const s = await start({ visitorId: vid, email: em, name: 'P' })
    const contact = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid } }, select: { id: true } }))
    const before = await withTenant(tenant.id, async () => db.widgetOtpRequest.findFirst({ where: { contactId: contact!.id, purpose: 'widget_verify' }, orderBy: { createdAt: 'desc' }, select: { providerRequestId: true, resendCount: true, attempts: true, expiresAt: true, status: true, verified: true, email: true, pendingName: true } }))

    // Make the provider throw.
    resendShouldThrow = true
    resendThrowCode = 'rate_limited'
    resendThrowStatus = 429
    try {
      const r = await resend({ visitorId: vid })
      // Safe error (Nixify error code surfaced, no raw internal leak).
      expect(r.status).toBe(429)
      expect(r.data.error).toBe('rate_limited')
    } finally {
      resendShouldThrow = false
    }

    // Local OTP state UNCHANGED (the transaction rolled back — resendCount NOT
    // consumed, providerRequestId NOT rotated, attempts NOT reset).
    const after = await withTenant(tenant.id, async () => db.widgetOtpRequest.findFirst({ where: { contactId: contact!.id, purpose: 'widget_verify' }, orderBy: { createdAt: 'desc' }, select: { providerRequestId: true, resendCount: true, attempts: true, expiresAt: true, status: true, verified: true, email: true, pendingName: true } }))
    expect(after!.providerRequestId).toBe(before!.providerRequestId) // NOT rotated
    expect(after!.resendCount).toBe(before!.resendCount) // NOT incremented
    expect(after!.attempts).toBe(before!.attempts)
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime())
    expect(after!.status).toBe(before!.status)
    expect(after!.verified).toBe(before!.verified)
    expect(after!.email).toBe(before!.email)
    expect(after!.pendingName).toBe(before!.pendingName)

    // Contact unchanged.
    const contactAfter = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contact!.id }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(contactAfter!.email).toBeNull()
    expect(contactAfter!.emailVerifiedAt).toBeNull()
  })
})

describe('Actual resend route — concurrent resend (provider-call bounding)', () => {
  test('10 concurrent resends: provider resendOtp calls bounded to MAX_RESENDS, final resendCount=MAX, one authoritative, no 500/raw P2002, Contact unchanged', async () => {
    const vid = uniq('rcc'), em = `${uniq('rcc')}@x.test`
    const s = await start({ visitorId: vid, email: em, name: 'CC' })
    expect(s.status).toBe(200)
    const contact = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { tenantId_identifier: { tenantId: tenant.id, identifier: vid } }, select: { id: true } }))

    resendOtpCount = 0
    const results = await Promise.all(Array.from({ length: 10 }, () => resend({ visitorId: vid })))

    // No 500, no raw P2002 — every response is a safe application result.
    for (const r of results) {
      expect(r.status).toBeLessThan(500)
      expect([200, 409, 429].includes(r.status)).toBe(true)
    }

    // Provider resendOtp calls MUST be bounded to MAX_RESENDS. (Pre-fix route:
    // resendOtpCount === 10 — FAILS here. Post-fix route: resendOtpCount === 3.)
    expect(resendOtpCount).toBeLessThanOrEqual(MAX_RESENDS)
    expect(resendOtpCount).toBe(MAX_RESENDS)

    // Final resendCount = MAX_RESENDS.
    const row = await withTenant(tenant.id, async () => db.widgetOtpRequest.findFirst({ where: { contactId: contact!.id, purpose: 'widget_verify' }, orderBy: { createdAt: 'desc' }, select: { resendCount: true, status: true, verified: true, providerRequestId: true, attempts: true } }))
    expect(row!.resendCount).toBe(MAX_RESENDS)
    expect(row!.status).toBe('active')
    expect(row!.verified).toBe(false)
    expect(row!.attempts).toBe(0)

    // Exactly one authoritative providerRequestId (partial unique guarantees one active).
    const active = await withTenant(tenant.id, async () => db.widgetOtpRequest.findMany({ where: { contactId: contact!.id, status: 'active' } }))
    expect(active).toHaveLength(1)
    expect(row!.providerRequestId).not.toBe(s.data.requestId) // rotated

    // Resend-limit results for the contenders that lost the resend slot.
    const resent = results.filter((r) => r.status === 200)
    const limited = results.filter((r) => r.status === 429)
    expect(resent.length).toBe(MAX_RESENDS)
    expect(limited.length).toBe(10 - MAX_RESENDS)

    // Contact unchanged.
    const contactAfter = await withTenant(tenant.id, async () => db.contact.findUnique({ where: { id: contact!.id }, select: { email: true, emailVerifiedAt: true, name: true } }))
    expect(contactAfter!.email).toBeNull()
    expect(contactAfter!.emailVerifiedAt).toBeNull()
  })
})
