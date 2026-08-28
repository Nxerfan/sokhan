import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } })
}

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
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }
  const c = tenant.widgetConfig
  return widgetHeaders(NextResponse.json({
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
  }))
}
