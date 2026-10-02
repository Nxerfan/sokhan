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
    auth: { token },
    transports: SOCKET_TRANSPORTS,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 10000,
  })

  // CRITICAL: after a reconnect, the server has lost all room subscriptions.
  // We re-emit `conversation:join` for the conversation currently open so we
  // keep receiving its messages. (The server side is idempotent — re-joining
  // a room you're already in is a no-op; re-joining after a disconnect is
  // required because the disconnect cleared the room state.)
  const createdSocket = socketInstance
  createdSocket.on('connect', () => {
    // If the singleton has been swapped out for a new socket, ignore this
    // event — it belongs to a stale connection that should not write state.
    if (socketInstance !== createdSocket) return
    const openConv = (createdSocket as Socket & { __lastJoinedConv?: string }).__lastJoinedConv
    if (openConv) {
      createdSocket.emit('conversation:join', openConv)
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
