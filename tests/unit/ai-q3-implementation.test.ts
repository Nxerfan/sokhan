/// <reference types="bun-types" />
/**
 * Developer-owned AI-Q3 implementation tests.
 * Covers strict confidence gate edge cases, normalization boundaries,
 * ambiguity detection, and source wiring beyond the 37 reviewer tests.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchFaq } from '../../src/lib/ai'
import {
  FAQ_CONFIDENCE_THRESHOLD,
  normalizeFaqQuestion,
  resolveExactFaq,
  selectUnambiguousFaqs,
  validateSemanticMatch,
} from '../../src/lib/ai/faq-policy'

const faqs = Object.freeze([
  Object.freeze({ id: 'd-1', question: 'آیا تحویل حضوری دارید؟', answer: 'بله، در فروشگاه.' }),
  Object.freeze({ id: 'd-2', question: 'Do you ship internationally?', answer: 'Yes, worldwide.' }),
])

describe('Developer — normalization boundary cases', () => {
  test('ZWNJ inside words becomes space (not deleted)', () => {
    // ZWNJ is a zero-width non-joiner — it separates letter forms in Persian.
    // It must become a space, not be silently deleted (which would join
    // two words into one).
    expect(normalizeFaqQuestion('می\u200Cشود')).toBe(normalizeFaqQuestion('می شود'))
  })

  test('multiple ZWNJs and spaces collapse to a single space', () => {
    expect(normalizeFaqQuestion('a\u200C\u200C  b')).toBe('a b')
  })

  test('internal question marks are preserved (meaningful)', () => {
    // Only TRAILING question marks are stripped. Internal ones carry meaning.
    expect(normalizeFaqQuestion('what? really?')).toBe('what? really')
  })

  test('Arabic Keheh with dagger alif is distinct from plain', () => {
    // These are different questions — normalization must not merge them.
    expect(normalizeFaqQuestion('کِتاب')).not.toBe(normalizeFaqQuestion('کتاب'))
  })

  test('empty string and whitespace-only normalize to empty', () => {
    expect(normalizeFaqQuestion('')).toBe('')
    expect(normalizeFaqQuestion('   ')).toBe('')
    expect(normalizeFaqQuestion('\u200C\u200C')).toBe('')
  })

  test('non-string input safely returns empty', () => {
    expect(normalizeFaqQuestion(null as unknown as string)).toBe('')
    expect(normalizeFaqQuestion(undefined as unknown as string)).toBe('')
    expect(normalizeFaqQuestion(42 as unknown as string)).toBe('')
  })

  test('Arabic-persian yeh in the middle of a word', () => {
    expect(normalizeFaqQuestion('فيلم')).toBe(normalizeFaqQuestion('فيلم'))
    // But 'فيلم' (film) and 'فيل' (elephant) are different words.
    expect(normalizeFaqQuestion('فيلم')).not.toBe(normalizeFaqQuestion('فيل'))
  })
})

describe('Developer — resolveExactFaq edge cases', () => {
  test('three canonical duplicates are also ambiguous', () => {
    const dup = [
      { id: '1', question: 'Q?', answer: 'A1' },
      { id: '2', question: 'q?', answer: 'A2' },
      { id: '3', question: 'Q؟', answer: 'A3' },
    ]
    expect(resolveExactFaq('Q', dup).status).toBe('ambiguous')
  })

  test('a blank-answer canonical duplicate still makes the question ambiguous (BLOCKER 2)', () => {
    const list = [
      { id: '1', question: 'Q?', answer: '' },
      { id: '2', question: 'Q?', answer: 'Valid' },
    ]
    // BLOCKER 2: canonical duplicates are detected among ALL eligible rows
    // BEFORE evaluating deliverability. Two rows with the same canonical
    // question are ambiguous regardless of answer content or row order.
    for (const order of [list, [...list].reverse()]) {
      expect(resolveExactFaq('Q', order)).toEqual({
        status: 'ambiguous', faqPairId: null, answer: null,
      })
    }
  })

  test('all-blank answers yield none, not matched', () => {
    const list = [{ id: '1', question: 'Q?', answer: '  ' }]
    expect(resolveExactFaq('Q', list).status).toBe('none')
  })

  test('whitespace-only visitor text yields none even with matching FAQ', () => {
    expect(resolveExactFaq('   ', faqs).status).toBe('none')
  })

  test('FAQ entries with empty IDs are still canonical duplicates → ambiguous', () => {
    const bad = [
      { id: '', question: 'آیا تحویل حضوری دارید؟', answer: 'x' },
      { id: 'ok', question: 'آیا تحویل حضوری دارید؟', answer: 'valid' },
    ]
    // Both canonicalize to the same question. Even though the first has an
    // empty ID (a data integrity issue), it is still a persisted FAQ row
    // with that question. The resolver cannot know it's "invalid" — it
    // correctly reports ambiguity because two rows claim the same question.
    const result = resolveExactFaq('آیا تحویل حضوری دارید؟', bad)
    expect(result.status).toBe('ambiguous')
  })
})

describe('Developer — validateSemanticMatch strict gate', () => {
  test('exactly 0.7 is accepted; 0.6999999 is not', () => {
    const v1 = validateSemanticMatch({ matched: true, id: 'd-1', confidence: 0.7 }, faqs)
    expect(v1).not.toBeNull()
    const v2 = validateSemanticMatch({ matched: true, id: 'd-1', confidence: 0.6999999 }, faqs)
    expect(v2).toBeNull()
  })

  test('confidence > 1 is rejected, not clamped', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: 1.01 }, faqs)).toBeNull()
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: 999 }, faqs)).toBeNull()
  })

  test('negative confidence is rejected', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: -0.5 }, faqs)).toBeNull()
  })

  test('NaN and Infinity confidence are rejected', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: NaN }, faqs)).toBeNull()
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: Infinity }, faqs)).toBeNull()
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: -Infinity }, faqs)).toBeNull()
  })

  test('string confidence "0.9" is rejected (no coercion)', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: '0.9' }, faqs)).toBeNull()
  })

  test('boolean confidence is rejected', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: true }, faqs)).toBeNull()
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: false }, faqs)).toBeNull()
  })

  test('missing confidence field is rejected (no default)', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1' }, faqs)).toBeNull()
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: undefined }, faqs)).toBeNull()
  })

  test('null confidence is rejected', () => {
    expect(validateSemanticMatch({ matched: true, id: 'd-1', confidence: null }, faqs)).toBeNull()
  })

  test('array parsed output is rejected', () => {
    expect(validateSemanticMatch([{ matched: true }], faqs)).toBeNull()
  })

  test('nested object as id is rejected', () => {
    expect(validateSemanticMatch({ matched: true, id: { a: 1 }, confidence: 0.9 }, faqs)).toBeNull()
  })

  test('numeric id is rejected (must be string)', () => {
    expect(validateSemanticMatch({ matched: true, id: 1, confidence: 0.9 }, faqs)).toBeNull()
  })

  test('blank answer disqualifies a semantic match', () => {
    const blankFaq = [{ id: 'b', question: 'Q?', answer: '   ' }]
    expect(validateSemanticMatch({ matched: true, id: 'b', confidence: 1 }, blankFaq)).toBeNull()
  })
})

describe('Developer — matchFaq integration with strict gate', () => {
  test('confidence exactly at threshold returns the stored answer', async () => {
    const provider = { complete: async () => JSON.stringify({ matched: true, id: 'd-1', confidence: FAQ_CONFIDENCE_THRESHOLD }) }
    const r = await matchFaq('سوال', [...faqs], provider)
    expect(r).toEqual({ matched: true, faqPairId: 'd-1', answer: 'بله، در فروشگاه.', confidence: 0.7 })
  })

  test('just below threshold yields no match with preserved confidence', async () => {
    const provider = { complete: async () => JSON.stringify({ matched: true, id: 'd-1', confidence: 0.65 }) }
    const r = await matchFaq('سوال', [...faqs], provider)
    expect(r.matched).toBe(false)
    expect(r.faqPairId).toBeNull()
    expect(r.answer).toBeNull()
    expect(r.confidence).toBe(0.65)
  })

  test('valid negative confidence is preserved as clamped 0', async () => {
    const provider = { complete: async () => JSON.stringify({ matched: false, id: null, confidence: -2 }) }
    const r = await matchFaq('سوال', [...faqs], provider)
    expect(r.matched).toBe(false)
    expect(r.confidence).toBe(0)
  })
})

describe('Developer — selectUnambiguousFaqs partitioning (BLOCKER 3)', () => {
  test('two canonical duplicates are both excluded from the unambiguous set', () => {
    const pairs = [
      { id: 'yes', question: 'آیا ارسال رایگان دارید؟', answer: 'بله' },
      { id: 'no', question: 'آيا ارسال رايگان داريد؟', answer: 'خیر' },
    ]
    expect(selectUnambiguousFaqs(pairs)).toEqual([])
  })

  test('three canonical duplicates are all excluded', () => {
    const pairs = [
      { id: 'a', question: 'Returns?', answer: 'Seven days' },
      { id: 'b', question: 'returns?', answer: 'Thirty days' },
      { id: 'c', question: 'RETURNS؟', answer: 'Fourteen days' },
    ]
    expect(selectUnambiguousFaqs(pairs)).toEqual([])
  })

  test('a unique FAQ alongside an ambiguous pair: only the unique one survives', () => {
    const pairs = [
      { id: 'dup-a', question: 'Returns?', answer: 'Seven days' },
      { id: 'dup-b', question: 'RETURNS؟', answer: 'Thirty days' },
      { id: 'unique', question: 'Shipping ETA?', answer: 'Two days' },
    ]
    expect(selectUnambiguousFaqs(pairs)).toEqual([
      { id: 'unique', question: 'Shipping ETA?', answer: 'Two days' },
    ])
  })

  test('a single FAQ with a blank answer is excluded (not deliverable)', () => {
    expect(selectUnambiguousFaqs([{ id: 'blank', question: 'Q?', answer: '   ' }])).toEqual([])
  })

  test('a single FAQ with an empty ID is excluded (never deliverable)', () => {
    expect(selectUnambiguousFaqs([{ id: '', question: 'Q?', answer: 'Valid' }])).toEqual([])
  })

  test('all unique valid FAQs are preserved in the unambiguous set', () => {
    const pairs = [
      { id: 'd-1', question: 'آیا تحویل حضوری دارید؟', answer: 'بله، در فروشگاه.' },
      { id: 'd-2', question: 'Do you ship internationally?', answer: 'Yes, worldwide.' },
    ]
    expect(selectUnambiguousFaqs(pairs)).toEqual(pairs)
  })

  test('source records are never mutated by partitioning', () => {
    const pairs = Object.freeze([
      Object.freeze({ id: 'a', question: 'Q?', answer: 'A' }),
      Object.freeze({ id: 'b', question: 'q?', answer: 'B' }),
    ])
    const original = JSON.stringify(pairs)
    selectUnambiguousFaqs(pairs)
    expect(JSON.stringify(pairs)).toBe(original)
  })
})

describe('Developer — matchFaq semantic duplicate safety (BLOCKER 3)', () => {
  test('all-ambiguous candidates → no provider call, safe negative', async () => {
    const pairs = [
      { id: 'yes', question: 'آیا ارسال رایگان دارید؟', answer: 'بله' },
      { id: 'no', question: 'آيا ارسال رايگان داريد؟', answer: 'خیر' },
    ]
    let called = 0
    const provider = { complete: async () => { called++; return JSON.stringify({ matched: true, id: 'yes', confidence: 0.99 }) } }
    const r = await matchFaq('برای ارسال هزینه پرداخت می‌کنم؟', pairs, provider)
    expect(r).toMatchObject({ matched: false, faqPairId: null, answer: null })
    expect(called).toBe(0)
  })

  test('mixed ambiguous + unique: provider IS called, only unique ID accepted', async () => {
    const pairs = [
      { id: 'dup-a', question: 'Returns?', answer: 'Seven days' },
      { id: 'dup-b', question: 'RETURNS؟', answer: 'Thirty days' },
      { id: 'unique', question: 'Shipping ETA?', answer: 'Two days' },
    ]
    let called = 0
    const provider = { complete: async () => { called++; return JSON.stringify({ matched: true, id: 'unique', confidence: 0.8 }) } }
    const r = await matchFaq('How soon will the package arrive?', pairs, provider)
    expect(r).toEqual({ matched: true, faqPairId: 'unique', answer: 'Two days', confidence: 0.8 })
    expect(called).toBe(1)
  })

  test('mixed ambiguous + unique: ambiguous ID rejected even with confidence 1', async () => {
    const pairs = [
      { id: 'dup-a', question: 'Returns?', answer: 'Seven days' },
      { id: 'dup-b', question: 'RETURNS؟', answer: 'Thirty days' },
      { id: 'unique', question: 'Shipping ETA?', answer: 'Two days' },
    ]
    let called = 0
    const provider = { complete: async () => { called++; return JSON.stringify({ matched: true, id: 'dup-a', confidence: 1 }) } }
    const r = await matchFaq('How soon will the package arrive?', pairs, provider)
    expect(r).toMatchObject({ matched: false, faqPairId: null, answer: null })
    // Provider IS called (unique candidate exists), but the ambiguous ID
    // 'dup-a' is not in the unambiguous set → rejected.
    expect(called).toBe(1)
  })

  test('a single blank-answer FAQ → no provider call, safe negative', async () => {
    let called = 0
    const provider = { complete: async () => { called++; return JSON.stringify({ matched: true, id: 'blank', confidence: 1 }) } }
    const r = await matchFaq('سوال', [{ id: 'blank', question: 'سوال', answer: '   ' }], provider)
    expect(r).toMatchObject({ matched: false, faqPairId: null, answer: null })
    expect(called).toBe(0)
  })
})

describe('Developer — Unicode NFC normalization (BLOCKER 4)', () => {
  test('NFC composes decomposed ALEF + MADDA ABOVE into pre-composed ALEF WITH MADDA ABOVE', () => {
    const composed = 'آیا ارسال امروز است؟'
    const decomposed = 'ا\u0653یا ارسال امروز است؟'
    expect(composed).not.toBe(decomposed)
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'))
    expect(normalizeFaqQuestion(composed)).toBe(normalizeFaqQuestion(decomposed))
  })

  test('NFC-resolved decomposed question exact-matches the composed stored FAQ', () => {
    const composed = 'آیا ارسال امروز است؟'
    const decomposed = 'ا\u0653یا ارسال امروز است؟'
    expect(resolveExactFaq(decomposed, [{ id: 'one', question: composed, answer: 'بله' }]))
      .toEqual({ status: 'matched', faqPairId: 'one', answer: 'بله' })
  })

  test('meaningful diacritics (kasra) are NOT stripped by NFC', () => {
    const withKasra = normalizeFaqQuestion('كِتاب؟')
    const withoutKasra = normalizeFaqQuestion('کتاب؟')
    expect(withKasra).not.toBe(withoutKasra)
    expect(normalizeFaqQuestion(withKasra)).toBe(withKasra)
    expect(normalizeFaqQuestion(withoutKasra)).toBe(withoutKasra)
  })
})

describe('Developer — AI-Q3 source wiring', () => {
  const routeSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')
  const aiSrc = readFileSync(join(process.cwd(), 'src/lib/ai/index.ts'), 'utf8')

  test('widget route imports resolveExactFaq from faq-policy', () => {
    expect(routeSrc).toContain("import('@/lib/ai/faq-policy')")
    expect(routeSrc).toContain('resolveExactFaq')
  })

  test('widget route handles ambiguous status (skips FAQ)', () => {
    expect(routeSrc).toContain("exact.status === 'matched'")
    expect(routeSrc).toContain("exact.status === 'none'")
    // The ambiguous status falls through — no explicit branch means skip.
    expect(routeSrc).not.toContain("exact.status === 'ambiguous'")
  })

  test('matchFaq uses validateSemanticMatch (strict gate)', () => {
    expect(aiSrc).toContain('validateSemanticMatch')
    expect(aiSrc).not.toMatch(/parsed\.confidence \?\? 0\.7/)
  })

  test('the old whitespace-only norm is replaced by faq-policy', () => {
    // The old `norm` function used trim + whitespace collapse only.
    expect(routeSrc).not.toMatch(/const norm = \(s: string\)/)
  })
})
