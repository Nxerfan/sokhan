/**
 * Legacy realtime-publish entrypoint.
 *
 * The implementation has moved to `src/lib/realtime/index.ts`, which adds
 * a Redis-backed publisher for Vercel mode while preserving the existing
 * HTTP-internal behaviour for docker/dev.
 *
 * This file re-exports the new API so existing callers (the Module 2
 * API routes that import from `@/lib/realtime-publish`) continue to work
 * unchanged.
 */

export {
  publishToRealtime,
  room,
  EVENTS,
  getRealtimePublisher,
  __resetRealtimePublisherCache,
} from '@/lib/realtime'
export type { RealtimeEvent, RealtimePublisher } from '@/lib/realtime'
