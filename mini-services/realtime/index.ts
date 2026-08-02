import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Sukhan Realtime Service (Module 2)
 *
 * Two HTTP servers:
 *   - Port 3003: Socket.IO server (path: '/') — handles realtime connections
 *     from the widget and dashboard, forwarded by Caddy via XTransformPort.
 *   - Port 3004: Internal HTTP server — handles /internal/publish calls from
 *     Next.js API routes. NOT exposed through Caddy; server-to-server only.
 *
 * IMPORTANT: loads NEXTAUTH_SECRET from the parent project's .env so token
 * signing/verification matches the Next.js app. Without this, the realtime
 * service falls back to 'dev-secret-change-me' and ALL token verification +
 * internal publish auth fails silently.
 *
 * No database access — this service is a pure message broker.
 */

// Load .env from the parent project (sandbox: the mini-service runs in its own
// process and doesn't inherit the parent's env). In production with Docker
// Compose, the env is passed explicitly and this file load is a no-op.
try {
  const envPath = resolve(process.cwd(), '..', '..', '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
  console.log('[env] loaded .env from', envPath)
} catch (e) {
  console.log('[env] no parent .env found, using process.env directly')
}

const SOCKET_PORT = 3003
const INTERNAL_PORT = 3004
const SECRET = process.env.NEXTAUTH_SECRET || 'dev-secret-change-me'

console.log('[secret] using NEXTAUTH_SECRET:', SECRET.slice(0, 8) + '...')

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

  socket.join(`tenant:${payload.tenantId}`)

  if (payload.type === 'agent') {
    socket.join(`agent:${payload.userId}`)
  }

  socket.on('conversation:join', (conversationId: string) => {
    socket.join(`conversation:${conversationId}`)
    console.log(`[join] ${payload.type} → conversation:${conversationId}`)
  })

  socket.on('conversation:leave', (conversationId: string) => {
    socket.leave(`conversation:${conversationId}`)
  })

  socket.on('typing:start', (data: { conversationId: string }) => {
    socket.to(`conversation:${data.conversationId}`).emit('typing:start', {
      conversationId: data.conversationId,
      senderType: payload.type,
      senderId: payload.type === 'agent' ? payload.userId : payload.contactId,
    })
  })

  socket.on('typing:stop', (data: { conversationId: string }) => {
    socket.to(`conversation:${data.conversationId}`).emit('typing:stop', {
      conversationId: data.conversationId,
      senderType: payload.type,
    })
  })

  socket.on('message:read', (data: { conversationId: string }) => {
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
// Internal HTTP server (port 3004 — server-to-server only)
// ============================================================
const internalServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, connections: io.engine.clientsCount }))
    return
  }

  if (req.method === 'POST' && req.url === '/internal/publish') {
    const authHeader = req.headers['x-internal-secret']
    if (authHeader !== SECRET) {
      console.log('[publish] forbidden — secret mismatch')
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
          console.log(`[publish] room=${roomName} event=${event}`)
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
