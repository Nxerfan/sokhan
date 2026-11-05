/**
 * AI provider abstraction (ADR-6).
 *
 * Uses the z-ai-web-dev-sdk (available in the project) for LLM calls.
 * The SDK is backend-only — never imported in client components.
 *
 * Two AI features:
 * 1. FAQ matching: given a visitor message + list of FAQ pairs, find the best
 *    match above a confidence threshold. Uses LLM-based classification.
 * 2. Product Q&A: given a visitor question + relevant products from the
 *    catalog, generate a grounded answer (RAG-style).
 *
 * Both features respect the tenant's AI usage cap (checked before calling).
 *
 * ## AI-Q1 — Injectable deterministic provider contract
 *
 * `matchFaq` and `answerProductQuestion` accept an OPTIONAL server-side
 * `provider` parameter for deterministic Unit testing. The injected provider
 * supports an async `complete(prompt)` method returning the completion text.
 *
 * IMPORTANT — this is an INTERNAL SERVER-SIDE TESTING SEAM only:
 * - It is never exported through any visitor / public API.
 * - It does not enable a public HTTP endpoint for arbitrary LLM responses.
 * - No production environment flag lets visitors supply fake responses.
 * - Production calls (no provider) continue using the existing backend-only
 *   `z-ai-web-dev-sdk` behavior.
 *
 * The injected provider never calls the real network or a public test
 * endpoint — it is a pure in-process function. This lets the reviewer and
 * developer Unit tests exercise deterministic positive AND negative FAQ /
 * Product-Q&A paths without a live LLM.
 *
 * ## Safety guarantees (unchanged for production)
 * - Provider responses are parsed safely (JSON.parse wrapped in try/catch).
 * - Returned FAQ IDs are checked against the supplied FAQ list — an invented
 *   ID never produces an answer.
 * - The REAL stored FAQ answer is always returned, never a provider-invented
 *   answer.
 * - Invalid / empty / failed completions are safe negatives (no positive
 *   answer, no throw).
 * - Provider initialization failures (getZAI) AND generation failures are
 *   both caught.
 * - An unavailable provider never breaks the visitor's already-persisted
 *   message (the caller catches and continues).
 */

import ZAI from 'z-ai-web-dev-sdk'
import { selectUnambiguousFaqs, validateSemanticMatch } from '@/lib/ai/faq-policy'
import {
  retrieveProductCandidates,
  detectAmbiguousCandidates,
  renderGroundedAnswer,
  type ProductCandidate,
} from '@/lib/ai/product-policy'

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

/**
 * Injectable deterministic AI provider — an INTERNAL SERVER-SIDE testing
 * seam. Never exported through visitor / public APIs.
 *
 * `complete(prompt)` returns the completion text (a string). For FAQ
 * matching the expected shape is a JSON object; for Product Q&A it is the
 * raw answer text.
 */
export interface AiProvider {
  complete(prompt: string): Promise<string>
}

export interface FaqMatchResult {
  matched: boolean
  faqPairId: string | null
  answer: string | null
  confidence: number // 0-1
}

/** Clamp a confidence-like number to [0, 1]; non-numbers → 0. */
function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : 0
}

/** Strip ```json fences from a model response (best-effort). */
function stripFences(text: string): string {
  return text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
}

/**
 * Match a visitor message against FAQ pairs using LLM classification.
 *
 * Approach: LLM-based classification (not vector embeddings).
 * Justification: at the scale of a few dozen to a few hundred FAQ pairs,
 * an LLM classification call is simpler to ship correctly than a vector
 * embedding pipeline. The LLM receives the visitor message + the full list
 * of FAQ questions, and returns the ID of the best match (or "none") with
 * a confidence score. This avoids the infrastructure overhead of a vector
 * database while handling semantic equivalence well.
 *
 * For >500 FAQ pairs, we'd switch to a two-stage approach (embedding retrieval
 * → LLM classification of top-K candidates), but that's out of scope for MVP.
 *
 * If `provider` is supplied (server-side test seam), it is used instead of
 * the real SDK. The provider's returned FAQ ID is validated against the
 * supplied list — an invented ID never produces an answer. The REAL stored
 * FAQ answer is always returned, never a provider-invented answer.
 */
export async function matchFaq(
  visitorMessage: string,
  faqPairs: Array<{ id: string; question: string; answer: string }>,
  provider?: AiProvider,
): Promise<FaqMatchResult> {
  // AI-Q3 BLOCKER 3: partition FAQ pairs into UNAMBIGUOUS semantic
  // candidates BEFORE any provider call. Groups of 2+ FAQs that
  // canonicalize to the same question are contradictory/duplicate — ALL
  // their IDs are excluded from the prompt AND from validation. The model
  // can never select an ambiguous ID, even with confidence 1. This is
  // enforced in code (selectUnambiguousFaqs + validateSemanticMatch
  // membership check), not merely described in the LLM prompt.
  const eligible = selectUnambiguousFaqs(faqPairs)

  if (eligible.length === 0) {
    // No unambiguous candidate remains — safe negative WITHOUT calling
    // the provider (BLOCKER 3, point 5). This covers the zero-candidate
    // case AND the all-candidates-ambiguous case.
    return { matched: false, faqPairId: null, answer: null, confidence: 0 }
  }

  const faqList = eligible.map((p, i) => `${i + 1}. [ID:${p.id}] ${p.question}`).join('\n')

  const prompt = `You are a FAQ matching assistant. Given a visitor's message and a list of FAQ questions, determine which FAQ question (if any) is semantically equivalent to the visitor's message.

Visitor message: "${visitorMessage}"

FAQ questions:
${faqList}

Respond with ONLY a JSON object (no markdown, no explanation):
- If there's a match (confidence >= 0.7): {"matched": true, "id": "the-faq-id", "confidence": 0.85}
- If no good match: {"matched": false, "id": null, "confidence": 0.3}

Rules:
- "semantically equivalent" means the same intent/question, even if worded differently
- If the visitor is asking about something not in the FAQ, return matched: false
- Confidence should reflect how certain you are (0.0 to 1.0)`

  // Both provider initialization AND generation failures are caught here.
  // getZAI() is inside the try so a SDK init failure is a safe negative.
  try {
    let text: string
    if (provider) {
      text = (await provider.complete(prompt)) ?? ''
    } else {
      const zai = await getZAI()
      const response = await zai.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are a FAQ matching assistant. Respond only with JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      })
      text = response.choices[0]?.message?.content?.trim() ?? ''
    }

    const jsonStr = stripFences(text)
    const parsed: unknown = JSON.parse(jsonStr)

    // AI-Q3: strict semantic confidence gate against the UNAMBIGUOUS
    // candidate list. A positive result requires matched===true (strict
    // boolean), a valid exact-member string ID (must be in `eligible` —
    // an ambiguous ID can never pass because it was excluded from the
    // prompt and from this list), a finite numeric confidence in [0.7, 1],
    // and a nonblank stored answer. No default confidence. No coercion.
    // No clamping into acceptance.
    const validated = validateSemanticMatch(parsed, eligible)
    if (validated) {
      return {
        matched: true,
        faqPairId: validated.faqPair.id,
        // ALWAYS the REAL stored answer — never a provider-invented answer.
        answer: validated.faqPair.answer,
        confidence: validated.confidence,
      }
    }

    // Not matched, ID not found, confidence below threshold/invalid, or
    // the stored answer was blank. Preserve a valid numeric confidence
    // (clamped to [0,1]) but NEVER produce an answer.
    let preservedConfidence = 0
    if (
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).confidence === 'number' &&
      Number.isFinite((parsed as Record<string, unknown>).confidence)
    ) {
      preservedConfidence = clamp01((parsed as Record<string, unknown>).confidence as number)
    }
    return { matched: false, faqPairId: null, answer: null, confidence: preservedConfidence }
  } catch (e) {
    console.error('[ai:matchFaq] error:', e instanceof Error ? e.message : e)
    return { matched: false, faqPairId: null, answer: null, confidence: 0 }
  }
}

export interface ProductQaResult {
  answered: boolean
  answer: string | null
  productIds: string[]
}

/**
 * Answer a product question using GROUNDED retrieval (AI-Q4).
 *
 * Flow:
 *   1. Retrieve eligible product candidates via `retrieveProductCandidates`
 *      (word-boundary token matching, generic-term filtering, deterministic
 *      ranking, max 10). Zero candidates → return negative, NO provider call.
 *   2. Detect ambiguity (same name, conflicting price/availability) →
 *      fail closed.
 *   3. If `provider` is supplied (AI-Q1 test seam) or the real ZAI SDK is
 *      available, call the provider ONCE. The provider's output is a
 *      go/no-go signal ONLY — a nonblank response means "proceed to render."
 *      The provider's text is NEVER used as the answer.
 *   4. If the provider output is blank or the provider throws → safe negative.
 *   5. Render the deterministic grounded answer from persisted product facts
 *      (name, price, currency, availability) via `renderGroundedAnswer`.
 *      The answer NEVER includes model-generated prices, stock claims,
 *      discounts, URLs, or injection text.
 *
 * AI-Q1 compatibility: the injected provider is called once on a positive
 * match. The provider's nonblank output drives the deterministic grounded
 * render. The provider's text itself never overrides persisted product
 * facts. Zero candidates → zero provider calls.
 *
 * Currency grounding: IRT prices render in Toman. Non-IRT currencies
 * (USD, etc.) render in their original unit. Unsupported currencies fail
 * closed. No currency conversions or exchange rates are invented.
 */
export async function answerProductQuestion(
  visitorMessage: string,
  products: Array<{ id: string; name: string; description: string; price: number; availability: string; currency?: string }>,
  provider?: AiProvider,
): Promise<ProductQaResult> {
  if (products.length === 0) {
    return { answered: false, answer: null, productIds: [] }
  }

  // 1. Deterministic retrieval — word-boundary token matching.
  // No provider call if zero candidates.
  const candidates = retrieveProductCandidates(visitorMessage, products as ReadonlyArray<ProductCandidate>)
  if (candidates.length === 0) {
    return { answered: false, answer: null, productIds: [] }
  }

  // 2. Ambiguity detection — same name, conflicting price/availability.
  const ambiguous = detectAmbiguousCandidates(candidates)
  if (ambiguous.size > 0) {
    // The query does not distinguish between conflicting products.
    // Fail closed rather than guess a single price.
    return { answered: false, answer: null, productIds: [] }
  }

  // 3. Call the provider ONCE — the output is a go/no-go signal.
  // The provider's text is NEVER used as the answer.
  const productContext = candidates.map(p =>
    `- ${p.name}: ${p.description} | Price: ${p.price} ${(p.currency ?? 'IRT').toUpperCase()} | Availability: ${p.availability}`
  ).join('\n')

  const prompt = `You are a product assistant. A visitor asked about a product. Confirm you understand the question.

Visitor question: "${visitorMessage}"

Available products:
${productContext}

Respond with a brief acknowledgment.`

  try {
    let providerOutput: string
    if (provider) {
      providerOutput = ((await provider.complete(prompt)) ?? '').trim()
    } else {
      const zai = await getZAI()
      const response = await zai.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are a product assistant. Acknowledge the question briefly.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      })
      providerOutput = response.choices[0]?.message?.content?.trim() ?? ''
    }

    // 4. Blank / whitespace-only output → safe negative.
    if (!providerOutput) {
      return { answered: false, answer: null, productIds: [] }
    }

    // 5. Render the deterministic grounded answer from persisted facts.
    // The provider's text is discarded — it was only a go/no-go signal.
    const groundedAnswer = renderGroundedAnswer(candidates)
    if (!groundedAnswer) {
      // Unsupported currency or render failure — fail closed.
      return { answered: false, answer: null, productIds: [] }
    }

    return {
      answered: true,
      answer: groundedAnswer,
      productIds: candidates.map((c) => c.id),
    }
  } catch (e) {
    console.error('[ai:answerProductQuestion] error:', e instanceof Error ? e.message : e)
    return { answered: false, answer: null, productIds: [] }
  }
}
