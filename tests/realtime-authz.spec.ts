import { test, expect, type BrowserContext } from '@playwright/test'

/**
 * Realtime conversation:join authz test — verifies the realtime service
 * rejects cross-tenant AND cross-contact conversation joins.
 *
 * The test connects a client (agent or visitor) to the realtime service
 * with a valid token (signed for tenant A / contact A) and emits
 * `conversation:join` for a conversation that belongs to a DIFFERENT
 * tenant (cross-tenant attack) or a different contact (cross-contact
 * attack).
 *
 * Both must be REJECTED by the realtime service's `conversation:join`
 * handler — the server must NOT add the socket to the conversation's
 * room. We verify this by emitting `typing:start` for that conversation
 * after the (rejected) join attempt. If the join was accepted, the
 * socket IS in the room and would receive the echoed `typing:start`
 * event — which would be a LEAK. If the join was rejected, the socket
 * is NOT in the room and no echo arrives.
 *
 * NOTE: the dashboard page is loaded via Caddy (port 81) so the
 * relative `/?XTransformPort=3003` URL routes through Caddy to the
 * realtime service. Loading the dashboard directly on port 3000 would
 * cause Socket.IO to connect to the Next.js dev server (which doesn't
 * understand XTransformPort).
 */

const DASHBOARD = 'http://127.0.0.1:81'   // Caddy — Socket.IO works here
const SIGNUP_API = 'http://127.0.0.1:3000' // Next.js direct — signup API is faster here

/** Minimal Socket.IO client shape used inside page.evaluate. */
interface SocketLike {
  on(event: string, cb: (data: unknown) => void): void
  emit(event: string, ...args: unknown[]): void
  disconnect(): void
}

interface SignupResult {
  page: import('@playwright/test').Page
  slug: string
  tenantId: string
}

async function signupAndSignin(ctx: BrowserContext, email: string, workspace: string): Promise<SignupResult> {
  const page = await ctx.newPage()
  // Load via Caddy so the page origin is port 81 — Socket.IO relative
  // URLs (`/?XTransformPort=3003`) will then be served by Caddy.
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // Use page.request so cookies are stored on the page's context
  await page.request.post(`${SIGNUP_API}/api/auth/signup`, {
    data: { email, password: 'password123', name: 'Agent', workspaceName: workspace },
  })
  const csrfRes = await page.request.get(`${SIGNUP_API}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${SIGNUP_API}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })

  // Get tenant ID
  const tenantRes = await page.request.get(`${SIGNUP_API}/api/tenants/me`)
  const tenantData = await tenantRes.json()
  const slug = tenantData.tenant?.slug
  const tenantId = tenantData.tenant?.id
  expect(slug, `slug should be set (tenant data: ${JSON.stringify(tenantData)})`).toBeTruthy()
  expect(tenantId).toBeTruthy()

  // Reload the page on Caddy so the session cookie applies and the
  // page origin is port 81 (Caddy) — Socket.IO relative URLs work.
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  return { page, slug, tenantId }
}

async function createVisitorConversation(
  ctx: BrowserContext,
  slug: string,
  visitorId: string,
  message: string,
): Promise<{ contactId: string; conversationId: string; realtimeToken: string }> {
  const page = await ctx.newPage()
  await page.goto(`${DASHBOARD}/widget-test.html`)
  await page.waitForLoadState('networkidle')

  // Identify as visitor — use Caddy origin so the test exercises the same
  // path widgets use in production.
  const identifyResult = await page.evaluate(async ({ slug, visitorId }) => {
    const r = await fetch(`/api/widget/${slug}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId }),
    })
    return r.json()
  }, { slug, visitorId })

  const contactId = identifyResult.contactId
  const realtimeToken = identifyResult.realtimeToken
  expect(contactId, `contactId should be set (response: ${JSON.stringify(identifyResult)})`).toBeTruthy()
  expect(realtimeToken, `realtimeToken should be set (response: ${JSON.stringify(identifyResult)})`).toBeTruthy()

  // Send a message to create a conversation
  const msgResult = await page.evaluate(async ({ slug, realtimeToken, message }) => {
    const r = await fetch(`/api/widget/${slug}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${realtimeToken}`,
      },
      body: JSON.stringify({ text: message }),
    })
    return r.json()
  }, { slug, realtimeToken, message })

  const conversationId = msgResult.conversationId || msgResult.message?.conversationId
  expect(conversationId, `conversationId should be set (response: ${JSON.stringify(msgResult)})`).toBeTruthy()

  await page.close()
  return { contactId, conversationId, realtimeToken }
}

test.describe('Realtime conversation:join authz', () => {
  test('agent CANNOT join cross-tenant conversation', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-xt`
    const emailA = `xt-a-${stamp}@test.com`
    const emailB = `xt-b-${stamp}@test.com`

    // === Tenant A: signup + create conversation ===
    const ctxA = await browser.newContext()
    const { page: pageA, slug: slugA } = await signupAndSignin(ctxA, emailA, `XT A ${stamp}`)
    const convA = await createVisitorConversation(await browser.newContext(), slugA, `vis-xt-A-${stamp}`, `msgA-${stamp}`)

    // === Tenant B: signup + create conversation ===
    const ctxB = await browser.newContext()
    const { slug: slugB } = await signupAndSignin(ctxB, emailB, `XT B ${stamp}`)
    const convB = await createVisitorConversation(await browser.newContext(), slugB, `vis-xt-B-${stamp}`, `msgB-${stamp}`)

    // === Tenant A's agent: fetch realtime token, connect to realtime ===
    const tokenRes = await pageA.evaluate(async () => {
      const r = await fetch('/api/realtime-token')
      return r.json()
    })
    expect(tokenRes.token, `realtime token should be set (response: ${JSON.stringify(tokenRes)})`).toBeTruthy()

    // Connect to the realtime service via Caddy (page origin is port 81).
    // Try to join Tenant B's conversation (cross-tenant attack).
    const result = await pageA.evaluate(async ({ token, convAId, convBId }) => {
      // Load socket.io-client from /socket.io.min.js (served by Next.js
      // and proxied by Caddy — same origin).
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = '/socket.io.min.js'
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('socket.io.min.js failed to load'))
        document.head.appendChild(s)
      })
      const ioFn = (window as unknown as { io: (url: string, opts: object) => SocketLike }).io
      const socket = ioFn('/?XTransformPort=3003', {
        path: '/',
        auth: { token },
        transports: ['websocket'],
      })
      const events: string[] = []
      return new Promise<string[]>((resolve) => {
        socket.on('connect', () => {
          events.push('connected')
          // Control: join OWN conversation — should succeed
          socket.emit('conversation:join', convAId)
          // Attack: join OTHER tenant's conversation — should be REJECTED
          setTimeout(() => socket.emit('conversation:join', convBId), 500)
        })
        // After 1.5s, probe whether the cross-tenant join was accepted.
        // If the join was rejected, the socket is NOT in convB's room.
        // Emit typing:start for convB — if echoed back, the join
        // succeeded (BAD).
        setTimeout(() => {
          socket.emit('typing:start', { conversationId: convBId })
        }, 1500)
        socket.on('typing:start', (data: unknown) => {
          const d = data as { conversationId?: string }
          if (d.conversationId === convBId) {
            events.push('LEAK:cross-tenant-typing-echoed')
          }
        })
        socket.on('connect_error', (err: unknown) => {
          events.push(`connect_error:${(err as Error).message}`)
        })
        setTimeout(() => {
          socket.disconnect()
          resolve(events)
        }, 3000)
      })
    }, { token: tokenRes.token, convAId: convA.conversationId, convBId: convB.conversationId })

    // The cross-tenant join must NOT have resulted in a typing echo.
    expect(result, `events should contain 'connected' — got: ${JSON.stringify(result)}`).toContain('connected')
    expect(result, `cross-tenant leak detected — got: ${JSON.stringify(result)}`).not.toContain('LEAK:cross-tenant-typing-echoed')

    await ctxA.close()
    await ctxB.close()
  })

  test('visitor CANNOT join another contact\'s conversation (cross-contact, same tenant)', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-xc`
    const email = `xc-${stamp}@test.com`

    // === Single tenant: signup ===
    const ctx = await browser.newContext()
    const { page, slug } = await signupAndSignin(ctx, email, `XC ${stamp}`)

    // === Create TWO conversations from TWO different visitors (same tenant) ===
    const visitorA = await createVisitorConversation(await browser.newContext(), slug, `vis-xc-A-${stamp}`, `msgA-${stamp}`)
    const visitorB = await createVisitorConversation(await browser.newContext(), slug, `vis-xc-B-${stamp}`, `msgB-${stamp}`)

    // === Visitor A connects and tries to join visitor B's conversation ===
    const result = await page.evaluate(async ({ token, convAId, convBId }) => {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = '/socket.io.min.js'
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('socket.io.min.js failed to load'))
        document.head.appendChild(s)
      })
      const ioFn = (window as unknown as { io: (url: string, opts: object) => SocketLike }).io
      const socket = ioFn('/?XTransformPort=3003', {
        path: '/',
        auth: { token },
        transports: ['websocket'],
      })
      const events: string[] = []
      return new Promise<string[]>((resolve) => {
        socket.on('connect', () => {
          events.push('connected')
          // Control: join OWN conversation — should succeed
          socket.emit('conversation:join', convAId)
          // Attack: join ANOTHER visitor's conversation in same tenant —
          // should be REJECTED (cross-contact isolation).
          setTimeout(() => socket.emit('conversation:join', convBId), 500)
        })
        // If the cross-contact join was accepted, emitting typing:start
        // for convB would echo back to us (because we'd be in the room).
        setTimeout(() => {
          socket.emit('typing:start', { conversationId: convBId })
        }, 1500)
        socket.on('typing:start', (data: unknown) => {
          const d = data as { conversationId?: string; senderType?: string }
          // The typing:start echo would have conversationId = convBId
          // if the cross-contact join succeeded.
          if (d.conversationId === convBId) {
            events.push('LEAK:cross-contact-typing-echoed')
          }
        })
        socket.on('connect_error', (err: unknown) => {
          events.push(`connect_error:${(err as Error).message}`)
        })
        setTimeout(() => {
          socket.disconnect()
          resolve(events)
        }, 3000)
      })
    }, { token: visitorA.realtimeToken, convAId: visitorA.conversationId, convBId: visitorB.conversationId })

    // The cross-contact join must NOT have resulted in a typing echo.
    expect(result, `events should contain 'connected' — got: ${JSON.stringify(result)}`).toContain('connected')
    expect(result, `cross-contact leak detected — got: ${JSON.stringify(result)}`).not.toContain('LEAK:cross-contact-typing-echoed')

    await ctx.close()
  })
})
