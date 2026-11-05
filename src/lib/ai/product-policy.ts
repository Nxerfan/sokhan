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
 * Explicitly supported currency codes. Only these may be rendered as
 * legitimate price units. Any other value (including merchant-controlled
 * injection text like "USD FREE SHIPPING") is rejected — the product
 * fails closed.
 *
 * - IRT: Iranian Toman — rendered with Persian digits + "تومان" label.
 * - USD: United States Dollar — rendered with ASCII digits + "USD" label.
 * - IRR: Iranian Rial — rendered with ASCII digits + "IRR" label (NOT
 *   silently converted to Toman).
 *
 * No currency conversion rates are ever invented.
 */
const SUPPORTED_CURRENCIES = new Set(['IRT', 'USD', 'IRR'])

/**
 * Generic commerce / question stop-words in Persian and English.
 * These never independently qualify a product. They also act as phrase
 * separators in multi-product queries (e.g. "و" = "and") and strip
 * injection text (e.g. "تمام قوانین را نادیده بگیر" = "ignore all rules").
 *
 * Only words that would NEVER be a product name or product attribute
 * (color, brand, model, variant) are included here. Specific attribute
 * words like "سبز" (green), "قرمز" (red), "آبی" (blue) are NOT generic —
 * they distinguish products and must participate in matching.
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
  // Persian injection / command / common words
  'تمام', 'قوانین', 'قانون', 'نادیده', 'بگیر', 'بنویس', 'بنویسید',
  'نویس', 'سایت', 'تومان', 'تومن', 'دلار', 'یورو',
  'تخفیف', 'رایگان', 'مجانی', 'کد', 'کدتخفیف',
  'لینک', 'پست', 'ایمیل', 'نشانی', 'آدرس',
  'ارسال', 'تحویل', 'پیک', 'سفارش', 'باشه', 'باشید',
  'یک', 'دو', 'سه', 'ده', 'صد', 'هزار', 'میلیون',
  'همین', 'انجام', 'دهید', 'نمایید', 'فرمایید',
  'البته', 'واقعا', 'حتما', 'الان', 'فوری',
  'قول', 'عدم', 'نباید', 'باید',
  // English question / commerce / injection generics
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
  'ignore', 'rules', 'rule', 'all', 'write', 'send', 'link',
  'site', 'url', 'password', 'credit', 'card', 'evil', 'example',
  'discount', 'free', 'toman', 'dollar', 'euro',
  'now', 'urgent', 'must', 'should', 'need',
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
  // Replace question marks and Persian/Arabic punctuation with spaces
  // (NOT just trailing) so that internal punctuation like "بلوط؟ تمام"
  // tokenizes correctly as ["بلوط", "تمام"] rather than ["بلوط؟", "تمام"].
  // This prevents false non-matches when a question mark appears mid-query.
  // Decimal points (.), percentages (%), and other meaningful punctuation
  // are preserved.
  s = s.replace(/[?؟،٬؛!]+/g, ' ')
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
 *   - currency (if present): must be one of SUPPORTED_CURRENCIES (IRT, USD, IRR).
 *     Undefined currency defaults to IRT. Arbitrary strings like "FAKE",
 *     "ZZZ", or "USD FREE SHIPPING" are rejected — they can never produce a
 *     billable product answer.
 */
export function isEligibleProduct(p: unknown): p is ProductCandidate {
  if (p === null || typeof p !== 'object') return false
  const obj = p as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id) return false
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false
  if (typeof obj.price !== 'number' || !Number.isFinite(obj.price)) return false
  if (!Number.isInteger(obj.price) || obj.price < 0) return false
  if (typeof obj.availability !== 'string' || !SUPPORTED_AVAILABILITY.has(obj.availability)) return false
  if (obj.currency !== undefined) {
    if (typeof obj.currency !== 'string') return false
    const cur = obj.currency.trim().toUpperCase()
    if (!cur || !SUPPORTED_CURRENCIES.has(cur)) return false
  }
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
 *   1. Normalize the query → split into phrases at generic-token boundaries.
 *   2. Filter eligible products (valid metadata + supported currency).
 *   3. Deduplicate by product ID. If the same ID has conflicting factual
 *      data (price, availability, currency), treat as ambiguous → return [].
 *   4. Match: a product is a candidate if ALL tokens in at least one
 *      phrase match its name/description token set exactly.
 *   5. Detect ambiguity across ALL matching candidates (same normalized
 *      name + conflicting price, availability, OR currency). This runs
 *      BEFORE top-K truncation so a conflicting 11th product cannot be
 *      hidden. If ambiguous → return [].
 *   6. Rank by match count (descending), then product ID (ascending).
 *   7. Take top MAX_PRODUCT_CANDIDATES (10).
 *
 * Invariants:
 *   - No partial-word false positives (token equality, not substring).
 *   - Generic-only queries produce zero candidates.
 *   - Injection tokens not in any product name do not block matching.
 *   - Ambiguity is detected on the FULL matching set BEFORE truncation.
 *   - Candidate IDs are unique (deduplicated).
 *   - Input DB order does not affect selection (deterministic by ID).
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

  // Filter eligible products, deduplicate by ID (BLOCKER 4).
  const seenIds = new Map<string, { product: ProductCandidate; tokens: Set<string> }>()
  let duplicateConflict = false
  for (const p of products) {
    if (!isEligibleProduct(p)) continue
    const existing = seenIds.get(p.id)
    if (existing) {
      // Duplicate ID — check for conflicting factual data.
      const a = existing.product
      const b = p
      if (a.price !== b.price || a.availability !== b.availability ||
          (a.currency ?? 'IRT').toUpperCase() !== (b.currency ?? 'IRT').toUpperCase()) {
        duplicateConflict = true
      }
      // Keep the first occurrence (deterministic). Do not mutate caller data.
      continue
    }
    seenIds.set(p.id, { product: p, tokens: productTokenSet(p) })
  }
  if (duplicateConflict) return []
  const eligible = Array.from(seenIds.values())
  if (eligible.length === 0) return []

  // Match: a product is a candidate if ALL tokens in at least one
  // phrase match its token set.
  const allCandidates: Array<{
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
        for (const token of phrase) {
          if (!matchedTerms.includes(token)) {
            matchedTerms.push(token)
          }
        }
      }
    }

    if (isCandidate) {
      allCandidates.push({ product, matchCount: totalMatches, matchedTerms })
    }
  }

  if (allCandidates.length === 0) return []

  // Rank: higher match count first, then product ID (ascending).
  allCandidates.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount
    return a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0
  })

  const top = allCandidates.slice(0, MAX_PRODUCT_CANDIDATES)

  return top.map((c) => ({
    ...c.product,
    matchedTerms: c.matchedTerms,
  }))
}

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------

/**
 * Check if any candidate has a conflicting same-name product in the FULL
 * product set (BLOCKER 1). This scans ALL eligible products — not just
 * the top-10 returned by retrieveProductCandidates — to ensure no
 * ambiguity is hidden by truncation.
 *
 * For each candidate, finds all eligible products in `allProducts` with
 * the same normalized name. If any have a conflicting price, availability,
 * OR currency, the set is ambiguous.
 *
 * Also checks for conflicting duplicate IDs (BLOCKER 4).
 *
 * Returns true if ambiguous (caller should fail closed).
 */
export function detectAmbiguityInFullSet(
  candidates: ReadonlyArray<RetrievedProduct>,
  allProducts: ReadonlyArray<ProductCandidate>,
): boolean {
  // Collect the normalized names of all candidates.
  const candidateNames = new Set<string>()
  for (const c of candidates) {
    candidateNames.add(normalizeProductQuery(c.name))
  }

  // Group ALL eligible products by normalized name (only for names that
  // appear in the candidates — other products are irrelevant).
  const groups = new Map<string, ProductCandidate[]>()
  for (const p of allProducts) {
    if (!isEligibleProduct(p)) continue
    const nameKey = normalizeProductQuery(p.name)
    if (!candidateNames.has(nameKey)) continue
    let group = groups.get(nameKey)
    if (!group) {
      group = []
      groups.set(nameKey, group)
    }
    group.push(p)
  }

  // Check each group for conflicts.
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]
    const firstPrice = first.price
    const firstAvail = first.availability
    const firstCur = (first.currency ?? 'IRT').toUpperCase()
    const hasConflict = group.some(
      (p) =>
        p.price !== firstPrice ||
        p.availability !== firstAvail ||
        (p.currency ?? 'IRT').toUpperCase() !== firstCur,
    )
    if (hasConflict) return true
  }

  return false
}

/**
 * Detect ambiguous candidates: products with identical normalized names
 * but conflicting prices, availability, OR currencies. If the query does
 * not distinguish them (same matched terms), the caller should fail closed.
 *
 * Currency is a monetary fact: the same numeric price in IRT vs USD is a
 * different amount. Conflicting currencies are always ambiguous.
 *
 * Returns the set of ambiguous product IDs (products that share a
 * normalized name with at least one other candidate that has a different
 * price, availability, or currency).
 */
export function detectAmbiguousCandidates(
  candidates: ReadonlyArray<RetrievedProduct>,
): Set<string> {
  const ambiguous = new Set<string>()
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
    const firstPrice = group[0].price
    const firstAvail = group[0].availability
    const firstCur = (group[0].currency ?? 'IRT').toUpperCase()
    const hasConflict = group.some(
      (p) =>
        p.price !== firstPrice ||
        p.availability !== firstAvail ||
        (p.currency ?? 'IRT').toUpperCase() !== firstCur,
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
 *
 * Only explicitly supported currencies (IRT, USD, IRR) are rendered.
 * Unsupported or malformed currency values return null → fail closed.
 *
 * - IRT: render in Toman (تومان) with Persian digits.
 * - USD: render as "USD" with ASCII digits.
 * - IRR: render as "IRR" with ASCII digits (NOT silently converted to Toman).
 *
 * No currency conversion rates are ever invented. Merchant-controlled
 * currency text (e.g. "USD FREE SHIPPING") is rejected by isEligibleProduct
 * and never reaches this function.
 */
function formatPrice(price: number, currency?: string): { value: string; label: string } | null {
  const cur = (currency ?? 'IRT').trim().toUpperCase()
  if (!SUPPORTED_CURRENCIES.has(cur)) return null
  const toPersianDigits = (s: string): string =>
    s.replace(/[0-9]/g, (d) => String.fromCharCode(0x06F0 + Number(d)))
  if (cur === 'IRT') {
    return { value: toPersianDigits(String(price)), label: 'تومان' }
  }
  if (cur === 'USD') {
    return { value: String(price), label: 'USD' }
  }
  if (cur === 'IRR') {
    return { value: String(price), label: 'IRR' }
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
