import { NextResponse } from 'next/server'
import { withSessionTenant } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'

/**
 * GET: analytics data for the dashboard.
 * Returns: conversation volume (last 7 days), response time stats, CSAT stats.
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Conversation volume over last 7 days (by day)
    const conversations = await db.conversation.findMany({
      where: { tenantId: tid, createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true, status: true, csatRating: true, firstResponseAt: true },
    })

    // Build per-day buckets
    const volumeByDay: { date: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const dayStr = day.toISOString().slice(0, 10)
      const count = conversations.filter(c => c.createdAt.toISOString().slice(0, 10) === dayStr).length
      volumeByDay.push({ date: dayStr, count })
    }

    // Response time: average first-response time (from conversation createdAt to firstResponseAt)
    const withResponseTime = conversations.filter(c => c.firstResponseAt)
    const avgResponseMs = withResponseTime.length > 0
      ? withResponseTime.reduce((sum, c) => sum + (c.firstResponseAt!.getTime() - c.createdAt.getTime()), 0) / withResponseTime.length
      : null

    // Resolution time: average from createdAt to updatedAt for closed conversations
    const closedConversations = await db.conversation.findMany({
      where: { tenantId: tid, status: 'closed', updatedAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, updatedAt: true },
    })
    const avgResolutionMs = closedConversations.length > 0
      ? closedConversations.reduce((sum, c) => sum + (c.updatedAt.getTime() - c.createdAt.getTime()), 0) / closedConversations.length
      : null

    // CSAT stats (last 30 days)
    const csatRated = await db.conversation.findMany({
      where: { tenantId: tid, csatRating: { not: null }, csatAt: { gte: thirtyDaysAgo } },
      select: { csatRating: true },
    })
    const csatAvg = csatRated.length > 0
      ? csatRated.reduce((sum, c) => sum + (c.csatRating ?? 0), 0) / csatRated.length
      : null
    const csatDistribution = [1, 2, 3, 4, 5].map(rating => ({
      rating,
      count: csatRated.filter(c => c.csatRating === rating).length,
    }))

    // Totals
    const totalConversations = await db.conversation.count({ where: { tenantId: tid } })
    const openConversations = await db.conversation.count({ where: { tenantId: tid, status: 'open' } })
    const closedConversationsCount = await db.conversation.count({ where: { tenantId: tid, status: 'closed' } })

    return {
      volumeByDay,
      avgResponseMs,
      avgResolutionMs,
      csatAvg,
      csatCount: csatRated.length,
      csatDistribution,
      totalConversations,
      openConversations,
      closedConversations: closedConversationsCount,
    }
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(result.result)
}
