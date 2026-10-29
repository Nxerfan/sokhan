/// <reference types="bun-types" />
/**
 * NPM widget API client unit tests (requirement #48).
 *
 * Behaviorally proves the typed ApiClient methods against the EXISTING
 * backend contracts:
 *   - anonymous contact call has the historical body + NO Authorization
 *   - resume contact bootstrap sends `Authorization: Bearer <resume>`
 *   - external identity bootstrap sends `Authorization: Bearer <token>`
 *   - OTP start / verify / resend paths + bodies
 *   - structured safe `SukhanApiError` parsing (code from `{error:string}`)
 *   - malformed error response does NOT leak the raw body
 */

import { test, expect, describe } from 'bun:test'
import { ApiClient, SukhanApiError } from '../../packages/widget-npm/src/api.js'

/** Original global fetch (restored after each test). */
const ORIG_FETCH = globalThis.fetch

/** Run `fn` with `globalThis.fetch` replaced by `mockFetch`; restore after. */
async function withFetch<T>(mockFetch: typeof fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = mockFetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = ORIG_FETCH
  }
}

/** Build a fake fetch that records the request + returns a canned response. */
function recordingFetch(res: { status: number; body: unknown }): { fetch: typeof fetch; calls: Request[] } {
  const calls: Request[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push(req)
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

/** fetch that returns non-JSON / malformed body. */
function malformedFetch(body: string, status = 500): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })) as unknown as typeof fetch
}

describe('ApiClient: anonymous identifyVisitor (historical body, no Authorization)', () => {
  test('sends POST /contact with {visitorId,email,name} and NO Authorization header', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: { contactId: 'c1', conversationId: null, realtimeToken: 'tok', locale: 'fa', direction: 'rtl' },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.identifyVisitor({ visitorId: 'vis_1', email: 'a@b.com', name: 'A' })
      expect(calls.length).toBe(1)
      const req = calls[0]
      expect(req.method).toBe('POST')
      expect(req.url).toBe('https://app.sukhan.chat/api/widget/demo/contact')
      expect(req.headers.get('authorization')).toBe(null)
      const sent = JSON.parse(await req.text())
      expect(sent).toEqual({ visitorId: 'vis_1', email: 'a@b.com', name: 'A' })
      expect(res.contactId).toBe('c1')
      expect(res.realtimeToken).toBe('tok')
    })
  })
})

describe('ApiClient: bootstrapContact (verified resume + external identity)', () => {
  test('resume credential → Authorization: Bearer <resume>', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: { contactId: 'c2', conversationId: 'conv1', realtimeToken: 'rt', locale: 'en', direction: 'ltr' },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.bootstrapContact('resume-cred-123')
      expect(calls[0].headers.get('authorization')).toBe('Bearer resume-cred-123')
      expect(res.conversationId).toBe('conv1')
    })
  })

  test('external identity token → Authorization: Bearer <token>', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: { contactId: 'c3', conversationId: 'conv2', realtimeToken: 'rt2', locale: 'fa', direction: 'rtl' },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      await api.bootstrapContact('ext-token-xyz')
      expect(calls[0].headers.get('authorization')).toBe('Bearer ext-token-xyz')
      // body must NOT contain externalUserId / email (backend resolves from token)
      const sent = JSON.parse(await calls[0].text())
      expect(sent).toEqual({})
    })
  })

  test('verification_required (403) → SukhanApiError code=verification_required', async () => {
    const { fetch } = recordingFetch({ status: 403, body: { error: 'verification_required' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.bootstrapContact('stale-resume')
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(SukhanApiError)
        expect((e as SukhanApiError).status).toBe(403)
        expect((e as SukhanApiError).code).toBe('verification_required')
      }
    })
  })

  test('website_login_required (403) → SukhanApiError code=website_login_required', async () => {
    const { fetch } = recordingFetch({ status: 403, body: { error: 'website_login_required' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.bootstrapContact('bad-token')
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as SukhanApiError).code).toBe('website_login_required')
      }
    })
  })
})

describe('ApiClient: OTP start / verify / resend paths + bodies', () => {
  test('startOtp → POST /verify-identity/start body {visitorId,email,name}', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { requestId: 'r1', expiresAt: '2025-01-01T00:00:00Z' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.startOtp({ visitorId: 'vis_1', email: 'a@b.com', name: 'A' })
      expect(calls[0].url).toBe('https://app.sukhan.chat/api/widget/demo/verify-identity/start')
      const sent = JSON.parse(await calls[0].text())
      expect(sent).toEqual({ visitorId: 'vis_1', email: 'a@b.com', name: 'A' })
      expect(res.requestId).toBe('r1')
      expect(res.expiresAt).toBe('2025-01-01T00:00:00Z')
    })
  })

  test('verifyOtp → POST /verify-identity/verify body {visitorId,email,requestId,code}', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: { verified: true, contactId: 'c9', resumeCredential: 'rc', realtimeToken: 'rt' },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.verifyOtp({ visitorId: 'vis_1', email: 'a@b.com', requestId: 'r1', code: '123456' })
      expect(calls[0].url).toBe('https://app.sukhan.chat/api/widget/demo/verify-identity/verify')
      const sent = JSON.parse(await calls[0].text())
      expect(sent).toEqual({ visitorId: 'vis_1', email: 'a@b.com', requestId: 'r1', code: '123456' })
      expect(res.verified).toBe(true)
      expect(res.resumeCredential).toBe('rc')
    })
  })

  test('resendOtp → POST /verify-identity/resend body {visitorId,email,requestId}', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { requestId: 'r2', expiresAt: '2025-01-02T00:00:00Z' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.resendOtp({ visitorId: 'vis_1', email: 'a@b.com', requestId: 'r1' })
      expect(calls[0].url).toBe('https://app.sukhan.chat/api/widget/demo/verify-identity/resend')
      const sent = JSON.parse(await calls[0].text())
      expect(sent).toEqual({ visitorId: 'vis_1', email: 'a@b.com', requestId: 'r1' })
      expect(res.requestId).toBe('r2')
    })
  })
})

describe('ApiClient: structured safe SukhanApiError parsing', () => {
  test('parses {error: string} into SukhanApiError.code', async () => {
    const { fetch } = recordingFetch({ status: 403, body: { error: 'policy_changed' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.sendMessage('tok', 'hi')
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as SukhanApiError).status).toBe(403)
        expect((e as SukhanApiError).code).toBe('policy_changed')
      }
    })
  })

  test('malformed body → code=unknown (no raw body in message)', async () => {
    await withFetch(malformedFetch('{"internal":"stack trace leak","not":"the error field"}', 500), async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.sendMessage('tok', 'hi')
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(SukhanApiError)
        expect((e as SukhanApiError).code).toBe('unknown')
        expect((e as SukhanApiError).status).toBe(500)
        // The raw body must NOT leak into the error message.
        expect((e as Error).message).not.toContain('stack trace leak')
      }
    })
  })

  test('array body → code=unknown', async () => {
    await withFetch(malformedFetch('["not","an","object"]', 500), async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.sendMessage('tok', 'hi')
      } catch (e) {
        expect((e as SukhanApiError).code).toBe('unknown')
      }
    })
  })

  test('missing `error` field → code=unknown', async () => {
    const { fetch } = recordingFetch({ status: 500, body: { detail: 'no top-level error string' } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.sendMessage('tok', 'hi')
      } catch (e) {
        expect((e as SukhanApiError).code).toBe('unknown')
      }
    })
  })

  test('non-string error → code=unknown', async () => {
    const { fetch } = recordingFetch({ status: 500, body: { error: { nested: 'obj' } } })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      try {
        await api.sendMessage('tok', 'hi')
      } catch (e) {
        expect((e as SukhanApiError).code).toBe('unknown')
      }
    })
  })

  test('2xx response does NOT throw', async () => {
    const { fetch } = recordingFetch({
      status: 200,
      body: { message: { id: 'm1', conversationId: 'c', senderType: 'contact', contentType: 'text', content: { text: 'hi' }, createdAt: 'now' } },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const res = await api.sendMessage('tok', 'hi')
      expect(res.message?.id).toBe('m1')
    })
  })

  test('loadMessages returns [] on failure (history is best-effort, no throw)', async () => {
    await withFetch(malformedFetch('server error', 500), async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const msgs = await api.loadMessages('tok', 'conv1')
      expect(msgs).toEqual([])
    })
  })

  test('fetchConfig success → WidgetConfig parsed', async () => {
    const { fetch } = recordingFetch({
      status: 200,
      body: { slug: 'demo', name: 'Demo', accentColor: '#E09A2B', launcherShape: 'pill', position: 'bottom-end', defaultLocale: 'fa', defaultDirection: 'rtl', accessMode: 'site_user_only', policyVersion: 2 },
    })
    await withFetch(fetch, async () => {
      const api = new ApiClient('demo', 'https://app.sukhan.chat')
      const cfg = await api.fetchConfig()
      expect(cfg.accessMode).toBe('site_user_only')
      expect(cfg.policyVersion).toBe(2)
    })
  })
})
