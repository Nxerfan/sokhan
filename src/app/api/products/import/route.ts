import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/**
 * POST: bulk import products from CSV/JSON.
 *
 * Body: { products: [{ name, price, description?, availability?, sku? }] }
 *
 * Validation strategy: validate ALL items BEFORE writing any. This avoids
 * half-imports (10 valid + 5 invalid → only the 10 valid persist, leaving
 * the user with a partial catalog). On any validation error we return 400
 * with the offending item index + field name and write nothing.
 *
 * Hard cap: 500 items per import. Larger batches should be split by the caller.
 */

const MAX_ITEMS_PER_IMPORT = 500
const MAX_NAME_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 5000
const MAX_SKU_LENGTH = 100
const MAX_PRICE = 2147483647 // Postgres INT max
const ALLOWED_AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'limited'])

interface ValidationError {
  error: 'invalid_product'
  index: number
  field: 'name' | 'description' | 'price' | 'availability' | 'sku' | 'products'
}

/** Validate a single product item. Returns the cleaned record or an error. */
function validateItem(
  raw: unknown,
  index: number,
): { ok: true; data: { name: string; description: string; price: number; availability: string; sku: string | null } } | { ok: false; error: ValidationError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { error: 'invalid_product', index, field: 'name' } }
  }
  const item = raw as Record<string, unknown>

  // name: string, trim, non-empty, max 500
  if (typeof item.name !== 'string') {
    return { ok: false, error: { error: 'invalid_product', index, field: 'name' } }
  }
  const name = item.name.trim()
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: { error: 'invalid_product', index, field: 'name' } }
  }

  // description: string if supplied, max 5000. Default to empty string when
  // genuinely absent (undefined or null). A non-string value (number, bool,
  // array) when supplied is rejected — caller must coerce to string before import.
  let description = ''
  if (item.description !== undefined && item.description !== null) {
    if (typeof item.description !== 'string') {
      return { ok: false, error: { error: 'invalid_product', index, field: 'description' } }
    }
    description = item.description.trim()
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, error: { error: 'invalid_product', index, field: 'description' } }
    }
  }

  // price: number, finite, integer, >= 0, <= 2147483647
  if (typeof item.price !== 'number' || !Number.isFinite(item.price)) {
    return { ok: false, error: { error: 'invalid_product', index, field: 'price' } }
  }
  if (!Number.isInteger(item.price)) {
    return { ok: false, error: { error: 'invalid_product', index, field: 'price' } }
  }
  if (item.price < 0 || item.price > MAX_PRICE) {
    return { ok: false, error: { error: 'invalid_product', index, field: 'price' } }
  }
  const price = item.price

  // availability: enum. Default 'in_stock' only when genuinely absent.
  let availability = 'in_stock'
  if (item.availability !== undefined && item.availability !== null) {
    if (typeof item.availability !== 'string' || !ALLOWED_AVAILABILITY.has(item.availability)) {
      return { ok: false, error: { error: 'invalid_product', index, field: 'availability' } }
    }
    availability = item.availability
  }

  // sku: null/undefined or string, max 100
  let sku: string | null = null
  if (item.sku !== undefined && item.sku !== null) {
    if (typeof item.sku !== 'string') {
      return { ok: false, error: { error: 'invalid_product', index, field: 'sku' } }
    }
    const trimmed = item.sku.trim()
    if (trimmed.length > MAX_SKU_LENGTH) {
      return { ok: false, error: { error: 'invalid_product', index, field: 'sku' } }
    }
    sku = trimmed || null
  }

  return { ok: true, data: { name, description, price, availability, sku } }
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'invalid_body' as const }
    }

    const items = Array.isArray(body.products) ? body.products : []
    if (items.length === 0) {
      return { error: 'no_products' as const }
    }

    // Hard cap at 500 items — reject if the caller sent more (don't silently
    // truncate, which would lead to data loss surprises).
    if (items.length > MAX_ITEMS_PER_IMPORT) {
      return { error: 'too_many_products' as const }
    }

    // === Phase 1: validate ALL items before writing any ===
    const validated: Array<{ name: string; description: string; price: number; availability: string; sku: string | null }> = []
    for (let i = 0; i < items.length; i++) {
      const v = validateItem(items[i], i)
      if (!v.ok) {
        return { validation: v.error }
      }
      validated.push(v.data)
    }

    // === Phase 2: all items passed — now write them ===
    const tid = getCurrentTenantId()!
    let created = 0
    for (const v of validated) {
      await db.product.create({
        data: {
          tenantId: tid,
          name: v.name,
          description: v.description,
          price: v.price,
          availability: v.availability,
          sku: v.sku,
          externalSource: 'csv',
          metadata: {},
        },
      })
      created++
    }
    return { created } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) {
    const status = result.result.error === 'too_many_products' ? 413 : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
  if ('validation' in result.result) {
    return NextResponse.json(result.result.validation, { status: 400 })
  }
  return NextResponse.json({ created: result.result.created })
}
