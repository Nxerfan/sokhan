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
    const price = Number(body.price ?? 0)
    const availability = typeof body.availability === 'string' ? body.availability : 'in_stock'
    const sku = typeof body.sku === 'string' ? body.sku.trim() : null
    if (!name || name.length > 500) return { error: 'invalid_name' as const }
    if (description.length > 5000) return { error: 'invalid_description' as const }
    if (typeof body.price !== 'number' || !Number.isFinite(price) || price < 0 || !Number.isInteger(price) || price > 2147483647) return { error: 'invalid_price' as const }
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
