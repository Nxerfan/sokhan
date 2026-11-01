/**
 * Message Preview policy — pure incoming-message eligibility + text shaping.
 *
 * Determines whether a newly ingested message should produce a launcher
 * preview bubble, and if so, returns the safe plain-text string to display.
 *
 * This module is PURE: no DOM, no Prisma, no Next.js, no side effects.
 * It is independently testable and never throws.
 *
 * Feature 5 — Message Preview.
 *
 * Eligibility (ALL must hold):
 *   - The tenant's effective messagePreview entitlement is enabled.
 *   - The widget panel is closed.
 *   - The visitor is authorized (active conversation).
 *   - The message belongs to the EXACT active conversation.
 *   - The message arrived via realtime ('live') or polling ('poll') —
 *     NEVER via 'history' (initial restore / reload) or 'post' (optimistic
 *     visitor echo).
 *   - The sender is an agent ('agent').
 *   - The content type is 'text'.
 *   - The text is non-empty after whitespace normalization.
 *   - The message id has not already been seen (dedup).
 *
 * Text shaping:
 *   - Whitespace normalized (trim + collapse internal runs to single spaces).
 *   - Capped at 120 Unicode code points; a single '…' ellipsis is appended
 *     when truncated (total ≤ 121 code points).
 *   - The raw text is returned as a plain string — the DOM layer MUST render
 *     it via textContent (never innerHTML) to prevent HTML injection.
 */

/** The source channel through which a message was ingested. */
export type MessagePreviewSource = 'live' | 'poll' | 'history' | 'post'

/** The incoming message shape consumed by the policy. */
export interface PreviewableMessage {
  id: string
  conversationId: string
  senderType: string
  contentType: string
  content: { text?: unknown }
  createdAt?: string
}

/** The options consumed by the pure eligibility + text policy. */
export interface MessagePreviewOptions {
  /** Effective server-authoritative messagePreview entitlement. */
  enabled: boolean
  /** Whether the widget panel is currently open. */
  panelOpen: boolean
  /** Whether the visitor has an authorized, active conversation. */
  authorized: boolean
  /** The active conversation id (null when no active conversation). */
  conversationId: string | null
  /** How the message was ingested. */
  source: MessagePreviewSource
  /** The candidate message. */
  message: PreviewableMessage
  /** Message ids already processed (for dedup across socket + poll). */
  seenIds: string[]
}

/** Maximum preview length in Unicode code points (excluding the ellipsis). */
export const PREVIEW_MAX_CODE_POINTS = 120

/** The ellipsis appended when the text is truncated (1 code point). */
const PREVIEW_ELLIPSIS = '\u2026'

/** Sources that may produce a live preview (new incoming replies only). */
const LIVE_SOURCES: ReadonlySet<MessagePreviewSource> = new Set(['live', 'poll'])

/**
 * Normalize whitespace safely: trim leading/trailing whitespace and collapse
 * internal runs of whitespace (spaces, tabs, newlines, etc.) into single
 * spaces. Never throws — returns '' for non-string or empty input.
 */
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  // \s matches all Unicode whitespace in JS (with the 'u' flag it is
  // Unicode-aware; without the flag, \s covers the common ASCII set +
  // a few Unicode whitespace). We use a plain regex without the 'u' flag
  // for broad compatibility — this collapses all whitespace runs.
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Cap a string to `max` Unicode code points, appending a single ellipsis
 * if truncation occurred. Returns the (possibly truncated) string.
 */
function capText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('') + PREVIEW_ELLIPSIS
}

/**
 * Determine whether a message should produce a launcher preview, and return
 * the safe plain-text string to display, or `null` if no preview is allowed.
 *
 * Pure function — never throws, never mutates inputs, never touches the DOM.
 * The caller is responsible for rendering the returned text via textContent
 * (never innerHTML) and for adding the message id to `seenIds` after display.
 */
export function getMessagePreviewText(options: MessagePreviewOptions): string | null {
  // Entitlement + state gate.
  if (!options.enabled) return null
  if (options.panelOpen) return null
  if (!options.authorized) return null
  if (!options.conversationId) return null

  // Source gate: only live realtime or polling deliveries may preview.
  // History (initial restore / reload) and post (optimistic visitor echo)
  // must NEVER produce a preview.
  if (!LIVE_SOURCES.has(options.source)) return null

  const msg = options.message
  if (!msg || typeof msg !== 'object') return null

  // Conversation match: the message must belong to the exact active
  // conversation. A message from another conversation never previews.
  if (msg.conversationId !== options.conversationId) return null

  // Sender gate: only agent messages preview.
  if (msg.senderType !== 'agent') return null

  // Content gate: only text messages preview (no attachments, images, etc.).
  if (msg.contentType !== 'text') return null

  // Dedup: a message already processed never previews again.
  const id = msg.id
  if (typeof id !== 'string' || id === '') return null
  if (options.seenIds && options.seenIds.indexOf(id) !== -1) return null

  // Text extraction + normalization.
  const text = normalizeText(msg.content && msg.content.text)
  if (text === '') return null

  // Cap + return the plain text (the DOM layer handles XSS via textContent).
  return capText(text, PREVIEW_MAX_CODE_POINTS)
}
