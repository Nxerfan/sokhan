/**
 * Context Chat types + page-context validation (Feature 11 — BETA).
 *
 * Context Chat is a privacy-conscious, visitor-initiated way to attach the
 * CURRENT website page (title + pathname ONLY) to a Sukhan chat message.
 *
 * Privacy contract — the ONLY permitted visitor-provided fields are:
 *   - `pathname`: a relative URL pathname (window.location.pathname)
 *   - `title`: the page title (document.title)
 *
 * NEVER transmitted (and therefore NEVER accepted here):
 *   - Full URL / origin / protocol / host
 *   - Query strings or URL fragments/hashes
 *   - Cookies, localStorage, sessionStorage
 *   - Authentication credentials
 *   - Form values, page HTML/DOM, arbitrary page text, hidden content,
 *     script code
 *
 * Validation is STRICT on both the browser capture boundary and the server
 * persistence boundary (defense-in-depth — the server NEVER trusts the
 * client's pre-validation):
 *   - Only a PLAIN object (prototype Object.prototype or null) with EXACTLY
 *     the two own DATA properties `pathname` + `title`.
 *   - Accessor-backed values are rejected WITHOUT executing the getters
 *     (descriptor inspection only).
 *   - Symbol keys and unknown keys are rejected.
 *   - Title: nonempty single-line string, no control characters, no
 *     leading/trailing whitespace, at most 120 Unicode code points, and no
 *     angle brackets (BETA strictness — markup-like text is rejected rather
 *     than relying on downstream escaping).
 *   - Pathname: begins with exactly one `/` (never protocol-relative),
 *     relative only (no scheme/host), no query (`?`), no fragment (`#`),
 *     no backslash, no control characters, bounded to 240 characters, and
 *     no percent-encoded control-character/`?`/`#`/`\` injection (the
 *     decoded form is checked).
 *
 * Page context is USER-CONTROLLED information, NOT authenticated proof of
 * which page the visitor visited. It is informational metadata for agents.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for the
 * NPM widget / browser bundle to import.
 */

/** The sanitized visitor page context attached to a message. */
export interface PageContext {
  /** Relative URL pathname (starts with a single `/`, no query/hash). */
  pathname: string
  /** Sanitized page title (single line, ≤120 code points). */
  title: string
}

/** Maximum pathname length in UTF-16 code units. */
export const PAGE_CONTEXT_PATHNAME_MAX = 240
/** Maximum title length in Unicode code points. */
export const PAGE_CONTEXT_TITLE_MAX_CODEPOINTS = 120

/**
 * True when a character code is a C0/C1 control character or DEL.
 * C0: U+0000–U+001F, DEL: U+007F, C1: U+0080–U+009F.
 */
function isControlCode(code: number): boolean {
  return (code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
}

/**
 * True for Unicode line/paragraph separators that make a string multi-line
 * (JS regex `\s` matches them, but they are not C0/C1 control characters).
 */
function isLineSeparator(code: number): boolean {
  return code === 0x2028 || code === 0x2029
}

/**
 * Validate + sanitize a candidate page title.
 * Returns null when the title violates any bound (fail closed).
 */
function sanitizeTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null
  // Nonempty + no leading/trailing whitespace (trim() covers the full
  // JS whitespace set including NBSP/BOM).
  if (title.length === 0 || title !== title.trim()) return null
  // Single line, no control characters, no line/paragraph separators.
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i)
    if (isControlCode(code) || isLineSeparator(code)) return null
  }
  // BETA strictness: reject angle brackets outright — markup-like text is
  // never persisted, so downstream renderers cannot be tricked by it.
  if (title.includes('<') || title.includes('>')) return null
  // Bounded to 120 Unicode code points (surrogate pairs count as ONE).
  if (Array.from(title).length > PAGE_CONTEXT_TITLE_MAX_CODEPOINTS) return null
  return title
}

/**
 * Validate + sanitize a candidate URL pathname.
 * Returns null when the pathname violates any bound (fail closed).
 */
function sanitizePathname(pathname: unknown): string | null {
  if (typeof pathname !== 'string') return null
  if (pathname.length === 0 || pathname.length > PAGE_CONTEXT_PATHNAME_MAX) return null
  // Must begin with exactly one '/' — never protocol-relative ('//host')
  // and never a scheme ('javascript:', 'https://…').
  if (pathname.charAt(0) !== '/') return null
  if (pathname.charAt(1) === '/') return null
  // No query, no fragment, no backslash (Windows-style/escaped path tricks).
  if (pathname.includes('?') || pathname.includes('#') || pathname.includes('\\')) return null
  // No raw whitespace (browsers percent-encode spaces in location.pathname,
  // so a raw space is anomalous) + no raw control characters.
  for (let i = 0; i < pathname.length; i++) {
    const code = pathname.charCodeAt(i)
    if (isControlCode(code)) return null
    const ch = pathname.charAt(i)
    if (ch === ' ' || ch === '\t') return null
  }
  // Percent-encoded injection: decode the (valid) percent-sequences and
  // reject when the DECODED form contains control characters, `?`, `#` or
  // `\`. Malformed percent-encoding (a bare `%` not followed by two hex
  // digits) also fails closed — location.pathname is always well-formed.
  if (pathname.includes('%')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i)
      if (isControlCode(code) || isLineSeparator(code)) return null
      const ch = decoded.charAt(i)
      if (ch === '?' || ch === '#' || ch === '\\') return null
    }
  }
  return pathname
}

/**
 * Validate a Context Chat config object (`{ enabled: boolean }` exactly).
 * Uses safe own-property descriptor inspection to avoid executing getters.
 */
export function isValidContextChatConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== 1) return false
    if (ownKeys[0] !== 'enabled') return false
    const desc = Object.getOwnPropertyDescriptor(value, 'enabled')
    if (!desc || !('value' in desc)) return false // accessor — reject
    return typeof desc.value === 'boolean'
  } catch {
    return false
  }
}

/**
 * Strictly validate + sanitize a visitor-supplied page context.
 *
 * Accepts ONLY a plain object with exactly the two own DATA properties
 * `pathname` + `title` (descriptor-read — getters are NEVER executed).
 * Returns a CANONICAL plain copy, or null for anything malformed,
 * non-plain, accessor-backed, symbol-keyed, or out of bounds. Never throws.
 */
export function sanitizePageContext(value: unknown): PageContext | null {
  if (value === null || value === undefined) return null
  // Plain object only — reject arrays, Date/Map/Set, class instances.
  if (typeof value !== 'object') return null
  let proto: unknown
  try {
    if (Array.isArray(value)) return null
    proto = Object.getPrototypeOf(value)
  } catch {
    return null
  }
  if (proto !== Object.prototype && proto !== null) return null

  // Exactly the two expected keys — no unknown keys, no missing keys,
  // no Symbol keys, no non-enumerable surprises.
  let keys: (string | symbol)[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return null
  }
  if (keys.length !== 2) return null
  let hasPathname = false
  let hasTitle = false
  for (const key of keys) {
    if (key === 'pathname') hasPathname = true
    else if (key === 'title') hasTitle = true
    else return null
  }
  if (!hasPathname || !hasTitle) return null

  // Read BOTH values from own DATA descriptors — an accessor is rejected
  // without ever invoking the getter (no side effects, no exceptions).
  let pathnameDesc: { value: unknown } | null
  let titleDesc: { value: unknown } | null
  try {
    const pd = Object.getOwnPropertyDescriptor(value, 'pathname')
    pathnameDesc = pd && 'value' in pd ? (pd as { value: unknown }) : null
    const td = Object.getOwnPropertyDescriptor(value, 'title')
    titleDesc = td && 'value' in td ? (td as { value: unknown }) : null
  } catch {
    return null
  }
  if (!pathnameDesc || !titleDesc) return null

  const pathname = sanitizePathname(pathnameDesc.value)
  if (pathname === null) return null
  const title = sanitizeTitle(titleDesc.value)
  if (title === null) return null

  // Canonical copy — callers never hold the raw input object.
  return { pathname, title }
}

/**
 * Server-boundary acceptance of a page context on a visitor message POST.
 *
 * - The effective Context Chat configuration must be ENABLED (server-side
 *   resolution — never client-controlled). Otherwise ANY supplied context
 *   is dropped (null), including forged payloads from Free tenants.
 * - A context is attached ONLY when explicitly supplied with the send;
 *   undefined/null never yields a context (no automatic scraping).
 *
 * Returns the sanitized PageContext or null. Never throws.
 */
export function acceptPageContext(value: unknown, enabled: boolean): PageContext | null {
  if (!enabled) return null
  return sanitizePageContext(value)
}
