import { test, expect, type BrowserContext } from '@playwright/test'
import { otpSignupPlaywright } from './helpers/otp-signup'

/**
 * Realtime conversation:join authz test — CORRECTED.
 *
 * The previous version of this test was INVALID: it relied on a
 * `socket.to(room).emit(...)` echo BACK TO THE SAME SOCKET that emitted
 * the event. But `socket.to()` explicitly EXCLUDES the sender (see
 * https://socket.io/docs/v4/rooms/), so the echo NEVER arrives regardless
 * of whether the unauthorized join was accepted or rejected. The test was
 * passing for the WRONG reason.
 *
 * Corrected approach — use a SECOND authorized socket as the event
 * receiver:
 *
 *   1. Authorized socket A (legitimately in conversation X) connects +
 *      joins conversation X.
 *   2. Malicious socket M (NOT authorized for conversation X) connects +
 *      ATTEMPTS to join conversation X (this is the attack).
 *   3. Authorized socket A emits `typing:start` for conversation X.
 *      - The server's typing:start handler checks A is in the room → YES
 *        (control join succeeded) → emits to the room EXCEPT the sender.
 *      - If M's join was ACCEPTED (leak): M IS in the room → M receives
 *        the typing event. → LEAK detected.
 *      - If M's join was REJECTED (correct behavior): M is NOT in the
 *        room → M does NOT receive the typing event. → test passes.
 *
 *   4. Control case: a SECOND authorized socket A2 (legitimately in
 *      conversation X) connects + joins X. Socket A emits typing:start.
 *      Socket A2 SHOULD receive the event — proves the room subscription
 *      mechanism works (so the negative result for M is meaningful).
 *
 * Both attack cases (cross-tenant + cross-contact) use this pattern.
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
  realtimeToken: string // agent realtime token
}

async function signupAndSignin(ctx: BrowserContext, email: string, workspace: string): Promise<SignupResult> {
  const page = await ctx.newPage()
  // Load via Caddy so the page origin is port 81 — Socket.IO relative
  // URLs (`/?XTransformPort=3003`) will then be served by Caddy.
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // Use page.request so cookies are stored on the page's context.
  // 3-step OTP signup (start → verify → complete).
  await otpSignupPlaywright(page.request, SIGNUP_API, email, workspace)
  const csrfRes = await page.request.get(`${SIGNUP_API}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  await page.request.post(`${SIGNUP_API}/api/auth/callback/credentials`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `email=${email}&password=password123&csrfToken=${csrfToken}&json=true`,
  })

  // Get tenant ID + agent realtime token
  const [tenantData, tokenData] = await Promise.all([
    page.request.get(`${SIGNUP_API}/api/tenants/me`).then(r => r.json()),
    page.evaluate(async () => {
      const r = await fetch('/api/realtime-token')
      return r.json()
    }),
  ])
  const slug = tenantData.tenant?.slug
  const tenantId = tenantData.tenant?.id
  expect(slug, `slug should be set (tenant data: ${JSON.stringify(tenantData)})`).toBeTruthy()
  expect(tenantId).toBeTruthy()
  expect(tokenData.token, `realtime token should be set`).toBeTruthy()

  // Reload the page on Caddy so the session cookie applies and the
  // page origin is port 81 (Caddy) — Socket.IO relative URLs work.
  await page.goto(DASHBOARD)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  return { page, slug, tenantId, realtimeToken: tokenData.token }
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

/**
 * Load socket.io-client into the page if not already loaded.
 */
async function ensureSocketIO(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    if ((window as unknown as { io?: unknown }).io) return
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = '/socket.io.min.js'
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('socket.io.min.js failed to load'))
      document.head.appendChild(s)
    })
  })
}

/**
 * Connect a socket to the realtime service with the given token.
 * Returns the socket handle (a string key into window). The socket
 * object is not serializable across the evaluate boundary, so we stash
 * it on the window and return a handle.
 */
async function connectSocket(
  page: import('@playwright/test').Page,
  token: string,
): Promise<{ socket: string }> {
  const handle = `socket_${Math.random().toString(36).slice(2)}`
  await page.evaluate(async ({ token, handle }) => {
    const ioFn = (window as unknown as { io: (url: string, opts: object) => SocketLike }).io
    const socket = ioFn('/?XTransformPort=3003', {
      path: '/',
      auth: { token },
      transports: ['websocket'],
    })
    ;(window as unknown as Record<string, unknown>)[handle] = socket
  }, { token, handle })
  return { socket: handle }
}

interface SocketEvents {
  connected: boolean
  events: string[]
}

/**
 * Run a script in the page that:
 *   - waits for the socket to connect
 *   - registers event listeners (typing:start for watched conversations)
 *   - emits `conversation:join` for the given conversation(s)
 *   - waits for `waitMs` milliseconds
 *   - returns the captured events
 */
async function runSocketScript(
  page: import('@playwright/test').Page,
  handle: string,
  opts: {
    joinConversations: string[]
    listenForTypingOfConversations: string[]
    waitMs: number
  },
): Promise<SocketEvents> {
  const { joinConversations, listenForTypingOfConversations, waitMs } = opts
  return await page.evaluate(async ({ handle, joinConversations, listenForTypingOfConversations, waitMs }) => {
    const socket = (window as unknown as Record<string, SocketLike & { connected?: boolean }>)[handle]
    if (!socket) throw new Error(`socket handle ${handle} not found`)
    const events: string[] = []
    // If the socket is ALREADY connected (from a previous phase), the
    // 'connect' event won't fire again. So we check socket.connected
    // up front and set the local `connected` flag accordingly.
    let connected = !!socket.connected

    // Helper: emit the joins (used both for fresh connects AND for
    // already-connected sockets in subsequent phases).
    const emitJoins = () => {
      joinConversations.forEach((convId, i) => {
        setTimeout(() => socket.emit('conversation:join', convId), i * 300 + 200)
      })
    }

    return new Promise<SocketEvents>((resolve) => {
      const done = () => resolve({ connected, events })
      socket.on('connect', () => {
        connected = true
        events.push('connected')
        emitJoins()
      })
      // If already connected, emit joins immediately (the 'connect'
      // listener won't fire again).
      if (connected) {
        events.push('already-connected')
        emitJoins()
      }
      socket.on('connect_error', (err: unknown) => {
        events.push(`connect_error:${(err as Error).message}`)
      })
      // Listen for typing:start events for the watched conversations.
      socket.on('typing:start', (data: unknown) => {
        const d = data as { conversationId?: string; senderType?: string }
        if (d.conversationId && listenForTypingOfConversations.includes(d.conversationId)) {
          events.push(`typing:start:${d.conversationId}`)
        }
      })
      // Give the joins time to process, plus the wait window for any
      // subsequent typing events.
      setTimeout(done, waitMs)
    })
  }, { handle, joinConversations, listenForTypingOfConversations, waitMs })
}

test.describe('Realtime conversation:join authz', () => {
  test('agent CANNOT join cross-tenant conversation (corrected — uses second authorized socket)', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-xt`
    const emailA = `xt-a-${stamp}@test.com`
    const emailB = `xt-b-${stamp}@test.com`

    // === Tenant A: signup + create conversation ===
    const ctxA = await browser.newContext()
    const tenantA = await signupAndSignin(ctxA, emailA, `XT A ${stamp}`)
    const convA = await createVisitorConversation(await browser.newContext(), tenantA.slug, `vis-xt-A-${stamp}`, `msgA-${stamp}`)

    // === Tenant B: signup + create conversation ===
    const ctxB = await browser.newContext()
    const tenantB = await signupAndSignin(ctxB, emailB, `XT B ${stamp}`)
    const convB = await createVisitorConversation(await browser.newContext(), tenantB.slug, `vis-xt-B-${stamp}`, `msgB-${stamp}`)

    // === Setup ===
    // - authorizedB: Tenant B's agent. Legitimately joins convB. Emits
    //   typing:start for convB. This is the "control emitter".
    // - maliciousA: Tenant A's agent. Attempts to join convB (cross-tenant
    //   attack). Listens for typing:start events for convB. If it receives
    //   one, that proves it's in convB's room → LEAK.
    // - controlB2: Tenant B's agent in a SECOND browser context. Legitimately
    //   joins convB. Listens for typing:start events for convB. Should
    //   receive the event → proves the room subscription mechanism works.

    const pageAuthB = tenantB.page
    const pageMalA = tenantA.page
    // Create a SECOND Tenant B agent context for the control receiver.
    // We need a fresh browser context because two sockets in the same
    // page would share the same `window.io` global, complicating handle
    // management. A fresh context is cleaner.
    const ctxB2 = await browser.newContext()
    const controlB2Page = await ctxB2.newPage()
    await controlB2Page.goto(DASHBOARD)
    await controlB2Page.waitForLoadState('networkidle')
    await controlB2Page.waitForTimeout(1000)
    // Re-use tenantB's agent token (same agent, two sockets) — that's fine,
    // the token is just an auth credential, not a session.
    const tenantBToken = tenantB.realtimeToken

    // Load socket.io-client into both pages.
    await ensureSocketIO(pageAuthB)
    await ensureSocketIO(pageMalA)
    await ensureSocketIO(controlB2Page)

    // Connect all three sockets.
    const authBHandle = (await connectSocket(pageAuthB, tenantBToken)).socket
    const malAHandle = (await connectSocket(pageMalA, tenantA.realtimeToken)).socket
    const controlB2Handle = (await connectSocket(controlB2Page, tenantBToken)).socket

    // === Phase 1: All sockets join their authorized conversations ===
    // - authB joins convB (legitimate — Tenant B agent in Tenant B conv)
    // - malA joins convA FIRST (legitimate — Tenant A agent in Tenant A conv,
    //   verifies the socket itself works), THEN attempts convB (attack)
    // - controlB2 joins convB (legitimate — second Tenant B socket)
    const phase1Ms = 2000
    const [authBPhase1, malAPhase1, controlB2Phase1] = await Promise.all([
      runSocketScript(pageAuthB, authBHandle, {
        joinConversations: [convB.conversationId],
        listenForTypingOfConversations: [convB.conversationId],
        waitMs: phase1Ms,
      }),
      runSocketScript(pageMalA, malAHandle, {
        joinConversations: [convA.conversationId, convB.conversationId],
        listenForTypingOfConversations: [convB.conversationId],
        waitMs: phase1Ms,
      }),
      runSocketScript(controlB2Page, controlB2Handle, {
        joinConversations: [convB.conversationId],
        listenForTypingOfConversations: [convB.conversationId],
        waitMs: phase1Ms,
      }),
    ])

    // All sockets should be connected.
    expect(authBPhase1.connected, `authB should connect: ${JSON.stringify(authBPhase1)}`).toBe(true)
    expect(malAPhase1.connected, `malA should connect: ${JSON.stringify(malAPhase1)}`).toBe(true)
    expect(controlB2Phase1.connected, `controlB2 should connect: ${JSON.stringify(controlB2Phase1)}`).toBe(true)

    // === Phase 2: authB emits typing:start for convB ===
    // malA listens (should NOT receive — cross-tenant join was rejected).
    // controlB2 listens (SHOULD receive — proves the event reaches
    // authorized room members).
    const phase2Ms = 2000
    const phase2Promise = Promise.all([
      // malA listens — no new joins, just listen.
      runSocketScript(pageMalA, malAHandle, {
        joinConversations: [],
        listenForTypingOfConversations: [convB.conversationId],
        waitMs: phase2Ms,
      }),
      // controlB2 listens — no new joins, just listen.
      runSocketScript(controlB2Page, controlB2Handle, {
        joinConversations: [],
        listenForTypingOfConversations: [convB.conversationId],
        waitMs: phase2Ms,
      }),
    ])

    // Wait briefly so the listeners are registered, then have authB emit.
    await pageAuthB.waitForTimeout(300)
    await pageAuthB.evaluate(({ handle, convId }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket.emit('typing:start', { conversationId: convId })
    }, { handle: authBHandle, convId: convB.conversationId })

    const [malAPhase2, controlB2Phase2] = await phase2Promise

    // CONTROL: controlB2 (authorized Tenant B agent) SHOULD receive the
    // typing:start event for convB. This proves the room subscription +
    // event broadcast works correctly — so the negative result for malA
    // is meaningful.
    expect(
      controlB2Phase2.events,
      `CONTROL: controlB2 (authorized Tenant B agent) should receive typing:start for convB — got: ${JSON.stringify(controlB2Phase2)}`,
    ).toContain(`typing:start:${convB.conversationId}`)

    // ATTACK: malA (unauthorized Tenant A agent) should NOT receive the
    // typing:start event for convB. If it did, its cross-tenant join was
    // accepted — that's a LEAK.
    expect(
      malAPhase2.events,
      `ATTACK: malA (unauthorized Tenant A agent) should NOT receive typing:start for convB — leak detected: ${JSON.stringify(malAPhase2)}`,
    ).not.toContain(`typing:start:${convB.conversationId}`)

    // Cleanup: disconnect all sockets.
    await pageAuthB.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: authBHandle })
    await pageMalA.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: malAHandle })
    await controlB2Page.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: controlB2Handle })

    await ctxA.close()
    await ctxB.close()
    await ctxB2.close()
  })

  test('visitor CANNOT join another contact\'s conversation (corrected — cross-contact, same tenant)', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-xc`
    const email = `xc-${stamp}@test.com`

    // === Single tenant: signup ===
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `XC ${stamp}`)

    // === Create TWO conversations from TWO different visitors (same tenant) ===
    const visitorA = await createVisitorConversation(await browser.newContext(), tenant.slug, `vis-xc-A-${stamp}`, `msgA-${stamp}`)
    const visitorB = await createVisitorConversation(await browser.newContext(), tenant.slug, `vis-xc-B-${stamp}`, `msgB-${stamp}`)

    // === Setup ===
    // - authorizedAgent: Tenant's agent. Legitimately joins convB (visitor B's
    //   conversation — agents can join any conversation in their tenant).
    //   Emits typing:start for convB.
    // - maliciousV1: visitor A. Attempts to join convB (cross-contact attack
    //   — visitor A is NOT the contact for convB). Listens for typing:start
    //   events for convB. If it receives one, that proves it's in convB's
    //   room → LEAK.
    // - controlV2: visitor B (the legitimate contact for convB). Joins
    //   convB. Listens for typing:start events for convB. Should receive
    //   the event → proves the room subscription mechanism works.

    const pageAuth = tenant.page
    // Create fresh contexts for the visitors (so each has its own page
    // origin and window.io global).
    const ctxV1 = await browser.newContext()
    const pageMalV1 = await ctxV1.newPage()
    await pageMalV1.goto(`${DASHBOARD}/widget-test.html`)
    await pageMalV1.waitForLoadState('networkidle')
    await pageMalV1.waitForTimeout(500)

    const ctxV2 = await browser.newContext()
    const pageControlV2 = await ctxV2.newPage()
    await pageControlV2.goto(`${DASHBOARD}/widget-test.html`)
    await pageControlV2.waitForLoadState('networkidle')
    await pageControlV2.waitForTimeout(500)

    // Load socket.io-client into all three pages.
    await ensureSocketIO(pageAuth)
    await ensureSocketIO(pageMalV1)
    await ensureSocketIO(pageControlV2)

    // Connect all three sockets with their respective tokens.
    const authHandle = (await connectSocket(pageAuth, tenant.realtimeToken)).socket
    const malV1Handle = (await connectSocket(pageMalV1, visitorA.realtimeToken)).socket
    const controlV2Handle = (await connectSocket(pageControlV2, visitorB.realtimeToken)).socket

    // === Phase 1: sockets join their authorized conversations ===
    // - auth joins convB (legitimate — agent in same-tenant conv)
    // - malV1 joins convA FIRST (legitimate — visitor A's own conversation),
    //   THEN attempts convB (cross-contact attack)
    // - controlV2 joins convB (legitimate — visitor B's own conversation)
    const phase1Ms = 2000
    const [authPhase1, malV1Phase1, controlV2Phase1] = await Promise.all([
      runSocketScript(pageAuth, authHandle, {
        joinConversations: [visitorB.conversationId],
        listenForTypingOfConversations: [visitorB.conversationId],
        waitMs: phase1Ms,
      }),
      runSocketScript(pageMalV1, malV1Handle, {
        joinConversations: [visitorA.conversationId, visitorB.conversationId],
        listenForTypingOfConversations: [visitorB.conversationId],
        waitMs: phase1Ms,
      }),
      runSocketScript(pageControlV2, controlV2Handle, {
        joinConversations: [visitorB.conversationId],
        listenForTypingOfConversations: [visitorB.conversationId],
        waitMs: phase1Ms,
      }),
    ])

    expect(authPhase1.connected, `auth should connect: ${JSON.stringify(authPhase1)}`).toBe(true)
    expect(malV1Phase1.connected, `malV1 should connect: ${JSON.stringify(malV1Phase1)}`).toBe(true)
    expect(controlV2Phase1.connected, `controlV2 should connect: ${JSON.stringify(controlV2Phase1)}`).toBe(true)

    // === Phase 2: auth emits typing:start for convB ===
    const phase2Ms = 2000
    const phase2Promise = Promise.all([
      runSocketScript(pageMalV1, malV1Handle, {
        joinConversations: [],
        listenForTypingOfConversations: [visitorB.conversationId],
        waitMs: phase2Ms,
      }),
      runSocketScript(pageControlV2, controlV2Handle, {
        joinConversations: [],
        listenForTypingOfConversations: [visitorB.conversationId],
        waitMs: phase2Ms,
      }),
    ])

    await pageAuth.waitForTimeout(300)
    await pageAuth.evaluate(({ handle, convId }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket.emit('typing:start', { conversationId: convId })
    }, { handle: authHandle, convId: visitorB.conversationId })

    const [malV1Phase2, controlV2Phase2] = await phase2Promise

    // CONTROL: controlV2 (visitor B — the legitimate contact for convB)
    // SHOULD receive the typing:start event for convB. This proves the
    // room subscription + event broadcast works.
    expect(
      controlV2Phase2.events,
      `CONTROL: controlV2 (visitor B — legitimate contact) should receive typing:start for convB — got: ${JSON.stringify(controlV2Phase2)}`,
    ).toContain(`typing:start:${visitorB.conversationId}`)

    // ATTACK: malV1 (visitor A — NOT the contact for convB) should NOT
    // receive the typing:start event for convB. If it did, its
    // cross-contact join was accepted — that's a LEAK.
    expect(
      malV1Phase2.events,
      `ATTACK: malV1 (visitor A — unauthorized contact) should NOT receive typing:start for convB — leak detected: ${JSON.stringify(malV1Phase2)}`,
    ).not.toContain(`typing:start:${visitorB.conversationId}`)

    // Cleanup.
    await pageAuth.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: authHandle })
    await pageMalV1.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: malV1Handle })
    await pageControlV2.evaluate(({ handle }) => {
      const socket = (window as unknown as Record<string, SocketLike>)[handle]
      socket?.disconnect()
    }, { handle: controlV2Handle })

    await ctx.close()
    await ctxV1.close()
    await ctxV2.close()
  })
})

// =====================================================================
// CURRENT-POLICY REALTIME VISITOR AUTHORIZATION TESTS
// =====================================================================

async function signCustomVisitorToken(
  page: import('@playwright/test').Page,
  params: { contactId: string; tenantId: string; slug: string; identityLevel?: string; policyVersion?: number },
): Promise<string> {
  const result = await page.evaluate(async (params: Record<string, unknown>) => {
    const r = await fetch('/api/dev/sign-realtime-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return r.json()
  }, params as Record<string, unknown>)
  return result.token
}

async function connectAndWait(
  page: import('@playwright/test').Page,
  token: string,
  // 8s safety-net timeout (bumped from 5s). connect_error still resolves fast
  // when the realtime middleware rejects synchronously; the timeout is only
  // the fallback. The extra headroom absorbs CI timing variance under the
  // longer browser suite (the NPM identity spec adds ~50s of customer-server
  // + socket load earlier in the suite). Test-only change.
  timeoutMs: number = 8000,
): Promise<{ connected: boolean; error?: string }> {
  const handle = `socket_${Math.random().toString(36).slice(2)}`
  await ensureSocketIO(page)
  await page.evaluate(async ({ token, handle }) => {
    const ioFn = (window as unknown as { io: (url: string, opts: object) => SocketLike }).io
    const socket = ioFn('/?XTransformPort=3003', { path: '/', auth: { token }, transports: ['websocket'] })
    ;(window as unknown as Record<string, unknown>)[handle] = socket
  }, { token, handle })

  const result = await page.evaluate(({ handle, timeoutMs }) => {
    return new Promise<{ connected: boolean; error?: string }>((resolve) => {
      const socket = (window as unknown as Record<string, SocketLike & { connected?: boolean }>)[handle]
      if (!socket) { resolve({ connected: false, error: 'socket_not_found' }); return }
      const done = (r: { connected: boolean; error?: string }) => { resolve(r) }
      socket.on('connect', () => done({ connected: true }))
      socket.on('connect_error', (err: unknown) => done({ connected: false, error: (err as Error).message }))
      setTimeout(() => done({ connected: false, error: 'timeout' }), timeoutMs)
    })
  }, { handle, timeoutMs })

  await page.evaluate(({ handle }) => {
    const s = (window as unknown as Record<string, SocketLike & { disconnect?: () => void }>)[handle]
    if (s && s.disconnect) s.disconnect()
  }, { handle }).catch(() => {})

  return result
}

async function setAccessMode(page: import('@playwright/test').Page, accessMode: string): Promise<void> {
  const result = await page.evaluate(async (accessMode: string) => {
    const res = await fetch('/api/widget-config/access', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessMode }),
    })
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
  }, accessMode)
  if (!result.ok) {
    throw new Error(`setAccessMode('${accessMode}') failed: ${result.status} ${JSON.stringify(result.data)}`)
  }
}

test.describe('CURRENT-policy realtime visitor connect authorization', () => {
  test('anonymous mode: modern anonymous token connects', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-rt-anon`
    const email = `rt-anon-${stamp}@test.com`
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `RT Anon ${stamp}`)
    const page = tenant.page
    await ensureSocketIO(page)

    const visitorResult = await page.evaluate(async ({ slug, visitorId }) => {
      const r = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      })
      return r.json()
    }, { slug: tenant.slug, visitorId: `vis-rt-anon-${stamp}` })

    expect(visitorResult.realtimeToken).toBeTruthy()
    const result = await connectAndWait(page, visitorResult.realtimeToken)
    expect(result.connected, `modern anonymous token should connect (result: ${JSON.stringify(result)})`).toBe(true)
    await ctx.close()
  })

  test('anonymous mode: legacy token (both claims absent) connects', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-rt-leg`
    const email = `rt-leg-${stamp}@test.com`
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `RT Leg ${stamp}`)
    const page = tenant.page
    await ensureSocketIO(page)

    const visitorResult = await page.evaluate(async ({ slug, visitorId }) => {
      const r = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      })
      return r.json()
    }, { slug: tenant.slug, visitorId: `vis-rt-leg-${stamp}` })

    const legacyToken = await signCustomVisitorToken(page, {
      contactId: visitorResult.contactId,
      tenantId: tenant.tenantId,
      slug: tenant.slug,
    })
    const result = await connectAndWait(page, legacyToken)
    expect(result.connected, `legacy token should connect in anonymous mode (result: ${JSON.stringify(result)})`).toBe(true)
    await ctx.close()
  })

  test('anonymous mode: partial token (identityLevel only) -> connect_error:identity_token_invalid', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-rt-part`
    const email = `rt-part-${stamp}@test.com`
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `RT Part ${stamp}`)
    const page = tenant.page
    await ensureSocketIO(page)

    const visitorResult = await page.evaluate(async ({ slug, visitorId }) => {
      const r = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      })
      return r.json()
    }, { slug: tenant.slug, visitorId: `vis-rt-part-${stamp}` })

    const partialToken = await signCustomVisitorToken(page, {
      contactId: visitorResult.contactId,
      tenantId: tenant.tenantId,
      slug: tenant.slug,
      identityLevel: 'anonymous',
    })
    const result = await connectAndWait(page, partialToken)
    expect(result.connected).toBe(false)
    expect(result.error).toBe('identity_token_invalid')
    await ctx.close()
  })

  test('anonymous mode: malformed identityLevel -> connect_error:identity_token_invalid', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-rt-mal`
    const email = `rt-mal-${stamp}@test.com`
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `RT Mal ${stamp}`)
    const page = tenant.page
    await ensureSocketIO(page)

    const visitorResult = await page.evaluate(async ({ slug, visitorId }) => {
      const r = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      })
      return r.json()
    }, { slug: tenant.slug, visitorId: `vis-rt-mal-${stamp}` })

    const malformedToken = await signCustomVisitorToken(page, {
      contactId: visitorResult.contactId,
      tenantId: tenant.tenantId,
      slug: tenant.slug,
      identityLevel: 'corrupt',
      policyVersion: 1,
    })
    const result = await connectAndWait(page, malformedToken)
    expect(result.connected).toBe(false)
    expect(result.error).toBe('identity_token_invalid')
    await ctx.close()
  })
})

test.describe('Live policy transition — anonymous -> verified_visitor', () => {
  test('connected anonymous socket cannot join a NEW conversation after policy change', async ({ browser }) => {
    const stamp = `${process.pid}-${Date.now()}-rt-trans`
    const email = `rt-trans-${stamp}@test.com`
    const ctx = await browser.newContext()
    const tenant = await signupAndSignin(ctx, email, `RT Trans ${stamp}`)
    const page = tenant.page
    await ensureSocketIO(page)

    // 1. Create visitor Contact → modern anonymous token
    const visitorResult = await page.evaluate(async ({ slug, visitorId }) => {
      const r = await fetch(`/api/widget/${slug}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId }),
      })
      return r.json()
    }, { slug: tenant.slug, visitorId: `vis-rt-trans-${stamp}` })
    const visitorToken = visitorResult.realtimeToken
    expect(visitorToken).toBeTruthy()

    // 2. Create conversation A + B via messages (mode still anonymous)
    const makeConv = async (msg: string) => {
      const r = await page.evaluate(async ({ slug, token, message }) => {
        const r = await fetch(`/api/widget/${slug}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: message }),
        })
        return r.json()
      }, { slug: tenant.slug, token: visitorToken, message: msg })
      return r.conversationId || r.message?.conversationId
    }
    const convA = await makeConv(`msgA-${stamp}`)
    expect(convA).toBeTruthy()
    // Close conversation A so the next message creates a NEW conversation B.
    // Without this, the messages route reuses the open conversation → convA === convB.
    const closeRes = await page.evaluate(async (convId) => {
      const r = await fetch(`/api/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      })
      return { ok: r.ok, status: r.status }
    }, convA)
    expect(closeRes.ok, `Failed to close conversation A: ${closeRes.status}`).toBe(true)
    const convB = await makeConv(`msgB-${stamp}`)
    expect(convB).toBeTruthy()
    // MANDATORY: A and B must be genuinely distinct conversations.
    expect(convB).not.toBe(convA)

    // 3. Connect visitor socket
    const visitorHandle = (await connectSocket(page, visitorToken)).socket

    // 4. Visitor joins conversation A
    const phase1 = await runSocketScript(page, visitorHandle, {
      joinConversations: [convA],
      listenForTypingOfConversations: [],
      waitMs: 2000,
    })
    expect(phase1.connected).toBe(true)

    // 5. Connect agent socket (control emitter for B)
    const agentCtx = await browser.newContext()
    const agentPage = await agentCtx.newPage()
    await agentPage.goto(DASHBOARD)
    await agentPage.waitForLoadState('networkidle')
    await agentPage.waitForTimeout(500)
    await ensureSocketIO(agentPage)
    const agentHandle = (await connectSocket(agentPage, tenant.realtimeToken)).socket
    const agentPhase1 = await runSocketScript(agentPage, agentHandle, {
      joinConversations: [convB],
      listenForTypingOfConversations: [],
      waitMs: 2000,
    })
    expect(agentPhase1.connected).toBe(true)

    // 6. Connect second agent socket (control receiver for B)
    const agentCtx2 = await browser.newContext()
    const agent2Page = await agentCtx2.newPage()
    await agent2Page.goto(DASHBOARD)
    await agent2Page.waitForLoadState('networkidle')
    await agent2Page.waitForTimeout(500)
    await ensureSocketIO(agent2Page)
    const agent2Handle = (await connectSocket(agent2Page, tenant.realtimeToken)).socket
    const agent2Phase1 = await runSocketScript(agent2Page, agent2Handle, {
      joinConversations: [convB],
      listenForTypingOfConversations: [convB],
      waitMs: 1000,
    })
    expect(agent2Phase1.connected).toBe(true)

    // 7. CHANGE POLICY: anonymous -> verified_visitor (policyVersion increments)
    await setAccessMode(page, 'verified_visitor')
    // setAccessMode already checks the PATCH response (throws on failure).
    // No arbitrary sleep — the DB commit is synchronous; the verify-visitor-access
    // endpoint reads the same DB. A small event-registration delay is inside the
    // Promise.all pattern below.

    // 8. Old visitor socket attempts to join conversation B — run the
    // visitor's join+listen + the agent's typing emit IN PARALLEL.
    // The emit must happen DURING the listener's active window so that if
    // the visitor IS in B's room (a bug), the listener catches the typing
    // event. Same parallel pattern as the existing cross-tenant test.
    const [phase2] = await Promise.all([
      runSocketScript(page, visitorHandle, {
        joinConversations: [convB],
        listenForTypingOfConversations: [convB],
        waitMs: 4000,
      }),
      (async () => {
        // Wait for the listener + join to register, then emit typing.
        await new Promise(r => setTimeout(r, 500))
        await agentPage.evaluate(({ handle, convB }) => {
          const socket = (window as unknown as Record<string, SocketLike>)[handle]
          socket.emit('typing:start', { conversationId: convB })
        }, { handle: agentHandle, convB })
      })(),
    ])

    // 10. Visitor should NOT receive typing:start for convB (rejected by
    //     CURRENT-policy revalidation at conversation:join).
    const visitorTypingForB = phase2.events.filter(e => e.includes(`typing:start:${convB}`))
    expect(visitorTypingForB.length,
      `visitor should NOT receive typing:start for convB (rejected by policy revalidation). Events: ${JSON.stringify(phase2.events)}`,
    ).toBe(0)

    // 11. Control: agent2 SHOULD receive the typing event (proves the room works).
    // Run agent2's listener + the agent's typing emit IN PARALLEL (same
    // pattern — the emit must happen DURING the listener's active window).
    const [agent2Phase3] = await Promise.all([
      runSocketScript(agent2Page, agent2Handle, {
        joinConversations: [],
        listenForTypingOfConversations: [convB],
        waitMs: 4000,
      }),
      (async () => {
        // Wait for the listener to register, then emit.
        await new Promise(r => setTimeout(r, 1000))
        await agentPage.evaluate(({ handle, convB }) => {
          const socket = (window as unknown as Record<string, SocketLike>)[handle]
          socket.emit('typing:start', { conversationId: convB })
        }, { handle: agentHandle, convB })
      })(),
    ])

    const agent2TypingForB = agent2Phase3.events.filter(e => e.includes(`typing:start:${convB}`))
    expect(agent2TypingForB.length,
      `control agent2 SHOULD receive typing:start for convB (proves room mechanism works). Events: ${JSON.stringify(agent2Phase3.events)}`,
    ).toBeGreaterThan(0)

    await ctx.close()
    await agentCtx.close()
    await agentCtx2.close()
  })
})
