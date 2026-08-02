import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'

/** GET: list routing rules for the tenant */
export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.routingRule.findMany({ orderBy: { priority: 'asc' } })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ rules: result.result })
}

/** POST: create a routing rule — tenantId explicit */
export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const rule = await db.routingRule.create({
      data: {
        tenantId: session.user.workspaceId!,
        name: String(body.name ?? 'Untitled rule'),
        enabled: body.enabled !== false,
        priority: Number(body.priority ?? 0),
        trigger: body.trigger ?? { event: 'conversation_created', conditions: {} },
        action: body.action ?? { type: 'assign_department' },
      },
    })
    return { rule } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ rule: result.result.rule })
}

/** PATCH: update a routing rule */
export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const data: any = {}
    if (body.name !== undefined) data.name = body.name
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.priority !== undefined) data.priority = body.priority
    if (body.trigger !== undefined) data.trigger = body.trigger
    if (body.action !== undefined) data.action = body.action
    // updateMany with tenantId in where — defense-in-depth (Module 2 convention)
    await db.routingRule.updateMany({
      where: { id: body.id, tenantId: session.user.workspaceId! },
      data,
    })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ ok: true })
}

/** DELETE: remove a routing rule */
export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return { error: 'invalid_id' as const }
    await db.routingRule.delete({ where: { id } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
