import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { enforceCurrentTenantPlanLimit, PlanLimitExceededError } from '@/lib/payments/gating'

export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.department.findMany({ orderBy: { createdAt: 'asc' } })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ departments: result.result })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    if (!name) return { error: 'invalid_name' as const }

    // Plan gating: check department limit before creating.
    try {
      await enforceCurrentTenantPlanLimit('departments')
    } catch (e) {
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result }
      }
      throw e
    }

    // Pass tenantId explicitly — the Prisma $extends query interceptor is
    // unreliable for `create` in Turbopack dev mode (the global tenant context
    // isn't read inside the extension's create handler). Explicit is safer.
    const department = await db.department.create({
      data: { name, tenantId: session.user.workspaceId! },
    })
    return { department } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('planLimit' in result.result) {
    const r = result.result as { planLimit: { current: number; limit: number; planSlug: string } }
    return NextResponse.json(
      {
        error: 'plan_limit_exceeded',
        limit: 'departments',
        current: r.planLimit.current,
        max: r.planLimit.limit,
        plan: r.planLimit.planSlug,
      },
      { status: 402 },
    )
  }
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ department: result.result.department })
}

export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return { error: 'invalid_id' as const }
    await db.department.deleteMany({ where: { id, tenantId: session.user.workspaceId! } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
