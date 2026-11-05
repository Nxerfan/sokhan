/**
 * AI-Q4 — Grounded Product Retrieval and Zero-Hallucination Product Q&A.
 *
 * Pure TS — no Prisma, no Next.js, no server-only imports. Safe for Unit
 * testing and server-side import.
 *
 * ## Safe normalization
 *
 * `normalizeProductQuery` produces a canonical form equivalent to
 * `normalizeFaqQuestion` (NFC, Persian/Arabic Yeh+Kaf, ZWNJ→space, NBSP→space,
 * case-fold, trailing ?/؟ strip). Never erases negation, numbers, decimals,
 * percentages, word boundaries, or meaningful punctuation.
 *
 * ## Reliable lexical retrieval
 *
 * `retrieveProductCandidates` uses word-boundary token matching (NOT
 * substring). Generic commerce terms (price, available, buy, محصول, خرید)
 * are stop-worded and act as phrase separators. A product is a candidate
 * only if ALL tokens in at least one non-generic phrase match the product's
 * name/description tokens exactly. This prevents partial-word false
 * positives (pen ≠ pencil, کتاب ≠ کتابخانه) and generic-only queries.
 *
 * ## Product data validation
 *
 * Only products with non-empty ID, non-empty name, finite nonnegative
 * integer price, and a supported availability state are eligible.
 * Malformed records are silently filtered.
 *
 * ## Ambiguity detection
 *
 * Products with identical normalized names but conflicting prices or
 * availability are ambiguous — the question does not distinguish them.
 * `detectAmbiguousCandidates` returns the ambiguous group so the caller
 * can fail closed.
 *
 * ## Grounded answer rendering
 *
 * `renderGroundedAnswer` produces a deterministic, localized string from
 * persisted product facts ONLY. Prices, currencies, and availability come
 * from the DB rows — never from model output. IRT prices render in Toman;
 * non-IRT currencies render in their original unit. Zero is a valid price
 * (rendered as ۰ / رایگان).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductCandidate {
  id: string
  name: string
  description: string
  price: number
  availability: string
  currency?: string
}

export interface RetrievedProduct extends ProductCandidate {
  /** Non-generic query tokens (in original query order) that matched this product. */
  matchedTerms: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum candidates returned by retrieveProductCandidates. */
export const MAX_PRODUCT_CANDIDATES = 10

/** Supported availability states. */
const SUPPORTED_AVAILABILITY = new Set(['in_stock', 'limited', 'out_of_stock'])

/**
 * Generic commerce / question stop-words in Persian and English.
 * These never independently qualify a product. They also act as phrase
 * separators in multi-product queries (e.g. "و" = "and").
 */
const GENERIC_TOKENS = new Set<string>([
  // Persian question / commerce generics
  'و', 'در', 'به', 'از', 'برای', 'که', 'این', 'آن', 'هست', 'است', 'می',
  'چه', 'چیست', 'چطور', 'چگونه', 'کجا', 'کی', 'کدام', 'آیا', 'نه', 'اما',
  'یا', 'هم', 'تا', 'با', 'مثل', 'مانند',
  'قیمت', 'چنده', 'چقدر', 'چند', 'موجود', 'موجودی', 'داشتن', 'دارید',
  'خرید', 'فروش', 'محصول', 'محصولات', 'کالا', 'کالاها',
  'لطفا', 'خواهشمندم', 'کنید', 'بفرمایید', 'سلام', 'تشکر', 'ممنون',
  'شد', 'شده', 'بود', 'باشد', 'کنم', 'کنید', 'می‌شود', 'میشه', 'هستش',
  'را', 'همه', 'لیست', 'فهرست',
  // English question / commerce generics
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'you', 'your', 'we', 'our',
  'i', 'my', 'he', 'she', 'his', 'her',
  'what', 'when', 'where', 'who', 'why', 'which', 'how',
  'much', 'many', 'price', 'prices', 'cost', 'costs',
  'available', 'availability', 'stock', 'in', 'out', 'of',
  'buy', 'purchase', 'product', 'products', 'item', 'items',
  'please', 'hello', 'hi', 'and', 'or', 'but', 'for', 'to', 'from',
  'with', 'about', 'me', 'us',
])

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a product query (or visitor message) into a canonical form.
 *
 * Same safe normalization as normalizeFaqQuestion: NFC → ZWNJ→space →
 * NBSP/tab→space → Arabic Yeh→Persian Yeh → Arabic Kaf→Persian Kaf →
 * whitespace collapse → trim → lowercase → strip trailing ?/؟ → trim.
 *
 * Deterministic and idempotent. Blank-safe (returns '' for whitespace).
 */
export function normalizeProductQuery(input: string): string {
  if (typeof input !== 'string') return ''
  let s = input.normalize('NFC')
  s = s.replace(/\u200C/g, ' ')
  s = s.replace(/[\u00A0\t]/g, ' ')
  s = s.replace(/\u064A/g, '\u06CC')
  s = s.replace(/\u0643/g, '\u06A9')
  s = s.replace(/\s+/g, ' ')
  s = s.trim()
  s = s.toLowerCase()
  s = s.replace(/[?؟]+$/, '')
  s = s.trim()
  return s
}

// ---------------------------------------------------------------------------
// Product eligibility validation
// ---------------------------------------------------------------------------

/**
 * Validate a single product's metadata for eligibility.
 * Returns true only if ALL fields are valid:
 *   - id: non-empty string
 *   - name: non-empty string
 *   - price: finite, nonnegative integer
 *   - availability: one of the supported states
 *   - currency (if present): non-empty string
 */
export function isEligibleProduct(p: unknown): p is ProductCandidate {
  if (p === null || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id) return false
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false
  if (typeof obj.price !== 'number' || !Number.isFinite(obj.price)) return false
  if (!Number.isInteger(obj.price) || obj.price < 0) return false
  if (typeof obj.availability !== 'string' || !SUPPORTED_AVAILABILITY.has(obj.availability)) return false
  if (obj.currency !== undefined && (typeof obj.currency !== 'string' || !obj.currency.trim())) return false
  return true
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/** Tokenize a normalized string into whitespace-separated tokens. */
function tokenize(s: string): string[] {
  const trimmed = s.trim()
  if (!trimmed) return []
  return trimmed.split(/\s+/)
}

/** Build a set of normalized tokens from a product's name + description. */
function productTokenSet(p: ProductCandidate): Set<string> {
  const combined = normalizeProductQuery(p.name + ' ' + p.description)
  return new Set(tokenize(combined))
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Split a normalized query into phrases at generic-token boundaries.
 * A phrase is a maximal run of consecutive non-generic tokens.
 */
function splitIntoPhrases(normalizedQuery: string): string[][] {
  const tokens = tokenize(normalizedQuery)
  const phrases: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (GENERIC_TOKENS.has(token)) {
      if (current.length > 0) {
        phrases.push(current)
        current = []
      }
    } else {
      current.push(token)
    }
  }
  if (current.length > 0) phrases.push(current)
  return phrases
}

/**
 * Retrieve eligible product candidates for a visitor query.
 *
 * Algorithm:
 *   1. Normalize the query.
 *   2. Split into phrases at generic-token boundaries.
 *   3. If no phrases (all generic or empty) → return [].
 *   4. For each eligible product, check if ALL tokens in at least one
 *      phrase are present in the product's name/description token set.
 *   5. Rank by total phrase-match count (descending), then by product ID
 *      (ascending) for deterministic tie-breaking.
 *   6. Take top MAX_PRODUCT_CANDIDATES (10).
 *
 * Invariants:
 *   - No partial-word false positives (token equality, not substring).
 *   - Generic-only queries produce zero candidates.
 *   - Input DB order does not affect selection (deterministic by ID).
 *   - Candidate IDs are unique.
 *   - Zero candidates → zero model calls (enforced by caller).
 *   - Never mutates input records.
 */
export function retrieveProductCandidates(
  query: string,
  products: ReadonlyArray<ProductCandidate>,
): RetrievedProduct[] {
  const normalizedQuery = normalizeProductQuery(query)
  if (!normalizedQuery) return []

  const phrases = splitIntoPhrases(normalizedQuery)
  if (phrases.length === 0) return []

  // Filter eligible products and build their token sets.
  const eligible: Array<{ product: ProductCandidate; tokens: Set<string> }> = []
  for (const p of products) {
    if (isEligibleProduct(p)) {
      eligible.push({ product: p, tokens: productTokenSet(p) })
    }
  }
  if (eligible.length === 0) return []

  // Match: a product is a candidate if ALL tokens in at least one phrase
  // are in its token set. Collect matched terms per product (in query order).
  const candidates: Array<{
    product: ProductCandidate
    matchCount: number
    matchedTerms: string[]
  }> = []

  for (const { product, tokens } of eligible) {
    let totalMatches = 0
    const matchedTerms: string[] = []
    let isCandidate = false

    for (const phrase of phrases) {
      const allMatch = phrase.every((token) => tokens.has(token))
      if (allMatch) {
        isCandidate = true
        totalMatches += phrase.length
        // Collect matched terms in query order (deduplicated).
        for (const token of phrase) {
          if (!matchedTerms.includes(token)) {
            matchedTerms.push(token)
          }
        }
      }
    }

    if (isCandidate) {
      candidates.push({ product, matchCount: totalMatches, matchedTerms })
    }
  }

  // Rank: higher match count first, then by product ID (ascending) for
  // deterministic tie-breaking independent of input DB order.
  candidates.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    return a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0
  })

  // Take top MAX_PRODUCT_CANDIDATES. IDs are unique by construction (each
  // eligible product appears at most once).
  const top = candidates.slice(0, MAX_PRODUCT_CANDIDATES)

  return top.map((c) => ({
    ...c.product,
    matchedTerms: c.matchedTerms,
  }))
}

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------

/**
 * Detect ambiguous candidates: products with identical normalized names
 * but conflicting prices or availability. If the query does not
 * distinguish them (same matched terms), the caller should fail closed.
 *
 * Returns the set of ambiguous product IDs (products that share a
 * normalized name with at least one other candidate that has a different
 * price or availability).
 */
export function detectAmbiguousCandidates(
  candidates: ReadonlyArray<RetrievedProduct>,
): Set<string> {
  const ambiguous = new Set<string>()
  // Group by normalized name + matchedTerms signature.
  const groups = new Map<string, RetrievedProduct[]>()
  for (const c of candidates) {
    const key = normalizeProductQuery(c.name)
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(c)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // Check for conflicting price or availability.
    const firstPrice = group[0].price
    const firstAvail = group[0].availability
    const hasConflict = group.some(
      (p) => p.price !== firstPrice || p.availability !== firstAvail,
    )
    if (hasConflict) {
      for (const p of group) {
        ambiguous.add(p.id)
      }
    }
  }
  return ambiguous
}

// ---------------------------------------------------------------------------
// Grounded answer rendering
// ---------------------------------------------------------------------------

/** Availability labels in Persian. */
const AVAILABILITY_LABELS: Record<string, string> = {
  in_stock: 'موجود',
  limited: 'محدود',
  out_of_stock: 'ناموجود',
}

/**
 * Render a price in the product's currency.
 * - IRT: render in Toman (تومان).
 * - USD: render as USD.
 * - Other: render the raw currency code.
 * - Unsupported/missing: return null (caller fails closed).
 */
function formatPrice(price: number, currency?: string): { value: string; label: string } | null {
  const cur = (currency ?? 'IRT').trim().toUpperCase()
  // Render the numeric value with Persian digits for IRT, ASCII otherwise.
  const toPersianDigits = (s: string): string =>
    s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06F0 + Number(d)))
  if (cur === 'IRT') {
    return { value: toPersianDigits(String(price)), label: 'تومان' }
  }
  if (cur === 'USD') {
    return { value: String(price), label: 'USD' }
  }
  // Other currencies: render the code as-is. Do NOT convert or guess.
  if (cur && cur !== 'IRT') {
    return { value: String(price), label: cur }
  }
  return null
}

/**
 * Render a deterministic, grounded answer from persisted product facts.
 *
 * The answer includes:
 *   - The matched query terms (in original order)
 *   - The product name (from DB)
 *   - The price (from DB, in the product's currency)
 *   - The availability status (from DB)
 *
 * For price 0: rendered as "رایگان" (free) for IRT.
 * For unsupported currencies: returns null (fail closed).
 *
 * The answer NEVER includes model-generated text, forged prices, stock
 * claims, discounts, or URLs.
 */
export function renderGroundedAnswer(
  candidates: ReadonlyArray<RetrievedProduct>,
): string | null {
  if (candidates.length === 0) return null

  const lines: string[] = []
  for (const c of candidates) {
    const terms = c.matchedTerms.length > 0 ? c.matchedTerms.join(' ') : c.name
    const priceFmt = formatPrice(c.price, c.currency)
    if (!priceFmt) {
      // Unsupported currency — fail closed for this product.
      return null
    }
    const availLabel = AVAILABILITY_LABELS[c.availability] ?? c.availability
    const priceLabel =
      c.price === 0 && (c.currency ?? 'IRT').toUpperCase() === 'IRT'
        ? 'رایگان'
        : `${priceFmt.value} ${priceFmt.label}`
    lines.push(`${terms} — ${c.name}: قیمت ${priceLabel} — وضعیت: ${availLabel}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Full grounded product Q&A (combines retrieval + provider signal + render)
// ---------------------------------------------------------------------------

/**
 * Result of a grounded product Q&A attempt.
 * - `answered: true` + `answer` + `productIds`: a grounded answer was rendered.
 * - `answered: false` + `answer: null` + `productIds: []`: no answer (no
 *   candidates, blank provider, provider exception, ambiguity, or
 *   unsupported currency).
 */
export interface GroundedProductResult {
  answered: boolean
  answer: string | null
  productIds: string[]
}

/**
 * Validate that a provider's output is a nonblank string (the "go" signal).
 * The provider's text is NEVER used as the answer — it only signals that
 * the model acknowledged the request. The actual answer comes from
 * `renderGroundedAnswer`.
 */
function isNonblankSignal(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0
}
