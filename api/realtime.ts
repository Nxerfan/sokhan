import http from 'http';
import { Server, type Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import {
  verifyToken as verifyTokenShared,
  type AgentTokenPayload,
  type VisitorTokenPayload,
  type RealtimeTokenPayload,
} from '../src/lib/realtime-token-shared';

/**
 * Vercel-native WebSocket endpoint (official Vercel Socket.IO pattern).
 *
 * Architecture:
 *   - Socket.IO server runs IN the Vercel Function (no separate host)
 *   - @socket.io/redis-adapter broadcasts across Function instances
 *   - Redis pub/sub receives events from Next.js API routes
 *   - Token verification uses the shared pure module (expiry + timing-safe)
 *   - Agent membership revalidation runs in io.use() MIDDLEWARE — before
 *     the `connect` event reaches the client. An inactive membership
 *     REFUSES the connection with `connect_error: membership_inactive`.
 *   - Tenant isolation enforced on conversation:join (DB check)
 */

const prisma = new PrismaClient({ log: ['error'] });

interface AuthSocket extends Socket { payload?: RealtimeTokenPayload }

const server = http.createServer();
const io = new Server(server, {
  path: '/api/realtime',
  addTrailingSlash: false,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Redis adapter (async, non-blocking)
const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  (async () => {
    try {
      const { createClient } = await import('redis');
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      pubClient.on('error', (e: Error) => console.error('[rt] redis pub:', e.message));
      subClient.on('error', (e: Error) => console.error('[rt] redis sub:', e.message));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));

      const sub = createClient({ url: redisUrl });
      await sub.connect();
      const channel = process.env.REDIS_CHANNEL || 'sukhan:realtime:publish';
      await sub.subscribe(channel, (msg: string) => {
        try {
          const { room, event, payload } = JSON.parse(msg);
          if (room && event) io.local.to(room).emit(event, payload);
        } catch {}
      });
      console.log('[rt] Redis adapter + subscriber ready');
    } catch (e) {
      console.error('[rt] Redis setup failed:', e instanceof Error ? e.message : e);
    }
  })();
}

// Auth + authorization middleware.
// Runs BEFORE the socket is considered connected. If next(new Error(...))
// is called, the client receives a `connect_error` event and the socket
// is never connected — no `connect` event, no room joins, no handlers.
const secret = process.env.NEXTAUTH_SECRET;
if (!secret) {
  console.error('[rt] FATAL: NEXTAUTH_SECRET is not set. Refusing to start.');
  process.exit(1);
}

io.use(async (socket: AuthSocket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  if (!token) return next(new Error('no_token'));

  const payload = verifyTokenShared(token, secret);
  if (!payload) return next(new Error('invalid_token'));

  // For agents: revalidate membership against CURRENT DB state.
  // A removed/inactive membership must NOT retain realtime access,
  // even if the token is still signed and not yet expired.
  if (payload.type === 'agent') {
    const agent = payload as AgentTokenPayload;
    let membership: { status: string } | null = null;
    try {
      membership = await prisma.membership.findFirst({
        where: { userId: agent.userId, tenantId: agent.tenantId, status: 'active' },
        select: { id: true, role: true, status: true },
      });
    } catch (e) {
      // Infrastructure failure — do NOT reveal DB errors to clients.
      console.error('[rt] membership revalidation DB error:', e instanceof Error ? e.message : e);
      return next(new Error('membership_check_failed'));
    }
    if (!membership || membership.status !== 'active') {
      console.log(`[rt] REJECTED agent — membership not active (user=${agent.userId}, tenant=${agent.tenantId})`);
      return next(new Error('membership_inactive'));
    }
  }

  socket.payload = payload;
  next();
});

io.on('connection', (socket: AuthSocket) => {
  const payload = socket.payload!;
  console.log(`[rt] connect type=${payload.type} id=${socket.id}`);

  // Connection is fully authorized by the middleware.
  // Agents join tenant-wide + agent rooms immediately.
  if (payload.type === 'agent') {
    const agent = payload as AgentTokenPayload;
    socket.join(`tenant:${agent.tenantId}`);
    socket.join(`agent:${agent.userId}`);
  }

  // CRITICAL: verify conversation belongs to the socket's tenant before joining
  socket.on('conversation:join', async (conversationId: string) => {
    try {
      const where: { id: string; tenantId: string; contactId?: string } = {
        id: conversationId,
        tenantId: payload.tenantId,
      };
      // Visitors may only join their OWN conversations (contactId match)
      if (payload.type === 'visitor') {
        where.contactId = (payload as VisitorTokenPayload).contactId;
      }
      const conv = await prisma.conversation.findFirst({ where, select: { id: true } });
      if (!conv) {
        console.log(`[rt] REJECTED conversation:join — tenant mismatch (conv=${conversationId}, tenant=${payload.tenantId})`);
        return; // silently reject — don't join the room
      }
      socket.join(`conversation:${conversationId}`);
      console.log(`[rt] join conversation:${conversationId} (tenant=${payload.tenantId})`);
    } catch (e) {
      console.error('[rt] conversation:join DB error:', e instanceof Error ? e.message : e);
    }
  });

  socket.on('conversation:leave', (conversationId: string) => {
    socket.leave(`conversation:${conversationId}`);
  });

  socket.on('typing:start', (d: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${d.conversationId}`)) return;
    socket.to(`conversation:${d.conversationId}`).emit('typing:start', {
      conversationId: d.conversationId, senderType: payload.type,
      senderId: payload.type === 'agent' ? (payload as AgentTokenPayload).userId : (payload as VisitorTokenPayload).contactId,
    });
  });
  socket.on('typing:stop', (d: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${d.conversationId}`)) return;
    socket.to(`conversation:${d.conversationId}`).emit('typing:stop', {
      conversationId: d.conversationId, senderType: payload.type,
    });
  });
  socket.on('message:read', (d: { conversationId: string }) => {
    if (!socket.rooms.has(`conversation:${d.conversationId}`)) return;
    socket.to(`conversation:${d.conversationId}`).emit('message:read', {
      conversationId: d.conversationId, readerType: payload.type,
      readerId: payload.type === 'agent' ? (payload as AgentTokenPayload).userId : (payload as VisitorTokenPayload).contactId,
    });
  });

  socket.on('disconnect', () => console.log(`[rt] disconnect id=${socket.id}`));
});

export default server;
