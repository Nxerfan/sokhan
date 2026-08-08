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
    const product = await db.product.create({
      data: {
        tenantId: session.user.workspaceId!,
        name: String(body.name ?? '').trim(),
        description: String(body.description ?? '').trim(),
        price: Number(body.price ?? 0),
        availability: String(body.availability ?? 'in_stock'),
        sku: body.sku || null,
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
