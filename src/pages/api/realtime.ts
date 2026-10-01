import type { NextApiRequest, NextApiResponse } from 'next'
import { Server, type Socket } from 'socket.io'
import type { Server as HTTPServer } from 'http'
import crypto from 'crypto'
import { getAuthSecret } from '@/lib/env-check'

/**
 * Vercel-native WebSocket endpoint.
 *
 * This route initializes a Socket.IO server on the first HTTP request and
 * attaches it to the underlying HTTP server. Vercel Functions support
 * WebSocket upgrade — the connection stays alive as long as the Function
 * instance is warm.
 *
 * Architecture (Vercel mode):
 *   - Client (dashboard/widget) connects to /api/realtime via WebSocket
 *   - Socket.IO server runs IN the Vercel Function (no separate host)
 *   - @socket.io/redis-adapter broadcasts events across Function instances
 *   - Next.js API routes publish events via Redis PUBLISH (src/lib/realtime)
 *   - Each Function instance subscribes to Redis and emits to local sockets
 *
 * Docker/self-host mode keeps the standalone realtime service at
 * mini-services/realtime/index.ts — this file is only invoked in Vercel mode.
 *
 * Token verification mirrors mini-services/realtime/index.ts — both use
 * the same HMAC-signed realtime tokens (signed with NEXTAUTH_SECRET).
 */

// Augment the HTTP server type to carry the Socket.IO instance.
interface HTTPServerWithIO extends HTTPServer {
  io?: Server
}

// ============================================================
// Token verification (mirrors mini-services/realtime/index.ts)
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

function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  if (sig !== expectedSig) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    if (payload.type !== 'agent' && payload.type !== 'visitor') return null
    return payload as TokenPayload
  } catch {
    return null
  }
}

interface AuthenticatedSocket extends Socket {
  payload?: TokenPayload
}

// ============================================================
// Redis adapter setup (lazy, only when REDIS_URL is set)
// ============================================================
let redisAdapterSetup: Promise<void> | null = null

async function setupRedisAdapter(io: Server): Promise<void> {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return // In-memory adapter (single instance — local dev)

  try {
    const { createClient } = await import('redis')
    const { createAdapter } = await import('@socket.io/redis-adapter')

    const pubClient = createClient({ url: redisUrl })
    const subClient = pubClient.duplicate()

    pubClient.on('error', (e: Error) => console.error('[realtime:vercel] redis pub error:', e.message))
    subClient.on('error', (e: Error) => console.error('[realtime:vercel] redis sub error:', e.message))

    await Promise.all([pubClient.connect(), subClient.connect()])
    io.adapter(createAdapter(pubClient, subClient))
    console.log('[realtime:vercel] Redis adapter enabled — cross-instance delivery works')
  } catch (e) {
    console.error(
      '[realtime:vercel] Redis adapter setup failed — falling back to in-memory:',
      e instanceof Error ? e.message : e,
    )
  }
}

// Also subscribe to the Redis publish channel (alternative to HTTP /internal/publish).
async function setupRedisSubscriber(io: Server): Promise<void> {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return

  try {
    const { createClient } = await import('redis')
    const sub = createClient({ url: redisUrl })
    await sub.connect()
    const channel = process.env.REDIS_CHANNEL || 'sukhan:realtime:publish'
    await sub.subscribe(channel, (message: string) => {
      try {
        const { room, event, payload } = JSON.parse(message)
        if (room && event) {
          // io.local = emit only to sockets on THIS instance (no adapter
          // fan-out). Each Function instance receives the Redis publish
          // and emits to its own local sockets — no duplication.
          io.local.to(room).emit(event, payload)
        }
      } catch {
        // ignore malformed messages
      }
    })
    console.log(`[realtime:vercel] Subscribed to Redis channel: ${channel}`)
  } catch (e) {
    console.error('[realtime:vercel] Redis subscriber setup failed:', e instanceof Error ? e.message : e)
  }
}

// ============================================================
// Route handler — initializes Socket.IO on first request
// ============================================================
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const server = (req as any).socket.server as HTTPServerWithIO

  if (!server.io) {
    console.log('[realtime:vercel] Initializing Socket.IO server...')
    const io = new Server(server, {
      path: '/api/realtime',
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 60000,
      pingInterval: 25000,
    })
    server.io = io

    // Setup Redis adapter + subscriber (async, non-blocking)
    redisAdapterSetup = (async () => {
      await setupRedisAdapter(io)
      await setupRedisSubscriber(io)
    })()

    // Auth middleware
    const secret = getAuthSecret()
    io.use((socket: AuthenticatedSocket, next) => {
      const token = (socket.handshake.auth as { token?: string })?.token
      if (!token) {
        return next(new Error('no_token'))
      }
      const payload = verifyToken(token, secret)
      if (!payload) {
        return next(new Error('invalid_token'))
      }
      socket.payload = payload
      next()
    })

    // Connection handler
    io.on('connection', (socket: AuthenticatedSocket) => {
      const payload = socket.payload!
      console.log(`[realtime:vercel] connect type=${payload.type} id=${socket.id}`)

      // Join tenant room
      socket.join(`tenant:${payload.tenantId}`)

      // Join agent room
      if (payload.type === 'agent') {
        socket.join(`agent:${payload.userId}`)
      }

      // Conversation room management
      socket.on('conversation:join', (conversationId: string) => {
        socket.join(`conversation:${conversationId}`)
        console.log(`[realtime:vercel] join conversation:${conversationId}`)
      })

      socket.on('conversation:leave', (conversationId: string) => {
        socket.leave(`conversation:${conversationId}`)
      })

      // Typing indicators
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

      // Read receipts
      socket.on('message:read', (data: { conversationId: string }) => {
        socket.to(`conversation:${data.conversationId}`).emit('message:read', {
          conversationId: data.conversationId,
          readerType: payload.type,
          readerId: payload.type === 'agent' ? payload.userId : payload.contactId,
        })
      })

      // Disconnect
      socket.on('disconnect', () => {
        console.log(`[realtime:vercel] disconnect id=${socket.id}`)
      })
    })

    console.log('[realtime:vercel] Socket.IO server ready (path: /api/realtime)')
  }

  // If this is a Socket.IO handshake/polling request (has EIO or transport query  // params), pass it to Engine.IO instead of responding with JSON.
  if (req.url?.includes("EIO=") || req.url?.includes("transport=")) {
    if (server.io?.engine) {
      ;(server.io.engine as any).handleRequest(req, res)
      return
    }
  }
  // HTTP GET returns a simple status (the WebSocket upgrade is handled by Socket.IO)
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      service: 'sukhan-realtime',
      mode: 'vercel-native',
      path: '/api/realtime',
      redis: !!process.env.REDIS_URL,
      connections: server.io?.engine?.clientsCount ?? 0,
    })
    return
  }

  // Health check
  if (req.method === 'GET' && req.url?.includes('/health')) {
    res.status(200).json({ ok: true, connections: server.io?.engine?.clientsCount ?? 0 })
    return
  }

  res.status(405).end()
}
