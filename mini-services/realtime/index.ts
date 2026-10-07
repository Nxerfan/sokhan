import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import crypto from 'crypto'
import {
  verifyToken as verifyTokenShared,
  type AgentTokenPayload,
  type VisitorTokenPayload,
  type RealtimeTokenPayload,
} from '../../src/lib/realtime-token-shared'

/**
 * Sukhan Realtime Service (Docker mode)
 *
 * Two HTTP servers:
 *   - Port 3003: Socket.IO server (path: '/') — handles realtime connections
 *     from the widget and dashboard, forwarded by Caddy via XTransformPort.
 *   - Port 3004: Internal HTTP server — handles /internal/publish calls from
 *     Next.js API routes. NOT exposed through Caddy; server-to-server only.
 *
 * Token verification uses the shared pure module (`realtime-token-shared.ts`)
 * which adds expiry (iat/exp) and timing-safe HMAC comparison.
 *
 * Agent membership is revalidated against the DB (via the Next.js app's
 * /api/realtime/verify-membership endpoint) before granting tenant-wide
 * realtime access. A removed or inactive agent loses access immediately.
 */

// Load .env AND .env.local from the parent project.
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
loadEnvFile(resolve(parentDir, '.env.local'), true)

const SOCKET_PORT = 3003
const INTERNAL_PORT = 3004

const DEV_SECRET = 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1'
if (!process.env.NEXTAUTH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n❌ FATAL: NEXTAUTH_SECRET is not set.')
    console.error('   Set the NEXTAUTH_SECRET environment variable.')
    console.error('   Generate one with: openssl rand -base64 32\n')
    process.exit(1)
  } else {
    process.env.NEXTAUTH_SECRET = DEV_SECRET
    console.warn(
      '\n⚠️  NEXTAUTH_SECRET not set — using deterministic dev secret.\n' +
      '   This is NOT secure. Set NEXTAUTH_SECRET in production.\n'
    )
  }
}
const SECRET = process.env.NEXTAUTH_SECRET
const APP_INTERNAL_URL = process.env.APP_INTERNAL_URL || 'http://localhost:3000'
const REDIS_URL = process.env.REDIS_URL

if (REDIS_URL) {
  console.log('[redis] REDIS_URL set — will enable adapter + pub/sub subscription')
} else {
  console.log('[redis] REDIS_URL not set — using in-memory adapter (single instance only)')
}

// Timing-safe string comparison for internal secret checks.
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
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
  payload?: RealtimeTokenPayload
}

// Auth + authorization middleware.
// Runs BEFORE the socket is considered connected. If next(new Error(...))
// is called, the client receives a `connect_error` event and the socket
// is never connected — no `connect` event, no room joins, no handlers.
io.use(async (socket: AuthenticatedSocket, next) => {
  const token = socket.handshake.auth?.token as string | undefined
  if (!token) {
    console.log('[auth] no token provided')
    return next(new Error('no_token'))
  }
  const payload = verifyTokenShared(token, SECRET!)
  if (!payload) {
    console.log('[auth] invalid or expired token')
    return next(new Error('invalid_token'))
  }

  // For agents: revalidate membership against CURRENT DB state via the
  // Next.js app's internal verify-membership endpoint. A removed/inactive
  // membership must NOT retain realtime access. This runs in MIDDLEWARE
  // so the connection is REFUSED before `connect` reaches the client.
  if (payload.type === 'agent') {
    const agent = payload as AgentTokenPayload
    try {
      const params = new URLSearchParams({
        userId: agent.userId,
        tenantId: agent.tenantId,
      })
      const verifyUrl = `${APP_INTERNAL_URL}/api/realtime/verify-membership?${params}`
      const res = await fetch(verifyUrl, {
        headers: { 'X-Internal-Secret': SECRET! },
      })
      if (!res.ok) {
        console.log(`[auth] REJECTED agent — membership not active (user=${agent.userId}, tenant=${agent.tenantId}, status=${res.status})`)
        return next(new Error('membership_inactive'))
      }
    } catch (e) {
      // Infrastructure failure — do NOT reveal DB errors to clients.
      console.error('[auth] membership revalidation error:', e instanceof Error ? e.message : e)
      return next(new Error('membership_check_failed'))
    }
  }

  socket.payload = payload
  next()
})

io.on('connection', (socket: AuthenticatedSocket) => {
  const payload = socket.payload!
  console.log(`[connect] type=${payload.type} id=${socket.id}`)

  // Connection is fully authorized by the middleware.
  // Agents join tenant-wide + agent rooms immediately.
  if (payload.type === 'agent') {
    const agent = payload as AgentTokenPayload
    socket.join(`tenant:${agent.tenantId}`)
    socket.join(`agent:${agent.userId}`)
  }

  // CRITICAL: verify conversation belongs to the socket's tenant before joining
  socket.on('conversation:join', async (conversationId: string) => {
    try {
      const params = new URLSearchParams({
        conversationId,
        tenantId: payload.tenantId,
        type: payload.type,
        contactId: payload.type === 'visitor' ? (payload as VisitorTokenPayload).contactId : '',
        userId: payload.type === 'agent' ? (payload as AgentTokenPayload).userId : '',
      })
      const verifyUrl = `${APP_INTERNAL_URL}/api/realtime/verify-conversation?${params}`
      const res = await fetch(verifyUrl, {
        headers: { 'X-Internal-Secret': SECRET! },
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
      senderId: payload.type === 'agent' ? (payload as AgentTokenPayload).userId : (payload as VisitorTokenPayload).contactId,
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
      readerId: payload.type === 'agent' ? (payload as AgentTokenPayload).userId : (payload as VisitorTokenPayload).contactId,
    })
  })

  socket.on('disconnect', () => {
    console.log(`[disconnect] type=${payload.type} id=${socket.id}`)
  })
})

// ============================================================
// Redis adapter + pub/sub (optional, when REDIS_URL is set)
// ============================================================
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

    io.adapter(createAdapter(pubClient, subClient))

    await publishSubscriber.subscribe(PUBLISH_CHANNEL, (message: string) => {
      try {
        const { room, event, payload } = JSON.parse(message)
        if (room && event) {
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
    const authHeader = String(req.headers['x-internal-secret'] || '')
    if (!timingSafeEqualStr(authHeader, SECRET!)) {
      res.writeHead(403); res.end('forbidden'); return
    }
    try {
      const nextUrl = `${APP_INTERNAL_URL}/api/realtime/verify-conversation${req.url.replace('/internal/verify-conversation', '')}`
      const nextRes = await fetch(nextUrl, { headers: { 'X-Internal-Secret': SECRET! } })
      res.writeHead(nextRes.status); res.end(await nextRes.text())
    } catch {
      res.writeHead(500); res.end('error')
    }
    return
  }

  if (req.method === 'POST' && req.url === '/internal/publish') {
    const authHeader = String(req.headers['x-internal-secret'] || '')
    if (!timingSafeEqualStr(authHeader, SECRET!)) {
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
// Start both servers
// ============================================================
socketServer.listen(SOCKET_PORT, () => {
  console.log(`Sukhan realtime Socket.IO on port ${SOCKET_PORT}`)
})

internalServer.listen(INTERNAL_PORT, () => {
  console.log(`Sukhan realtime internal HTTP on port ${INTERNAL_PORT}`)
})

setupRedis().catch((e) => {
  console.error('[redis] setup threw:', e instanceof Error ? e.message : e)
})

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
