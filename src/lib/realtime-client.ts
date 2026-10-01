'use client'

import { io, type Socket } from 'socket.io-client'

let socketInstance: Socket | null = null

/**
 * Resolve the Socket.IO connection URL.
 *
 * - In docker/dev (Caddy front of everything) we connect to
 *   `/?XTransformPort=3003` — Caddy forwards to the realtime service.
 * - In Vercel (no Caddy), the realtime service runs on a separate host.
 *   Set `NEXT_PUBLIC_REALTIME_URL` to its public URL.
 *
 * The URL is resolved ONCE at module load time so that it is stable
 * across reconnects. Tests can set the env var before loading the page.
 */
function resolveSocketUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL
  if (explicit) return explicit
  // Default: rely on Caddy's XTransformPort forwarding.
  // Works in docker + dev; on Vercel this must be overridden via env.
  return '/?XTransformPort=3003'
}

const SOCKET_URL = resolveSocketUrl()

export async function connectRealtime(): Promise<Socket> {
  if (socketInstance?.connected) return socketInstance

  // Fetch the agent realtime token
  const res = await fetch('/api/realtime-token')
  if (!res.ok) throw new Error('Failed to get realtime token')
  const { token } = await res.json()

  // Connect — path: '/' matches the realtime service's Socket.IO server config.
  socketInstance = io(SOCKET_URL, {
    path: SOCKET_URL.includes('/api/realtime') ? '/api/realtime/socket.io' : '/',
    auth: { token },
    transports: SOCKET_URL.includes("/api/realtime") ? ["websocket"] : ["websocket", "polling"],
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
