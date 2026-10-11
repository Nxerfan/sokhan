import { test, expect } from '@playwright/test'

/**
 * Caddy public realtime boundary regression.
 *
 * Proves that the hardened docker/Caddyfile only proxies
 * XTransformPort=3003 (the public Socket.IO port) to the realtime
 * container. Internal port 3004 (which exposes /health and
 * /internal/publish) must NOT be publicly routable.
 *
 * Coverage:
 *   1. XTransformPort=3003 supports the Socket.IO handshake
 *      (engine.io OPEN packet).
 *   2. XTransformPort=3004 does NOT expose /health.
 *   3. XTransformPort=3004 does NOT expose /internal/publish.
 *   4. An arbitrary port value (e.g. 9999) is NOT proxied to the
 *      realtime container (it falls through to the Next.js app).
 *   5. Normal non-realtime traffic (no XTransformPort) routes to
 *      the Next.js app.
 *
 * This test runs in BOTH Full and Lite Docker CI.
 */

const BASE = 'http://127.0.0.1:81'

test.describe('Caddy public realtime boundary', () => {
  test('XTransformPort=3003 supports Socket.IO handshake (engine.io OPEN)', async ({ request }) => {
    // The Socket.IO engine.io handshake with transport=polling returns
    // a text body starting with '0' (the OPEN packet).
    const res = await request.get(`${BASE}/?EIO=4&transport=polling&XTransformPort=3003`)
    expect(res.status(), '3003 should be proxied to realtime (200)').toBe(200)
    const body = await res.text()
    expect(body, 'engine.io OPEN packet starts with 0').toMatch(/^0/)
  })

  test('XTransformPort=3004 does NOT expose /health', async ({ request }) => {
    // 3004 is the internal realtime HTTP port. It must NOT be publicly
    // reachable. With the hardened Caddyfile, ?XTransformPort=3004
    // falls through to the Next.js app handler (which returns a normal
    // HTML page or 404, NOT the realtime health JSON).
    const res = await request.get(`${BASE}/?XTransformPort=3004`)
    const body = await res.text()
    // The Next.js app will return HTML (200) or a 404 — NOT the
    // realtime health JSON { "ok": true, "connections": N, ... }.
    expect(body, '3004 must NOT expose realtime /health JSON').not.toMatch(/"ok"\s*:\s*true.*"connections"/)
  })

  test('XTransformPort=3004 with /health path does NOT expose health', async ({ request }) => {
    const res = await request.get(`${BASE}/health?XTransformPort=3004`)
    const body = await res.text()
    expect(body, '3004 + /health path must NOT expose realtime health JSON').not.toMatch(/"ok"\s*:\s*true.*"connections"/)
  })

  test('XTransformPort=3004 does NOT expose /internal/publish', async ({ request }) => {
    const res = await request.post(`${BASE}/internal/publish?XTransformPort=3004`, {
      data: { room: 'test', event: 'test', payload: {} },
      headers: { 'Content-Type': 'application/json' },
    })
    // The Next.js app returns 404 for /internal/publish — it does NOT
    // route to the realtime service's internal HTTP endpoint.
    expect(res.status(), '3004 + /internal/publish must NOT return 200').not.toBe(200)
    const body = await res.text()
    expect(body, 'must NOT return {ok:true} from /internal/publish').not.toMatch(/"ok"\s*:\s*true/)
  })

  test('arbitrary XTransformPort=9999 is NOT proxied to realtime', async ({ request }) => {
    // With the hardened Caddyfile, only XTransformPort=3003 is proxied.
    // XTransformPort=9999 falls through to the Next.js app.
    const res = await request.get(`${BASE}/?XTransformPort=9999`)
    const body = await res.text()
    // The Next.js app returns HTML — NOT the realtime health JSON.
    expect(body, 'arbitrary port must NOT expose realtime endpoints').not.toMatch(/"ok"\s*:\s*true.*"connections"/)
  })

  test('normal traffic without XTransformPort routes to Next.js app', async ({ request }) => {
    const res = await request.get(`${BASE}/api`)
    // The /api catch-all route returns 200 from the Next.js app.
    expect(res.status(), 'normal traffic must reach Next.js app').toBe(200)
  })
})
