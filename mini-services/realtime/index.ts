import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Sukhan Realtime Service (Module 2 + Module 3 Docker)
 *
 * Two HTTP servers:
 *   - Port 3003: Socket.IO server (path: '/') — handles realtime connections
 *     from the widget and dashboard, forwarded by Caddy via XTransformPort.
 *   - Port 3004: Internal HTTP server — handles /internal/publish calls from
 *     Next.js API routes. NOT exposed through Caddy; server-to-server only.
 *
 * Redis (optional, enabled when REDIS_URL is set):
 *   - Socket.IO adapter (@socket.io/redis-adapter) for cross-instance
 *     broadcast of socket events (typing, read receipts, etc.). Required
 *     when running multiple realtime replicas behind a load balancer.
 *   - Pub/sub subscription on 'sukhan:realtime:publish' — an alternative
 *     to the HTTP /internal/publish endpoint. Next.js can publish events
 *     via Redis PUBLISH (lower latency, no HTTP overhead). The HTTP
 *     endpoint is kept as a fallback for backwards compatibility.
 *
 * IMPORTANT: loads NEXTAUTH_SECRET from the parent project's .env so token
 * signing/verification matches the Next.js app. Without this, the realtime
 * service falls back to 'dev-secret-change-me' and ALL token verification +
 * internal publish auth fails silently.
 *
 * No database access — this service is a pure message broker.
 */

// Load .env AND .env.local from the parent project (sandbox: the mini-service
// runs in its own process and doesn't inherit the parent's env, and bun doesn't
// auto-load .env.local like Next.js does). In production with Docker Compose,
// the env is passed explicitly and this file load is a no-op.
//
// Load order: .env first, then .env.local — .env.local OVERWRITES values from
// .env (matching Next.js behavior where .env.local takes precedence).
function loadEnvFile(filePath: string, overwrite = false) {
  try {
    const envContent = readFileSync(filePath, 'utf-8')
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (overwrite || !process.env[key]) process.env[key] = value
    }
    console.log('[env] loaded', filePath)
  } catch {
    // file doesn't exist — skip
  }
}

const parentDir = resolve(process.cwd(), '..', '..')
loadEnvFile(resolve(parentDir, '.env'))
loadEnvFile(resolve(parentDir, '.env.local'), true) // overwrite — .env.local takes precedence

const SOCKET_PORT = 3003
const INTERNAL_PORT = 3004

// NEXTAUTH_SECRET check — in dev, use a DETERMINISTIC dev secret (not random).
// This ensures Next.js and the realtime service share the SAME secret even
// when both start without NEXTAUTH_SECRET set in the environment.
// A random per-process secret would cause Socket.IO auth to fail silently
// (tokens signed by one process wouldn't verify in the other), degrading to
// 8-10s polling. The deterministic dev secret avoids this.
const DEV_SECRET = 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1'
if (!process.env.NEXTAUTH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n❌ FATAL: NEXTAUTH_SECRET is not set.')
    console.error('   Set the NEXTAUTH_SECRET environment variable.')
    console.error('   Generate one with: openssl rand -base64 32\n')
    process.exit(1)
  } else {
    // Dev mode: use the deterministic dev secret (same as Next.js's env-check.ts)
    process.env.NEXTAUTH_SECRET = DEV_SECRET
    console.warn(
      '\n⚠️  NEXTAUTH_SECRET not set — using deterministic dev secret.\n' +
      '   This is NOT secure. Set NEXTAUTH_SECRET in production.\n' +
      '   Both Next.js and this service use the same dev secret\n' +
      '   so Socket.IO auth works correctly.\n'
    )
  }
}
const SECRET = process.env.NEXTAUTH_SECRET
const APP_INTERNAL_URL = process.env.APP_INTERNAL_URL || 'http://localhost:3000'
const REDIS_URL = process.env.REDIS_URL

// NEXTAUTH_SECRET is used for token verification — never log it.
if (REDIS_URL) {
  console.log('[redis] REDIS_URL set — will enable adapter + pub/sub subscription')
} else {
  console.log('[redis] REDIS_URL not set — using in-memory adapter (single instance only)')
}

// ============================================================
// Token verification (mirrors src/lib/realtime-token.ts)
// ============================================================
interface AgentPayload {
  type: 'agent'
  userId: string
  tenantId: string
  role: string
}
interface VisitorPayload {
  type: 'visitor'
  contactId: string
  tenantId: string
  slug: string
}
type TokenPayload = AgentPayload | VisitorPayload

function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  const expectedSig = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url')
  if (sig !== expectedSig) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    if (payload.type !== 'agent' && payload.type !== 'visitor') return null
    return payload as TokenPayload
  } catch {
    return null
  }
}

// ============================================================
// Socket.IO server (port 3003 — public, via Caddy)
// ============================================================
const socketServer = createServer()
const io = new Server(socketServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

interface AuthenticatedSocket extends Socket {
  payload?: TokenPayload
}

io.use((socket: AuthenticatedSocket, next) => {
  const token = socket.handshake.auth?.token as string | undefined
  if (!token) {
    console.log('[auth] no token provided')
    return next(new Error('no_token'))
  }
  const payload = verifyToken(token)
  if (!payload) {
    console.log('[auth] invalid token')
    return next(new Error('invalid_token'))
  }
  socket.payload = payload
  next()
})

io.on('connection', (socket: AuthenticatedSocket) => {
  const payload = socket.payload!
  console.log(`[connect] type=${payload.type} id=${socket.id}`)

  // Only agents join the tenant-wide room.
  // Visitors only receive events for their own conversation.
  if (payload.type === 'agent') {
    socket.join(`tenant:${payload.tenantId}`)
    socket.join(`agent:${payload.userId}`)
  }

  socket.on('conversation:join', async (conversationId: string) => {
    // Verify conversation ownership via the Next.js app's verify-conversation endpoint.
    // Agents: must match tenant. Visitors: must match tenant AND contactId.
    // In Docker Compose, the Next.js service is 'app' (not localhost).
    try {
      const params = new URLSearchParams({
        conversationId,
        tenantId: payload.tenantId,
        type: payload.type,
        contactId: payload.type === 'visitor' ? payload.contactId : '',
        userId: payload.type === 'agent' ? payload.userId : '',
      })
      const verifyUrl = `${APP_INTERNAL_URL}/api/realtime/verify-conversation?${params}`
      const res = await fetch(verifyUrl, {
        headers: { 'X-Internal-Secret': SECRET },
      })
      if (res.ok) {
        socket.join(`conversation:${conversationId}`)
        console.log(`[join] ${payload.type} → conversation:${conversationId}`)
      } else {
        console.log(`[join] REJECTED ${payload.type} → conversation:${conversationId} (${res.status})`)
      }
    } catch (e) {
      console.error('[join] verify error:', e instanceof Error ? e.message : e)
    }
  })

  socket.on('conversation:leave', (conversationId: string) => {
    socket.leave(`conversation:${conversationId}`)
  })

  socket.on('typing:start', (data: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${data.conversationId}`)) return
    socket.to(`conversation:${data.conversationId}`).emit('typing:start', {
      conversationId: data.conversationId,
      senderType: payload.type,
      senderId: payload.type === 'agent' ? payload.userId : payload.contactId,
    })
  })

  socket.on('typing:stop', (data: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${data.conversationId}`)) return
    socket.to(`conversation:${data.conversationId}`).emit('typing:stop', {
      conversationId: data.conversationId,
      senderType: payload.type,
    })
  })

  socket.on('message:read', (data: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${data.conversationId}`)) return
    socket.to(`conversation:${data.conversationId}`).emit('message:read', {
      conversationId: data.conversationId,
      readerType: payload.type,
      readerId: payload.type === 'agent' ? payload.userId : payload.contactId,
    })
  })

  socket.on('disconnect', () => {
    console.log(`[disconnect] type=${payload.type} id=${socket.id}`)
  })
})

// ============================================================
// Redis adapter + pub/sub (optional, when REDIS_URL is set)
// ============================================================
//
// The adapter enables cross-instance broadcast of Socket.IO events. With
// multiple realtime replicas behind a load balancer, a socket event emitted
// on instance A is delivered to sockets connected to instances B, C, etc.
//
// The pub/sub subscription is an alternative to the HTTP /internal/publish
// endpoint. When REDIS_URL is set, Next.js API routes SHOULD publish via
// Redis PUBLISH to the 'sukhan:realtime:publish' channel. The HTTP endpoint
// is kept as a fallback for backwards compatibility.
//
// To avoid duplicate delivery when multiple realtime instances each receive
// the same Redis publish, we use `io.local.to(room).emit(...)` on the Redis
// subscription path — `local` means "emit only to sockets on THIS instance".
// Each realtime instance receives the Redis publish and emits to its own
// local sockets. The HTTP endpoint, by contrast, uses `io.to(room).emit(...)`
// (with adapter fan-out) so a single HTTP POST reaches all instances' sockets.
const PUBLISH_CHANNEL = process.env.REDIS_CHANNEL || 'sukhan:realtime:publish'
let redisEnabled = false

async function setupRedis() {
  if (!REDIS_URL) return

  try {
    const { createClient } = await import('redis')
    const { createAdapter } = await import('@socket.io/redis-adapter')

    const pubClient = createClient({ url: REDIS_URL })
    const subClient = pubClient.duplicate()
    const publishSubscriber = pubClient.duplicate()

    pubClient.on('error', (e: Error) => console.error('[redis] pub client error:', e.message))
    subClient.on('error', (e: Error) => console.error('[redis] sub client error:', e.message))
    publishSubscriber.on('error', (e: Error) => console.error('[redis] publish-subscriber error:', e.message))

    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
      publishSubscriber.connect(),
    ])

    // Adapter for cross-instance Socket.IO event broadcast (typing, read receipts, etc.)
    io.adapter(createAdapter(pubClient, subClient))

    // Subscribe to the app-level publish channel (alternative to the HTTP endpoint)
    await publishSubscriber.subscribe(PUBLISH_CHANNEL, (message: string) => {
      try {
        const { room, event, payload } = JSON.parse(message)
        if (room && event) {
          // io.local = emit only to sockets on THIS instance (no adapter fan-out).
          // Each realtime instance receives the Redis publish and emits to its
          // own local sockets — no duplication.
          io.local.to(room).emit(event, payload)
          console.log(`[publish:redis] room=${room} event=${event}`)
        }
      } catch (e) {
        console.error('[publish:redis] invalid message:', e instanceof Error ? e.message : e)
      }
    })

    redisEnabled = true
    console.log(`[redis] adapter + publish channel "${PUBLISH_CHANNEL}" subscribed`)
  } catch (e) {
    console.error(
      '[redis] setup failed — falling back to in-memory adapter:',
      e instanceof Error ? e.message : e
    )
    console.error(
      '[redis] multi-instance broadcast will NOT work. Set REDIS_URL correctly or use a single realtime replica.'
    )
  }
}

// ============================================================
// Internal HTTP server (port 3004 — server-to-server only)
// ============================================================
const internalServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, connections: io.engine.clientsCount, redis: redisEnabled }))
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/internal/verify-conversation')) {
    // Proxy to the Next.js app for DB-backed verification
    const authHeader = req.headers['x-internal-secret']
    if (authHeader !== SECRET) {
      res.writeHead(403); res.end('forbidden'); return
    }
    // Forward to Next.js app
    try {
      const nextUrl = `http://localhost:3000/api/realtime/verify-conversation${req.url.replace('/internal/verify-conversation', '')}`
      const nextRes = await fetch(nextUrl, { headers: { 'X-Internal-Secret': SECRET } })
      res.writeHead(nextRes.status); res.end(await nextRes.text())
    } catch (e) {
      res.writeHead(500); res.end('error')
    }
    return
  }

  if (req.method === 'POST' && req.url === '/internal/publish') {
    const authHeader = req.headers['x-internal-secret']
    if (authHeader !== SECRET) {
      console.log('[publish:http] forbidden — secret mismatch')
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { room: roomName, event, payload } = JSON.parse(body)
        if (roomName && event) {
          // When Redis adapter is enabled, io.to() broadcasts across all
          // instances via the adapter. When it's not, this emits locally.
          // Either way, the HTTP endpoint works correctly as a fallback.
          io.to(roomName).emit(event, payload)
          console.log(`[publish:http] room=${roomName} event=${event}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      } catch {
        res.writeHead(400)
        res.end('bad request')
      }
    })
    return
  }

  res.writeHead(404)
  res.end('not found')
})

// ============================================================
// Start both servers (Redis is set up async, non-blocking)
// ============================================================
socketServer.listen(SOCKET_PORT, () => {
  console.log(`Sukhan realtime Socket.IO on port ${SOCKET_PORT}`)
})

internalServer.listen(INTERNAL_PORT, () => {
  console.log(`Sukhan realtime internal HTTP on port ${INTERNAL_PORT}`)
})

// Set up Redis after servers are listening — non-blocking.
// If Redis is unavailable, the service continues with the in-memory adapter.
setupRedis().catch((e) => {
  console.error('[redis] setup threw:', e instanceof Error ? e.message : e)
})

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...')
  io.close(() => {
    socketServer.close(() => {
      internalServer.close(() => process.exit(0))
    })
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
