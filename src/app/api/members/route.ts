import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole, getCurrentTenantId, ROLE_RANK } from '@/lib/auth'
import { db } from '@/lib/db'
import { enforceCurrentTenantPlanLimit, PlanLimitExceededError } from '@/lib/payments/gating'

/**
 * Role hierarchy:
 *   owner: 5, admin: 4, manager: 3, agent: 2, viewer: 1
 *
 * Rules:
 *   owner   may manage admin / manager / agent / viewer (not owner)
 *   admin   may manage manager / agent / viewer (not owner / admin)
 *   manager may manage agent / viewer (not owner / admin / manager)
 *   agent   no membership management
 *   viewer  no membership management
 *
 * Nobody may assign 'owner' through this endpoint.
 * Actor cannot modify their own membership (no self-promotion / self-demotion).
 * Only owner may modify admin memberships.
 */

const VALID_ROLES = ['admin', 'manager', 'agent', 'viewer']

/**
 * Returns true if `actorRole` is allowed to manage a membership whose
 * current or target role is `targetRole`.
 *
 * The target role must be strictly below the actor's role, and 'owner'
 * is never manageable through this endpoint.
 */
function canManageRole(actorRole: string, targetRole: string): boolean {
  if (targetRole === 'owner') return false
  if (!hasRole(actorRole, 'manager')) return false
  const actorRank = ROLE_RANK[actorRole] ?? 0
  const targetRank = ROLE_RANK[targetRole] ?? 0
  return targetRank < actorRank
}

export async function GET() {
  const result = await withSessionTenant(async () => {
    // Explicit tenantId filter — defense-in-depth (do not rely solely on
    // the Prisma extension's auto-injection).
    return db.membership.findMany({
      where: { tenantId: getCurrentTenantId()! },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ members: result.result })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    // Agent and viewer have no membership management.
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const body = await req.json()
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = String(body.role ?? '')

    // Validate role — reject 'owner' and invalid roles.
    if (role === 'owner') {
      return { error: 'cannot_assign_owner' as const }
    }
    if (!VALID_ROLES.includes(role)) {
      return { error: 'invalid_role' as const }
    }

    // Actor cannot assign a role at or above their own authority.
    if (!canManageRole(session.user.role, role)) {
      return { forbidden: true as const }
    }

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
  if ('error' in result.result) {
    const status = result.result.error === 'invalid_role' || result.result.error === 'cannot_assign_owner' || result.result.error === 'invalid_email' || result.result.error === 'already_member'
      ? 400
      : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
  return NextResponse.json({ membership: result.result.membership })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    // Agent and viewer have no membership management.
    if (!hasRole(session.user.role, 'manager')) {
      return { forbidden: true as const }
    }

    const body = await req.json()
    const memberId = String(body.memberId ?? '')
    const role = String(body.role ?? '')

    // Validate role — reject 'owner' and invalid roles.
    if (role === 'owner') {
      return { error: 'cannot_assign_owner' as const }
    }
    if (!VALID_ROLES.includes(role)) {
      return { error: 'invalid_role' as const }
    }

    // Actor cannot assign a role at or above their own authority.
    if (!canManageRole(session.user.role, role)) {
      return { forbidden: true as const }
    }

    const tid = getCurrentTenantId()!

    // Fetch the target membership — must belong to the current tenant.
    const target = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
    })
    if (!target) {
      return { error: 'not_found' as const }
    }

    // Actor cannot modify their own membership (no self-promotion / demotion).
    if (target.userId === session.user.id) {
      return { forbidden: true as const }
    }

    // Only owner may modify admin memberships; nobody may modify owner.
    // General rule: actor can only manage roles strictly below their own.
    if (!canManageRole(session.user.role, target.role)) {
      return { forbidden: true as const }
    }

    // Apply the role change — tenantId explicit in where (defense-in-depth).
    await db.membership.updateMany({
      where: { id: memberId, tenantId: tid },
      data: { role },
    })
    const membership = await db.membership.findFirst({
      where: { id: memberId, tenantId: tid },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    return { membership } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) {
    const status = result.result.error === 'not_found' ? 404 : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
  return NextResponse.json({ membership: result.result.membership })
}

export { canManageRole }
