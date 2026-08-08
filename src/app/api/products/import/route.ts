import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/** POST: bulk import products from CSV. Body: { products: [{name, price, description, availability}] } */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const items = Array.isArray(body.products) ? body.products : []
    if (items.length === 0) return { error: 'no_products' as const }

    const tid = getCurrentTenantId()!
    let created = 0
    for (const item of items.slice(0, 500)) {
      await db.product.create({
        data: {
          tenantId: tid,
          name: String(item.name ?? '').trim(),
          description: String(item.description ?? '').trim(),
          price: Number(item.price ?? 0),
          availability: String(item.availability ?? 'in_stock'),
          sku: item.sku || null,
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
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ created: result.result.created })
}
