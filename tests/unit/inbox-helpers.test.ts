/// <reference types="bun-types" />
/**
 * Pure unit tests for the inbox helpers (src/lib/inbox-helpers.ts).
 *
 * Run with: `bun test tests/unit/inbox-helpers.test.ts`
 *
 * Coverage:
 *   - moveConversationToTop: first / middle / last conversation; no
 *     duplicate IDs; updated conversation becomes index 0; other order
 *     stable; idempotent; not-found returns input unchanged.
 *   - mergeMessages / mergeSingle: no duplicate IDs; chronological
 *     ordering; same-ID replacement preserves the newer copy; history
 *     fetch does NOT erase a newer realtime message; POST + realtime
 *     echo collapses to one entry; server-updated copy replaces stale
 *     local copy.
 *   - incrementUnreadOnce: same messageId → incremented true once, then
 *     false on subsequent duplicates; pure (input Set not mutated).
 *   - applyMessageToConversationList: end-to-end behavior tying the above
 *     together for the `message:new` handler (move-to-top + preview +
 *     unread-once + selected-conversation-no-increment).
 *
 * NO React, NO DOM, NO fetch — these are pure-data tests.
 */

import { test, expect, describe } from 'bun:test'
import {
  moveConversationToTop,
  mergeMessages,
  mergeSingle,
  incrementUnreadOnce,
  applyMessageToConversationList,
  previewFromMessage,
  compareMessages,
  type ConversationLike,
  type MessageLike,
} from '@/lib/inbox-helpers'

// ─── fixtures ─────────────────────────────────────────────────────

function makeConv(
  id: string,
  preview = '',
  unread = 0,
  lastAt = '2024-01-01T00:00:00.000Z',
): ConversationLike {
  return {
    id,
    lastMessagePreview: preview,
    lastMessageAt: lastAt,
    unreadCount: unread,
  }
}

function makeMsg(
  id: string,
  conversationId: string,
  text: string,
  createdAt: string,
  senderType: 'contact' | 'agent' | 'system' = 'contact',
): MessageLike & { content: { text: string } } {
  return { id, conversationId, senderType, createdAt, content: { text } }
}

// ─── moveConversationToTop ───────────────────────────────────────

describe('moveConversationToTop', () => {
  test('moves a MIDDLE conversation to index 0 and preserves other order', () => {
    const list = [makeConv('a'), makeConv('b'), makeConv('c'), makeConv('d')]
    const next = moveConversationToTop(list, 'c')
    expect(next.map((c) => c.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  test('moves the LAST conversation to index 0', () => {
    const list = [makeConv('a'), makeConv('b'), makeConv('c')]
    const next = moveConversationToTop(list, 'c')
    expect(next.map((c) => c.id)).toEqual(['c', 'a', 'b'])
  })

  test('returns the input unchanged when the conversation is already at index 0', () => {
    const list = [makeConv('a'), makeConv('b'), makeConv('c')]
    const next = moveConversationToTop(list, 'a')
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    // AND returns the SAME reference (no-op optimization)
    expect(next).toBe(list)
  })

  test('returns input unchanged (same reference) when conversation is not found', () => {
    const list = [makeConv('a'), makeConv('b')]
    const next = moveConversationToTop(list, 'zzz')
    expect(next).toBe(list)
    expect(next.map((c) => c.id)).toEqual(['a', 'b'])
  })

  test('handles a single-element list', () => {
    const list = [makeConv('a')]
    const next = moveConversationToTop(list, 'a')
    expect(next.map((c) => c.id)).toEqual(['a'])
  })

  test('does NOT mutate the input (purity)', () => {
    const list = [makeConv('a'), makeConv('b'), makeConv('c')]
    const snapshot = list.map((c) => c.id)
    moveConversationToTop(list, 'c')
    expect(list.map((c) => c.id)).toEqual(snapshot)
  })

  test('produces NO duplicate IDs (the original §19 bug)', () => {
    // The original buggy code did:
    //   updated.splice(idx, 1); updated.unshift(updated[0])
    // which produced a list with a DUPLICATE of the wrong first item and
    // LOST the updated conversation. This test asserts the fix:
    const list = [makeConv('a'), makeConv('b'), makeConv('c')]
    const next = moveConversationToTop(list, 'c')
    const ids = next.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect(ids).toContain('c')
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  test('the moved conversation is the SAME object reference (updated data preserved)', () => {
    const convB = makeConv('b', 'preview-b', 5)
    const list = [makeConv('a'), convB, makeConv('c')]
    const next = moveConversationToTop(list, 'b')
    expect(next[0]).toBe(convB)
  })
})

// ─── mergeMessages / mergeSingle ──────────────────────────────────

describe('mergeMessages', () => {
  test('deduplicates by ID — no duplicate IDs in output', () => {
    const a = makeMsg('m1', 'c1', 'hello', '2024-01-01T00:00:00.000Z')
    const b = makeMsg('m1', 'c1', 'hello echo', '2024-01-01T00:00:00.000Z')
    const out = mergeMessages([a], [b])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('m1')
  })

  test('keeps chronological order (createdAt ASC)', () => {
    const m1 = makeMsg('m1', 'c1', 'first', '2024-01-01T00:00:01.000Z')
    const m2 = makeMsg('m2', 'c1', 'second', '2024-01-01T00:00:02.000Z')
    const m3 = makeMsg('m3', 'c1', 'third', '2024-01-01T00:00:03.000Z')
    // Pass in scrambled order
    const out = mergeMessages([m3, m1], [m2])
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('on same ID, the NEWER copy wins (later createdAt)', () => {
    const old = makeMsg('m1', 'c1', 'old text', '2024-01-01T00:00:00.000Z')
    const newer = makeMsg('m1', 'c1', 'new text', '2024-01-01T00:00:05.000Z')
    // incoming (newer) replaces existing (older)
    expect(mergeMessages([old], [newer])[0].content.text).toBe('new text')
    // existing (newer) is preserved when incoming is older — this is the
    // "history fetch must NOT erase a newer realtime message" rule.
    expect(mergeMessages([newer], [old])[0].content.text).toBe('new text')
  })

  test('history fetch does NOT erase a newer realtime message (§20)', () => {
    // Realtime delivered m1 at 00:00:05; then the history fetch resolves
    // with the same m1 at 00:00:05 (tie → incoming wins) OR at 00:00:04
    // (older → existing wins). Both must keep the realtime copy.
    const realtime = makeMsg('m1', 'c1', 'realtime copy', '2024-01-01T00:00:05.000Z')
    const historyOlder = makeMsg('m1', 'c1', 'history copy', '2024-01-01T00:00:04.000Z')
    const out = mergeMessages([realtime], [historyOlder])
    expect(out).toHaveLength(1)
    expect(out[0].content.text).toBe('realtime copy')
  })

  test('history fetch (tie timestamp) — incoming (server) copy wins', () => {
    // Same ID, same timestamp: server (incoming) view replaces local copy.
    // This is the "server-updated copy of the same ID can replace stale
    // local copy" rule.
    const local = makeMsg('m1', 'c1', 'local', '2024-01-01T00:00:00.000Z')
    const server = makeMsg('m1', 'c1', 'server', '2024-01-01T00:00:00.000Z')
    expect(mergeMessages([local], [server])[0].content.text).toBe('server')
  })

  test('POST reply + Socket.IO broadcast of the same message → one entry (§27)', () => {
    // POST response contains message id m5 at time T.
    // Socket.IO broadcast ALSO delivers m5 at time T.
    // Both go through mergeSingle — the result has exactly one m5.
    const post = makeMsg('m5', 'c1', 'reply', '2024-01-01T00:00:10.000Z', 'agent')
    const broadcast = makeMsg('m5', 'c1', 'reply', '2024-01-01T00:00:10.000Z', 'agent')
    let state: MessageLike[] = []
    state = mergeSingle(state, post)
    state = mergeSingle(state, broadcast)
    expect(state).toHaveLength(1)
    expect(state[0].id).toBe('m5')
  })

  test('Socket.IO broadcast + 8s polling of the same message → one entry (§20)', () => {
    const m = makeMsg('m9', 'c1', 'hi', '2024-01-01T00:00:11.000Z')
    let state: MessageLike[] = []
    state = mergeSingle(state, m) // realtime broadcast
    state = mergeMessages(state, [m]) // 8s polling
    expect(state).toHaveLength(1)
  })

  test('handles empty inputs', () => {
    expect(mergeMessages([], [])).toEqual([])
    const m = makeMsg('m1', 'c1', 'x', '2024-01-01T00:00:00.000Z')
    expect(mergeMessages([], [m])).toEqual([m])
    expect(mergeMessages([m], [])).toEqual([m])
  })

  test('does NOT mutate inputs (purity)', () => {
    const a = makeMsg('m1', 'c1', 'a', '2024-01-01T00:00:00.000Z')
    const b = makeMsg('m2', 'c1', 'b', '2024-01-01T00:00:01.000Z')
    const inA = [a]
    const inB = [b]
    mergeMessages(inA, inB)
    expect(inA).toEqual([a])
    expect(inB).toEqual([b])
  })

  test('stable chronological order with multiple distinct IDs in both lists', () => {
    const a = makeMsg('a', 'c1', '1', '2024-01-01T00:00:01.000Z')
    const b = makeMsg('b', 'c1', '2', '2024-01-01T00:00:02.000Z')
    const c = makeMsg('c', 'c1', '3', '2024-01-01T00:00:03.000Z')
    const d = makeMsg('d', 'c1', '4', '2024-01-01T00:00:04.000Z')
    const out = mergeMessages([d, a], [b, c])
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('mergeSingle', () => {
  test('appends a new message in chronological position', () => {
    const m1 = makeMsg('m1', 'c1', 'first', '2024-01-01T00:00:01.000Z')
    const m2 = makeMsg('m2', 'c1', 'second', '2024-01-01T00:00:02.000Z')
    const m3 = makeMsg('m3', 'c1', 'third', '2024-01-01T00:00:03.000Z')
    let state = [m1, m3]
    state = mergeSingle(state, m2)
    expect(state.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('replaces same-ID with newer copy', () => {
    const m1Old = makeMsg('m1', 'c1', 'old', '2024-01-01T00:00:01.000Z')
    const m1New = makeMsg('m1', 'c1', 'new', '2024-01-01T00:00:02.000Z')
    const state = mergeSingle([m1Old], m1New)
    expect(state).toHaveLength(1)
    expect(state[0].content.text).toBe('new')
  })

  test('does NOT replace same-ID with older copy (realtime preserved)', () => {
    const m1New = makeMsg('m1', 'c1', 'new', '2024-01-01T00:00:02.000Z')
    const m1Old = makeMsg('m1', 'c1', 'old', '2024-01-01T00:00:01.000Z')
    const state = mergeSingle([m1New], m1Old)
    expect(state).toHaveLength(1)
    expect(state[0].content.text).toBe('new')
  })
})

// ─── incrementUnreadOnce ──────────────────────────────────────────

describe('incrementUnreadOnce', () => {
  test('first delivery of a message ID increments (returns true)', () => {
    const seen = new Set<string>()
    const r = incrementUnreadOnce(seen, 'm1')
    expect(r.incremented).toBe(true)
    expect(r.seen.has('m1')).toBe(true)
  })

  test('duplicate delivery of the SAME message ID does NOT re-increment (§26)', () => {
    const seen = new Set<string>()
    const r1 = incrementUnreadOnce(seen, 'm1')
    const r2 = incrementUnreadOnce(r1.seen, 'm1')
    const r3 = incrementUnreadOnce(r2.seen, 'm1')
    expect(r1.incremented).toBe(true)
    expect(r2.incremented).toBe(false)
    expect(r3.incremented).toBe(false)
    expect(r3.seen.size).toBe(1)
  })

  test('two DIFFERENT message IDs each increment exactly once', () => {
    let seen = new Set<string>()
    const r1 = incrementUnreadOnce(seen, 'm1')
    seen = r1.seen
    const r2 = incrementUnreadOnce(seen, 'm2')
    seen = r2.seen
    const r3 = incrementUnreadOnce(seen, 'm1') // duplicate of m1
    seen = r3.seen
    const r4 = incrementUnreadOnce(seen, 'm2') // duplicate of m2
    expect(r1.incremented).toBe(true)
    expect(r2.incremented).toBe(true)
    expect(r3.incremented).toBe(false)
    expect(r4.incremented).toBe(false)
    expect(seen.size).toBe(2)
  })

  test('does NOT mutate the input Set (purity)', () => {
    const seen = new Set<string>(['existing'])
    const snapshot = new Set(seen)
    incrementUnreadOnce(seen, 'm1')
    expect(seen).toEqual(snapshot) // input untouched
    expect(seen.size).toBe(1)
  })

  test('returns the SAME Set reference on the duplicate path', () => {
    const seen = new Set<string>(['m1'])
    const r = incrementUnreadOnce(seen, 'm1')
    expect(r.seen).toBe(seen) // referential equality — no allocation
  })
})

// ─── previewFromMessage & compareMessages ─────────────────────────

describe('previewFromMessage', () => {
  test('returns first 120 chars of text', () => {
    const long = 'x'.repeat(200)
    expect(previewFromMessage(makeMsg('m', 'c', long, '2024-01-01T00:00:00.000Z'))).toBe('x'.repeat(120))
  })
  test('falls back to [attachment] when no text', () => {
    expect(
      previewFromMessage({ id: 'm', conversationId: 'c', senderType: 'contact', createdAt: 't', content: {} }),
    ).toBe('[attachment]')
  })
  test('falls back to [attachment] when content is undefined', () => {
    expect(
      previewFromMessage({ id: 'm', conversationId: 'c', senderType: 'contact', createdAt: 't' }),
    ).toBe('[attachment]')
  })
})

describe('compareMessages', () => {
  test('sorts by createdAt ASC', () => {
    const a = makeMsg('a', 'c', '1', '2024-01-01T00:00:01.000Z')
    const b = makeMsg('b', 'c', '2', '2024-01-01T00:00:02.000Z')
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(compareMessages(b, a)).toBeGreaterThan(0)
  })
  test('tie-broken by id ASC', () => {
    const a = makeMsg('aaa', 'c', '1', '2024-01-01T00:00:00.000Z')
    const b = makeMsg('bbb', 'c', '2', '2024-01-01T00:00:00.000Z')
    expect(compareMessages(a, b)).toBeLessThan(0)
  })
  test('same id + same timestamp compares equal', () => {
    const a = makeMsg('m', 'c', '1', '2024-01-01T00:00:00.000Z')
    expect(compareMessages(a, a)).toBe(0)
  })
})

// ─── applyMessageToConversationList (pure — shouldIncrementUnread: boolean) ───

describe('applyMessageToConversationList', () => {
  function setup() {
    const list = [
      makeConv('a', 'old-a', 0, '2024-01-01T00:00:00.000Z'),
      makeConv('b', 'old-b', 1, '2024-01-01T00:00:10.000Z'),
      makeConv('c', 'old-c', 0, '2024-01-01T00:00:20.000Z'),
    ]
    return { list }
  }

  test('updates the affected conversation and moves it to index 0', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'b', 'new message', '2024-01-01T00:00:30.000Z', 'contact')
    const r = applyMessageToConversationList(list, msg, false, false)
    expect(r.isNew).toBe(false)
    expect(r.list.map((c) => c.id)).toEqual(['b', 'a', 'c'])
    expect(r.list[0].lastMessagePreview).toBe('new message')
    expect(r.list[0].lastMessageAt).toBe('2024-01-01T00:00:30.000Z')
  })

  test('increments unread when shouldIncrementUnread=true; no-op when false (dedup)', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'b', 'new', '2024-01-01T00:00:30.000Z', 'contact')
    const r1 = applyMessageToConversationList(list, msg, false, true)
    expect(r1.incrementedUnread).toBe(true)
    expect(r1.list.find((c) => c.id === 'b')!.unreadCount).toBe(2)
    const r2 = applyMessageToConversationList(r1.list, msg, false, false)
    expect(r2.incrementedUnread).toBe(false)
    expect(r2.list.find((c) => c.id === 'b')!.unreadCount).toBe(2)
  })

  test('does NOT increment unread when the conversation IS selected', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'b', 'new', '2024-01-01T00:00:30.000Z', 'contact')
    const r = applyMessageToConversationList(list, msg, true, false)
    expect(r.incrementedUnread).toBe(false)
    expect(r.list.find((c) => c.id === 'b')!.unreadCount).toBe(1)
  })

  test('does NOT increment unread for an AGENT-sender message', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'b', 'agent reply', '2024-01-01T00:00:30.000Z', 'agent')
    const r = applyMessageToConversationList(list, msg, false, false)
    expect(r.incrementedUnread).toBe(false)
    expect(r.list.find((c) => c.id === 'b')!.unreadCount).toBe(1)
  })

  test('returns isNew=true when the conversation is not in the list (caller reloads)', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'unknown-conv', 'hi', '2024-01-01T00:00:30.000Z', 'contact')
    const r = applyMessageToConversationList(list, msg, false, false)
    expect(r.isNew).toBe(true)
    expect(r.list).toBe(list)
  })

  test('produces NO duplicate IDs after move-to-top', () => {
    const { list } = setup()
    const msg = makeMsg('m99', 'c', 'new', '2024-01-01T00:00:30.000Z', 'contact')
    const r = applyMessageToConversationList(list, msg, false, false)
    const ids = r.list.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('c')
    expect(ids.slice(1)).toEqual(['a', 'b'])
  })

  test('does NOT mutate the input list (purity)', () => {
    const { list } = setup()
    const snapshot = list.map((c) => ({ ...c }))
    const msg = makeMsg('m99', 'b', 'new', '2024-01-01T00:00:30.000Z', 'contact')
    applyMessageToConversationList(list, msg, false, false)
    expect(list.map((c) => ({ ...c }))).toEqual(snapshot)
  })

  test('preview falls back to [attachment] for a no-text message', () => {
    const { list } = setup()
    const msg: MessageLike = {
      id: 'm99', conversationId: 'b', senderType: 'contact',
      createdAt: '2024-01-01T00:00:30.000Z', content: {},
    }
    const r = applyMessageToConversationList(list, msg, false, false)
    expect(r.list.find((c) => c.id === 'b')!.lastMessagePreview).toBe('[attachment]')
  })
})

// ─── Burst: two MESSAGE_NEW events before a render (PR#5 final race fix) ───

describe('Burst: two back-to-back MESSAGE_NEW events (PR#5 race fix)', () => {
  function applyEvent(
    list: ConversationLike[],
    seen: Set<string>,
    msg: MessageLike,
    isSelected: boolean,
  ): { list: ConversationLike[]; seen: Set<string> } {
    const shouldIncrement =
      msg.senderType === 'contact' && !isSelected && !seen.has(msg.id)
    const nextSeen = shouldIncrement ? new Set(seen).add(msg.id) : seen
    const r = applyMessageToConversationList(list, msg, isSelected, shouldIncrement)
    return { list: r.isNew ? list : r.list, seen: nextSeen }
  }

  test('Case A: same non-selected conversation, two distinct IDs → unread = 2', () => {
    const list = [
      makeConv('a', '', 0, '2024-01-01T00:00:00.000Z'),
      makeConv('b', '', 0, '2024-01-01T00:00:10.000Z'),
    ]
    let seen = new Set<string>()
    const msg1 = makeMsg('m1', 'b', 'first', '2024-01-01T00:00:30.000Z', 'contact')
    const msg2 = makeMsg('m2', 'b', 'second', '2024-01-01T00:00:31.000Z', 'contact')
    let state = list
    const r1 = applyEvent(state, seen, msg1, false); state = r1.list; seen = r1.seen
    const r2 = applyEvent(state, seen, msg2, false); state = r2.list; seen = r2.seen
    expect(seen.has('m1')).toBe(true)
    expect(seen.has('m2')).toBe(true)
    expect(seen.size).toBe(2)
    expect(state.find((c) => c.id === 'b')!.unreadCount).toBe(2)
    expect(state.find((c) => c.id === 'b')!.lastMessagePreview).toBe('second')
  })

  test('Case A: duplicate redelivery of the SAME message ID → unread stays 1', () => {
    const list = [makeConv('b', '', 0, '2024-01-01T00:00:10.000Z')]
    let seen = new Set<string>()
    const msg = makeMsg('m1', 'b', 'first', '2024-01-01T00:00:30.000Z', 'contact')
    let state = list
    const r1 = applyEvent(state, seen, msg, false); state = r1.list; seen = r1.seen
    const r2 = applyEvent(state, seen, msg, false); state = r2.list; seen = r2.seen
    const r3 = applyEvent(state, seen, msg, false); state = r3.list; seen = r3.seen
    expect(seen.size).toBe(1)
    expect(state.find((c) => c.id === 'b')!.unreadCount).toBe(1)
  })

  test('out-of-order delivery: older message (msg2) after newer (msg3) does NOT overwrite the preview', () => {
    // Two messages sent back-to-back via Promise.all -> the server processes
    // them concurrently -> Socket.IO MESSAGE_NEW delivery order is non-
    // deterministic. If msg3 (newer createdAt) is delivered BEFORE msg2
    // (older createdAt), msg2's applyMessageToConversationList must NOT
    // overwrite the preview with its stale (older) text. The createdAt guard
    // ensures the preview always reflects the LATEST message.
    const list = [makeConv('b', 'old', 0, '2024-01-01T00:00:10.000Z')]
    let seen = new Set<string>()
    // msg3 (newer) arrives FIRST.
    const msg3 = makeMsg('m3', 'b', 'preview-3', '2024-01-01T00:00:31.000Z', 'contact')
    // msg2 (older) arrives SECOND (out of order).
    const msg2 = makeMsg('m2', 'b', 'preview-2', '2024-01-01T00:00:30.000Z', 'contact')
    let state = list
    const r3 = applyEvent(state, seen, msg3, false); state = r3.list; seen = r3.seen
    const r2 = applyEvent(state, seen, msg2, false); state = r2.list; seen = r2.seen
    // The preview must be msg3 (the NEWER message), NOT msg2 (the older).
    expect(state.find((c) => c.id === 'b')!.lastMessagePreview).toBe('preview-3')
    expect(state.find((c) => c.id === 'b')!.lastMessageAt).toBe('2024-01-01T00:00:31.000Z')
  })
  test('Case B: two different conversations back-to-back → both previews preserved, latest at index 0', () => {
    const list = [
      makeConv('a', 'old-a', 0, '2024-01-01T00:00:00.000Z'),
      makeConv('b', 'old-b', 0, '2024-01-01T00:00:10.000Z'),
    ]
    let seen = new Set<string>()
    const msgA = makeMsg('m1', 'a', 'preview-A', '2024-01-01T00:00:30.000Z', 'contact')
    const msgB = makeMsg('m2', 'b', 'preview-B', '2024-01-01T00:00:31.000Z', 'contact')
    let state = list
    const r1 = applyEvent(state, seen, msgA, false); state = r1.list; seen = r1.seen
    const r2 = applyEvent(state, seen, msgB, false); state = r2.list; seen = r2.seen
    expect(state.find((c) => c.id === 'a')!.lastMessagePreview).toBe('preview-A')
    expect(state.find((c) => c.id === 'b')!.lastMessagePreview).toBe('preview-B')
    expect(state.find((c) => c.id === 'a')!.lastMessageAt).toBe('2024-01-01T00:00:30.000Z')
    expect(state.find((c) => c.id === 'b')!.lastMessageAt).toBe('2024-01-01T00:00:31.000Z')
    const ids = state.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(2)
    expect(ids[0]).toBe('b')
    expect(state.find((c) => c.id === 'a')!.unreadCount).toBe(1)
    expect(state.find((c) => c.id === 'b')!.unreadCount).toBe(1)
  })
})
