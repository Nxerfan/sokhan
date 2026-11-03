/// <reference types="bun-types" />
/**
 * Independent reviewer-owned AI Phase / AI-Q1 contract.
 * API PATCH correctness and deterministic positive/negative response tests.
 * These tests must NOT be changed by the implementation agent.
 *
 * AI-Q1 intentionally does NOT modify numeric plan caps, BYOK, knowledge
 * uploads, confidence gating (AI-Q3), or product retrieval ranking (AI-Q4).
 */
import { describe, test, expect } from 'bun:test'
import {
  validateAiConfigPatch,
  mergeAiConfigPatch,
} from '../../src/lib/ai/ai-config-policy'
import { matchFaq, answerProductQuestion } from '../../src/lib/ai'

const off = Object.freeze({ faqEnabled: false, productQaEnabled: false })
const on = Object.freeze({ faqEnabled: true, productQaEnabled: true })

describe('Reviewer AI-Q1 — strict authenticated AI settings PATCH policy', () => {
  test('exact single-key true patch is accepted', () => {
    expect(validateAiConfigPatch({ faqEnabled: true })).toEqual({ faqEnabled: true })
    expect(validateAiConfigPatch({ productQaEnabled: true })).toEqual({ productQaEnabled: true })
  })
  test('explicit false and both-key updates are accepted', () => {
    expect(validateAiConfigPatch({ faqEnabled: false })).toEqual({ faqEnabled: false })
    expect(validateAiConfigPatch({ productQaEnabled: false, faqEnabled: true }))
      .toEqual({ productQaEnabled: false, faqEnabled: true })
  })
  test('missing body, arrays and primitives are rejected', () => {
    for (const value of [null, undefined, false, true, 0, 'a', [], [true]]) {
      expect(validateAiConfigPatch(value)).toBeNull()
    }
  })
  test('empty patch and unknown keys are rejected', () => {
    for (const value of [{}, { owner: true }, { faqEnabled: true, tenantId: 'other' },
      { productQaEnabled: true, aiActionCount: 1000000 },
      { productQaEnabled: true, aiActionResetAt: '2099-01-01' }]) {
      expect(validateAiConfigPatch(value)).toBeNull()
    }
  })
  test('boolean lookalikes and null do not coerce', () => {
    for (const bad of ['true', 'false', 1, 0, null, [], {}, '']) {
      expect(validateAiConfigPatch({ faqEnabled: bad })).toBeNull()
      expect(validateAiConfigPatch({ productQaEnabled: bad })).toBeNull()
    }
  })
  test('symbol keys and accessor keys are rejected without executing getters', () => {
    let getterCalled = false
    const getter = { get faqEnabled() { getterCalled = true; throw Error('getter executed') } }
    expect(() => validateAiConfigPatch(getter)).not.toThrow()
    expect(validateAiConfigPatch(getter)).toBeNull()
    expect(getterCalled).toBe(false)
    expect(validateAiConfigPatch({ faqEnabled: true, [Symbol('x')]: 'secret' })).toBeNull()
  })
  test('prototype-backed and object-constructed payloads are rejected', () => {
    const proto = Object.create({ faqEnabled: true })
    proto.productQaEnabled = false
    expect(validateAiConfigPatch(proto)).toBeNull()
    expect(validateAiConfigPatch(new Boolean(true))).toBeNull()
  })
  test('return value is a fresh object without affecting input', () => {
    const patch = { faqEnabled: true }
    const result = validateAiConfigPatch(patch)
    expect(result).toEqual(patch)
    expect(result).not.toBe(patch)
    expect(patch).toEqual({ faqEnabled: true })
  })
  test('true PATCH never silently clears the other enabled feature', () => {
    expect(mergeAiConfigPatch(on, { faqEnabled: false })).toEqual({ faqEnabled: false, productQaEnabled: true })
    expect(mergeAiConfigPatch(on, { productQaEnabled: false })).toEqual({ faqEnabled: true, productQaEnabled: false })
  })
  test('enabling one feature does not silently enable or disable the other', () => {
    expect(mergeAiConfigPatch(off, { faqEnabled: true })).toEqual({ faqEnabled: true, productQaEnabled: false })
    expect(mergeAiConfigPatch(off, { productQaEnabled: true })).toEqual({ faqEnabled: false, productQaEnabled: true })
  })
  test('no mutation of frozen snapshots or patch objects', () => {
    const raw = Object.freeze({ faqEnabled: true })
    expect(mergeAiConfigPatch(off, raw)).toEqual({ faqEnabled: true, productQaEnabled: false })
    expect(off).toEqual({ faqEnabled: false, productQaEnabled: false })
    expect(raw).toEqual({ faqEnabled: true })
  })
  test('malformed merge input fails closed rather than resetting unrelated setting', () => {
    expect(mergeAiConfigPatch(on, { faqEnabled: 'false' })).toBeNull()
    expect(mergeAiConfigPatch(on, { productQaEnabled: null })).toBeNull()
  })
})

describe('Reviewer AI-Q1 — deterministic FAQ positive/negative LLM contract', () => {
  const faqs = Object.freeze([
    Object.freeze({ id: 'faq-1', question: 'آیا پرداخت حضوری دارید؟', answer: 'بله، پرداخت حضوری داریم.' }),
    Object.freeze({ id: 'faq-2', question: 'ساعات کاری؟', answer: 'شنبه تا پنجشنبه ۹ تا ۱۸.' }),
  ])
  test('positive semantic FAQ classification returns the REAL stored answer and ID', async () => {
    let calls = 0
    const fakeProvider = {
      complete: async () => { calls++; return JSON.stringify({ matched: true, id: 'faq-1', confidence: 0.96 }) },
    }
    const result = await matchFaq('میشه موقع دریافت، حضوری پرداخت کنم؟', [...faqs], fakeProvider)
    expect(calls).toBe(1)
    expect(result).toEqual({ matched: true, faqPairId: 'faq-1', answer: 'بله، پرداخت حضوری داریم.', confidence: 0.96 })
  })
  test('provider cannot replace the owner-stored FAQ answer with hallucinated answer', async () => {
    const provider = { complete: async () => JSON.stringify({ matched: true, id: 'faq-2', confidence: 0.94, answer: 'ورودی جعلی' }) }
    const result = await matchFaq('چه ساعتی باز هستید؟', [...faqs], provider)
    expect(result.matched).toBe(true)
    expect(result.answer).toBe('شنبه تا پنجشنبه ۹ تا ۱۸.')
    expect(result.answer).not.toBe('ورودی جعلی')
  })
  test('invented FAQ ID must not produce an answer', async () => {
    const provider = { complete: async () => '{"matched":true,"id":"other-tenant-id","confidence":0.99}' }
    const result = await matchFaq('موضوع دیگر', [...faqs], provider)
    expect(result).toEqual({ matched: false, faqPairId: null, answer: null, confidence: 0.99 })
  })
  test('explicit no-match does not create a positive answer', async () => {
    const provider = { complete: async () => '{"matched":false,"id":null,"confidence":0.1}' }
    const result = await matchFaq('لطفا یک لطیفه بگو', [...faqs], provider)
    expect(result.matched).toBe(false)
    expect(result.answer).toBeNull()
  })
  test('invalid model output is a safe negative and does not throw', async () => {
    const provider = { complete: async () => 'not-json' }
    expect((await matchFaq('سلام', [...faqs], provider)).matched).toBe(false)
  })
  test('model outage is safe negative and does not throw', async () => {
    const provider = { complete: async () => { throw Error('provider unavailable') } }
    const result = await matchFaq('سلام', [...faqs], provider)
    expect(result.matched).toBe(false)
    expect(result.answer).toBeNull()
  })
  test('empty FAQ list makes zero provider requests', async () => {
    let calls = 0
    const provider = { complete: async () => { calls++; return 'invalid' } }
    expect(await matchFaq('آیا باز هستید؟', [], provider)).toEqual({ matched: false, faqPairId: null, answer: null, confidence: 0 })
    expect(calls).toBe(0)
  })
})

describe('Reviewer AI-Q1 — deterministic product Q&A positive/negative LLM contract', () => {
  const products = [
    { id: 'prod-1', name: 'هدفون بلوتوث اسپارک', description: 'باتری ۲۴ ساعته', price: 2500000, availability: 'in_stock' },
    { id: 'prod-2', name: 'کیبورد مکانیکی', description: 'سوییچ آبی', price: 1200000, availability: 'limited' },
  ]
  test('positive product response includes actual retrieved product ID', async () => {
    let calls = 0
    const provider = { complete: async () => { calls++; return 'هدفون اسپارک با قیمت ۲۵۰۰۰۰۰ تومان موجود است.' } }
    const result = await answerProductQuestion('قیمت هدفون اسپارک چقدر است؟', products, provider)
    expect(calls).toBe(1)
    expect(result.answered).toBe(true)
    expect(result.answer).toContain('هدفون اسپارک')
    expect(result.productIds).toContain('prod-1')
    expect(result.productIds).not.toContain('other-tenant')
  })
  test('no retrieved candidate means no generated answer or model call', async () => {
    let calls = 0
    const provider = { complete: async () => { calls++; return 'hallucination' } }
    const result = await answerProductQuestion('درباره بیمه ماشین', products, provider)
    expect(result).toEqual({ answered: false, answer: null, productIds: [] })
    expect(calls).toBe(0)
  })
  test('empty product list does not call model', async () => {
    let calls = 0
    const provider = { complete: async () => { calls++; return 'test' } }
    expect(await answerProductQuestion('هدفون اسپارک', [], provider)).toEqual({ answered: false, answer: null, productIds: [] })
    expect(calls).toBe(0)
  })
  test('blank answer does not count as a positive response', async () => {
    const provider = { complete: async () => '  ' }
    expect(await answerProductQuestion('هدفون اسپارک', products, provider)).toEqual({ answered: false, answer: null, productIds: [] })
  })
  test('provider failure falls back safely, not a positive hallucinated response', async () => {
    const provider = { complete: async () => { throw Error('timeout') } }
    expect(await answerProductQuestion('هدفون اسپارک', products, provider)).toEqual({ answered: false, answer: null, productIds: [] })
  })
})
