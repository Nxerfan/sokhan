/**
 * Sukhan Widget — pure message-merge helpers.
 *
 * ONE central merge function keyed by `Message.id`. Used for ALL
 * ingestion paths (POST response, socket `message:new`, polling, history
 * reload). Same ID appears exactly once. A server-updated copy of the
 * same ID replaces the stale local copy. Stable chronological ordering
 * by `createdAt` then `id` as a deterministic tiebreaker.
 */

import type { Message } from './types'

function ts(m: Message): number {
  if (!m || !m.createdAt) return 0
  const n = Date.parse(m.createdAt)
  return Number.isFinite(n) ? n : 0
}

function compareMessages(a: Message, b: Message): number {
  const ta = ts(a)
  const tb = ts(b)
  if (ta !== tb) return ta - tb
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const map = new Map<string, Message>()
  for (const m of existing) {
    if (m && m.id) map.set(m.id, m)
  }
  for (const m of incoming) {
    if (m && m.id) map.set(m.id, m)
  }
  const merged = Array.from(map.values())
  merged.sort(compareMessages)
  return merged
}

export function mergeMessage(
  existing: readonly Message[],
  incoming: Message,
): Message[] {
  return mergeMessages(existing, [incoming])
}
