import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * Public widget configuration, resolved by tenant slug. No auth — this is the
 * customer-facing config consumed by the embedded widget script.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: { widgetConfig: true },
  })
  if (!tenant || !tenant.widgetConfig) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const c = tenant.widgetConfig
  return NextResponse.json({
    slug,
    name: tenant.name,
    accentColor: c.accentColor,
    launcherShape: c.launcherShape,
    position: c.position,
    avatarUrl: c.avatarUrl,
    logoUrl: c.logoUrl,
    greetingTexts: c.greetingTexts as Record<string, string>,
    defaultLocale: c.defaultLocale,
    defaultDirection: tenant.defaultDirection,
  })
}
