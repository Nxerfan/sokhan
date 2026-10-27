import { PrismaClient } from '@prisma/client'
import { evaluateVisitorCurrentPolicyAccess, type ContactIdentityClass } from './widget-access-evaluator'
import type { VisitorTokenPayload } from './realtime-token-shared'

/**
 * Production visitor-access adapter for the Vercel realtime function.
 * Loads CURRENT tenant+WidgetConfig+Contact from the DB + runs the shared
 * pure evaluator. Returns { allowed: true } or { allowed: false, reason }.
 * reason is one of: policy_unavailable, identity_token_invalid, policy_changed,
 * verification_required, website_login_required.
 */
export async function verifyVisitorAccess(
  payload: VisitorTokenPayload,
  prisma: PrismaClient,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  // 1. Validate required token binding fields.
  if (!payload.tenantId || !payload.slug || !payload.contactId) {
    return { allowed: false, reason: 'identity_token_invalid' }
  }
  // 2. Load tenant by slug (token.slug).
  const tenant = await prisma.tenant.findUnique({
    where: { slug: payload.slug },
    include: { widgetConfig: true },
  })
  if (!tenant) return { allowed: false, reason: 'policy_unavailable' }
  // 3. Verify tenant.id === token.tenantId.
  if (tenant.id !== payload.tenantId) return { allowed: false, reason: 'identity_token_invalid' }
  // 4. Load CURRENT WidgetConfig.
  if (!tenant.widgetConfig) return { allowed: false, reason: 'policy_unavailable' }
  // 5. Load Contact (raw Prisma — not the fail-closed proxy, since the Vercel
  //    function runs outside the Next.js app's tenant context).
  const contact = await prisma.contact.findUnique({
    where: { id: payload.contactId },
    select: { id: true, tenantId: true, identifierType: true, externalUserId: true, emailVerifiedAt: true },
  })
  if (!contact || contact.tenantId !== tenant.id) return { allowed: false, reason: 'identity_token_invalid' }
  // 6. Build ContactIdentityClass + 7. Call evaluateVisitorCurrentPolicyAccess.
  const contactIdentityClass: ContactIdentityClass = {
    identifierType: contact.identifierType,
    externalUserId: contact.externalUserId,
    emailVerifiedAt: contact.emailVerifiedAt,
  }
  const decision = evaluateVisitorCurrentPolicyAccess({
    currentAccessMode: tenant.widgetConfig.accessMode,
    currentPolicyVersion: tenant.widgetConfig.policyVersion,
    tokenIdentityLevel: payload.identityLevel,
    tokenPolicyVersion: payload.policyVersion,
    contactIdentityClass,
  })
  // 8. Return the shared decision.
  if (decision.allowed) return { allowed: true }
  return { allowed: false, reason: decision.reason }
}
