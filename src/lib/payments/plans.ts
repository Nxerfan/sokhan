/**
 * Plan catalog (Module 6 restructure).
 *
 * Plans: Free (30-day trial, 100 msgs/week, 1 website, locked customization),
 * Pro (1,200,000 Toman/month, 1,400 AI replies, full customization),
 * Max (7,500,000 Toman/month, 10,000 AI replies, full customization),
 * Self-Hosted (contact sales, unlimited).
 *
 * AI-Q2 owner-approved pricing: Pro 1.2M Toman / 1,400 successful AI replies,
 * Max 7.5M Toman / 10,000 replies. Free built-in AI is zero. Self-hosted
 * remains contact-sales with unlimited (-1).
 *
 * `getPlan(slug)` looks up by slug (prototype-pollution-safe).
 * `ensurePlansSeeded()` syncs to DB.
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
    priceToman: 1_200_000,
    interval: 'month',
    limits: { agents: 5, conversations: 500_000, departments: 5, aiActions: 1_400, websites: 3, weeklyMessages: -1 },
    contactSales: false,
    customization: true,
    trialDays: 0,
  },
  {
    slug: 'max',
    name: 'Max',
    priceToman: 7_500_000,
    interval: 'month',
    limits: { agents: 20, conversations: 1_000_000, departments: -1, aiActions: 10_000, websites: 8, weeklyMessages: -1 },
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

// Null-prototype backing store — prototype pollution safe. `getPlan('constructor')`
// etc. returns null, not the Object constructor.
const PLAN_BY_SLUG: Readonly<Record<string, Plan>> = Object.assign(
  Object.create(null) as Record<string, Plan>,
  ...PLANS.map((p) => ({ [p.slug]: p })),
)

export function getPlan(slug: string): Plan | null {
  // Explicit hasOwnProperty check on a null-prototype object — safe against
  // `constructor`, `__proto__`, `toString`, etc.
  return Object.prototype.hasOwnProperty.call(PLAN_BY_SLUG, slug)
    ? PLAN_BY_SLUG[slug]
    : null
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
