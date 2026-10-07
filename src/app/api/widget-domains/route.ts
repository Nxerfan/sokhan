import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { getWebsiteLimit } from '@/lib/payments/domain-validation'
import { normalizeDomain } from '@/lib/payments/domain-validation'

export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const [domains, limit] = await Promise.all([
      db.widgetDomain.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' } }),
      getWebsiteLimit(tid),
    ])
    return { domains, limit }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ domains: result.result.domains, limit: result.result.limit })
}

export async function POST(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const tid = getCurrentTenantId()!
    const body = await req.json()
    const domain = normalizeDomain(String(body.domain ?? ''))

    if (!domain || domain.length < 3) {
      return { error: 'invalid_domain' as const }
    }

    // Check plan limit
    const limit = await getWebsiteLimit(tid)
    const count = await db.widgetDomain.count({ where: { tenantId: tid } })
    if (limit >= 0 && count >= limit) {
      return { error: 'limit_reached' as const }
    }

    // Check for duplicate
    const existing = await db.widgetDomain.findUnique({
      where: { tenantId_domain: { tenantId: tid, domain } },
    })
    if (existing) {
      return { error: 'already_exists' as const }
    }

    const widgetDomain = await db.widgetDomain.create({
      data: { tenantId: tid, domain },
    })
    return { widgetDomain } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ domain: result.result.widgetDomain })
}

export async function DELETE(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const tid = getCurrentTenantId()!
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return { error: 'invalid_id' as const }
    await db.widgetDomain.deleteMany({ where: { id, tenantId: tid } })
    return { ok: true as const }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('error' in result.result) return NextResponse.json({ error: result.result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}
