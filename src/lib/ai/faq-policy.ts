/**
 * AI-Q3 — Strict FAQ confidence gating and deterministic exact matching.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for Unit
 * testing and server-side import.
 *
 * ## Exact-match normalization
 *
 * `normalizeFaqQuestion` produces a canonical form that treats equivalent
 * Persian/Arabic and English orthographic variants as identical, while
 * NEVER discarding meaningful distinctions:
 *
 * - Leading/trailing whitespace removal + repeated whitespace collapse.
 * - Persian ZWNJ (U+200C) → regular space (and vice versa — both become space).
 * - NBSP (U+00A0) and tabs → regular space.
 * - Arabic Yeh (U+064A ي) → Persian Yeh (U+06CC ی).
 * - Arabic Kaf (U+0643 ك) → Persian Kaf (U+06A9 ک).
 * - English case-folding (lowercase).
 * - Equivalent trailing `?` (Latin) and `؟` (Arabic/Persian) → both stripped
 *   ONLY at the very end (after all other normalization).
 *
 * Never touched: negation particles, numbers, decimal points, percentages,
 * word order, meaningful internal punctuation, diacritics (kasra/damma etc.
 * are preserved — they carry meaning in some contexts).
 *
 * ## Exact-match ambiguity
 *
 * `resolveExactFaq` returns `ambiguous` when multiple eligible FAQs
 * canonicalize to the same question — regardless of answer equality. An
 * ambiguous exact match never selects an arbitrary row, never invokes
 * semantic classification, and never produces a charge.
 *
 * ## Semantic confidence gate
 *
 * `FAQ_CONFIDENCE_THRESHOLD = 0.7` — a semantic match requires:
 *   1. Parsed output is a non-null, non-array object.
 *   2. `matched === true` (strictly boolean).
 *   3. `id` is an exact string member of the supplied list.
 *   4. `confidence` is a finite number (typeof === 'number').
 *   5. `confidence >= 0.7 && confidence <= 1`.
 *   6. The stored answer is nonblank.
 *
 * No default confidence. No coercion. No clamping invalid scores into
 * acceptance. Boundary 0.7 qualifies; 0.699999 does not.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FAQ_CONFIDENCE_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a FAQ question (or visitor message) into a canonical form for
 * deterministic exact matching.
 *
 * Deterministic and idempotent: normalizeFaqQuestion(normalizeFaqQuestion(x))
 * === normalizeFaqQuestion(x).
 */
export function normalizeFaqQuestion(input: string): string {
  if (typeof input !== 'string') return ''
  let s = input

  // 1. Persian ZWNJ (U+200C) → regular space.
  s = s.replace(/\u200C/g, ' ')

  // 2. NBSP (U+00A0) and tabs → regular space.
  s = s.replace(/[\u00A0\t]/g, ' ')

  // 3. Arabic Yeh (U+064A) → Persian Yeh (U+06CC).
  s = s.replace(/\u064A/g, '\u06CC')

  // 4. Arabic Kaf (U+0643) → Persian Kaf (U+06A9).
  s = s.replace(/\u0643/g, '\u06A9')

  // 5. Collapse repeated whitespace into single spaces.
  s = s.replace(/\s+/g, ' ')

  // 6. Trim leading/trailing whitespace.
  s = s.trim()

  // 7. English case-folding (lowercase) — applied after trim so it doesn't
  //    affect whitespace handling. This affects ASCII A-Z only; Persian and
  //    Arabic characters are unaffected.
  s = s.toLowerCase()

  // 8. Strip equivalent trailing question marks (both Latin `?` and
  //    Arabic/Persian `؟`) — ONLY at the very end, after all other
  //    normalization. Internal question marks (meaningful) are preserved.
  s = s.replace(/[?؟]+$/, '')

  // 9. Final trim (in case stripping trailing marks left trailing space).
  s = s.trim()

  return s
}

// ---------------------------------------------------------------------------
// Exact-match resolver
// ---------------------------------------------------------------------------

export type ExactFaqResult =
  | { status: 'matched'; faqPairId: string; answer: string }
  | { status: 'none'; faqPairId: null; answer: null }
  | { status: 'ambiguous'; faqPairId: null; answer: null }

/**
 * Resolve a visitor message against a list of eligible FAQ pairs using
 * deterministic exact matching.
 *
 * Returns:
 * - `matched` — exactly one FAQ canonicalizes to the visitor message AND
 *   has a nonblank stored answer. The persisted ID and owner-authored
 *   answer are returned verbatim.
 * - `ambiguous` — multiple FAQs canonicalize to the same question. Never
 *   selects an arbitrary row, never bills.
 * - `none` — no FAQ matches, or the matching FAQ has a blank answer.
 *
 * Never mutates the input array or its objects.
 */
export function resolveExactFaq(
  visitorMessage: string,
  faqPairs: ReadonlyArray<{ id: string; question: string; answer: string }>,
): ExactFaqResult {
  if (typeof visitorMessage !== 'string' || faqPairs.length === 0) {
    return { status: 'none', faqPairId: null, answer: null }
  }

  const canonicalVisitor = normalizeFaqQuestion(visitorMessage)
  if (!canonicalVisitor) {
    return { status: 'none', faqPairId: null, answer: null }
  }

  // Find ALL FAQs whose canonical question equals the canonical visitor
  // message AND whose answer is nonblank (deliverable).
  const matches: Array<{ id: string; answer: string }> = []
  for (const faq of faqPairs) {
    if (typeof faq.id !== 'string' || typeof faq.question !== 'string' || typeof faq.answer !== 'string') {
      continue
    }
    const canonicalQuestion = normalizeFaqQuestion(faq.question)
    if (canonicalQuestion === canonicalVisitor && faq.answer.trim()) {
      matches.push({ id: faq.id, answer: faq.answer })
    }
  }

  if (matches.length === 0) {
    return { status: 'none', faqPairId: null, answer: null }
  }

  if (matches.length > 1) {
    // Multiple canonical duplicates → ambiguous. Never first-row-wins,
    // never semantic classification to guess, never a charge.
    return { status: 'ambiguous', faqPairId: null, answer: null }
  }

  // Exactly one deliverable match.
  return { status: 'matched', faqPairId: matches[0].id, answer: matches[0].answer }
}

// ---------------------------------------------------------------------------
// Semantic confidence validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed semantic model output against the strict AI-Q3 gate.
 *
 * Returns the matched FAQ pair + confidence if ALL conditions hold:
 *   1. `parsed` is a non-null, non-array object.
 *   2. `parsed.matched === true` (strictly boolean).
 *   3. `parsed.id` is a string that exactly identifies a supplied FAQ.
 *   4. `parsed.confidence` is typeof 'number' and Number.isFinite.
 *   5. `confidence >= FAQ_CONFIDENCE_THRESHOLD && confidence <= 1`.
 *   6. The FAQ's stored answer is nonblank.
 *
 * Returns null if any condition fails. No defaults. No coercion.
 */
export function validateSemanticMatch(
  parsed: unknown,
  faqPairs: ReadonlyArray<{ id: string; question: string; answer: string }>,
): { faqPair: { id: string; answer: string }; confidence: number } | null {
  // 1. Must be a non-null, non-array object.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const obj = parsed as Record<string, unknown>

  // 2. matched must be strictly boolean true.
  if (obj.matched !== true) return null

  // 3. id must be a string.
  if (typeof obj.id !== 'string') return null

  // 4+5. confidence must be an actual finite number in [threshold, 1].
  if (typeof obj.confidence !== 'number') return null
  if (!Number.isFinite(obj.confidence)) return null
  if (obj.confidence < FAQ_CONFIDENCE_THRESHOLD) return null
  if (obj.confidence > 1) return null

  // 6. The ID must exactly identify a supplied eligible FAQ.
  const faq = faqPairs.find(f => f.id === obj.id)
  if (!faq) return null

  // 7. The stored answer must be nonblank.
  if (typeof faq.answer !== 'string' || !faq.answer.trim()) return null

  return { faqPair: { id: faq.id, answer: faq.answer }, confidence: obj.confidence }
}
