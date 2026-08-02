'use client'

import { io, type Socket } from 'socket.io-client'

let socketInstance: Socket | null = null

/**
 * Dashboard realtime client. Connects to the Socket.IO service via the Caddy
 * gateway (path '/', XTransformPort=3003 query param). Authenticates with a
 * realtime agent token fetched from /api/realtime-token.
 */
export async function connectRealtime(): Promise<Socket> {
  if (socketInstance?.connected) return socketInstance

  // Fetch the agent realtime token
  const res = await fetch('/api/realtime-token')
  if (!res.ok) throw new Error('Failed to get realtime token')
  const { token } = await res.json()

  // Connect via the gateway — NEVER use a direct port in the URL.
  // path: '/' matches the realtime service's Socket.IO server config.
  socketInstance = io('/?XTransformPort=3003', {
    path: '/',
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 10000,
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
  socket.emit('conversation:join', conversationId)
}

/** Leave a conversation room */
export function leaveConversation(socket: Socket, conversationId: string) {
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
