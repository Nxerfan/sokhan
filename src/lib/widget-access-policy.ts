import 'server-only'
import { db, getCurrentTenantId } from '@/lib/db'
import { evaluateSendAuthorization, type AuthorizationDecision } from './widget-access-evaluator'

// Re-export ALL pure functions/types from the zero-dep evaluator core.
export * from './widget-access-evaluator'

// DB-touching wrapper (needs Prisma — NOT in the pure evaluator).
export async function authorizeSendWithTenant(args: { identityLevel: unknown; presentedPolicyVersion?: number | null }): Promise<AuthorizationDecision> {
  const tid = getCurrentTenantId()
  if (!tid) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  const config = await db.widgetConfig.findUnique({ where: { tenantId: tid }, select: { accessMode: true, policyVersion: true } })
  if (!config) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  return evaluateSendAuthorization({ accessMode: config.accessMode, currentPolicyVersion: config.policyVersion, identityLevel: args.identityLevel, presentedPolicyVersion: args.presentedPolicyVersion })
}
