/**
 * Free plan enforcement.
 *
 * - 30-day trial lock: after 30 days, dashboard is locked and widget stops
 * - Weekly message limit: 100 messages per rolling 7-day window
 * - Customization lock: widget config is locked to Sukhan brand defaults
 * - Email trial restriction: can't create another free workspace after using trial
 */

import { db, withTenant } from '@/lib/db'
import { getPlan, type PlanSlug } from './plans'

/** Check if a tenant's free trial has expired (> 30 days old). */
export async function isFreeTrialExpired(tenantId: string): Promise<boolean> {
  // Tenant is a global model — no withTenant wrap needed.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, workspaceCreatedAt: true },
  })
  if (!tenant || tenant.plan !== 'free') return false

  const plan = getPlan('free')
  if (!plan || plan.trialDays === 0) return false

  const ageMs = Date.now() - tenant.workspaceCreatedAt.getTime()
  return ageMs > plan.trialDays * 24 * 60 * 60 * 1000
}

/** Check if a user has already used their free trial. */
export async function hasUsedFreeTrial(email: string): Promise<boolean> {
  // User is a global model — no withTenant wrap needed.
  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { hasUsedFreeTrial: true },
  })
  return user?.hasUsedFreeTrial ?? false
}

/** Mark a user as having used their free trial. */
export async function markFreeTrialUsed(email: string): Promise<void> {
  // User is a global model — no withTenant wrap needed.
  await db.user.update({
    where: { email: email.toLowerCase() },
    data: { hasUsedFreeTrial: true },
  })
}

/**
 * Check if the tenant can send a visitor message (weekly limit for free plan).
 * Returns { allowed, reason } where reason is a user-friendly message.
 */
export async function checkMessageLimit(tenantId: string): Promise<{ allowed: boolean; reason?: string }> {
  // Tenant is a global model — no withTenant wrap needed for this lookup.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true },
  })
  if (!tenant) return { allowed: false, reason: 'invalid_tenant' }

  const plan = getPlan(tenant.plan)
  if (!plan) return { allowed: false, reason: 'invalid_plan' }

  // Free plan: check weekly message limit
  if (tenant.plan === 'free') {
    const expired = await isFreeTrialExpired(tenantId)
    if (expired) {
      return { allowed: false, reason: 'trial_expired' }
    }

    if (plan.limits.weeklyMessages > 0) {
      // Message is a tenant-scoped model — must run inside withTenant.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const count = await withTenant(tenantId, () =>
        db.message.count({
          where: { senderType: 'contact', createdAt: { gte: sevenDaysAgo } },
        }),
      )
      if (count >= plan.limits.weeklyMessages) {
        return { allowed: false, reason: 'weekly_limit_reached' }
      }
    }
  }

  return { allowed: true }
}

/**
 * Get the effective widget config for a tenant.
 * Free plan: returns LOCKED defaults (Sukhan brand).
 * Paid plans: returns the tenant's configured values.
 */
export async function getEffectiveWidgetConfig(tenantId: string) {
  // Tenant is a global model. The `include: { widgetConfig: true }` performs a
  // nested read on WidgetConfig (a tenant-scoped model), but the read is
  // scoped by the Tenant row's unique tenantId — there's exactly one
  // WidgetConfig row per tenant. No withTenant wrap needed for correctness.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    include: { widgetConfig: true },
  })
  if (!tenant) return null

  const plan = getPlan(tenant.plan)
  const isLocked = !plan?.customization

  if (isLocked) {
    // Return Sukhan brand defaults — locked
    return {
      accentColor: '#E09A2B',
      launcherShape: 'tab',
      position: 'bottom-end',
      avatarUrl: null,
      logoUrl: null,
      greetingTexts: {
        fa: 'سلام! چطور می‌تونم کمکتون کنم؟',
        en: 'Hi there! How can I help?',
      },
      defaultLocale: tenant.defaultLocale,
      defaultDirection: tenant.defaultDirection,
      isLocked: true,
      poweredBy: true, // "Powered by Sukhan" badge — always visible on free plan
    }
  }

  if (!tenant.widgetConfig) return null

  return {
    accentColor: tenant.widgetConfig.accentColor,
    launcherShape: tenant.widgetConfig.launcherShape,
    position: tenant.widgetConfig.position,
    avatarUrl: tenant.widgetConfig.avatarUrl,
    logoUrl: tenant.widgetConfig.logoUrl,
    greetingTexts: tenant.widgetConfig.greetingTexts as Record<string, string>,
    defaultLocale: tenant.widgetConfig.defaultLocale,
    defaultDirection: tenant.defaultDirection,
    isLocked: false,
    poweredBy: false,
  }
}
