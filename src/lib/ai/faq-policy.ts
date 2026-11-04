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
 * - Unicode NFC canonical composition FIRST — so a decomposed ALEF + MADDA
 *   ABOVE (U+0627 + U+0653) and the pre-composed ALEF WITH MADDA ABOVE
 *   (U+0622) canonicalize to the same character. Meaningful diacritics
 *   like kasra (U+0650) do NOT compose away under NFC — they are preserved.
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
 * are preserved — NFC does not compose them away).
 *
 * ## Exact-match ambiguity (BLOCKER 2)
 *
 * `resolveExactFaq` detects canonical duplicates among ALL supplied eligible
 * FAQ rows BEFORE evaluating deliverability. Two or more rows with the same
 * canonical question → `ambiguous`, regardless of answer content or row
 * order. A single canonical match with a blank answer → `none`. A single
 * match with an empty/invalid ID → `none` (never deliverable). Never mutates
 * source FAQ records. Never chooses an arbitrary database row.
 *
 * ## Semantic candidate partitioning (BLOCKER 3)
 *
 * `selectUnambiguousFaqs` groups FAQ pairs by canonical question. Groups
 * with 2+ members (contradictory or duplicate canonical questions) are
 * EXCLUDED entirely from semantic classification — an ambiguous ID can
 * never be selected by the model, even with confidence 1. Only
 * single-member groups with a non-empty ID and a nonblank answer remain
 * eligible. If no unambiguous candidate remains, `matchFaq` returns a safe
 * negative WITHOUT calling the provider.
 *
 * ## Semantic confidence gate
 *
 * `FAQ_CONFIDENCE_THRESHOLD = 0.7` — a semantic match requires:
 *   1. Parsed output is a non-null, non-array object.
 *   2. `matched === true` (strictly boolean).
 *   3. `id` is an exact string member of the supplied UNAMBIGUOUS list.
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
  // Unicode NFC canonical composition FIRST. This unifies visually identical
  // representations: e.g. decomposed ALEF (U+0627) + MADDA ABOVE (U+0653)
  // composes to pre-composed ALEF WITH MADDA ABOVE (U+0622). Meaningful
  // diacritics like kasra (U+0650) are preserved — NFC does not compose them
  // away. NFC is itself idempotent, so re-normalizing an NFC string is a
  // no-op.
  let s = input.normalize('NFC')

  // 2. Persian ZWNJ (U+200C) → regular space.
  s = s.replace(/\u200C/g, ' ')

  // 3. NBSP (U+00A0) and tabs → regular space.
  s = s.replace(/[\u00A0\t]/g, ' ')

  // 4. Arabic Yeh (U+064A) → Persian Yeh (U+06CC).
  s = s.replace(/\u064A/g, '\u06CC')

  // 5. Arabic Kaf (U+0643) → Persian Kaf (U+06A9).
  s = s.replace(/\u0643/g, '\u06A9')

  // 6. Collapse repeated whitespace into single spaces.
  s = s.replace(/\s+/g, ' ')

  // 7. Trim leading/trailing whitespace.
  s = s.trim()

  // 8. English case-folding (lowercase) — applied after trim so it doesn't
  //    affect whitespace handling. This affects ASCII A-Z only; Persian and
  //    Arabic characters are unaffected.
  s = s.toLowerCase()

  // 9. Strip equivalent trailing question marks (both Latin `?` and
  //    Arabic/Persian `؟`) — ONLY at the very end, after all other
  //    normalization. Internal question marks (meaningful) are preserved.
  s = s.replace(/[?؟]+$/, '')

  // 10. Final trim (in case stripping trailing marks left trailing space).
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
 * BLOCKER 2: canonical duplicates are detected among ALL supplied eligible
 * FAQ rows BEFORE evaluating deliverability. A row with a blank answer or
 * an empty ID still counts toward canonical-duplicate detection — it is a
 * persisted FAQ row claiming that question, so two such rows are ambiguous
 * regardless of answer content or row order.
 *
 * Returns:
 * - `matched` — exactly ONE FAQ row canonicalizes to the visitor message,
 *   has a non-empty string ID, AND has a nonblank stored answer. The
 *   persisted ID and owner-authored answer are returned verbatim.
 * - `ambiguous` — two or more FAQ rows canonicalize to the same question
 *   as the visitor message, regardless of answer content or row order.
 *   Never selects an arbitrary row, never bills.
 * - `none` — no FAQ matches; OR the single matching row has a blank answer;
 *   OR the single matching row has an empty/invalid ID (never deliverable).
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

  // Collect ALL FAQ rows whose canonical question equals the canonical
  // visitor message, regardless of ID validity or answer content. A row
  // with a blank answer or an empty ID is still a persisted FAQ row
  // claiming that question — it counts toward canonical-duplicate
  // detection (BLOCKER 2). This prevents a blank-answer row from being
  // silently filtered out before the duplicate check, which would
  // incorrectly produce a positive answer from a neighboring duplicate.
  const matchingGroup: Array<{ id: string; answer: string }> = []
  for (const faq of faqPairs) {
    if (faq === null || typeof faq !== 'object') continue
    if (typeof faq.question !== 'string') continue
    const canonicalQuestion = normalizeFaqQuestion(faq.question)
    if (canonicalQuestion !== canonicalVisitor) continue
    const id = typeof faq.id === 'string' ? faq.id : ''
    const answer = typeof faq.answer === 'string' ? faq.answer : ''
    matchingGroup.push({ id, answer })
  }

  if (matchingGroup.length === 0) {
    return { status: 'none', faqPairId: null, answer: null }
  }

  if (matchingGroup.length > 1) {
    // Multiple canonical duplicates → ambiguous. Never first-row-wins,
    // never semantic classification to guess, never a charge.
    return { status: 'ambiguous', faqPairId: null, answer: null }
  }

  // Exactly one row matches the canonical question. Check deliverability:
  // the ID must be a non-empty string (an empty/invalid ID is never a
  // deliverable source), and the answer must be nonblank.
  const only = matchingGroup[0]
  if (!only.id) {
    return { status: 'none', faqPairId: null, answer: null }
  }
  if (!only.answer.trim()) {
    return { status: 'none', faqPairId: null, answer: null }
  }

  return { status: 'matched', faqPairId: only.id, answer: only.answer }
}

// ---------------------------------------------------------------------------
// Semantic candidate partitioning (BLOCKER 3)
// ---------------------------------------------------------------------------

/**
 * Partition FAQ pairs into unambiguous semantic candidates (BLOCKER 3).
 *
 * Groups FAQ pairs by canonical question. A group with 2+ members
 * (contradictory or duplicate canonical questions) is AMBIGUOUS — ALL its
 * members are excluded from semantic matching. The model can never select
 * an ambiguous ID, even with confidence 1. A group with exactly 1 member is
 * unambiguous — but it is included ONLY if it has a non-empty string ID and
 * a nonblank stored answer (otherwise it cannot be delivered).
 *
 * Returns the list of unambiguous, deliverable FAQ candidates suitable for
 * semantic classification. Never mutates the input array or its objects.
 *
 * If the returned list is empty, `matchFaq` MUST return a safe negative
 * WITHOUT calling the provider (BLOCKER 3, point 5).
 */
export function selectUnambiguousFaqs(
  faqPairs: ReadonlyArray<{ id: string; question: string; answer: string }>,
): Array<{ id: string; question: string; answer: string }> {
  // Group by canonical question. Preserve original object shape (no
  // mutation of source records).
  const groups = new Map<string, Array<{ id: string; question: string; answer: string }>>()
  for (const faq of faqPairs) {
    if (faq === null || typeof faq !== 'object') continue
    if (typeof faq.id !== 'string' || typeof faq.question !== 'string' || typeof faq.answer !== 'string') continue
    const canonical = normalizeFaqQuestion(faq.question)
    if (!canonical) continue
    let group = groups.get(canonical)
    if (!group) {
      group = []
      groups.set(canonical, group)
    }
    group.push({ id: faq.id, question: faq.question, answer: faq.answer })
  }

  const result: Array<{ id: string; question: string; answer: string }> = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0]
      // Include only if ID is non-empty AND answer is nonblank — a
      // blank-answer or empty-ID single row cannot be delivered.
      if (only.id && only.answer.trim()) {
        result.push(only)
      }
    }
    // group.length > 1 → ambiguous, exclude ALL members.
  }
  return result
}

// ---------------------------------------------------------------------------
// Semantic confidence validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed semantic model output against the strict AI-Q3 gate.
 *
 * The `faqPairs` argument MUST be the UNAMBIGUOUS candidate list (output of
 * `selectUnambiguousFaqs`). An ambiguous ID can never pass this check
 * because it is not a member of the supplied list.
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
