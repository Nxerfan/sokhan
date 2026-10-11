/// <reference types="bun-types" />
/**
 * Nixify client contract tests.
 *
 * Mocks global.fetch to verify exact request/response contracts with
 * https://nixify.ir/api/v1/otp/* — no real network calls are made.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test'

// Set test env BEFORE importing the client
process.env.NIXIFY_API_KEY = 'test-nixify-key-12345'
process.env.NIXIFY_MOCK = ''

// Import the client (server-only is a no-op in Bun/Node)
import {
  sendOtp,
  verifyOtp,
  resendOtp,
  NixifyError,
  NIXIFY_ENDPOINTS,
  PURPOSE_MAP,
  REQUEST_TIMEOUT_MS,
} from '@/lib/nixify/client'

// ─── Mock helpers ───────────────────────────────────────────────
type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

let fetchCalls: FetchCall[] = []
let mockResponses: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = []
let mockResponseIndex = 0
let mockNetworkError: Error | null = null
let mockAbort = false
let originalFetch: typeof global.fetch

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString()
  fetchCalls.push({
    url: urlStr,
    method: init?.method || 'GET',
    headers: (init?.headers || {}) as Record<string, string>,
    body: (init?.body as string) || '',
  })

  if (mockNetworkError) {
    return Promise.reject(mockNetworkError)
  }

  if (mockAbort) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    return Promise.reject(err)
  }

  const mock = mockResponses[mockResponseIndex] || mockResponses[mockResponses.length - 1]
  mockResponseIndex++
  const headerMap = new Map<string, string>()
  if (mock.headers) {
    for (const [k, v] of Object.entries(mock.headers)) {
      headerMap.set(k.toLowerCase(), v)
    }
  }
  const response = {
    ok: mock.status >= 200 && mock.status < 300,
    status: mock.status,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) || null,
    },
    json: () => Promise.resolve(mock.body),
  }
  return Promise.resolve(response as unknown as Response)
}

beforeEach(() => {
  fetchCalls = []
  mockResponses = []
  mockResponseIndex = 0
  mockNetworkError = null
  mockAbort = false
  originalFetch = global.fetch
  global.fetch = mockFetch as typeof global.fetch
})

afterEach(() => {
  global.fetch = originalFetch
  process.env.NIXIFY_API_KEY = 'test-nixify-key-12345'
})

// ─── Tests ──────────────────────────────────────────────────────

test('send uses canonical https://nixify.ir/api/v1/otp/send', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_1', expires_at: '2026-10-06T12:00:00.000Z', request_id: 'trace_1' } })
  await sendOtp('user@test.com', 'signup')
  expect(fetchCalls[0].url).toBe('https://nixify.ir/api/v1/otp/send')
})

test('verify uses canonical https://nixify.ir/api/v1/otp/verify', async () => {
  mockResponses.push({ status: 200, body: { verified: true, otp_request_id: 'otp_expected_123', request_id: 'trace_1' } })
  await verifyOtp('user@test.com', '123456', 'signup', 'otp_expected_123')
  expect(fetchCalls[0].url).toBe('https://nixify.ir/api/v1/otp/verify')
})

test('resend uses canonical https://nixify.ir/api/v1/otp/resend', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_2', expires_at: '2026-10-06T12:00:00.000Z', request_id: 'trace_2' } })
  await resendOtp('user@test.com', 'signup')
  expect(fetchCalls[0].url).toBe('https://nixify.ir/api/v1/otp/resend')
})

test('sends Bearer <NIXIFY_API_KEY>', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_1', expires_at: '2026-10-06T12:00:00.000Z' } })
  await sendOtp('user@test.com', 'signup')
  expect(fetchCalls[0].headers['Authorization']).toBe('Bearer test-nixify-key-12345')
})

test('maps signup → signup', () => {
  expect(PURPOSE_MAP.signup).toBe('signup')
})

test('maps login → login', () => {
  expect(PURPOSE_MAP.login).toBe('login')
})

test('maps reset_password → reset (NOT reset_password)', () => {
  expect(PURPOSE_MAP.reset_password).toBe('reset')
})

test('send sends mapped purpose in body', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_1', expires_at: '2026-10-06T12:00:00.000Z' } })
  await sendOtp('user@test.com', 'reset_password')
  const body = JSON.parse(fetchCalls[0].body)
  expect(body.purpose).toBe('reset')
})

test('verify sends mapped purpose in body', async () => {
  mockResponses.push({ status: 200, body: { verified: true, otp_request_id: 'otp_expected_reset' } })
  await verifyOtp('user@test.com', '123456', 'reset_password', 'otp_expected_reset')
  const body = JSON.parse(fetchCalls[0].body)
  expect(body.purpose).toBe('reset')
})

test('send preserves otp_request_id as otpRequestId (NOT apiRequestId)', async () => {
  mockResponses.push({
    status: 200,
    body: { otp_request_id: 'otp_123', expires_at: '2026-10-06T12:00:00.000Z', request_id: 'api_trace_456' },
  })
  const result = await sendOtp('user@test.com', 'signup')
  expect(result.otpRequestId).toBe('otp_123')
  expect(result.apiRequestId).toBe('api_trace_456')
  expect(result.otpRequestId).not.toBe(result.apiRequestId)
})

test('verify preserves both IDs', async () => {
  mockResponses.push({
    status: 200,
    body: { verified: true, otp_request_id: 'otp_expected_123', request_id: 'api_trace_456' },
  })
  const result = await verifyOtp('user@test.com', '123456', 'signup', 'otp_expected_123')
  expect(result.verified).toBe(true)
  expect(result.otpRequestId).toBe('otp_expected_123')
  expect(result.apiRequestId).toBe('api_trace_456')
})

test('resend preserves both IDs', async () => {
  mockResponses.push({
    status: 200,
    body: { otp_request_id: 'otp_new', expires_at: '2026-10-06T12:10:00.000Z', request_id: 'trace_new' },
  })
  const result = await resendOtp('user@test.com', 'signup')
  expect(result.otpRequestId).toBe('otp_new')
  expect(result.apiRequestId).toBe('trace_new')
})

test('parses structured error envelope: 429 rate_limited + Retry-After', async () => {
  mockResponses.push({
    status: 429,
    body: { error: { code: 'rate_limited', message: 'Too many requests', doc_url: '/docs#error-rate_limited' }, request_id: 'trace_1' },
    headers: { 'retry-after': '60' },
  })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true) // should have thrown
  } catch (e) {
    expect(e).toBeInstanceOf(NixifyError)
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('rate_limited')
    expect(err.statusCode).toBe(429)
    expect(err.apiRequestId).toBe('trace_1')
    expect(err.retryAfterSeconds).toBe(60)
  }
})

test('parses 401 unauthorized', async () => {
  mockResponses.push({ status: 401, body: { error: { code: 'unauthorized', message: 'Invalid API key' }, request_id: 't1' } })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('unauthorized')
    expect(err.statusCode).toBe(401)
  }
})

test('parses 403 key_revoked', async () => {
  mockResponses.push({ status: 403, body: { error: { code: 'key_revoked', message: 'Key revoked' }, request_id: 't2' } })
  try {
    await verifyOtp('user@test.com', '123456', 'signup', 'otp_expected_123')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('key_revoked')
  }
})

test('parses 400 code_mismatch from verify', async () => {
  mockResponses.push({ status: 400, body: { error: { code: 'code_mismatch', message: 'Wrong code' }, request_id: 't3' } })
  try {
    await verifyOtp('user@test.com', '000000', 'signup', 'otp_expected_123')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('code_mismatch')
  }
})

test('parses 500 internal_error', async () => {
  mockResponses.push({ status: 500, body: { error: { code: 'internal_error', message: 'Server error' }, request_id: 't4' } })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('internal_error')
    expect(err.statusCode).toBe(500)
  }
})

test('returns nixify_network_error on fetch rejection', async () => {
  mockNetworkError = new Error('ECONNREFUSED')
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('nixify_network_error')
    expect(err.statusCode).toBe(502)
  }
})

test('does NOT expose API key in network error message', async () => {
  mockNetworkError = new Error('ECONNREFUSED')
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    const msg = (e as Error).message
    expect(msg).not.toContain('test-nixify-key')
    expect(msg).not.toContain('Bearer')
  }
})

test('returns nixify_timeout on AbortError', async () => {
  mockAbort = true
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('nixify_timeout')
    expect(err.statusCode).toBe(504)
  }
})

test('uses a bounded timeout (15s)', () => {
  expect(REQUEST_TIMEOUT_MS).toBe(15000)
})

test('throws nixify_invalid_response on non-object 200', async () => {
  mockResponses.push({ status: 200, body: 'just a string' })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('nixify_invalid_response')
  }
})

test('throws nixify_invalid_response when otp_request_id is missing', async () => {
  mockResponses.push({ status: 200, body: { expires_at: '2026-10-06T12:00:00.000Z', request_id: 'trace' } })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('nixify_invalid_response')
  }
})

test('throws nixify_invalid_response when expires_at is invalid', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_1', expires_at: 'not-a-date' } })
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('nixify_invalid_response')
  }
})

test('throws nixify_invalid_response when verify response has verified !== true', async () => {
  mockResponses.push({ status: 200, body: { verified: false } })
  try {
    await verifyOtp('user@test.com', '123456', 'signup', 'otp_expected_123')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('nixify_invalid_response')
  }
})

test('send sends only { email, purpose } — no request_id, no locale', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_1', expires_at: '2026-10-06T12:00:00.000Z' } })
  await sendOtp('user@test.com', 'signup')
  const body = JSON.parse(fetchCalls[0].body)
  expect(Object.keys(body).sort()).toEqual(['email', 'purpose'])
})

test('verify sends only { email, code, purpose } — no request_id, no otp_request_id', async () => {
  mockResponses.push({ status: 200, body: { verified: true, otp_request_id: 'otp_expected_123' } })
  await verifyOtp('user@test.com', '123456', 'signup', 'otp_expected_123')
  const body = JSON.parse(fetchCalls[0].body)
  expect(Object.keys(body).sort()).toEqual(['code', 'email', 'purpose'])
})

test('resend sends only { email, purpose }', async () => {
  mockResponses.push({ status: 200, body: { otp_request_id: 'otp_2', expires_at: '2026-10-06T12:00:00.000Z' } })
  await resendOtp('user@test.com', 'login')
  const body = JSON.parse(fetchCalls[0].body)
  expect(Object.keys(body).sort()).toEqual(['email', 'purpose'])
})

test('throws nixify_configuration_error when API key is missing', async () => {
  process.env.NIXIFY_API_KEY = ''
  try {
    await sendOtp('user@test.com', 'signup')
    expect(false).toBe(true)
  } catch (e) {
    expect((e as InstanceType<typeof NixifyError>).code).toBe('nixify_configuration_error')
  }
})

test('NIXIFY_ENDPOINTS are hardcoded to nixify.ir', () => {
  expect(NIXIFY_ENDPOINTS.send).toBe('https://nixify.ir/api/v1/otp/send')
  expect(NIXIFY_ENDPOINTS.verify).toBe('https://nixify.ir/api/v1/otp/verify')
  expect(NIXIFY_ENDPOINTS.resend).toBe('https://nixify.ir/api/v1/otp/resend')
})


// ─── Nixify OTP correlation enforcement (executable) ───────────

test('correlation A: matching otp_request_id → success', async () => {
  mockResponses.push({
    status: 200,
    body: { verified: true, otp_request_id: 'otp_A', request_id: 'trace_1' },
  })
  const result = await verifyOtp('user@test.com', '123456', 'signup', 'otp_A')
  expect(result.verified).toBe(true)
  expect(result.otpRequestId).toBe('otp_A')
  expect(result.apiRequestId).toBe('trace_1')
})

test('correlation B: missing otp_request_id → nixify_invalid_response (502)', async () => {
  mockResponses.push({
    status: 200,
    body: { verified: true, request_id: 'trace_2' },
  })
  try {
    await verifyOtp('user@test.com', '123456', 'signup', 'otp_A')
    expect(false).toBe(true) // should have thrown
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('nixify_invalid_response')
    expect(err.statusCode).toBe(502)
  }
})

test('correlation C: mismatched otp_request_id → nixify_correlation_mismatch (409)', async () => {
  mockResponses.push({
    status: 200,
    body: { verified: true, otp_request_id: 'otp_B', request_id: 'trace_3' },
  })
  try {
    await verifyOtp('user@test.com', '123456', 'signup', 'otp_A')
    expect(false).toBe(true) // should have thrown
  } catch (e) {
    const err = e as InstanceType<typeof NixifyError>
    expect(err.code).toBe('nixify_correlation_mismatch')
    expect(err.statusCode).toBe(409)
    expect(err.apiRequestId).toBe('trace_3')
  }
})

test('correlation D: outgoing verify body contains ONLY { email, code, purpose }', async () => {
  mockResponses.push({
    status: 200,
    body: { verified: true, otp_request_id: 'otp_A', request_id: 'trace_1' },
  })
  await verifyOtp('user@test.com', '123456', 'signup', 'otp_A')
  const body = JSON.parse(fetchCalls[0].body)
  expect(Object.keys(body).sort()).toEqual(['code', 'email', 'purpose'])
  expect(body).not.toHaveProperty('request_id')
  expect(body).not.toHaveProperty('otp_request_id')
  expect(body).not.toHaveProperty('expectedOtpRequestId')
})
