import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/** GET: list routing rules for the tenant */
export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.routingRule.findMany({ where: { tenantId: getCurrentTenantId()! }, orderBy: { priority: 'asc' } })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ rules: result.result })
}

/** POST: create a routing rule — tenantId explicit */

const VALID_ACTIONS = ['assign_department', 'assign_user', 'add_tag', 'send_message']
const VALID_EVENTS = ['conversation_created', 'message_received']

/**
 * Validate a routing rule action AND verify that any user/department it
 * references belongs to the current tenant.
 *
 * Called inside `withSessionTenant`, so the fail-closed Prisma extension
 * scopes the lookups to the current tenant — a foreign userId/departmentId
 * simply returns null → reject as 'invalid_user_id'/'invalid_department_id'.
 *
 * This is a SAVE-TIME guard: better to reject a misconfigured rule up-front
 * than to discover at execution time that it silently no-ops (the routing
 * engine also re-validates at execution time as defense-in-depth).
 */
async function validateRuleAction(action: any): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!action || typeof action !== 'object') return { ok: false, error: 'invalid_action' }
  if (!VALID_ACTIONS.includes(action.type)) return { ok: false, error: 'invalid_action_type' }

  if (action.type === 'assign_department') {
    if (!action.departmentId || typeof action.departmentId !== 'string') return { ok: false, error: 'invalid_department_id' }
    // Tenant-scoped lookup — foreign departmentId returns null.
    const dept = await db.department.findUnique({ where: { id: action.departmentId } })
    if (!dept) return { ok: false, error: 'invalid_department_id' }
  }
  if (action.type === 'assign_user') {
    if (!action.userId || typeof action.userId !== 'string') return { ok: false, error: 'invalid_user_id' }
    // Tenant-scoped lookup — foreign userId (no Membership in this tenant)
    // returns null.
    const member = await db.membership.findFirst({ where: { userId: action.userId, status: 'active', tenantId: tid },
      where: { userId: action.userId, status: 'active' },
      select: { id: true },
    })
    if (!member) return { ok: false, error: 'invalid_user_id' }
  }
  if (action.type === 'add_tag') {
    if (typeof action.tag !== 'string' || action.tag.trim().length === 0 || action.tag.length > 100) return { ok: false, error: 'invalid_tag' }
  }
  if (action.type === 'send_message') {
    if (typeof action.text !== 'string' || action.text.trim().length === 0 || action.text.length > 5000) return { ok: false, error: 'invalid_text' }
  }
  return { ok: true }
}

function validateRuleTrigger(trigger: any): { ok: true } | { ok: false; error: string } {
  if (!trigger || typeof trigger !== 'object') return { ok: false, error: 'invalid_trigger' }
  if (trigger.event && !VALID_EVENTS.includes(trigger.event)) return { ok: false, error: 'invalid_event' }
  if (trigger.conditions) {
    if (typeof trigger.conditions !== 'object') return { ok: false, error: 'invalid_conditions' }
    if (trigger.conditions.keyword && typeof trigger.conditions.keyword !== 'string') return { ok: false, error: 'invalid_keyword' }
    if (trigger.conditions.businessHours) {
      const bh = trigger.conditions.businessHours
      if (typeof bh.start !== 'number' || typeof bh.end !== 'number') return { ok: false, error: 'invalid_business_hours' }
      if (bh.start < 0 || bh.start > 23 || bh.end < 0 || bh.end > 23) return { ok: false, error: 'invalid_business_hours' }
    }
  }
  return { ok: true }
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()

    // Validate the action BEFORE creating the rule — this is the save-time
    // guard that prevents a rule referencing a foreign user/department from
    // ever being persisted.
    if (body.action !== undefined) {
      const av = await validateRuleAction(body.action)
      if (!av.ok) return { error: av.error }
    }

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
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
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
    // Validate trigger/action if being updated
    if (body.trigger !== undefined) {
      const tv = validateRuleTrigger(body.trigger)
      if (!tv.ok) return { error: tv.error }
      data.trigger = body.trigger
    }
    if (body.action !== undefined) {
      const av = await validateRuleAction(body.action)
      if (!av.ok) return { error: av.error }
      data.action = body.action
    }
    if (body.name !== undefined) data.name = body.name
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.priority !== undefined) data.priority = body.priority
    // updateMany with tenantId in where — defense-in-depth (Module 2 convention)
    const updated = await db.routingRule.updateMany({
      where: { id: body.id, tenantId: session.user.workspaceId! },
      data,
    })
    if (updated.count === 0) return { error: 'not_found' as const }
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) {
    const status = result.result.error === 'not_found' ? 404 : 400
    return NextResponse.json({ error: result.result.error }, { status })
  }
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
    await db.routingRule.deleteMany({ where: { id, tenantId: getCurrentTenantId()! } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
