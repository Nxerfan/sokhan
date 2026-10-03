/**
 * Regression tests for the shared realtime-token module.
 *
 * Covers:
 *   - Token expiry (iat/exp signed fields)
 *   - Timing-safe signature comparison
 *   - Rejection of: expired tokens, malformed exp, future iat, bad
 *     signature, invalid payload type, non-object payload.
 *   - The legacy `sig !== expectedSig` (non-constant-time) pattern must NOT
 *     be present in any of the three verifiers.
 */

import { test, expect } from 'bun:test'
import crypto from 'crypto'
import {
  signToken,
  verifyToken,
  DEFAULT_TOKEN_TTL_SECONDS,
} from '../../src/lib/realtime-token-shared'

const SECRET = 'test-secret-for-regression-12345'
const ALT_SECRET = 'different-secret-67890'

function makeLegacyToken(payload: object, secret: string): string {
  // A token WITHOUT iat/exp (the old format) — must be rejected.
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

function makeExpiredToken(payload: object, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload = { ...payload, iat: now - 3600, exp: now - 60 } // expired 1 min ago
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

function makeFutureIatToken(payload: object, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload = { ...payload, iat: now + 3600, exp: now + 7200 } // iat 1h in future
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

function makeMalformedExpToken(payload: object, secret: string): string {
  const fullPayload = { ...payload, iat: 'not-a-number', exp: 'not-a-number' }
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

function makeBadSigToken(payload: object, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload = { ...payload, iat: now, exp: now + 600 }
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url')
  const realSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  // Flip the first character to break the signature
  const badSig = (realSig[0] === 'a' ? 'b' : 'a') + realSig.slice(1)
  return `${encoded}.${badSig}`
}

// ------------------------------------------------------------------
// Expiry tests
// ------------------------------------------------------------------

test('fresh token verifies successfully', () => {
  const token = signToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  const payload = verifyToken(token, SECRET)
  expect(payload).not.toBeNull()
  expect(payload!.type).toBe('agent')
})

test('expired token is rejected', () => {
  const token = makeExpiredToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('future iat is rejected', () => {
  const token = makeFutureIatToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('malformed exp (not a number) is rejected', () => {
  const token = makeMalformedExpToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('token without iat/exp (legacy format) is rejected', () => {
  const token = makeLegacyToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('token TTL defaults to 10 minutes', () => {
  expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(600)
})

// ------------------------------------------------------------------
// Signature tests
// ------------------------------------------------------------------

test('token with wrong secret is rejected', () => {
  const token = signToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, ALT_SECRET)).toBeNull()
})

test('token with bad signature is rejected', () => {
  const token = makeBadSigToken({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' }, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('token with no signature (single segment) is rejected', () => {
  const encoded = Buffer.from(JSON.stringify({ type: 'agent', userId: 'u1', tenantId: 't1', role: 'agent' })).toString('base64url')
  expect(verifyToken(encoded, SECRET)).toBeNull()
})

test('garbage token is rejected', () => {
  expect(verifyToken('garbage.token', SECRET)).toBeNull()
})

test('empty token is rejected', () => {
  expect(verifyToken('', SECRET)).toBeNull()
})

// ------------------------------------------------------------------
// Payload type tests
// ------------------------------------------------------------------

test('token with invalid payload type is rejected', () => {
  const token = signToken({ type: 'admin', userId: 'u1', tenantId: 't1' } as any, SECRET)
  expect(verifyToken(token, SECRET)).toBeNull()
})

test('token with non-object payload is rejected', () => {
  // A JSON string payload
  const encoded = Buffer.from('"just-a-string"').toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url')
  expect(verifyToken(`${encoded}.${sig}`, SECRET)).toBeNull()
})

test('visitor token verifies successfully', () => {
  const token = signToken({ type: 'visitor', contactId: 'c1', tenantId: 't1', slug: 'test-slug' }, SECRET)
  const payload = verifyToken(token, SECRET)
  expect(payload).not.toBeNull()
  expect(payload!.type).toBe('visitor')
  if (payload!.type === 'visitor') {
    expect(payload.contactId).toBe('c1')
    expect(payload.slug).toBe('test-slug')
  }
})

// ------------------------------------------------------------------
// Timing-safe comparison regression
// ------------------------------------------------------------------

test('verifyToken uses timing-safe comparison (not string ===)', () => {
  // Read the source file and assert it uses crypto.timingSafeEqual
  const source = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/lib/realtime-token-shared.ts'),
    'utf-8'
  )
  expect(source).toContain('timingSafeEqual')
  expect(source).not.toContain('sig !== expectedSig')
})

test('app-side realtime-token.ts delegates to shared module', () => {
  const source = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/lib/realtime-token.ts'),
    'utf-8'
  )
  expect(source).toContain('realtime-token-shared')
  expect(source).not.toContain('sig !== expectedSig')
})

test('Vercel realtime function uses shared module', () => {
  const source = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../api/realtime.ts'),
    'utf-8'
  )
  expect(source).toContain('realtime-token-shared')
  expect(source).not.toMatch(/\bsig\s*!==\s*expectedSig\b/)
})

test('Docker realtime service uses shared module', () => {
  const source = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../mini-services/realtime/index.ts'),
    'utf-8'
  )
  expect(source).toContain('realtime-token-shared')
  expect(source).not.toMatch(/\bsig\s*!==\s*expectedSig\b/)
})
