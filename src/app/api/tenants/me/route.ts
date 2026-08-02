import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    return db.tenant.findUnique({ where: { id: tid } })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ tenant: result.result })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const tid = getCurrentTenantId()!
    const updated = await db.tenant.update({
      where: { id: tid },
      data: {
        name: body.name,
        defaultLocale: body.defaultLocale === 'en' ? 'en' : 'fa',
        defaultDirection: body.defaultDirection === 'ltr' ? 'ltr' : 'rtl',
      },
    })
    return { tenant: updated } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ tenant: result.result.tenant })
}
