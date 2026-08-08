/**
 * Plan catalog.
 *
 * Prices in Toman (IRR). Limits are stored as numbers; -1 means unlimited.
 *
 * - `free`       — 0 Toman, 2 agents, 100 conversations/month, 1 department
 * - `pro`        — 290,000 Toman/month, 5 agents, 1,000 conversations/month, 5 departments
 * - `business`   — 890,000 Toman/month, 20 agents, 5,000 conversations/month, unlimited departments
 * - `enterprise` — contact sales, unlimited everything
 *
 * `getPlan(slug)` looks up by slug. The `ensurePlansSeeded()` helper syncs the
 * catalog to the DB so the Plan table is always up-to-date.
 */

import { db } from '@/lib/db'

export type PlanSlug = 'free' | 'pro' | 'business' | 'enterprise'

export interface PlanLimit {
  /** Max agents (memberships). -1 = unlimited. */
  agents: number
  /** Max conversations per month. -1 = unlimited. */
  conversations: number
  /** Max departments. -1 = unlimited. */
  departments: number
  /** Max AI actions (FAQ matches + product Q&A) per month. -1 = unlimited. 0 = AI disabled. */
  aiActions: number
}

export interface Plan {
  slug: PlanSlug
  name: string
  /** Price in Toman. 0 for free / contact-sales. */
  priceToman: number
  /** Billing interval. */
  interval: 'month' | 'year' | 'once'
  limits: PlanLimit
  /** When true, do not show a payment flow — contact sales instead. */
  contactSales: boolean
}

/** The canonical plan catalog. Source of truth for limits + pricing. */
export const PLANS: Plan[] = [
  {
    slug: 'free',
    name: 'Free',
    priceToman: 0,
    interval: 'month',
    limits: { agents: 2, conversations: 100, departments: 1, aiActions: 0 },
    contactSales: false,
  },
  {
    slug: 'pro',
    name: 'Pro',
    priceToman: 290_000,
    interval: 'month',
    limits: { agents: 5, conversations: 1_000, departments: 5, aiActions: 500 },
    contactSales: false,
  },
  {
    slug: 'business',
    name: 'Business',
    priceToman: 890_000,
    interval: 'month',
    limits: { agents: 20, conversations: 5_000, departments: -1, aiActions: 2_000 },
    contactSales: false,
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    priceToman: 0,
    interval: 'month',
    limits: { agents: -1, conversations: -1, departments: -1, aiActions: -1 },
    contactSales: true,
  },
]

const PLAN_BY_SLUG: Record<string, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.slug, p]),
)

export function getPlan(slug: string): Plan | null {
  return PLAN_BY_SLUG[slug] ?? null
}

export function isPaidPlan(slug: string): boolean {
  const plan = getPlan(slug)
  if (!plan) return false
  return !plan.contactSales && plan.priceToman > 0
}

/**
 * Sync the catalog to the DB. Idempotent — upserts each plan by slug.
 * Call this on first billing API hit (lazy seed).
 *
 * Note: Plan is NOT a tenant-scoped model — it is global catalog data.
 */
export async function ensurePlansSeeded(): Promise<void> {
  for (const plan of PLANS) {
    await db.plan.upsert({
      where: { slug: plan.slug },
      create: {
        slug: plan.slug,
        name: plan.name,
        priceToman: plan.priceToman,
        interval: plan.interval,
        // Prisma's JsonValue requires an index signature; cast satisfies it.
        limits: plan.limits as unknown as object,
        active: true,
      },
      update: {
        name: plan.name,
        priceToman: plan.priceToman,
        interval: plan.interval,
        limits: plan.limits as unknown as object,
        active: true,
      },
    })
  }
}
