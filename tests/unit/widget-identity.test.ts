/// <reference types="bun-types" />
/**
 * Unit tests for the widget access-policy + identity-token libraries.
 * (feat/widget-visitor-access-modes — PHASE 5)
 *
 * Pure unit tests (no DB) — run via `bun test tests/unit/widget-identity.test.ts`.
 * Covers: strict parsing, token identityLevel verification, signer policyVersion
 * validation, legacy-token compatibility, publicAccessConfig fail-closed.
 */

import { test, expect, describe } from 'bun:test'
import {
  parseAccessMode,
  parseIdentityLevel,
  parsePolicyVersion,
  coerceAccessMode,
  evaluateSendAuthorization,
  isIdentitySufficient,
  resolveLegacyTokenIdentity,
  publicAccessConfig,
  type AccessMode,
  type IdentityLevel,
} from '@/lib/widget-access-policy'
import {
  signResumeCredential,
  verifyResumeCredential,
  signExternalIdentityToken,
  verifyExternalIdentityToken,
  tamperToken,
} from '@/lib/widget-identity-tokens'

import crypto from 'crypto'
import { getAuthSecret } from '@/lib/env-check'

// Test-only raw envelope signer — creates correctly-signed HS256 envelopes
// with ARBITRARY claims for negative testing. Does NOT export production
// signing primitives — test-only code in the test file.
function signRawEnvelope(payload: Record<string, unknown>, opts?: { pastExpiry?: boolean; futureIat?: boolean }): string {
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: opts?.futureIat ? now + 9999 : now, exp: opts?.pastExpiry ? now - 1 : now + 300 }
  const encoded = Buffer.from(JSON.stringify(full)).toString('base64url')
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(encoded).digest('base64url')
  return encoded + '.' + sig
}

// --- strict parsing ---

describe('parseAccessMode (strict)', () => {
  test('valid modes', () => {
    expect(parseAccessMode('anonymous')).toBe('anonymous')
    expect(parseAccessMode('verified_visitor')).toBe('verified_visitor')
    expect(parseAccessMode('site_user_only')).toBe('site_user_only')
  })
  test('invalid → null (never anonymous)', () => {
    expect(parseAccessMode('corrupt')).toBeNull()
    expect(parseAccessMode('')).toBeNull()
    expect(parseAccessMode(null)).toBeNull()
    expect(parseAccessMode(undefined)).toBeNull()
    expect(parseAccessMode(123)).toBeNull()
    expect(parseAccessMode({})).toBeNull()
  })
  test('coerceAccessMode (tolerant — display only) defaults to anonymous', () => {
    expect(coerceAccessMode('corrupt')).toBe('anonymous')
    expect(coerceAccessMode(null)).toBe('anonymous')
  })
})

describe('parseIdentityLevel (strict)', () => {
  test('valid levels', () => {
    expect(parseIdentityLevel('anonymous')).toBe('anonymous')
    expect(parseIdentityLevel('verified_contact')).toBe('verified_contact')
    expect(parseIdentityLevel('external_user')).toBe('external_user')
  })
  test('invalid → null', () => {
    expect(parseIdentityLevel('corrupt')).toBeNull()
    expect(parseIdentityLevel(null)).toBeNull()
    expect(parseIdentityLevel(42)).toBeNull()
  })
})

describe('parsePolicyVersion (strict)', () => {
  test('valid positive integer', () => {
    expect(parsePolicyVersion(1)).toBe(1)
    expect(parsePolicyVersion(99)).toBe(99)
  })
  test('0 rejected', () => { expect(parsePolicyVersion(0)).toBeNull() })
  test('negative rejected', () => { expect(parsePolicyVersion(-1)).toBeNull() })
  test('fractional rejected', () => { expect(parsePolicyVersion(1.5)).toBeNull() })
  test('NaN rejected', () => { expect(parsePolicyVersion(NaN)).toBeNull() })
  test('Infinity rejected', () => { expect(parsePolicyVersion(Infinity)).toBeNull() })
  test('non-number rejected', () => { expect(parsePolicyVersion('1')).toBeNull(); expect(parsePolicyVersion(null)).toBeNull() })
})

// --- evaluateSendAuthorization ---

describe('evaluateSendAuthorization (strict — deny on invalid)', () => {
  test('invalid accessMode → policy_unavailable', () => {
    const r = evaluateSendAuthorization({ accessMode: 'corrupt', currentPolicyVersion: 1, identityLevel: 'anonymous' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })
  test('invalid policyVersion → policy_unavailable', () => {
    const r = evaluateSendAuthorization({ accessMode: 'anonymous', currentPolicyVersion: NaN, identityLevel: 'anonymous' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })
  test('invalid identityLevel → policy_unavailable', () => {
    const r = evaluateSendAuthorization({ accessMode: 'anonymous', currentPolicyVersion: 1, identityLevel: 'corrupt' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })
  test('anonymous mode allows anonymous', () => {
    expect(evaluateSendAuthorization({ accessMode: 'anonymous', currentPolicyVersion: 1, identityLevel: 'anonymous' }).allowed).toBe(true)
  })
  test('verified_visitor denies anonymous', () => {
    const r = evaluateSendAuthorization({ accessMode: 'verified_visitor', currentPolicyVersion: 1, identityLevel: 'anonymous', presentedPolicyVersion: 1 })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('verification_required')
  })
  test('verified_visitor allows verified_contact', () => {
    expect(evaluateSendAuthorization({ accessMode: 'verified_visitor', currentPolicyVersion: 1, identityLevel: 'verified_contact', presentedPolicyVersion: 1 }).allowed).toBe(true)
  })
  test('site_user_only denies verified_contact', () => {
    const r = evaluateSendAuthorization({ accessMode: 'site_user_only', currentPolicyVersion: 1, identityLevel: 'verified_contact', presentedPolicyVersion: 1 })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('website_login_required')
  })
  test('site_user_only allows external_user', () => {
    expect(evaluateSendAuthorization({ accessMode: 'site_user_only', currentPolicyVersion: 1, identityLevel: 'external_user', presentedPolicyVersion: 1 }).allowed).toBe(true)
  })
  test('stale policyVersion → policy_changed', () => {
    const r = evaluateSendAuthorization({ accessMode: 'verified_visitor', currentPolicyVersion: 2, identityLevel: 'verified_contact', presentedPolicyVersion: 1 })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_changed')
  })
})

// --- resolveLegacyTokenIdentity ---

describe('resolveLegacyTokenIdentity', () => {
  test('modern token (has claims) → use them', () => {
    expect(resolveLegacyTokenIdentity({ currentAccessMode: 'verified_visitor', tokenIdentityLevel: 'verified_contact', tokenPolicyVersion: 1 })).toBe('verified_contact')
  })
  test('legacy token (missing claims) in anonymous mode → anonymous', () => {
    expect(resolveLegacyTokenIdentity({ currentAccessMode: 'anonymous', tokenIdentityLevel: undefined, tokenPolicyVersion: undefined })).toBe('anonymous')
  })
  test('legacy token in verified_visitor → null (rejected)', () => {
    expect(resolveLegacyTokenIdentity({ currentAccessMode: 'verified_visitor', tokenIdentityLevel: undefined, tokenPolicyVersion: undefined })).toBeNull()
  })
  test('legacy token in site_user_only → null (rejected)', () => {
    expect(resolveLegacyTokenIdentity({ currentAccessMode: 'site_user_only', tokenIdentityLevel: undefined, tokenPolicyVersion: undefined })).toBeNull()
  })
})

// --- publicAccessConfig fail-closed ---

describe('publicAccessConfig (fail-closed)', () => {
  test('valid config returns safe fields', () => {
    const r = publicAccessConfig({ accessMode: 'verified_visitor', policyVersion: 1, loginUrl: '/login', loginButtonLabel: 'Sign in', loginReturnUrlParam: 'return', identityEndpointPath: '/api/sukhan-identity' })
    expect(r).not.toBeNull()
    expect(r!.accessMode).toBe('verified_visitor')
    expect(r!.loginUrl).toBe('/login')
  })
  test('invalid accessMode → null (not anonymous)', () => {
    expect(publicAccessConfig({ accessMode: 'corrupt', policyVersion: 1 })).toBeNull()
  })
  test('invalid policyVersion → null', () => {
    expect(publicAccessConfig({ accessMode: 'anonymous', policyVersion: 0 })).toBeNull()
  })
})

// --- publicAccessConfig — legacy unsafe persisted-field validation ---
// publicAccessConfig validates the persisted login fields against the SAME
// contract as dashboard PATCH. A legacy unsafe value fail-closes (null) ->
// the public route returns 503 policy_unavailable. NEVER silently passed to
// the browser, NEVER coerced.

describe('publicAccessConfig — unsafe persisted fields fail-close', () => {
  const valid = { accessMode: 'verified_visitor' as const, policyVersion: 1, loginUrl: '/login', loginButtonLabel: 'Sign in', loginReturnUrlParam: 'next', identityEndpointPath: '/api/sukhan-identity' }

  test('exact safe values returned for a valid config', () => {
    const r = publicAccessConfig(valid)
    expect(r).not.toBeNull()
    expect(r!.accessMode).toBe('verified_visitor')
    expect(r!.policyVersion).toBe(1)
    expect(r!.loginUrl).toBe('/login')
    expect(r!.loginButtonLabel).toBe('Sign in')
    expect(r!.loginReturnUrlParam).toBe('next')
    expect(r!.identityEndpointPath).toBe('/api/sukhan-identity')
  })

  test('null login fields are allowed (not required)', () => {
    const r = publicAccessConfig({ accessMode: 'anonymous', policyVersion: 1, loginUrl: null, loginButtonLabel: null, loginReturnUrlParam: null, identityEndpointPath: null })
    expect(r).not.toBeNull()
    expect(r!.loginUrl).toBeNull()
    expect(r!.loginButtonLabel).toBeNull()
    expect(r!.loginReturnUrlParam).toBeNull()
    expect(r!.identityEndpointPath).toBeNull()
  })

  test('unsafe loginUrl -> null', () => {
    for (const bad of ['//evil.example', 'javascript:alert(1)', 'data:text/html,x', '/\\evil', 'http://x/\\e', 'x'.repeat(501), 'ht!tp://x']) {
      expect(publicAccessConfig({ ...valid, loginUrl: bad })).toBeNull()
    }
  })

  test('unsafe loginButtonLabel -> null (empty/whitespace/oversized)', () => {
    for (const bad of ['', '   ', '\t\n', 'x'.repeat(201)]) {
      expect(publicAccessConfig({ ...valid, loginButtonLabel: bad })).toBeNull()
    }
  })

  test('unsafe loginReturnUrlParam -> null (URL-structure/whitespace/oversized)', () => {
    for (const bad of ['re&turn', 're?turn', 're=turn', 're#turn', 're turn', 're\tturn', 'x'.repeat(101)]) {
      expect(publicAccessConfig({ ...valid, loginReturnUrlParam: bad })).toBeNull()
    }
  })

  test('unsafe identityEndpointPath -> null (absolute/backslash/query/oversized)', () => {
    for (const bad of ['https://x/api/identity', '//x/api/identity', '/\\api/identity', '/api/identity?foo=bar', '/api/identity#frag', '/?', 'x'.repeat(501)]) {
      expect(publicAccessConfig({ ...valid, identityEndpointPath: bad })).toBeNull()
    }
  })

  test('valid http(s) loginUrl accepted', () => {
    for (const ok of ['http://example.com/login', 'https://example.com/login', '/account/login', '/']) {
      expect(publicAccessConfig({ ...valid, loginUrl: ok })).not.toBeNull()
    }
  })
})

// --- resume credential ---

describe('signResumeCredential / verifyResumeCredential', () => {
  const tenantId = 'tenant-123'
  const contactId = 'contact-456'
  const pv = 1

  test('valid resume credential verifies', () => {
    const token = signResumeCredential({ contactId, tenantId, policyVersion: pv })
    const v = verifyResumeCredential(token, tenantId, pv)
    expect(v).not.toBeNull()
    expect(v!.contactId).toBe(contactId)
    expect(v!.tenantId).toBe(tenantId)
    expect(v!.policyVersion).toBe(pv)
  })

  test('wrong tenant → null', () => {
    const token = signResumeCredential({ contactId, tenantId, policyVersion: pv })
    expect(verifyResumeCredential(token, 'other-tenant', pv)).toBeNull()
  })

  test('stale policyVersion → null', () => {
    const token = signResumeCredential({ contactId, tenantId, policyVersion: 1 })
    expect(verifyResumeCredential(token, tenantId, 2)).toBeNull()
  })

  test('tampered token → null', () => {
    const token = signResumeCredential({ contactId, tenantId, policyVersion: pv })
    expect(verifyResumeCredential(tamperToken(token), tenantId, pv)).toBeNull()
  })

  test('invalid string → null', () => {
    expect(verifyResumeCredential('not-a-token', tenantId, pv)).toBeNull()
    expect(verifyResumeCredential('', tenantId, pv)).toBeNull()
  })

  test('signer rejects invalid policyVersion', () => {
    expect(() => signResumeCredential({ contactId, tenantId, policyVersion: 0 })).toThrow()
    expect(() => signResumeCredential({ contactId, tenantId, policyVersion: -1 })).toThrow()
    expect(() => signResumeCredential({ contactId, tenantId, policyVersion: 1.5 })).toThrow()
    expect(() => signResumeCredential({ contactId, tenantId, policyVersion: NaN })).toThrow()
    expect(() => signResumeCredential({ contactId, tenantId, policyVersion: Infinity })).toThrow()
  })
})

// --- external identity token ---

describe('signExternalIdentityToken / verifyExternalIdentityToken', () => {
  const tenantId = 'tenant-789'
  const externalUserId = 'ext-user-123'
  const contactId = 'contact-ext-1'
  const pv = 1

  test('valid external token verifies', () => {
    const token = signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: pv })
    const v = verifyExternalIdentityToken(token, tenantId, pv)
    expect(v).not.toBeNull()
    expect(v!.externalUserId).toBe(externalUserId)
    expect(v!.contactId).toBe(contactId)
    expect(v!.tenantId).toBe(tenantId)
    expect(v!.policyVersion).toBe(pv)
  })

  test('wrong tenant → null', () => {
    const token = signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: pv })
    expect(verifyExternalIdentityToken(token, 'other-tenant', pv)).toBeNull()
  })

  test('stale policyVersion → null', () => {
    const token = signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: 1 })
    expect(verifyExternalIdentityToken(token, tenantId, 2)).toBeNull()
  })

  test('tampered token → null', () => {
    const token = signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: pv })
    expect(verifyExternalIdentityToken(tamperToken(token), tenantId, pv)).toBeNull()
  })

  test('#3 empty externalUserId → null', () => {
    const token = signRawEnvelope({ type: 'external_identity', aud: 'sukhan-external', externalUserId: '', contactId, tenantId, identityLevel: 'external_user', policyVersion: pv })
    expect(verifyExternalIdentityToken(token, tenantId, pv)).toBeNull()
  })
  test('#3 missing externalUserId → null', () => {
    const token = signRawEnvelope({ type: 'external_identity', aud: 'sukhan-external', contactId, tenantId, identityLevel: 'external_user', policyVersion: pv })
    expect(verifyExternalIdentityToken(token, tenantId, pv)).toBeNull()
  })

  test('signer rejects invalid policyVersion', () => {
    expect(() => signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: 0 })).toThrow()
    expect(() => signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: -1 })).toThrow()
    expect(() => signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: 1.5 })).toThrow()
    expect(() => signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: NaN })).toThrow()
    expect(() => signExternalIdentityToken({ tenantId, externalUserId, contactId, policyVersion: Infinity })).toThrow()
  })
})

// --- cross-credential-type rejection ---

describe('cross-credential-type rejection (purpose/audience separation)', () => {
  test('resume credential not accepted as external token', () => {
    const resume = signResumeCredential({ contactId: 'c1', tenantId: 't1', policyVersion: 1 })
    expect(verifyExternalIdentityToken(resume, 't1', 1)).toBeNull()
  })
  test('external token not accepted as resume credential', () => {
    const ext = signExternalIdentityToken({ tenantId: 't1', externalUserId: 'e1', contactId: 'c1', policyVersion: 1 })
    expect(verifyResumeCredential(ext, 't1', 1)).toBeNull()
  })
})

// --- isIdentitySufficient ---

describe('isIdentitySufficient', () => {
  test('anonymous allows all', () => {
    expect(isIdentitySufficient('anonymous', 'anonymous')).toBe(true)
    expect(isIdentitySufficient('anonymous', 'verified_contact')).toBe(true)
    expect(isIdentitySufficient('anonymous', 'external_user')).toBe(true)
  })
  test('verified_visitor allows verified_contact + external_user, denies anonymous', () => {
    expect(isIdentitySufficient('verified_visitor', 'verified_contact')).toBe(true)
    expect(isIdentitySufficient('verified_visitor', 'external_user')).toBe(true)
    expect(isIdentitySufficient('verified_visitor', 'anonymous')).toBe(false)
  })
  test('site_user_only allows only external_user', () => {
    expect(isIdentitySufficient('site_user_only', 'external_user')).toBe(true)
    expect(isIdentitySufficient('site_user_only', 'verified_contact')).toBe(false)
    expect(isIdentitySufficient('site_user_only', 'anonymous')).toBe(false)
  })
})

// --- #4 resume credential — full negative envelope matrix ---

describe('resume credential — negative envelope matrix', () => {
  const tenantId = 't-neg', contactId = 'c-neg', pv = 1
  const base = { contactId, tenantId, policyVersion: pv }

  test('wrong audience → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'wrong', identityLevel: 'verified_contact' }), tenantId, pv)).toBeNull()
  })
  test('wrong type → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'wrong', aud: 'sukhan-resume', identityLevel: 'verified_contact' }), tenantId, pv)).toBeNull()
  })
  test('expired → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }, { pastExpiry: true }), tenantId, pv)).toBeNull()
  })
  test('future iat → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }, { futureIat: true }), tenantId, pv)).toBeNull()
  })
  test('missing identityLevel → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume' }), tenantId, pv)).toBeNull()
  })
  test('wrong identityLevel → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume', identityLevel: 'external_user' }), tenantId, pv)).toBeNull()
  })
  test('missing contactId → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ tenantId, policyVersion: pv, type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }), tenantId, pv)).toBeNull()
  })
  test('empty contactId → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, contactId: '', type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }), tenantId, pv)).toBeNull()
  })
  test('wrong tenant → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }), 'other-tenant', pv)).toBeNull()
  })
  test('stale policyVersion → null', () => {
    expect(verifyResumeCredential(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-resume', identityLevel: 'verified_contact' }), tenantId, 2)).toBeNull()
  })
  test('tampered signature → null', () => {
    expect(verifyResumeCredential(tamperToken(signResumeCredential({ ...base })), tenantId, pv)).toBeNull()
  })
})

// --- #4 external identity token — full negative envelope matrix ---

describe('external identity token — negative envelope matrix', () => {
  const tenantId = 't-ext-neg', externalUserId = 'ext-neg', contactId = 'c-ext-neg', pv = 1
  const base = { externalUserId, contactId, tenantId, policyVersion: pv }

  test('wrong audience → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'wrong', identityLevel: 'external_user' }), tenantId, pv)).toBeNull()
  })
  test('wrong type → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'resume', aud: 'sukhan-external', identityLevel: 'external_user' }), tenantId, pv)).toBeNull()
  })
  test('expired → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }, { pastExpiry: true }), tenantId, pv)).toBeNull()
  })
  test('future iat → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }, { futureIat: true }), tenantId, pv)).toBeNull()
  })
  test('missing identityLevel → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external' }), tenantId, pv)).toBeNull()
  })
  test('wrong identityLevel → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'verified_contact' }), tenantId, pv)).toBeNull()
  })
  test('missing externalUserId → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ contactId, tenantId, policyVersion: pv, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }), tenantId, pv)).toBeNull()
  })
  test('empty externalUserId → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, externalUserId: '', type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }), tenantId, pv)).toBeNull()
  })
  test('wrong tenant → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }), 'other-tenant', pv)).toBeNull()
  })
  test('stale policyVersion → null', () => {
    expect(verifyExternalIdentityToken(signRawEnvelope({ ...base, type: 'external_identity', aud: 'sukhan-external', identityLevel: 'external_user' }), tenantId, 2)).toBeNull()
  })
  test('tampered signature → null', () => {
    expect(verifyExternalIdentityToken(tamperToken(signExternalIdentityToken({ ...base })), tenantId, pv)).toBeNull()
  })
})
