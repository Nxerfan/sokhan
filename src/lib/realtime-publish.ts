/**
 * Publishes realtime events to the Socket.IO service via internal HTTP.
 *
 * In the sandbox (no Redis), Next.js API routes call this after persisting to
 * the DB. The realtime service receives the POST and emits to connected sockets
 * in the specified room.
 *
 * In production with Redis, this would be replaced by a Redis PUBLISH call —
 * the realtime service would subscribe to Redis instead of exposing an HTTP
 * endpoint. The function signature stays the same.
 */

import { AUTH_SECRET } from './env-check'

const REALTIME_INTERNAL_URL = process.env.REALTIME_INTERNAL_URL || 'http://localhost:3004'
const INTERNAL_SECRET = AUTH_SECRET

export interface RealtimeEvent {
  room: string
  event: string
  payload: unknown
}

export async function publishToRealtime(event: RealtimeEvent): Promise<void> {
  try {
    await fetch(`${REALTIME_INTERNAL_URL}/internal/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(event),
    })
  } catch (e) {
    // Realtime service may be down or starting — don't block the API response.
    // Messages are persisted to DB; clients will catch up on reconnect.
    console.error('[realtime] publish failed:', e instanceof Error ? e.message : e)
  }
}

/** Room name helpers — keep naming consistent between API routes and the realtime service. */
export const room = {
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  agent: (userId: string) => `agent:${userId}`,
}

/** Event names — shared between API routes, realtime service, and clients. */
export const EVENTS = {
  MESSAGE_NEW: 'message:new',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
  MESSAGE_READ: 'message:read',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_NEW: 'conversation:new',
} as const
