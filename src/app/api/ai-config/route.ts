import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/** GET: return AI config (feature toggles) */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    let config = await db.aiConfig.findUnique({ where: { tenantId: tid } })
    if (!config) {
      // Create default config (both features OFF)
      config = await db.aiConfig.create({
        data: { tenantId: tid, faqEnabled: false, productQaEnabled: false },
      })
    }
    return config
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ config: result.result })
}

/** PATCH: update AI feature toggles */
export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const tid = getCurrentTenantId()!

    // Upsert the config
    const config = await db.aiConfig.upsert({
      where: { tenantId: tid },
      create: {
        tenantId: tid,
        faqEnabled: body.faqEnabled ?? false,
        productQaEnabled: body.productQaEnabled ?? false,
      },
      update: {
        faqEnabled: body.faqEnabled ?? false,
        productQaEnabled: body.productQaEnabled ?? false,
      },
    })
    return { config } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ config: result.result.config })
}
