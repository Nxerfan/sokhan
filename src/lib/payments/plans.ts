/**
 * Plan catalog (Module 6 restructure).
 *
 * Plans: Free (30-day trial, 100 msgs/week, 1 website, locked customization),
 * Pro (500K msgs/month, 3 websites, full customization), Max (1M msgs/month,
 * 8 websites, full customization), Self-Hosted (contact us).
 *
 * `getPlan(slug)` looks up by slug. `ensurePlansSeeded()` syncs to DB.
 */

import { db } from '@/lib/db'

export type PlanSlug = 'free' | 'pro' | 'max' | 'self-hosted'

export interface PlanLimit {
  /** Max agents (memberships). -1 = unlimited. */
  agents: number
  /** Max conversations per month. -1 = unlimited. */
  conversations: number
  /** Max departments. -1 = unlimited. */
  departments: number
  /** Max AI actions per month. -1 = unlimited. 0 = AI disabled. */
  aiActions: number
  /** Max widget domains (websites). -1 = unlimited. */
  websites: number
  /** Weekly message limit for free plan. -1 = no weekly limit. */
  weeklyMessages: number
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
  /** Whether widget customization is unlocked. */
  customization: boolean
  /** Free trial duration in days. 0 = no trial limit. */
  trialDays: number
}

/** The canonical plan catalog. Source of truth for limits + pricing. */
export const PLANS: Plan[] = [
  {
    slug: 'free',
    name: 'Free',
    priceToman: 0,
    interval: 'month',
    limits: { agents: 2, conversations: -1, departments: 1, aiActions: 0, websites: 1, weeklyMessages: 100 },
    contactSales: false,
    customization: false,
    trialDays: 30,
  },
  {
    slug: 'pro',
    name: 'Pro',
    priceToman: 0, // Coming Soon — price TBD
    interval: 'month',
    limits: { agents: 5, conversations: 500_000, departments: 5, aiActions: 500, websites: 3, weeklyMessages: -1 },
    contactSales: false,
    customization: true,
    trialDays: 0,
  },
  {
    slug: 'max',
    name: 'Max',
    priceToman: 0, // Coming Soon — price TBD
    interval: 'month',
    limits: { agents: 20, conversations: 1_000_000, departments: -1, aiActions: 2_000, websites: 8, weeklyMessages: -1 },
    contactSales: false,
    customization: true,
    trialDays: 0,
  },
  {
    slug: 'self-hosted',
    name: 'Self-Hosted',
    priceToman: 0,
    interval: 'month',
    limits: { agents: -1, conversations: -1, departments: -1, aiActions: -1, websites: -1, weeklyMessages: -1 },
    contactSales: true,
    customization: true,
    trialDays: 0,
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
