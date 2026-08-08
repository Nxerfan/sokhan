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
 */

import ZAI from 'z-ai-web-dev-sdk'

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

async function getZAI() {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}

export interface FaqMatchResult {
  matched: boolean
  faqPairId: string | null
  answer: string | null
  confidence: number // 0-1
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
 */
export async function matchFaq(
  visitorMessage: string,
  faqPairs: Array<{ id: string; question: string; answer: string }>,
): Promise<FaqMatchResult> {
  if (faqPairs.length === 0) {
    return { matched: false, faqPairId: null, answer: null, confidence: 0 }
  }

  const zai = await getZAI()

  const faqList = faqPairs.map((p, i) => `${i + 1}. [ID:${p.id}] ${p.question}`).join('\n')

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

  try {
    const response = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a FAQ matching assistant. Respond only with JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    })

    const text = response.choices[0]?.message?.content?.trim() || ''
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(jsonStr)

    if (parsed.matched && parsed.id) {
      const faq = faqPairs.find(f => f.id === parsed.id)
      if (faq) {
        return {
          matched: true,
          faqPairId: faq.id,
          answer: faq.answer,
          confidence: Math.min(1, Math.max(0, parsed.confidence || 0.7)),
        }
      }
    }

    return { matched: false, faqPairId: null, answer: null, confidence: parsed.confidence || 0 }
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
 * Answer a product question using RAG (Retrieval-Augmented Generation).
 *
 * Approach: retrieve relevant products from the catalog (by keyword match
 * in the product name/description), then generate a grounded answer using
 * the LLM. The LLM is instructed to only use the provided product data —
 * no hallucination.
 */
export async function answerProductQuestion(
  visitorMessage: string,
  products: Array<{ id: string; name: string; description: string; price: number; availability: string }>,
): Promise<ProductQaResult> {
  if (products.length === 0) {
    return { answered: false, answer: null, productIds: [] }
  }

  const zai = await getZAI()

  const messageWords = visitorMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const relevant = products.filter(p => {
    const text = (p.name + ' ' + p.description).toLowerCase()
    return messageWords.some(word => text.includes(word))
  }).slice(0, 10)

  if (relevant.length === 0) {
    return { answered: false, answer: null, productIds: [] }
  }

  const productContext = relevant.map(p =>
    `- ${p.name}: ${p.description} | Price: ${p.price} Toman | Availability: ${p.availability}`
  ).join('\n')

  const prompt = `You are a product assistant for a store. A visitor asked a question. Answer using ONLY the product data below. Do not make up prices or availability.

Visitor question: "${visitorMessage}"

Available products:
${productContext}

Rules:
- Answer in the same language as the visitor's question
- Only mention products from the list above
- If no product matches the question, say you don't have that product
- Be concise and helpful
- Include the price in Toman if relevant`

  try {
    const response = await zai.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a helpful product assistant. Answer using only the provided product data.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    })

    const answer = response.choices[0]?.message?.content?.trim() || ''
    if (!answer) {
      return { answered: false, answer: null, productIds: [] }
    }

    return {
      answered: true,
      answer,
      productIds: relevant.map(p => p.id),
    }
  } catch (e) {
    console.error('[ai:answerProductQuestion] error:', e instanceof Error ? e.message : e)
    return { answered: false, answer: null, productIds: [] }
  }
}
