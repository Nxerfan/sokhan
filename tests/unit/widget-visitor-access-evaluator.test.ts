/// <reference types="bun-types" />
/**
 * Unit tests for `evaluateVisitorCurrentPolicyAccess` — the pure shared
 * evaluator that powers:
 *   - REST POST /api/widget/[slug]/messages (send authorization)
 *   - Vercel realtime io.use() (visitor connect)
 *   - Vercel realtime conversation:join (revalidation)
 *   - Docker realtime io.use() + conversation:join (via the internal verifier endpoint)
 *
 * Pure — no DB, no Next.js, no Prisma. The caller loads the tenant's
 * WidgetConfig + the Contact's identity class and passes them in.
 *
 * Coverage:
 *   - Legacy both-absent tokens (anonymous mode → allow; verified_visitor
 *     → deny verification_required; site_user_only → deny website_login_required).
 *   - Partial claims (one present, one missing) → identity_token_invalid.
 *   - Malformed claims (corrupt identityLevel, policyVersion=0, explicit
 *     null) → identity_token_invalid.
 *   - Modern anonymous / verified_contact / external_user tokens across
 *     all three modes (anonymous accepts stronger; verified_visitor
 *     requires verified_contact/external_user; site_user_only requires
 *     external_user only).
 *   - Stale policyVersion (pv mismatch) → policy_changed.
 *   - Contact identity class mismatch (e.g. a verified_contact token for
 *     an externalUser Contact, or a Contact missing emailVerifiedAt) →
 *     identity_token_invalid.
 *   - Corrupt current policy (invalid accessMode / invalid policyVersion) →
 *     policy_unavailable.
 */

import { test, expect, describe } from 'bun:test'
import {
  evaluateVisitorCurrentPolicyAccess,
  type ContactIdentityClass,
} from '@/lib/widget-access-evaluator'

const vcContact: ContactIdentityClass = {
  identifierType: 'visitorId',
  externalUserId: null,
  emailVerifiedAt: new Date(),
}
const anonContact: ContactIdentityClass = {
  identifierType: 'visitorId',
  externalUserId: null,
  emailVerifiedAt: null,
}
const extContact: ContactIdentityClass = {
  identifierType: 'externalUser',
  externalUserId: 'ext-1',
  emailVerifiedAt: null,
}

// ===========================================================================
// legacy both-claims-absent tokens
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — legacy tokens (both claims absent)', () => {
  test('anonymous mode → allow (identityLevel=anonymous)', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: undefined,
      tokenPolicyVersion: undefined,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('anonymous')
  })

  test('verified_visitor mode → deny verification_required', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: undefined,
      tokenPolicyVersion: undefined,
      contactIdentityClass: vcContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('verification_required')
  })

  test('site_user_only mode → deny website_login_required', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: undefined,
      tokenPolicyVersion: undefined,
      contactIdentityClass: extContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('website_login_required')
  })
})

// ===========================================================================
// partial claims (one present, one missing)
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — partial claims → identity_token_invalid', () => {
  test('identityLevel present, policyVersion absent → deny identity_token_invalid', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: undefined,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('identityLevel absent, policyVersion present → deny identity_token_invalid', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: undefined,
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })
})

// ===========================================================================
// malformed claims
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — malformed claims → identity_token_invalid', () => {
  test('corrupt identityLevel (not in the canonical set) → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'corrupt',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('policyVersion=0 (invalid) → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 0,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('explicit null identityLevel + null policyVersion → deny (not legacy)', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: null,
      tokenPolicyVersion: null,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })
})

// ===========================================================================
// modern tokens across all three modes
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — modern tokens (matrix)', () => {
  test('modern anonymous + anonymous mode → allow', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('anonymous')
  })

  test('modern verified_contact + anonymous mode → allow (anonymous accepts stronger)', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 1,
      contactIdentityClass: vcContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('verified_contact')
  })

  test('modern external_user + anonymous mode → allow (anonymous accepts stronger)', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 1,
      contactIdentityClass: extContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('external_user')
  })

  test('modern anonymous + verified_visitor mode → deny verification_required', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 2,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('verification_required')
  })

  test('modern verified_contact + verified_visitor mode → allow', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 2,
      contactIdentityClass: vcContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('verified_contact')
  })

  test('modern external_user + verified_visitor mode → allow', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 2,
      contactIdentityClass: extContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('external_user')
  })

  test('modern anonymous + site_user_only mode → deny website_login_required', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 3,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('website_login_required')
  })

  test('modern verified_contact + site_user_only mode → deny website_login_required', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 3,
      contactIdentityClass: vcContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('website_login_required')
  })

  test('modern external_user + site_user_only mode → allow', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 3,
      contactIdentityClass: extContact,
    })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.identityLevel).toBe('external_user')
  })
})

// ===========================================================================
// stale policyVersion → policy_changed
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — stale policyVersion → policy_changed', () => {
  test('verified_visitor + verified_contact token with stale pv → deny policy_changed', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 1, // stale
      contactIdentityClass: vcContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_changed')
  })

  test('site_user_only + external_user token with stale pv → deny policy_changed', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 2, // stale
      contactIdentityClass: extContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_changed')
  })

  test('anonymous mode does NOT enforce pv (anonymous allows legacy tokens) — allow despite stale pv', () => {
    // Anonymous mode never requires verification — pv mismatch is irrelevant.
    // (resolveLegacyTokenIdentity would also accept legacy both-absent; for
    // modern tokens the parsed pv is only checked when requiresVerification.)
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 5,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1, // stale — but anonymous mode ignores pv
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(true)
  })
})

// ===========================================================================
// contact identity class mismatch
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — Contact identity class mismatch → identity_token_invalid', () => {
  test('verified_contact token for an externalUser Contact → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 2,
      contactIdentityClass: extContact, // externalUser, not visitorId
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('external_user token for a visitorId Contact → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 3,
      contactIdentityClass: vcContact, // visitorId, not externalUser
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('verified_contact token for a Contact missing emailVerifiedAt → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'verified_visitor',
      currentPolicyVersion: 2,
      tokenIdentityLevel: 'verified_contact',
      tokenPolicyVersion: 2,
      contactIdentityClass: anonContact, // visitorId but emailVerifiedAt=null
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('anonymous token for a Contact with externalUserId set → deny (visitorId class violated)', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: { identifierType: 'visitorId', externalUserId: 'leak', emailVerifiedAt: null },
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })

  test('external_user token for a Contact with externalUserId=null → deny', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'site_user_only',
      currentPolicyVersion: 3,
      tokenIdentityLevel: 'external_user',
      tokenPolicyVersion: 3,
      contactIdentityClass: { identifierType: 'externalUser', externalUserId: null, emailVerifiedAt: null },
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('identity_token_invalid')
  })
})

// ===========================================================================
// corrupt current policy → policy_unavailable
// ===========================================================================

describe('evaluateVisitorCurrentPolicyAccess — corrupt current policy → policy_unavailable', () => {
  test('corrupt current accessMode → deny policy_unavailable', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'corrupt_mode',
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })

  test('current policyVersion=0 → deny policy_unavailable', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: 0,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })

  test('current accessMode=null → deny policy_unavailable', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: null,
      currentPolicyVersion: 1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })

  test('current policyVersion negative → deny policy_unavailable', () => {
    const r = evaluateVisitorCurrentPolicyAccess({
      currentAccessMode: 'anonymous',
      currentPolicyVersion: -1,
      tokenIdentityLevel: 'anonymous',
      tokenPolicyVersion: 1,
      contactIdentityClass: anonContact,
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('policy_unavailable')
  })
})
