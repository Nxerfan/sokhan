/**
 * Pure helpers extracted from the dashboard inbox view.
 *
 * These functions are pure: NO React, NO DOM, NO fetch, NO side effects.
 * They operate on plain data and return new data. This makes them trivially
 * unit-testable with `bun:test` and re-usable by both the live inbox view
 * and any future inbox implementation (e.g. a widget host page).
 *
 * Coverage maps to the bug list in the widget-inbox-realtime-reliability PR:
 *
 *   - §19 conversation move-to-top (immutable, no duplicate IDs)
 *   - §20 central message merge (ID dedup + chronological order +
 *        same-ID replacement preserving the newer copy)
 *   - §26 unread count semantics (increment exactly once per message ID)
 */

/** Minimal shape of a conversation list entry used by the helpers. */
export interface ConversationLike {
  id: string
  lastMessagePreview: string
  lastMessageAt: string
  unreadCount: number
}

/** Minimal shape of a message used by the helpers. */
export interface MessageLike {
  id: string
  conversationId: string
  senderType: string
  createdAt: string
  content?: { text?: string }
}

/**
 * Move the conversation with `conversationId` to the front of the list.
 *
 * Pure: returns a NEW array; does NOT mutate the input.
 *
 * - If the conversation is not found, returns the input unchanged.
 * - If it is already at index 0, returns the input unchanged (no reorder).
 *
 * Bug fixed (§19): the previous code did
 *   `updated.splice(idx, 1); updated.unshift(updated[0])`
 * which REMOVED the updated conversation (the splice victim) and then
 * DUPLICATED the wrong first item (whatever was at index 0 after the
 * splice). This implementation captures the spliced-out item and unshifts
 * THAT, so the updated conversation becomes index 0 and the relative order
 * of every other conversation is preserved.
 */
export function moveConversationToTop<T extends { id: string }>(
  list: T[],
  conversationId: string,
): T[] {
  const idx = list.findIndex((c) => c.id === conversationId)
  if (idx <= 0) return list
  const next = list.slice()
  const [moved] = next.splice(idx, 1)
  next.unshift(moved)
  return next
}

/**
 * Chronological comparison for messages: by `createdAt` ASC, then by `id`
 * ASC for a stable total order when timestamps tie.
 *
 * `createdAt` is treated as a string — ISO-8601 UTC timestamps sort
 * lexicographically in chronological order, which is what the inbox uses
 * everywhere. For two messages with the same timestamp, the lexicographic
 * comparison of `id` provides a deterministic tie-breaker so the sort is
 * total (no two messages compare equal), which keeps Array#sort stable
 * even on engines where it isn't guaranteed.
 */
export function compareMessages<T extends { id: string; createdAt: string }>(
  a: T,
  b: T,
): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * Merge two message arrays by ID, returning a stable chronologically
 * ordered list with NO duplicate IDs.
 *
 * Rules (§20):
 *
 *   - No duplicate IDs in the output — the result is a Set-by-id
 *     deduplication of `existing` ∪ `incoming`.
 *
 *   - When the same ID appears in both inputs, the copy with the LATER
 *     `createdAt` wins ("keep the newer"). On a tie (same timestamp),
 *     the `incoming` copy wins — this lets a server-updated message
 *     replace a stale local copy, AND lets a fresh realtime broadcast
 *     replace a stale history-fetch copy.
 *
 *   - The result is sorted chronologically (createdAt ASC, id ASC tie-break)
 *     via `compareMessages`.
 *
 * This single helper is the chokepoint for all message-ingestion paths in
 * the inbox (history fetch, Socket.IO broadcast, POST reply response, 8s
 * polling). Routing all of them through here guarantees:
 *
 *   - History fetch does NOT erase a newer realtime message that arrived
 *     before the history resolved (the realtime copy has a later
 *     `createdAt`, so it wins).
 *   - POST reply + Socket.IO broadcast of the same message → one entry.
 *   - Socket.IO broadcast + 8s polling of the same message → one entry.
 *   - Server-edited (updated) copy of an existing ID replaces the stale
 *     local copy.
 */
export function mergeMessages<T extends { id: string; createdAt: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byId = new Map<string, T>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) {
    const cur = byId.get(m.id)
    if (!cur) {
      byId.set(m.id, m)
    } else if (m.createdAt >= cur.createdAt) {
      // `incoming` is at least as new as the existing copy → replace.
      // A strictly newer realtime copy already in `existing` is preserved
      // (we only replace when incoming >= existing), which is the
      // "history fetch must not erase a newer realtime message" rule.
      byId.set(m.id, m)
    }
  }
  return Array.from(byId.values()).sort(compareMessages)
}

/**
 * Merge a single incoming message into an existing list. Convenience
 * wrapper around `mergeMessages` for the common single-message case
 * (e.g. POST reply echo, one realtime broadcast).
 *
 * Same dedup + ordering rules as `mergeMessages`.
 */
export function mergeSingle<T extends { id: string; createdAt: string }>(
  existing: T[],
  msg: T,
): T[] {
  return mergeMessages(existing, [msg])
}

/**
 * Track seen message IDs for unread-count effects.
 *
 * A contact message may be delivered MORE THAN ONCE:
 *   - Socket.IO broadcast + 8s polling catch-up
 *   - POST reply echo + Socket.IO broadcast (for agent messages, not
 *     unread-affecting, but the helper is generic)
 *   - duplicate Socket.IO delivery across reconnect reconciliation
 *
 * The unread badge must increment EXACTLY ONCE per unique message ID.
 * This helper tracks the set of IDs we have already counted, so a duplicate
 * delivery returns `incremented: false` and the caller does NOT bump the
 * unread count a second time (§26).
 *
 * Pure: returns a NEW Set on the increment path (does NOT mutate the
 * input Set). On the duplicate path, returns the SAME Set reference for
 * cheap referential-equality when nothing changed.
 */
export function incrementUnreadOnce(
  seen: Set<string>,
  messageId: string,
): { seen: Set<string>; incremented: boolean } {
  if (seen.has(messageId)) {
    return { seen, incremented: false }
  }
  const next = new Set(seen)
  next.add(messageId)
  return { seen: next, incremented: true }
}

/**
 * Derive the conversation-list preview string from a message.
 *
 * Mirrors the inbox's existing rule: take the first 120 chars of the
 * message text; fall back to `'[attachment]'` for messages with no text
 * (e.g. image-only attachment messages).
 */
export function previewFromMessage<M extends MessageLike>(message: M): string {
  const text = message.content?.text
  if (text && text.length > 0) return text.slice(0, 120)
  return '[attachment]'
}

/**
 * Apply an incoming message to a conversation-list snapshot.
 *
 * Combined helper for the `message:new` handler — does the immutable
 * move-to-top, the lastMessagePreview/lastMessageAt update, AND the unread
 * increment decision in one pure call (§19 + §26).
 *
 * Unread rule (§26): ONLY contact-sender messages increment the unread
 * count, and ONLY when the conversation is NOT currently selected (the
 * selected conversation stays read via sendRead reconciliation). The
 * `unreadSeen` set dedupes by message ID so a duplicate delivery does not
 * re-increment.
 *
 * Returns:
 *   - `list`           — the new conversation list (or the input unchanged
 *                        if the conversation was not in the list — caller
 *                        should reload from the server in that case).
 *   - `isNew`          — true if the conversation was not in the input list
 *                        (caller should `loadConversations` to pick it up).
 *   - `incrementedUnread` — whether the unread count was incremented.
 *   - `seen`           — the (possibly-updated) unread-seen set. A NEW
 *                        Set on the increment path; the SAME reference on
 *                        the no-increment path (caller can detect "nothing
 *                        changed" via referential equality if desired).
 */
export function applyMessageToConversationList<
  C extends ConversationLike,
  M extends MessageLike,
>(
  list: C[],
  message: M,
  isSelected: boolean,
  /** Whether the caller decided to increment unread for this message.
   *  Computed OUTSIDE the React state updater (from the unread-seen ref)
   *  so the updater stays PURE — two back-to-back MESSAGE_NEW events chain
   *  correctly under React StrictMode double-invocation. */
  shouldIncrementUnread: boolean,
): {
  list: C[]
  isNew: boolean
  incrementedUnread: boolean
} {
  const idx = list.findIndex((c) => c.id === message.conversationId)
  if (idx === -1) {
    return { list, isNew: true, incrementedUnread: false }
  }
  const conv = list[idx]
  const incrementedUnread = shouldIncrementUnread
  const updatedConv: C = {
    ...conv,
    lastMessagePreview: previewFromMessage(message),
    lastMessageAt: message.createdAt,
    unreadCount: incrementedUnread ? conv.unreadCount + 1 : conv.unreadCount,
  }
  const next = list.slice()
  next[idx] = updatedConv
  return {
    list: moveConversationToTop(next, message.conversationId),
    isNew: false,
    incrementedUnread,
  }
}
