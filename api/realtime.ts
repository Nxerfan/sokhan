import http from 'http';
import { Server, type Socket } from 'socket.io';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

/**
 * Vercel-native WebSocket endpoint (official Vercel Socket.IO pattern).
 *
 * Per https://vercel.com/docs/functions/websockets — Vercel Functions can
 * serve WebSocket connections using standard Node.js libraries like Socket.IO.
 * The pattern: create an HTTP server, attach Socket.IO, export the server.
 *
 * Architecture:
 *   - Socket.IO server runs IN the Vercel Function (no separate host)
 *   - @socket.io/redis-adapter broadcasts across Function instances
 *   - Redis pub/sub receives events from Next.js API routes
 *   - Tenant isolation enforced on conversation:join (DB check)
 */

const prisma = new PrismaClient({ log: ['error'] });

// Token verification (mirrors src/lib/realtime-token.ts)
interface AgentPayload { type: 'agent'; userId: string; tenantId: string; role: string }
interface VisitorPayload { type: 'visitor'; contactId: string; tenantId: string; slug: string }
type TokenPayload = AgentPayload | VisitorPayload;

function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.type !== 'agent' && payload.type !== 'visitor') return null;
    return payload as TokenPayload;
  } catch { return null }
}

interface AuthSocket extends Socket { payload?: TokenPayload }

const server = http.createServer();
const io = new Server(server, {
  path: '/api/realtime',
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

      // Subscribe to the publish channel
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

// Auth middleware
const secret = process.env.NEXTAUTH_SECRET || 'sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1';
io.use((socket: AuthSocket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  if (!token) return next(new Error('no_token'));
  const payload = verifyToken(token, secret);
  if (!payload) return next(new Error('invalid_token'));
  socket.payload = payload;
  next();
});

io.on('connection', (socket: AuthSocket) => {
  const payload = socket.payload!;
  console.log(`[rt] connect type=${payload.type} id=${socket.id}`);
  // Only agents join the tenant-wide room (for conversation:new/updated events).
  // Visitors only receive events for their own conversation.
  if (payload.type === 'agent') {
    socket.join(`tenant:${payload.tenantId}`);
    socket.join(`agent:${payload.userId}`);
  }

  // CRITICAL: verify conversation belongs to the socket's tenant before joining
  socket.on('conversation:join', async (conversationId: string) => {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId: payload.tenantId },
        select: { id: true },
      });
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
      senderId: payload.type === 'agent' ? payload.userId : payload.contactId,
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
      readerId: payload.type === 'agent' ? payload.userId : payload.contactId,
    });
  });

  socket.on('disconnect', () => console.log(`[rt] disconnect id=${socket.id}`));
});

export default server;
