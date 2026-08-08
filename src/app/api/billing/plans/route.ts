import { NextResponse } from 'next/server'
import { PLANS } from '@/lib/payments/plans'

/**
 * Public plan catalog endpoint. Returns the static PLANS array — no DB read
 * required, no auth required. The catalog is the source of truth for pricing
 * + limits.
 */
export async function GET() {
  return NextResponse.json({
    plans: PLANS.map((p) => ({
      slug: p.slug,
      name: p.name,
      priceToman: p.priceToman,
      interval: p.interval,
      contactSales: p.contactSales,
      limits: p.limits,
    })),
  })
}
