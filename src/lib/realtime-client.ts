'use client'

import { io, type Socket } from 'socket.io-client'

let socketInstance: Socket | null = null

/**
 * Resolve the Socket.IO connection URL + path.
 *
 * IMPORTANT: passing `/api/realtime` as the URL to `io()` makes Socket.IO
 * treat it as a NAMESPACE, not a path. This breaks connection on Vercel.
 *
 * Correct per-deployment behaviour:
 *
 *   - Vercel mode (VERCEL=1):
 *       URL:  '' (empty — io() connects to the page origin = Sukhan
 *                 deployment URL, using the default namespace)
 *       Path: '/api/realtime'
 *       (Vercel routes /api/realtime* to the root-level api/realtime.ts
 *       function, which runs a Socket.IO server with path: '/api/realtime'.)
 *
 *   - Explicit URL (NEXT_PUBLIC_REALTIME_URL set):
 *       Used as-is. Path is '/api/realtime' if the URL contains
 *       '/api/realtime' (serverless WebSocket pattern), otherwise '/'.
 *
 *   - Docker / dev (default, behind Caddy):
 *       URL:  '/?XTransformPort=3003'  (Caddy reverse-proxies to port 3003)
 *       Path: '/'                     (the realtime service uses default
 *                                       Socket.IO path /socket.io)
 *
 * The URL is resolved ONCE at module load time so that it is stable
 * across reconnects. Tests can set the env var before loading the page.
 */
interface SocketConfig {
  url: string
  path: string
  transports: ('websocket' | 'polling')[]
}

function resolveSocketConfig(): SocketConfig {
  // Vercel mode — VERCEL=1 is set by the Vercel runtime.
  // Use the DEFAULT namespace (no URL) with path /api/realtime.
  // Vercel routes /api/realtime* to the root-level api/realtime.ts function.
  // The server's Socket.IO path is /api/realtime (not /api/realtime/socket.io).
  // Transports: websocket-only on Vercel (no polling fallback).
  const isVercel = process.env.NEXT_PUBLIC_VERCEL === '1' || process.env.VERCEL === '1'
  if (isVercel) {
    return { url: '', path: '/api/realtime', transports: ['websocket'] }
  }
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL
  if (explicit) {
    const isApiRealtime = explicit.includes('/api/realtime')
    return {
      url: explicit,
      path: isApiRealtime ? '/api/realtime' : '/',
      transports: isApiRealtime ? ['websocket'] : ['websocket', 'polling'],
    }
  }
  // Default: rely on Caddy's XTransformPort forwarding.
  // Works in docker + dev; on Vercel this must be overridden via env.
  return {
    url: '/?XTransformPort=3003',
    path: '/',
    transports: ['websocket', 'polling'],
  }
}

const { url: SOCKET_URL, path: SOCKET_PATH, transports: SOCKET_TRANSPORTS } = resolveSocketConfig()

// Refresh-in-flight guard — prevents concurrent token refresh storms.
let refreshPromise: Promise<string | null> | null = null

async function refreshToken(): Promise<string | null> {
  // If a refresh is already in-flight, reuse it.
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const res = await fetch('/api/realtime-token')
      if (!res.ok) return null
      const { token } = await res.json()
      return token as string
    } catch {
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

export async function connectRealtime(): Promise<Socket> {
  if (socketInstance?.connected) return socketInstance

  // Fetch the agent realtime token
  const res = await fetch('/api/realtime-token')
  if (!res.ok) throw new Error('Failed to get realtime token')
  const { token } = await res.json()

  // Connect. SOCKET_URL is empty on Vercel — `io('')` connects to the
  // page origin (Sukhan deployment) using the default namespace.
  socketInstance = io(SOCKET_URL, {
    path: SOCKET_PATH,
    addTrailingSlash: false,
    auth: { token },
    transports: SOCKET_TRANSPORTS,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 10000,
  })

  const createdSocket = socketInstance

  // After a reconnect, the server has lost all room subscriptions.
  // Re-emit conversation:join for the currently open conversation.
  createdSocket.on('connect', () => {
    if (socketInstance !== createdSocket) return
    const openConv = (createdSocket as Socket & { __lastJoinedConv?: string }).__lastJoinedConv
    if (openConv) {
      createdSocket.emit('conversation:join', openConv)
    }
  })

  // When the server middleware rejects the connection (invalid/expired
  // token), Socket.IO does NOT auto-reconnect. We must:
  //   1. Fetch a fresh token
  //   2. Update socket.auth
  //   3. Manually call socket.connect()
  // For membership_inactive, do NOT retry — a new token cannot fix a
  // revoked membership. Stop the retry loop and remain disconnected.
  let membershipRevoked = false
  createdSocket.on('connect_error', async (err: Error) => {
    if (socketInstance !== createdSocket) return
    const msg = err.message
    if (msg === 'membership_inactive' || msg === 'membership_check_failed') {
      // A new token cannot repair a revoked membership. Stop retrying.
      membershipRevoked = true
      createdSocket.io.opts.reconnection = false
      console.error('[realtime] membership inactive — disconnecting')
      createdSocket.disconnect()
      return
    }
    if (msg === 'invalid_token' || msg === 'no_token') {
      if (membershipRevoked) return
      const freshToken = await refreshToken()
      if (freshToken) {
        createdSocket.auth = { token: freshToken }
        // Socket.IO does NOT auto-reconnect after a middleware rejection.
        // We must manually initiate a new connection attempt.
        createdSocket.connect()
      }
    }
  })

  return socketInstance
}

export function getSocket(): Socket | null {
  return socketInstance
}

export function disconnectRealtime() {
  if (socketInstance) {
    socketInstance.disconnect()
    socketInstance = null
  }
}

/** Event names — must match the realtime service + src/lib/realtime-publish.ts */
export const RT_EVENTS = {
  MESSAGE_NEW: 'message:new',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  MESSAGE_READ: 'message:read',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_NEW: 'conversation:new',
} as const

/** Join a conversation room to receive its messages + typing events */
export function joinConversation(socket: Socket, conversationId: string) {
  ;(socket as Socket & { __lastJoinedConv?: string }).__lastJoinedConv = conversationId
  socket.emit('conversation:join', conversationId)
}

/** Leave a conversation room */
export function leaveConversation(socket: Socket, conversationId: string) {
  const self = socket as Socket & { __lastJoinedConv?: string }
  if (self.__lastJoinedConv === conversationId) self.__lastJoinedConv = undefined
  socket.emit('conversation:leave', conversationId)
}

/** Send a typing indicator to the other party in the conversation */
export function sendTypingStart(socket: Socket, conversationId: string) {
  socket.emit('typing:start', { conversationId })
}

export function sendTypingStop(socket: Socket, conversationId: string) {
  socket.emit('typing:stop', { conversationId })
}

/** Mark conversation as read (relays to other party + used for unread counts) */
export function sendRead(socket: Socket, conversationId: string) {
  socket.emit('message:read', { conversationId })
}

/** Exposed for tests — the URL that will be used on the next connect. */
export function getSocketUrl(): string {
  return SOCKET_URL
}
