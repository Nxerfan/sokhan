import { NextResponse } from 'next/server'
import { withSessionTenant } from '@/lib/auth'
import { db } from '@/lib/db'

/** GET: list contacts for the tenant */
export async function GET() {
  const result = await withSessionTenant(async () => {
    return db.contact.findMany({
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        identifier: true,
        identifierType: true,
        lastSeenAt: true,
        createdAt: true,
      },
    })
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ contacts: result.result })
}
