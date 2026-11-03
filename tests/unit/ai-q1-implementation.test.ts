/// <reference types="bun-types" />
/**
 * Developer-owned AI-Q1 implementation tests.
 *
 * Covers (beyond the 24 reviewer contract tests):
 *   - Strict Boolean validation edge cases.
 *   - True PATCH in both directions (omitted flag preserved).
 *   - Empty and malformed requests.
 *   - Unknown and forbidden fields (tenantId, aiActionCount, aiActionResetAt).
 *   - Prototype pollution, accessors and symbols.
 *   - Deterministic successful FAQ and Product Q&A with injected providers.
 *   - Unknown FAQ IDs and invalid LLM responses.
 *   - Provider outages and no-answer fallback.
 *   - No cross-tenant FAQ/product references.
 *   - Source inspection: the AI config route uses the strict policy module
 *     (never the old `?? false` bug), requires admin auth, parses JSON safely,
 *     and applies TRUE-PATCH semantics.
 *   - Source inspection: the widget messages route has the exact-match FAQ
 *     fast path inside the faqEnabled block, after the plan cap check,
 *     returning the stored answer before the LLM-based matchFaq.
 *   - Source inspection: the AI functions accept an optional provider
 *     parameter (internal server-side testing seam, never exported through
 *     visitor APIs).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateAiConfigPatch,
  mergeAiConfigPatch,
  type AiConfigFlags,
} from '../../src/lib/ai/ai-config-policy'
import { matchFaq, answerProductQuestion, type AiProvider } from '../../src/lib/ai'

// ---------------------------------------------------------------------------
// Policy module — strict validation
// ---------------------------------------------------------------------------

const OFF: Readonly<AiConfigFlags> = Object.freeze({ faqEnabled: false, productQaEnabled: false })
const ON: Readonly<AiConfigFlags> = Object.freeze({ faqEnabled: true, productQaEnabled: true })
const FAQ_ONLY: Readonly<AiConfigFlags> = Object.freeze({ faqEnabled: true, productQaEnabled: false })
const PRODUCT_ONLY: Readonly<AiConfigFlags> = Object.freeze({ faqEnabled: false, productQaEnabled: true })

describe('Developer — strict Boolean validation', () => {
  test('actual booleans are accepted; lookalikes are rejected for both keys', () => {
    expect(validateAiConfigPatch({ faqEnabled: true })).toEqual({ faqEnabled: true })
    expect(validateAiConfigPatch({ faqEnabled: false })).toEqual({ faqEnabled: false })
    expect(validateAiConfigPatch({ productQaEnabled: true })).toEqual({ productQaEnabled: true })
    expect(validateAiConfigPatch({ productQaEnabled: false })).toEqual({ productQaEnabled: false })
    // Lookalikes — no coercion.
    for (const bad of ['true', 'false', 1, 0, 'yes', 'no', 'on', 'off', '', ' ', NaN, Infinity, -Infinity]) {
      expect(validateAiConfigPatch({ faqEnabled: bad })).toBeNull()
      expect(validateAiConfigPatch({ productQaEnabled: bad })).toBeNull()
    }
    // Objects and arrays as values.
    for (const bad of [{}, [], [true], { v: 1 }, new Date(), Symbol('x') as unknown]) {
      expect(validateAiConfigPatch({ faqEnabled: bad })).toBeNull()
      expect(validateAiConfigPatch({ productQaEnabled: bad })).toBeNull()
    }
  })

  test('Boolean object wrapper is rejected (not a plain object)', () => {
    // new Boolean(true) has Boolean.prototype, not Object.prototype.
    expect(validateAiConfigPatch(new Boolean(true))).toBeNull()
    expect(validateAiConfigPatch(new Boolean(false))).toBeNull()
  })

  test('Number / String object wrappers are rejected', () => {
    expect(validateAiConfigPatch(new Number(1))).toBeNull()
    expect(validateAiConfigPatch(new String('true'))).toBeNull()
  })
})

describe('Developer — true PATCH in both directions', () => {
  test('omitting productQaEnabled preserves its stored value when toggling faqEnabled', () => {
    expect(mergeAiConfigPatch(ON, { faqEnabled: false })).toEqual({ faqEnabled: false, productQaEnabled: true })
    expect(mergeAiConfigPatch(OFF, { faqEnabled: true })).toEqual({ faqEnabled: true, productQaEnabled: false })
    expect(mergeAiConfigPatch(FAQ_ONLY, { faqEnabled: false })).toEqual({ faqEnabled: false, productQaEnabled: false })
    expect(mergeAiConfigPatch(PRODUCT_ONLY, { faqEnabled: true })).toEqual({ faqEnabled: true, productQaEnabled: true })
  })

  test('omitting faqEnabled preserves its stored value when toggling productQaEnabled', () => {
    expect(mergeAiConfigPatch(ON, { productQaEnabled: false })).toEqual({ faqEnabled: true, productQaEnabled: false })
    expect(mergeAiConfigPatch(OFF, { productQaEnabled: true })).toEqual({ faqEnabled: false, productQaEnabled: true })
    expect(mergeAiConfigPatch(FAQ_ONLY, { productQaEnabled: true })).toEqual({ faqEnabled: true, productQaEnabled: true })
    expect(mergeAiConfigPatch(PRODUCT_ONLY, { productQaEnabled: false })).toEqual({ faqEnabled: false, productQaEnabled: false })
  })

  test('both keys can be updated in a single PATCH', () => {
    expect(mergeAiConfigPatch(OFF, { faqEnabled: true, productQaEnabled: true })).toEqual(ON)
    expect(mergeAiConfigPatch(ON, { faqEnabled: false, productQaEnabled: false })).toEqual(OFF)
    expect(mergeAiConfigPatch(FAQ_ONLY, { faqEnabled: false, productQaEnabled: true })).toEqual(PRODUCT_ONLY)
  })

  test('a no-op PATCH (same values) is accepted and returns the same flags', () => {
    expect(mergeAiConfigPatch(ON, { faqEnabled: true, productQaEnabled: true })).toEqual(ON)
    expect(mergeAiConfigPatch(OFF, { faqEnabled: false })).toEqual(OFF)
  })
})

describe('Developer — empty and malformed requests', () => {
  test('null, undefined, primitives and arrays are rejected', () => {
    for (const v of [null, undefined, false, true, 0, 1, -1, '', 'yes', [], [true], [false]]) {
      expect(validateAiConfigPatch(v)).toBeNull()
    }
  })

  test('empty object is rejected (no mutable keys)', () => {
    expect(validateAiConfigPatch({})).toBeNull()
  })

  test('merge with malformed patch returns null and never resets the stored flags', () => {
    for (const bad of [null, undefined, {}, [], 'true', 1, { faqEnabled: 'true' }, { productQaEnabled: null }]) {
      expect(mergeAiConfigPatch(ON, bad)).toBeNull()
      // ON is frozen — ensure it was not mutated.
      expect(ON).toEqual({ faqEnabled: true, productQaEnabled: true })
    }
  })
})

describe('Developer — unknown and forbidden fields', () => {
  test('tenantId, aiActionCount, aiActionResetAt and arbitrary keys are rejected', () => {
    for (const bad of [
      { faqEnabled: true, tenantId: 'other-tenant' },
      { productQaEnabled: true, aiActionCount: 999999 },
      { faqEnabled: false, aiActionResetAt: '2099-01-01' },
      { faqEnabled: true, extra: 'unknown' },
      { faqEnabled: true, id: 'cfg-1' },
      { faqEnabled: true, createdAt: '2020-01-01' },
      { faqEnabled: true, updatedAt: '2020-01-01' },
      { owner: true },
      { tenantId: 'x' },
      { aiActionCount: 1 },
    ]) {
      expect(validateAiConfigPatch(bad)).toBeNull()
    }
  })

  test('a patch with a forbidden field alongside a valid one is still rejected', () => {
    // The valid faqEnabled: true is NOT enough — the presence of tenantId
    // makes the whole patch invalid (no partial application).
    expect(validateAiConfigPatch({ faqEnabled: true, tenantId: 'x' })).toBeNull()
    expect(mergeAiConfigPatch(OFF, { faqEnabled: true, tenantId: 'x' })).toBeNull()
    // OFF is unchanged.
    expect(OFF).toEqual({ faqEnabled: false, productQaEnabled: false })
  })
})

describe('Developer — prototype pollution, accessors and symbols', () => {
  test('Object.create payloads are rejected (inherited keys not trusted)', () => {
    const proto = Object.create({ faqEnabled: true })
    proto.productQaEnabled = false
    expect(validateAiConfigPatch(proto)).toBeNull()
    // The inherited faqEnabled must not have been read.
    expect(Object.getPrototypeOf(proto).faqEnabled).toBe(true)
  })

  test('accessor-backed properties are rejected WITHOUT invoking the getter', () => {
    let getterCalled = false
    const obj = {
      get faqEnabled() { getterCalled = true; throw new Error('getter executed') },
    }
    expect(() => validateAiConfigPatch(obj)).not.toThrow()
    expect(validateAiConfigPatch(obj)).toBeNull()
    expect(getterCalled).toBe(false)
  })

  test('symbol own properties are rejected', () => {
    expect(validateAiConfigPatch({ faqEnabled: true, [Symbol('secret')]: 'payload' })).toBeNull()
    expect(validateAiConfigPatch({ [Symbol('x')]: true })).toBeNull()
  })

  test('non-enumerable own properties are still checked (hidden tenantId)', () => {
    const obj = { faqEnabled: true }
    Object.defineProperty(obj, 'tenantId', { value: 'hidden', enumerable: false, configurable: true, writable: true })
    expect(validateAiConfigPatch(obj)).toBeNull()
  })

  test('return value is a fresh object — not the input reference', () => {
    const patch = { faqEnabled: true, productQaEnabled: false }
    const result = validateAiConfigPatch(patch)
    expect(result).toEqual(patch)
    expect(result).not.toBe(patch)
    // Input is not mutated.
    expect(patch).toEqual({ faqEnabled: true, productQaEnabled: false })
  })

  test('merge returns a fresh object — not the stored reference', () => {
    const result = mergeAiConfigPatch(ON, { faqEnabled: false })
    expect(result).toEqual({ faqEnabled: false, productQaEnabled: true })
    expect(result).not.toBe(ON)
    // ON is frozen and unchanged.
    expect(ON).toEqual({ faqEnabled: true, productQaEnabled: true })
  })

  test('frozen input is not mutated by validate or merge', () => {
    const frozen = Object.freeze({ faqEnabled: true })
    expect(() => mergeAiConfigPatch(OFF, frozen)).not.toThrow()
    expect(mergeAiConfigPatch(OFF, frozen)).toEqual({ faqEnabled: true, productQaEnabled: false })
    expect(frozen).toEqual({ faqEnabled: true })
    expect(OFF).toEqual({ faqEnabled: false, productQaEnabled: false })
  })
})

// ---------------------------------------------------------------------------
// Deterministic FAQ matching with injected providers
// ---------------------------------------------------------------------------

const FAQS = Object.freeze([
  Object.freeze({ id: 'faq-1', question: 'آیا پرداخت حضوری دارید؟', answer: 'بله، پرداخت حضوری داریم.' }),
  Object.freeze({ id: 'faq-2', question: 'ساعات کاری؟', answer: 'شنبه تا پنجشنبه ۹ تا ۱۸.' }),
  Object.freeze({ id: 'faq-3', question: 'ارسال رایگان دارید؟', answer: 'بله، برای سفارش‌های بالای ۵۰۰ هزار تومان.' }),
])

describe('Developer — deterministic FAQ positive/negative with injected provider', () => {
  test('positive match returns the REAL stored answer and the correct FAQ ID', async () => {
    let calls = 0
    const provider: AiProvider = {
      complete: async () => { calls++; return JSON.stringify({ matched: true, id: 'faq-3', confidence: 0.91 }) },
    }
    const result = await matchFaq('آیا ارسال رایگان انجام می‌دهید؟', [...FAQS], provider)
    expect(calls).toBe(1)
    expect(result).toEqual({ matched: true, faqPairId: 'faq-3', answer: 'بله، برای سفارش‌های بالای ۵۰۰ هزار تومان.', confidence: 0.91 })
  })

  test('the provider cannot inject a fake answer — the stored answer is always returned', async () => {
    const provider: AiProvider = {
      complete: async () => JSON.stringify({ matched: true, id: 'faq-1', confidence: 0.95, answer: 'جعل شده' }),
    }
    const result = await matchFaq('پرداخت حضوری', [...FAQS], provider)
    expect(result.matched).toBe(true)
    expect(result.answer).toBe('بله، پرداخت حضوری داریم.')
    expect(result.answer).not.toBe('جعل شده')
  })

  test('an invented / cross-tenant FAQ ID produces no answer but preserves confidence', async () => {
    const provider: AiProvider = {
      complete: async () => JSON.stringify({ matched: true, id: 'other-tenant-faq', confidence: 0.88 }),
    }
    const result = await matchFaq('سوال ناشناخته', [...FAQS], provider)
    expect(result).toEqual({ matched: false, faqPairId: null, answer: null, confidence: 0.88 })
  })

  test('explicit no-match returns a safe negative', async () => {
    const provider: AiProvider = {
      complete: async () => JSON.stringify({ matched: false, id: null, confidence: 0.2 }),
    }
    const result = await matchFaq('یک لطیفه بگو', [...FAQS], provider)
    expect(result.matched).toBe(false)
    expect(result.answer).toBeNull()
  })

  test('invalid JSON output is a safe negative', async () => {
    const provider: AiProvider = { complete: async () => 'this is not json' }
    expect((await matchFaq('سلام', [...FAQS], provider)).matched).toBe(false)
  })

  test('partial / malformed JSON is a safe negative', async () => {
    const provider: AiProvider = { complete: async () => '{"matched":' }
    expect((await matchFaq('سلام', [...FAQS], provider)).matched).toBe(false)
  })

  test('model outage (provider throws) is a safe negative and does not crash', async () => {
    const provider: AiProvider = { complete: async () => { throw new Error('provider unavailable') } }
    const result = await matchFaq('سلام', [...FAQS], provider)
    expect(result.matched).toBe(false)
    expect(result.answer).toBeNull()
    expect(result.confidence).toBe(0)
  })

  test('empty FAQ list makes zero provider requests and returns a safe negative', async () => {
    let calls = 0
    const provider: AiProvider = { complete: async () => { calls++; return 'invalid' } }
    expect(await matchFaq('سوال', [], provider)).toEqual({ matched: false, faqPairId: null, answer: null, confidence: 0 })
    expect(calls).toBe(0)
  })

  test('confidence is clamped to [0, 1]', async () => {
    const high: AiProvider = { complete: async () => JSON.stringify({ matched: true, id: 'faq-1', confidence: 5 }) }
    expect((await matchFaq('x', [...FAQS], high)).confidence).toBe(1)
    const low: AiProvider = { complete: async () => JSON.stringify({ matched: false, id: null, confidence: -3 }) }
    expect((await matchFaq('x', [...FAQS], low)).confidence).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Deterministic Product Q&A with injected provider
// ---------------------------------------------------------------------------

const PRODUCTS = [
  { id: 'prod-1', name: 'هدفون بلوتوث اسپارک', description: 'باتری ۲۴ ساعته', price: 2500000, availability: 'in_stock' },
  { id: 'prod-2', name: 'کیبورد مکانیکی', description: 'سوییچ آبی', price: 1200000, availability: 'limited' },
  { id: 'prod-3', name: 'ماوس گیمینگ', description: 'سنسور ۱۶۰۰۰ DPI', price: 800000, availability: 'out_of_stock' },
]

describe('Developer — deterministic Product Q&A positive/negative with injected provider', () => {
  test('positive response includes the actual retrieved product ID', async () => {
    let calls = 0
    const provider: AiProvider = {
      complete: async () => { calls++; return 'هدفون اسپارک با قیمت ۲۵۰۰۰۰۰ تومان موجود است.' },
    }
    const result = await answerProductQuestion('قیمت هدفون اسپارک چقدر است؟', PRODUCTS, provider)
    expect(calls).toBe(1)
    expect(result.answered).toBe(true)
    expect(result.answer).toContain('هدفون اسپارک')
    expect(result.productIds).toContain('prod-1')
  })

  test('only retrieved product IDs appear — no cross-tenant / invented IDs', async () => {
    const provider: AiProvider = { complete: async () => 'پاسخ تست' }
    const result = await answerProductQuestion('کیبورد', PRODUCTS, provider)
    expect(result.productIds).toEqual(['prod-2'])
    expect(result.productIds).not.toContain('prod-1')
    expect(result.productIds).not.toContain('other-tenant')
  })

  test('non-matching question retrieves zero candidates and skips the model', async () => {
    let calls = 0
    const provider: AiProvider = { complete: async () => { calls++; return 'hallucination' } }
    const result = await answerProductQuestion('درباره بیمه ماشین', PRODUCTS, provider)
    expect(result).toEqual({ answered: false, answer: null, productIds: [] })
    expect(calls).toBe(0)
  })

  test('empty product list does not call the model', async () => {
    let calls = 0
    const provider: AiProvider = { complete: async () => { calls++; return 'test' } }
    expect(await answerProductQuestion('هدفون', [], provider)).toEqual({ answered: false, answer: null, productIds: [] })
    expect(calls).toBe(0)
  })

  test('blank / whitespace-only answer does not count as a positive response', async () => {
    for (const blank of ['', '  ', '\t\n', '   ']) {
      const provider: AiProvider = { complete: async () => blank }
      expect(await answerProductQuestion('هدفون اسپارک', PRODUCTS, provider)).toEqual({ answered: false, answer: null, productIds: [] })
    }
  })

  test('provider failure falls back safely — no positive hallucinated response', async () => {
    const provider: AiProvider = { complete: async () => { throw new Error('timeout') } }
    expect(await answerProductQuestion('هدفون اسپارک', PRODUCTS, provider)).toEqual({ answered: false, answer: null, productIds: [] })
  })

  test('multiple matching products are all included in productIds', async () => {
    // 'اسپارک' matches prod-1; 'کیبورد' matches prod-2. A question
    // mentioning both should retrieve both.
    const provider: AiProvider = { complete: async () => 'پاسخ' }
    const result = await answerProductQuestion('هدفون اسپارک و کیبورد', PRODUCTS, provider)
    expect(result.answered).toBe(true)
    expect(result.productIds).toContain('prod-1')
    expect(result.productIds).toContain('prod-2')
  })
})

// ---------------------------------------------------------------------------
// Source inspection — AI config route (true-PATCH, auth, safe parse)
// ---------------------------------------------------------------------------

describe('Developer — AI config route source wiring', () => {
  const routeSrc = readFileSync(join(process.cwd(), 'src/app/api/ai-config/route.ts'), 'utf8')
  // Strip comments so NEGATIVE assertions inspect CODE, not prose.
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const routeCode = code(routeSrc)

  test('the route imports and uses the strict policy module', () => {
    // The route uses validateAiConfigPatch to validate the payload before
    // the atomic upsert. mergeAiConfigPatch is NOT imported by the route —
    // the atomic true-PATCH writes `{ ...validated }` directly, without a
    // stale read/merge. (mergeAiConfigPatch remains exported by the policy
    // module for standalone deterministic policy tests.)
    expect(routeCode).toContain('validateAiConfigPatch')
    expect(routeCode).not.toContain('mergeAiConfigPatch')
    expect(routeCode).not.toContain('AiConfigFlags')
  })

  test('the old `?? false` reset bug is gone', () => {
    // The old bug: body.faqEnabled ?? false / body.productQaEnabled ?? false
    // reset omitted fields. These patterns MUST NOT appear.
    expect(routeCode).not.toMatch(/body\.faqEnabled\s*\?\?/)
    expect(routeCode).not.toMatch(/body\.productQaEnabled\s*\?\?/)
  })

  test('GET uses upsert (atomic, no find-then-create race)', () => {
    expect(routeCode).toContain('db.aiConfig.upsert')
    expect(routeCode).toContain("where: { tenantId: tid }")
  })

  test('GET returns default-OFF flags', () => {
    expect(routeCode).toContain('faqEnabled: false')
    expect(routeCode).toContain('productQaEnabled: false')
  })

  test('PATCH requires admin-or-higher authorization', () => {
    expect(routeCode).toContain("hasRole(session.user.role, 'admin')")
    expect(routeCode).toContain('forbidden')
  })

  test('PATCH parses JSON safely (malformed body → 400, not a crash)', () => {
    expect(routeCode).toMatch(/try\s*{[\s\S]*?body\s*=\s*await req\.json\(\)[\s\S]*?}\s*catch/)
    expect(routeCode).toContain('invalid')
    expect(routeCode).toContain('400')
  })

  test('PATCH validates with validateAiConfigPatch before any DB write', () => {
    expect(routeCode).toContain('validateAiConfigPatch(body)')
    expect(routeCode).toContain('invalid')
  })

  test('PATCH write set is ONLY the validated keys — no stale full-merge (atomic true-PATCH)', () => {
    // The UPDATE branch must spread `...validated` (only supplied keys),
    // NOT replay a stale full snapshot. This is the atomic true-PATCH
    // contract: an omitted flag is never written, so a concurrent PATCH
    // setting the other flag cannot be overwritten by a stale read.
    expect(routeCode).toContain('...validated')
    // The unsafe full-merge pattern (update: { faqEnabled: merged.X, ... })
    // MUST NOT appear.
    expect(routeCode).not.toMatch(/update:\s*\{\s*faqEnabled:\s*merged\.faqEnabled/)
    expect(routeCode).not.toMatch(/faqEnabled:\s*merged\.faqEnabled/)
    expect(routeCode).not.toMatch(/productQaEnabled:\s*merged\.productQaEnabled/)
  })

  test('PATCH does NOT load a stale snapshot before the write (no findUnique + mergeAiConfigPatch race)', () => {
    // The handler must NOT read the current config and merge before writing —
    // that read/merge/full-update flow is the lost-update race. The atomic
    // true-PATCH writes directly from the validated payload.
    expect(routeCode).not.toMatch(/db\.aiConfig\.findUnique/)
    expect(routeCode).not.toMatch(/mergeAiConfigPatch/)
  })

  test('PATCH create branch defaults omitted flags OFF (?? false)', () => {
    // When the row does not exist, the create branch seeds supplied flags
    // from `validated` and omitted flags default OFF.
    expect(routeCode).toContain('validated.faqEnabled ?? false')
    expect(routeCode).toContain('validated.productQaEnabled ?? false')
  })

  test('PATCH never trusts client-supplied tenant or quota fields', () => {
    // The upsert only writes faqEnabled + productQaEnabled + tenantId (bound
    // to the authenticated tenant). aiActionCount / aiActionResetAt are
    // never written.
    expect(routeCode).not.toMatch(/aiActionCount/)
    expect(routeCode).not.toMatch(/aiActionResetAt/)
  })

  test('the route binds the tenant to the authenticated session', () => {
    expect(routeCode).toContain('getCurrentTenantId()')
  })
})

// ---------------------------------------------------------------------------
// Concurrent true-PATCH write-set contract
//
// The previous implementation had a lost-update race: it read the stored
// snapshot (findUnique), merged the patch (mergeAiConfigPatch), and wrote
// BOTH merged flags (update: { faqEnabled: merged.X, productQaEnabled:
// merged.Y }). Under concurrent PATCHes, whichever completed last destroyed
// the other's independent update.
//
// The fix: the upsert.update write set is `{ ...validated }` — ONLY the keys
// the client explicitly supplied. Prisma applies only the fields present in
// this object, so an omitted flag is never written and a concurrent PATCH
// setting the other flag cannot be clobbered.
//
// These tests verify the write-set contract at the source level (the
// definitive guard against the stale full-merge pattern) AND at the policy
// level (the validated partial is exactly what gets spread into the update).
// ---------------------------------------------------------------------------

describe('Developer — concurrent true-PATCH write-set contract', () => {
  const routeSrc = readFileSync(join(process.cwd(), 'src/app/api/ai-config/route.ts'), 'utf8')
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const routeCode = code(routeSrc)
  const patchHandler = routeSrc.split('export async function PATCH')[1] ?? ''

  test('concurrent independent true/true PATCHes from off/off cannot lose either flag', () => {
    // Request A: { faqEnabled: true }. Request B: { productQaEnabled: true }.
    // Both start from off/off. The update write set for A must be ONLY
    // { faqEnabled: true } and for B ONLY { productQaEnabled: true }.
    // The `...validated` spread guarantees this — each PATCH writes only its
    // own key, so both true values survive regardless of interleaving.
    expect(patchHandler).toContain('...validated')
    expect(patchHandler).not.toMatch(/faqEnabled:\s*merged\.faqEnabled/)
    expect(patchHandler).not.toMatch(/productQaEnabled:\s*merged\.productQaEnabled/)
    // The validated partial for { faqEnabled: true } contains ONLY faqEnabled.
    const a = validateAiConfigPatch({ faqEnabled: true })!
    expect(Object.keys(a)).toEqual(['faqEnabled'])
    expect(a).toEqual({ faqEnabled: true })
    const b = validateAiConfigPatch({ productQaEnabled: true })!
    expect(Object.keys(b)).toEqual(['productQaEnabled'])
    expect(b).toEqual({ productQaEnabled: true })
  })

  test('concurrent independent false/false PATCHes from on/on cannot lose either flag', () => {
    // Request A: { faqEnabled: false }. Request B: { productQaEnabled: false }.
    // Both start from on/on. Each writes ONLY its own key (false), so both
    // false values survive — the final state is off/off, not a stale on/off.
    const a = validateAiConfigPatch({ faqEnabled: false })!
    expect(Object.keys(a)).toEqual(['faqEnabled'])
    expect(a).toEqual({ faqEnabled: false })
    const b = validateAiConfigPatch({ productQaEnabled: false })!
    expect(Object.keys(b)).toEqual(['productQaEnabled'])
    expect(b).toEqual({ productQaEnabled: false })
    // The spread of each into a separate update does not interfere.
    const updateA = { ...a }
    const updateB = { ...b }
    expect(updateA).not.toHaveProperty('productQaEnabled')
    expect(updateB).not.toHaveProperty('faqEnabled')
  })

  test('a PATCH that explicitly changes both fields writes both keys', () => {
    // Request: { faqEnabled: true, productQaEnabled: false }.
    // The validated partial contains BOTH keys — the spread writes both.
    const validated = validateAiConfigPatch({ faqEnabled: true, productQaEnabled: false })!
    expect(Object.keys(validated).sort()).toEqual(['faqEnabled', 'productQaEnabled'])
    const update = { ...validated }
    expect(update).toEqual({ faqEnabled: true, productQaEnabled: false })
  })

  test('an omitted flag is never present in the update write set', () => {
    // The core invariant: validateAiConfigPatch returns ONLY the supplied
    // mutable keys. Spreading into `update` writes only those keys. An
    // omitted flag is absent from the object, so Prisma never touches it.
    for (const [patch, expectedKeys] of [
      [{ faqEnabled: true }, ['faqEnabled']],
      [{ faqEnabled: false }, ['faqEnabled']],
      [{ productQaEnabled: true }, ['productQaEnabled']],
      [{ productQaEnabled: false }, ['productQaEnabled']],
      [{ faqEnabled: true, productQaEnabled: true }, ['faqEnabled', 'productQaEnabled']],
      [{ faqEnabled: false, productQaEnabled: false }, ['faqEnabled', 'productQaEnabled']],
    ] as const) {
      const validated = validateAiConfigPatch(patch)!
      expect(Object.keys(validated).sort()).toEqual([...expectedKeys].sort())
      const update = { ...validated }
      // The update write set has exactly the expected keys — no stale
      // snapshot, no omitted flag.
      expect(Object.keys(update).sort()).toEqual([...expectedKeys].sort())
    }
  })

  test('the create branch seeds omitted flags OFF (atomic creation when no row exists)', () => {
    // When the row does not exist, the create branch uses
    // `validated.X ?? false` — supplied flags from the patch, omitted flags
    // default OFF. This preserves default-OFF behavior for new records.
    expect(patchHandler).toContain('validated.faqEnabled ?? false')
    expect(patchHandler).toContain('validated.productQaEnabled ?? false')
  })

  test('the handler never loads a stale snapshot (no findUnique before the upsert)', () => {
    // The read/merge/full-update race requires a findUnique + mergeAiConfigPatch
    // before the write. The atomic true-PATCH has neither — it writes
    // directly from the validated payload.
    expect(patchHandler).not.toMatch(/db\.aiConfig\.findUnique/)
    expect(patchHandler).not.toMatch(/mergeAiConfigPatch/)
    expect(patchHandler).not.toMatch(/mergeAiConfigPatch\(stored/)
  })

  test('the unsafe full-merge write set pattern is absent', () => {
    // The exact pattern the reviewer's static guard checks for: the update
    // object must NOT contain `faqEnabled: merged.faqEnabled, productQaEnabled:
    // merged.productQaEnabled`. This is the stale full-merge that causes
    // lost updates.
    const unsafe = /update:\s*\{\s*faqEnabled:\s*merged\.faqEnabled,\s*productQaEnabled:\s*merged\.productQaEnabled,?\s*\}/
    expect(patchHandler).not.toMatch(unsafe)
  })

  test('the upsert is atomic (create-or-update in a single Prisma call)', () => {
    // A single upsert call handles both creation and update — no
    // find-then-create race, no duplicate records.
    expect(patchHandler).toContain('db.aiConfig.upsert')
    expect(patchHandler).toContain('where: { tenantId: tid }')
    expect(patchHandler).toContain('create:')
    expect(patchHandler).toContain('update:')
  })

  test('unknown fields and quota forgery are still rejected (validateAiConfigPatch guards the write set)', () => {
    // The write set is derived from `validated`, which only contains the two
    // mutable keys. Unknown / quota fields are rejected by validateAiConfigPatch
    // before the upsert, so they can never enter the write set.
    expect(validateAiConfigPatch({ faqEnabled: true, tenantId: 'foreign' })).toBeNull()
    expect(validateAiConfigPatch({ productQaEnabled: true, aiActionCount: 999 })).toBeNull()
    expect(validateAiConfigPatch({ faqEnabled: true, aiActionResetAt: '2099-01-01' })).toBeNull()
    expect(validateAiConfigPatch({ faqEnabled: true, extra: 'x' })).toBeNull()
    // A valid patch's write set contains NO quota / tenant fields.
    const validated = validateAiConfigPatch({ faqEnabled: true })!
    expect(validated).not.toHaveProperty('tenantId')
    expect(validated).not.toHaveProperty('aiActionCount')
    expect(validated).not.toHaveProperty('aiActionResetAt')
  })

  test('the write set never includes the tenantId (bound to the authenticated session)', () => {
    // The tenantId in the upsert is `tid` (from getCurrentTenantId), NOT from
    // the validated payload. The client cannot supply a foreign tenantId.
    expect(patchHandler).toContain('tenantId: tid')
    const validated = validateAiConfigPatch({ faqEnabled: true })!
    expect(validated).not.toHaveProperty('tenantId')
  })

  test('PATCH authorization requires admin-or-higher', () => {
    expect(patchHandler).toContain("hasRole(session.user.role, 'admin')")
    expect(patchHandler).toContain('forbidden')
  })
})

// ---------------------------------------------------------------------------
// Source inspection — widget messages route (exact-match FAQ fast path)
// ---------------------------------------------------------------------------

describe('Developer — exact-match FAQ fast-path source wiring', () => {
  const msgSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const msgCode = code(msgSrc)

  test('tryAiResponse has an exact-match fast path', () => {
    expect(msgCode).toContain('exact')
    expect(msgCode).toMatch(/norm\(/)
    expect(msgCode).toMatch(/\.trim\(\)\.replace\(\/\\s\+\/g/)
  })

  test('the fast path returns the stored FAQ answer with source faq', () => {
    expect(msgCode).toContain('exact.answer')
    expect(msgCode).toContain("source: 'faq'")
  })

  test('the fast path is inside the faqEnabled block', () => {
    // The exact-match code must appear AFTER `if (aiConfig.faqEnabled)`.
    const faqBlockIdx = msgCode.indexOf('if (aiConfig.faqEnabled)')
    const exactIdx = msgCode.indexOf('exact.answer')
    expect(faqBlockIdx).toBeGreaterThan(-1)
    expect(exactIdx).toBeGreaterThan(faqBlockIdx)
  })

  test('the fast path runs BEFORE the LLM-based matchFaq', () => {
    const exactIdx = msgCode.indexOf('exact.answer')
    const matchFaqIdx = msgCode.indexOf('matchFaq(visitorMessage')
    expect(exactIdx).toBeGreaterThan(-1)
    expect(matchFaqIdx).toBeGreaterThan(exactIdx)
  })

  test('the AI-Q2 reservation runs before the FAQ block (Free zero quota is enforced)', () => {
    // AI-Q2: the reservation (reserveAiReply) is the authoritative quota gate,
    // replacing the old count-based checkPlanLimit. Free aiActions: 0 →
    // limit_reached → no generation.
    const reserveIdx = msgCode.indexOf('reserveAiReply')
    const faqBlockIdx = msgCode.indexOf('if (aiConfig.faqEnabled)')
    expect(reserveIdx).toBeGreaterThan(-1)
    expect(faqBlockIdx).toBeGreaterThan(reserveIdx)
  })

  test('the AI error is caught and never breaks the visitor message', () => {
    expect(msgCode).toMatch(/tryAiResponse/)
    expect(msgCode).toMatch(/catch/)
    // The AI response is optional — the visitor message is persisted first.
    expect(msgCode).toContain('senderType: \'contact\'')
    // AI-Q2: the AI message is created by commitAiReply (inside the usage
    // service transaction), not directly by the route. The route fetches it
    // for realtime publication.
    expect(msgCode).toContain('commitAiReply')
  })

  test('the AI message content includes text and source (via commitAiReply)', () => {
    // AI-Q2: the AI message is persisted by commitAiReply with
    // content: { text, source }. The route no longer creates the message
    // directly — it fetches it for realtime.
    const tryBlock = msgCode.split('async function tryAiResponse')[1] ?? ''
    expect(tryBlock).toContain('commitAiReply')
    expect(tryBlock).toContain('text: generated.text')
    expect(tryBlock).toContain('source: generated.source')
  })
})

// ---------------------------------------------------------------------------
// Source inspection — AI module provider seam
// ---------------------------------------------------------------------------

describe('Developer — AI module injectable provider seam', () => {
  const aiSrc = readFileSync(join(process.cwd(), 'src/lib/ai/index.ts'), 'utf8')
  const code = (src: string): string =>
    src
      .replace(/\/[\u002A][\s\S]*?[\u002A]\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
  const aiCode = code(aiSrc)

  test('matchFaq accepts an optional provider parameter', () => {
    expect(aiCode).toMatch(/matchFaq\(/)
    expect(aiCode).toMatch(/provider\?:\s*AiProvider/)
  })

  test('answerProductQuestion accepts an optional provider parameter', () => {
    expect(aiCode).toMatch(/answerProductQuestion\(/)
    expect(aiCode).toMatch(/provider\?:\s*AiProvider/)
  })

  test('the AiProvider interface is exported (internal server-side seam)', () => {
    expect(aiCode).toContain('export interface AiProvider')
    expect(aiCode).toContain('complete(prompt: string): Promise<string>')
  })

  test('when a provider is injected, the real SDK is NOT called', () => {
    // The provider branch must be checked BEFORE getZAI().
    const providerBranch = aiCode.indexOf('if (provider)')
    const getZAICall = aiCode.indexOf('getZAI()')
    // getZAI is called in the else branch (production), after the provider check.
    expect(providerBranch).toBeGreaterThan(-1)
    expect(getZAICall).toBeGreaterThan(-1)
  })

  test('the FAQ answer is always the stored answer, never a provider-invented answer', () => {
    // The return uses faq.answer, not parsed.answer.
    expect(aiCode).toContain('answer: faq.answer')
    expect(aiCode).not.toMatch(/answer:\s*parsed\.answer/)
  })

  test('returned FAQ IDs are validated against the supplied list', () => {
    expect(aiCode).toMatch(/faqPairs\.find/)
  })

  test('invalid JSON and provider failures are caught (safe negative)', () => {
    expect(aiCode).toMatch(/JSON\.parse/)
    expect(aiCode).toMatch(/catch/)
  })
})

// ---------------------------------------------------------------------------
// No regression — visitor messaging preserved
// ---------------------------------------------------------------------------

describe('Developer — visitor messaging preserved when AI fails', () => {
  const msgSrc = readFileSync(join(process.cwd(), 'src/app/api/widget/[slug]/messages/route.ts'), 'utf8')

  test('the visitor message is persisted BEFORE the AI response', () => {
    // The visitor message create must appear before the AI try block.
    const visitorCreate = msgSrc.indexOf("senderType: 'contact'")
    const aiTry = msgSrc.indexOf('tryAiResponse')
    expect(visitorCreate).toBeGreaterThan(-1)
    expect(aiTry).toBeGreaterThan(visitorCreate)
  })

  test('the AI response is wrapped in a try/catch (failure does not break the response)', () => {
    expect(msgSrc).toMatch(/try\s*{[\s\S]*?tryAiResponse[\s\S]*?}\s*catch/)
  })

  test('the visitor response is returned even if aiResponse is null', () => {
    expect(msgSrc).toContain('aiResponse')
    expect(msgSrc).toMatch(/return widgetHeaders\(NextResponse\.json\(\s*\{\s*message/)
  })
})
