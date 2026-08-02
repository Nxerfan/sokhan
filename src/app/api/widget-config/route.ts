import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    return db.widgetConfig.findUnique({ where: { tenantId: tid } })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ config: result.result })
}

export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }
    const body = await req.json()
    const tid = getCurrentTenantId()!
    const config = await db.widgetConfig.update({
      where: { tenantId: tid },
      data: {
        accentColor: String(body.accentColor ?? '#E09A2B'),
        launcherShape: ['tab', 'rounded', 'pill'].includes(body.launcherShape)
          ? body.launcherShape
          : 'tab',
        position: ['bottom-start', 'bottom-end'].includes(body.position)
          ? body.position
          : 'bottom-end',
        avatarUrl: body.avatarUrl ?? null,
        logoUrl: body.logoUrl ?? null,
        greetingTexts:
          body.greetingTexts && typeof body.greetingTexts === 'object'
            ? body.greetingTexts
            : { fa: '', en: '' },
        defaultLocale: body.defaultLocale === 'en' ? 'en' : 'fa',
      },
    })
    return { config } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ config: result.result.config })
}
