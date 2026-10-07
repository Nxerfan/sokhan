import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.product.findMany({
      where: { tenantId: getCurrentTenantId()! },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ products: result.result })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    if (typeof body.name !== 'string') return { error: 'invalid_name' as const }
    const name = body.name.trim()
    if (typeof body.description !== 'string') return { error: 'invalid_description' as const }
    const description = body.description.trim()
    // Reject non-string price at the type level before any coercion.
    // `Number(body.price ?? 0)` previously let `body.price = "100"` slip through
    // as the number 100 — but a string price is a type error and should be
    // rejected explicitly.
    if (typeof body.price !== 'number' || !Number.isFinite(body.price)) {
      return { error: 'invalid_price' as const }
    }
    const price = body.price
    // availability: default to 'in_stock' ONLY when genuinely absent.
    // If the field is provided but is not a string (or is an invalid enum),
    // reject — never silently coerce.
    let availability = 'in_stock'
    if (body.availability !== undefined && body.availability !== null) {
      if (typeof body.availability !== 'string') {
        return { error: 'invalid_availability' as const }
      }
      availability = body.availability
    }
    // sku: default to null ONLY when genuinely absent (undefined or null).
    // If the field is provided but is not a string, reject.
    let sku: string | null = null
    if (body.sku !== undefined && body.sku !== null) {
      if (typeof body.sku !== 'string') {
        return { error: 'invalid_sku' as const }
      }
      sku = body.sku.trim()
    }
    if (!name || name.length > 500) return { error: 'invalid_name' as const }
    if (description.length > 5000) return { error: 'invalid_description' as const }
    if (price < 0 || !Number.isInteger(price) || price > 2147483647) return { error: 'invalid_price' as const }
    if (!['in_stock', 'out_of_stock', 'limited'].includes(availability)) return { error: 'invalid_availability' as const }
    if (sku !== null && sku.length > 100) return { error: 'invalid_sku' as const }
    const product = await db.product.create({
      data: {
        tenantId: session.user.workspaceId!,
        name,
        description,
        price,
        availability,
        sku,
        externalSource: 'manual',
        metadata: {},
      },
    })
    return { product } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ product: result.result.product })
}

export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return { error: 'invalid_id' as const }
    await db.product.deleteMany({ where: { id, tenantId: getCurrentTenantId()! } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
