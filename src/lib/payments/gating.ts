/**
 * Plan gating: enforce per-tenant limits on agents, conversations, departments.
 *
 * `checkPlanLimit(tenantId, limit)` queries the actual counts and compares to
 * the plan's limits. Returns `{ allowed, current, limit }`.
 *
 * `enforcePlanLimit(...)` throws a PlanLimitExceededError that the API routes
 * can catch and convert to a 402 Payment Required response.
 *
 * Conventions:
 *   - The plan is read from the Tenant.plan column (slug). If the tenant has
 *     an active Subscription, that subscription's plan takes precedence.
 *   - Limits use -1 to mean "unlimited" — always allowed.
 *   - Conversations are counted for the current month (calendar month, UTC).
 *
 * Tenant context: every tenant-scoped read (Membership, Conversation,
 * Department, Message, Subscription, WidgetDomain) runs inside
 * `withTenant(tenantId)`. Callers that are already inside a tenant context
 * (e.g. `withSessionTenant`) simply nest a same-value context — a no-op.
 */

import { db, getCurrentTenantId, withTenant } from '@/lib/db'
import { getPlan, type PlanLimit } from './plans'

export type LimitKind = keyof PlanLimit

// Add 'weeklyMessages' and 'websites' to the limit kinds
// These are checked differently from the monthly limits

export interface PlanLimitResult {
  allowed: boolean
  /** Current usage count. */
  current: number
  /** Plan limit (-1 = unlimited). */
  limit: number
  /** The plan slug used for this check. */
  planSlug: string
}

export class PlanLimitExceededError extends Error {
  constructor(
    public readonly limitKind: LimitKind,
    public readonly result: PlanLimitResult,
  ) {
    super(`Plan limit exceeded for "${limitKind}"`)
    this.name = 'PlanLimitExceededError'
  }
}

/**
 * Resolve the effective plan slug for a tenant. If the tenant has an active
 * Subscription, use that subscription's plan; otherwise fall back to
 * `tenant.plan`.
 */
export async function resolveTenantPlanSlug(tenantId: string): Promise<string> {
  // Subscription is a tenant-scoped model — must run inside withTenant.
  // Global Tenant lookup below doesn't need wrapping.
  const sub = await withTenant(tenantId, () =>
    db.subscription.findFirst({
      where: { status: 'active' },
      include: { plan: { select: { slug: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  )
  if (sub?.plan?.slug) return sub.plan.slug

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  })
  return tenant?.plan ?? 'free'
}

/** Count the current usage for the given limit kind. */
async function countUsage(tenantId: string, limit: LimitKind): Promise<number> {
  // All tenant-scoped model reads inside this function are wrapped in
  // withTenant so the fail-closed extension allows them.
  return withTenant(tenantId, async () => {
    switch (limit) {
      case 'agents': {
        // Active + invited memberships count toward the agent limit.
        return db.membership.count({
          where: { status: { in: ['active', 'invited'] } },
        })
      }
      case 'conversations': {
        // Conversations created this calendar month (UTC).
        const now = new Date()
        const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        return db.conversation.count({
          where: { createdAt: { gte: startOfMonth } },
        })
      }
      case 'departments': {
        return db.department.count({})
      }
      case 'aiActions': {
        const now = new Date()
        const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        return db.message.count({
          where: { senderType: 'ai', createdAt: { gte: startOfMonth } },
        })
      }
      case 'weeklyMessages': {
        // Messages sent by visitors in the last 7 days (rolling window)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        return db.message.count({
          where: { senderType: 'contact', createdAt: { gte: sevenDaysAgo } },
        })
      }
      case 'websites': {
        return db.widgetDomain.count({})
      }
      default:
        return 0
    }
  })
}

/**
 * Check whether the tenant can perform an action that would increase the
 * given usage by 1. Does NOT throw — returns the result for the caller to
 * decide.
 */
export async function checkPlanLimit(
  tenantId: string,
  limit: LimitKind,
): Promise<PlanLimitResult> {
  const planSlug = await resolveTenantPlanSlug(tenantId)
  const plan = getPlan(planSlug) ?? getPlan('free')!
  const limitValue = plan.limits[limit]
  const current = await countUsage(tenantId, limit)

  // -1 = unlimited
  const allowed = limitValue === -1 || current < limitValue

  return { allowed, current, limit: limitValue, planSlug }
}

/**
 * Enforce the plan limit. Throws `PlanLimitExceededError` if the action would
 * exceed the limit. Use this in API handlers:
 *
 *   await enforcePlanLimit(getCurrentTenantId()!, 'agents')
 *
 * If `getCurrentTenantId()` returns undefined, this is a no-op (the caller is
 * outside a tenant context — should never happen for authenticated writes).
 */
export async function enforcePlanLimit(
  tenantId: string | undefined,
  limit: LimitKind,
): Promise<PlanLimitResult> {
  if (!tenantId) {
    // No tenant context — let the caller handle the auth error.
    return { allowed: true, current: 0, limit: -1, planSlug: 'free' }
  }
  const result = await checkPlanLimit(tenantId, limit)
  if (!result.allowed) {
    throw new PlanLimitExceededError(limit, result)
  }
  return result
}

/** Convenience wrapper that uses the current async tenant context. */
export async function enforceCurrentTenantPlanLimit(limit: LimitKind): Promise<PlanLimitResult> {
  return enforcePlanLimit(getCurrentTenantId(), limit)
}

/**
 * Get all current usage + limits for a tenant in one shot. Used by the billing
 * panel UI.
 */
export async function getTenantUsage(tenantId: string): Promise<{
  planSlug: string
  usage: Record<LimitKind, { current: number; limit: number }>
}> {
  const planSlug = await resolveTenantPlanSlug(tenantId)
  const plan = getPlan(planSlug) ?? getPlan('free')!

  const [agents, conversations, departments] = await Promise.all([
    countUsage(tenantId, 'agents'),
    countUsage(tenantId, 'conversations'),
    countUsage(tenantId, 'departments'),
  ])

  return {
    planSlug,
    usage: {
      agents: { current: agents, limit: plan.limits.agents },
      conversations: { current: conversations, limit: plan.limits.conversations },
      departments: { current: departments, limit: plan.limits.departments },
      aiActions: { current: 0, limit: (plan.limits as any).aiActions ?? -1 },
      websites: { current: 0, limit: (plan.limits as any).websites ?? 1 },
      weeklyMessages: { current: 0, limit: (plan.limits as any).weeklyMessages ?? 100 },
    },
  }
}
