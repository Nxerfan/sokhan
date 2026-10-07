/**
 * WooCommerce product catalog connector.
 *
 * Syncs a tenant's WooCommerce store into the internal `Product` table so that
 * AI product Q&A and the dashboard can read product data WITHOUT making a live
 * WooCommerce API call per message (the task's explicit constraint).
 *
 * Authentication: WooCommerce REST API v3 supports HTTP Basic Auth with the
 * store's REST consumer key + consumer secret (generated under
 * WooCommerce → Settings → Advanced → REST API). The credentials are sent as
 * `Authorization: Basic base64(consumerKey:consumerSecret)`.
 *
 * Endpoint: `GET {storeUrl}/wp-json/wc/v3/products?per_page=100&page=N`
 *
 * Pagination: WooCommerce signals more pages via the `Link` header
 * (`<...>; rel="next"`), NOT by returning an empty array. We follow `next`
 * links until none remain (with a hard ceiling to defend against misbehaving
 * servers). The `X-WP-TotalPages` header is used as an additional sanity cap.
 *
 * Price mapping: WooCommerce returns `price` as a decimal string in the store's
 * configured currency (e.g. `"290000.00"` for an Iranian store using Toman, or
 * `"12.99"` for a USD store). Our internal Product model stores prices as
 * integer Toman. We round the parsed float to the nearest integer — this is
 * correct for Iranian Toman-configured stores (the primary deployment target)
 * and the best available heuristic for others. A future improvement could read
 * the store's `currency` field and convert IRR → Toman (÷10) when appropriate.
 */

import { db, withTenant } from '@/lib/db'
import { safeFetch, assertPublicUrl, SsrfError, validateOutboundUrl } from '@/lib/security/ssrf-guard'

export interface WooCommerceConfig {
  /** Store root URL, e.g. `https://shop.example.com`. No trailing slash. */
  storeUrl: string
  /** REST API consumer key (starts with `ck_`). */
  consumerKey: string
  /** REST API consumer secret (starts with `cs_`). */
  consumerSecret: string
}

export interface ProductSyncResult {
  synced: number
  created: number
  updated: number
  errors: string[]
}

/** Max pages to fetch per sync — defends against a misbehaving Link header. */
const MAX_PAGES_PER_SYNC = 50
/** Per-page request size (WooCommerce allows up to 100). */
const PER_PAGE = 100

/**
 * Strip HTML tags from a string and collapse whitespace. Used to convert
 * WooCommerce's HTML product descriptions to plain text for AI product Q&A.
 *
 * We avoid pulling in a DOM parser dependency — descriptions are simple enough
 * for a regex pass. This handles <p>, <br>, <strong>, <ul>/<li>, &entities;.
 */
function stripHtml(html: string): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '') // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Convert WooCommerce price string to integer Toman. */
function toTomanPrice(price: string | null | undefined): number {
  if (!price) return 0
  const n = Number.parseFloat(price)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

/** Map WooCommerce stock_status to our availability enum. */
function mapAvailability(stockStatus: string | null | undefined): string {
  switch (stockStatus) {
    case 'instock':
      return 'in_stock'
    case 'outofstock':
      return 'out_of_stock'
    case 'onbackorder':
      return 'limited'
    default:
      return 'in_stock'
  }
}

/**
 * Normalize a user-supplied store URL: trim whitespace, strip trailing slashes,
 * and accept it as-is (we don't enforce https here — the caller may be on a
 * localhost dev store). An empty/invalid URL is rejected by the caller.
 */
function normalizeStoreUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

interface WooProduct {
  id: number
  name: string
  slug?: string
  permalink?: string
  sku?: string
  price?: string
  regular_price?: string
  sale_price?: string
  description?: string
  short_description?: string
  stock_status?: string
  manage_stock?: boolean
  stock_quantity?: number | null
  type?: string
  status?: string
  categories?: Array<{ id: number; name: string; slug: string }>
  images?: Array<{ id: number; src: string; alt?: string }>
}

/**
 * Fetch a single page of WooCommerce products. Returns the parsed products + the
 * `next` page URL extracted from the Link header (or null if no more pages).
 *
 * Throws an Error with a structured message on auth/rate-limit/network failure
 * so the caller can record it in the `errors` array and continue (or abort).
 *
 * Dependency injection: the optional `__deps.safeFetch` parameter is used ONLY
 * by behavioral tests to inject a mocked fetch (so tests can exercise the
 * Link-header parsing + cross-origin rejection code path WITHOUT real HTTP).
 * Production callers omit `__deps`, in which case `safeFetch` from
 * `@/lib/security/ssrf-guard` is used — production behavior is unchanged.
 */
export type SafeFetchFn = (
  urlStr: string,
  options?: RequestInit & {
    timeoutMs?: number
    maxRedirects?: number
    allowedOrigin?: string
  },
) => Promise<Response>

export interface FetchProductPageDeps {
  /** Injectable safeFetch — tests only. Defaults to the production safeFetch. */
  safeFetch?: SafeFetchFn
}

export async function fetchProductPage(
  url: string,
  config: WooCommerceConfig,
  page: number,
  __deps?: FetchProductPageDeps,
): Promise<{ products: WooProduct[]; nextUrl: string | null }> {
  const fetchFn: SafeFetchFn = __deps?.safeFetch ?? safeFetch
  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64')
  const urlObj = new URL(url)
  // Ensure per_page + page are set / overridden on this request.
  urlObj.searchParams.set('per_page', String(PER_PAGE))
  urlObj.searchParams.set('page', String(page))

  const storeOrigin = new URL(normalizeStoreUrl(config.storeUrl)).origin
  let res: Response
  try {
    res = await fetchFn(urlObj.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'User-Agent': 'Sukhan-Connector/1.0',
      },
      cache: 'no-store',
      timeoutMs: 15000,
      maxRedirects: 3,
      allowedOrigin: storeOrigin,
    })
  } catch (err: any) {
    // Safe error — no credentials, no raw URLs
    if (err instanceof SsrfError) throw err
    throw new Error(`WooCommerce request failed (page ${page}): ${err?.code ?? 'network_error'}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('WooCommerce authentication failed — check consumer key/secret (401/403)')
  }
  if (res.status === 404) {
    // SECURITY: never include the full URL in error messages — it may
    // contain a malformed-but-accepted path or query that was used as an
    // attack vector. Surface only the hostname + page + status.
    throw new Error(
      `WooCommerce endpoint not found (404) — verify storeUrl and that WC REST API is enabled (host: ${urlObj.hostname}, page: ${page})`,
    )
  }
  if (res.status === 429) {
    // Respect Retry-After if present; we still surface an error to the caller.
    const retryAfter = res.headers.get('Retry-After')
    throw new Error(
      `WooCommerce rate limit hit (429)${retryAfter ? ` — retry after ${retryAfter}s` : ''}`,
    )
  }
  if (res.status >= 500) {
    throw new Error(`WooCommerce server error (${res.status}) on page ${page}`)
  }
  if (!res.ok) {
    throw new Error(`WooCommerce request failed (${res.status}) on page ${page}`)
  }

  let products: WooProduct[]
  try {
    products = (await res.json()) as WooProduct[]
  } catch (err: any) {
    throw new Error(`WooCommerce returned non-JSON body on page ${page}: ${err?.message ?? ''}`)
  }

  if (!Array.isArray(products)) {
    throw new Error(`WooCommerce returned unexpected payload shape on page ${page}`)
  }

  // Determine next page from the Link header. WooCommerce emits:
  //   Link: <https://shop.example.com/wp-json/wc/v3/products?page=2>; rel="next"
  // We follow it but also cap by X-WP-TotalPages as a sanity check.
  //
  // SECURITY: a cross-origin or otherwise unsafe Link header URL is NOT
  // silently treated as "end of pagination" (nextUrl=null). Doing so would
  // mask a security failure as a benign end-of-data, leaving the operator
  // with no signal that pagination was truncated by a guard rather than
  // exhausted. Instead we throw a bounded SsrfError so the caller can
  // distinguish "no more pages" (nextUrl=null, no error) from
  // "pagination blocked by SSRF guard" (throw). The X-WP-TotalPages
  // fallback only fires when there's NO Link header at all.
  const linkHeader = res.headers.get('Link') ?? res.headers.get('link') ?? ''
  let nextUrl: string | null = null
  if (linkHeader) {
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i)
    if (match) {
      // Validate Link header URL: SSRF + same-origin enforcement.
      // Both checks throw bounded SsrfError on failure — propagated up
      // as an explicit security failure (not a silent end-of-pagination).
      let linkUrl: URL
      try {
        linkUrl = new URL(match[1])
      } catch {
        throw new SsrfError('Link header URL is malformed', 'ssrf_link_malformed')
      }
      if (linkUrl.origin !== storeOrigin) {
        // Cross-origin Link header — never forward credentials. Throw so
        // the sync aborts with a clear security signal rather than silently
        // truncating pagination (which would look like normal end-of-data).
        throw new SsrfError(
          'Cross-origin Link header forbidden',
          'ssrf_cross_origin_link',
        )
      }
      // Same-origin — but still validate it's not a private IP / SSRF
      // attempt (the host could have been repointed to internal infra
      // between syncs). Throws SsrfError on failure.
      await assertPublicUrl(match[1])
      nextUrl = match[1]
    }
  }

  // Fallback: if no Link header, check X-WP-TotalPages.
  if (!nextUrl) {
    const totalPages = Number.parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10)
    if (Number.isFinite(totalPages) && totalPages > page) {
      nextUrl = urlObj.toString() // re-request with page+1
    }
  }

  return { products, nextUrl }
}

/**
 * Upsert a single WooCommerce product into the internal Product table.
 *
 * Lookup key: (tenantId, externalSource='woocommerce', externalId=wooId).
 * The Prisma tenant-scoping extension auto-injects `tenantId` on the where
 * clause, so we filter by externalSource+externalId only. The tenantId is
 * still passed explicitly on create to satisfy the "all Prisma writes must
 * pass tenantId explicitly" convention.
 */
async function upsertProduct(
  tenantId: string,
  woo: WooProduct,
): Promise<{ created: boolean }> {
  const externalId = String(woo.id)
  const existing = await db.product.findFirst({
    where: { externalSource: 'woocommerce', externalId },
    select: { id: true },
  })

  const name = (woo.name ?? '').trim() || `WooCommerce product #${woo.id}`
  const price = toTomanPrice(woo.price ?? woo.regular_price)
  const description = stripHtml(woo.description ?? woo.short_description ?? '')
  const availability = mapAvailability(woo.stock_status)
  const sku = woo.sku && woo.sku.trim() ? woo.sku.trim() : null

  // Raw payload kept in metadata for debugging + future field expansion.
  const metadata = {
    wooId: woo.id,
    slug: woo.slug ?? null,
    permalink: woo.permalink ?? null,
    regularPrice: woo.regular_price ?? null,
    salePrice: woo.sale_price ?? null,
    type: woo.type ?? null,
    status: woo.status ?? null,
    manageStock: woo.manage_stock ?? false,
    stockQuantity: woo.stock_quantity ?? null,
    stockStatus: woo.stock_status ?? null,
    categories: woo.categories ?? [],
    images: woo.images ?? [],
    syncedAt: new Date().toISOString(),
  }

  if (existing) {
    await db.product.update({
      where: { id: existing.id },
      data: {
        name,
        description,
        price,
        availability,
        sku,
        metadata: metadata as any,
      },
    })
    return { created: false }
  }

  await db.product.create({
    data: {
      tenantId,
      name,
      description,
      price,
      currency: 'IRT',
      availability,
      sku,
      externalId,
      externalSource: 'woocommerce',
      metadata: metadata as any,
    },
  })
  return { created: true }
}

/**
 * Sync all products from the configured WooCommerce store into the tenant's
 * internal Product catalog. Idempotent — re-running updates existing rows.
 *
 * Errors are collected (per-page) and the sync continues with the next page
 * unless the error is fatal (auth, rate-limit, or the first page fails — in
 * which case there's nothing to sync). The returned `errors` array lets the
 * caller surface partial-failure warnings to the dashboard.
 */
export async function syncWooCommerceProducts(
  tenantId: string,
  config: WooCommerceConfig,
): Promise<ProductSyncResult> {
  return withTenant(tenantId, async () => {
  const storeUrl = normalizeStoreUrl(config.storeUrl)
  if (!storeUrl) {
    return { synced: 0, created: 0, updated: 0, errors: ['storeUrl is required'] }
  }
  if (!config.consumerKey || !config.consumerSecret) {
    return {
      synced: 0,
      created: 0,
      updated: 0,
      errors: ['consumerKey and consumerSecret are required'],
    }
  }

  // Revalidate store URL on every sync (DNS can change)
  try {
    await validateOutboundUrl(storeUrl)
  } catch (e: any) {
    return { synced: 0, created: 0, updated: 0, errors: [`Store URL validation failed: ${e?.message ?? e}`] }
  }

  const endpoint = `${storeUrl}/wp-json/wc/v3/products`
  const errors: string[] = []
  let synced = 0
  let created = 0
  let updated = 0
  let page = 1
  let nextUrl: string | null = endpoint
  let firstPageSucceeded = false

  while (nextUrl && page <= MAX_PAGES_PER_SYNC) {
    let result: { products: WooProduct[]; nextUrl: string | null }
    try {
      result = await fetchProductPage(nextUrl === endpoint ? endpoint : nextUrl, config, page)
      firstPageSucceeded = true
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      // If the very first page fails, this is almost certainly a config issue
      // (auth / wrong URL / no WC REST API). Abort — no point paging further.
      if (!firstPageSucceeded) {
        return { synced: 0, created: 0, updated: 0, errors: [msg] }
      }
      // Mid-sync page failure — record and abort the rest of the pagination.
      errors.push(msg)
      break
    }

    const { products, nextUrl: next } = result

    for (const woo of products) {
      // Skip products that aren't `publish` (i.e. drafts/private) — they
      // shouldn't surface in customer-facing chat AI.
      if (woo.status && woo.status !== 'publish') continue
      try {
        const { created: wasCreated } = await upsertProduct(tenantId, woo)
        synced++
        if (wasCreated) created++
        else updated++
      } catch (err: any) {
        errors.push(
          `Failed to upsert product #${woo.id} (${woo.name ?? 'unnamed'}): ${err?.message ?? String(err)}`,
        )
      }
    }

    nextUrl = next
    page++
    // If the Link header gave us a fully-qualified URL we use it directly on
    // the next loop — but we still increment `page` so the MAX_PAGES_PER_SYNC
    // guard works.
    if (nextUrl && nextUrl !== endpoint) {
      // Reuse the URL from the Link header verbatim; the fetchProductPage
      // call will set per_page + page on it again.
      // (We pass the existing nextUrl; page counter is incremented above.)
    }
  }

  return { synced, created, updated, errors }
  })
}

/** Convenience helper: mask the consumer secret for display in the dashboard. */
export function maskConsumerSecret(secret: string | undefined | null): string {
  if (!secret) return ''
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}••••••${secret.slice(-4)}`
}

/**
 * Validate a WooCommerce config shape before persisting.
 *
 * storeUrl strict checks (in addition to http(s) scheme):
 *   - reject embedded credentials (user:pass@) — these would be sent
 *     as Basic Auth headers by `new URL()` and could leak via logs
 *   - reject missing/empty hostname (scheme-only strings like "https://")
 *   - reject query string and fragment — storeUrl must be the bare origin
 */
export function validateWooCommerceConfig(
  cfg: Partial<WooCommerceConfig> | null | undefined,
): string[] {
  const errs: string[] = []
  if (!cfg) {
    errs.push('config is required')
    return errs
  }
  if (!cfg.storeUrl || typeof cfg.storeUrl !== 'string') {
    errs.push('storeUrl is required')
  } else {
    try {
      const u = new URL(cfg.storeUrl)
      if (!['http:', 'https:'].includes(u.protocol)) {
        errs.push('storeUrl must be http(s)')
      }
      // Reject embedded credentials — these would be silently sent as
      // HTTP Basic Auth headers by `fetch` and could leak via logs.
      if (u.username || u.password) {
        errs.push('storeUrl must not contain credentials')
      }
      // Reject missing/empty hostname (scheme-only strings like "https://").
      if (!u.hostname || u.hostname.trim() === '') {
        errs.push('storeUrl must have a hostname')
      }
      // storeUrl must be the bare origin — a path/query/fragment is not
      // supported (the sync builds paths off the origin).
      if (u.pathname && u.pathname !== '/') {
        errs.push('storeUrl must not contain a path')
      }
      if (u.search) {
        errs.push('storeUrl must not contain a query string')
      }
      if (u.hash) {
        errs.push('storeUrl must not contain a fragment')
      }
    } catch {
      errs.push('storeUrl is not a valid URL')
    }
  }
  if (!cfg.consumerKey || typeof cfg.consumerKey !== 'string') {
    errs.push('consumerKey is required')
  }
  if (!cfg.consumerSecret || typeof cfg.consumerSecret !== 'string') {
    errs.push('consumerSecret is required')
  }
  return errs
}
