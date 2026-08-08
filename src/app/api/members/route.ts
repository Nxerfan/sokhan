import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId } from '@/lib/auth'
import { db } from '@/lib/db'
import { enforceCurrentTenantPlanLimit, PlanLimitExceededError } from '@/lib/payments/gating'
export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.membership.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ members: result.result })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = ['admin', 'manager', 'agent', 'viewer'].includes(body.role)
      ? body.role
      : 'agent'
    if (!email) return { error: 'invalid_email' as const }

    // Plan gating: check agent limit before adding a new member.
    try {
      await enforceCurrentTenantPlanLimit('agents')
    } catch (e) {
      if (e instanceof PlanLimitExceededError) {
        return { planLimit: e.result }
      }
      throw e
    }

    // Module-1 simplification: if the user exists globally, attach them to this
    // workspace; otherwise create a placeholder user (no password) that will
    // complete signup on first login. Full email-invite flow lands in Module 2.
    const tid = getCurrentTenantId()!
    const existing = await db.user.findUnique({ where: { email } })
    let userId: string
    if (existing) {
      const m = await db.membership.findUnique({
        where: { userId_tenantId: { userId: existing.id, tenantId: tid } },
      })
      if (m) return { error: 'already_member' as const }
      userId = existing.id
    } else {
      const created = await db.user.create({
        data: { email, name: email.split('@')[0], locale: 'fa' },
      })
      userId = created.id
    }

    const membership = await db.membership.create({
      data: { userId, role, status: 'invited', tenantId: session.user.workspaceId! },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    return { membership } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('planLimit' in result.result) {
    const r = result.result as { planLimit: { current: number; limit: number; planSlug: string } }
    return NextResponse.json(
      {
        error: 'plan_limit_exceeded',
        limit: 'agents',
        current: r.planLimit.current,
        max: r.planLimit.limit,
        plan: r.planLimit.planSlug,
      },
      { status: 402 },
    )
  }
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ membership: result.result.membership })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const role = ['admin', 'manager', 'agent', 'viewer'].includes(body.role)
      ? body.role
      : 'agent'
    // updateMany with tenantId — defense-in-depth (Module 2 convention)
    await db.membership.updateMany({
      where: { id: body.memberId, tenantId: getCurrentTenantId()! },
      data: { role },
    })
    const membership = await db.membership.findFirst({ where: { id: body.memberId, tenantId: getCurrentTenantId()! } })
    return { membership } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ membership: result.result.membership })
}
