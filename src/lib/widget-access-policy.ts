import 'server-only'
import { db, getCurrentTenantId } from '@/lib/db'
import {
  parseAccessMode, parsePolicyVersion, parseIdentityLevel,
  type AccessMode, type IdentityLevel,
  evaluateSendAuthorization, isPolicyVersionCurrent,
  isValidLoginUrl, isValidLoginButtonLabel, isValidReturnUrlParam, isValidIdentityEndpointPath,
  resolveLegacyTokenIdentity, type AuthorizationDecision,
} from './widget-access-evaluator'

// Re-export ALL pure functions/types from the zero-dep evaluator core.
// Vercel realtime + Docker mini-service import the PURE evaluator directly
// (no server-only/Prisma); app-side code imports from here (backward-compat).
export * from './widget-access-evaluator'

// DB-touching wrapper (needs Prisma — NOT in the pure evaluator).

export async function authorizeSendWithTenant(args: { identityLevel: unknown; presentedPolicyVersion?: number | null }): Promise<AuthorizationDecision> {
  const tid = getCurrentTenantId()
  if (!tid) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  const config = await db.widgetConfig.findUnique({ where: { tenantId: tid }, select: { accessMode: true, policyVersion: true } })
  if (!config) return { allowed: false, reason: 'integration_unavailable', accessMode: null }
  return evaluateSendAuthorization({ accessMode: config.accessMode, currentPolicyVersion: config.policyVersion, identityLevel: args.identityLevel, presentedPolicyVersion: args.presentedPolicyVersion })
}

export function publicAccessConfig(config: { accessMode: string; policyVersion: number; loginUrl?: string | null; loginButtonLabel?: string | null; loginReturnUrlParam?: string | null; identityEndpointPath?: string | null }): { accessMode: AccessMode; policyVersion: number; loginUrl: string | null; loginButtonLabel: string | null; loginReturnUrlParam: string | null; identityEndpointPath: string | null } | null {
  const accessMode = parseAccessMode(config.accessMode)
  if (accessMode === null) return null
  const policyVersion = parsePolicyVersion(config.policyVersion)
  if (policyVersion === null) return null
  // Validate the persisted public login fields against the SAME contract as
  // dashboard PATCH. A legacy unsafe value fail-closes (returns null -> the
  // public route returns 503 policy_unavailable). NEVER silently passed to the
  // browser, NEVER coerced.
  const loginUrl = config.loginUrl ?? null
  if (loginUrl !== null && !isValidLoginUrl(loginUrl)) return null
  const loginButtonLabel = config.loginButtonLabel ?? null
  if (loginButtonLabel !== null && !isValidLoginButtonLabel(loginButtonLabel)) return null
  const loginReturnUrlParam = config.loginReturnUrlParam ?? null
  if (loginReturnUrlParam !== null && !isValidReturnUrlParam(loginReturnUrlParam)) return null
  const identityEndpointPath = config.identityEndpointPath ?? null
  if (identityEndpointPath !== null && !isValidIdentityEndpointPath(identityEndpointPath)) return null
  return { accessMode, policyVersion, loginUrl, loginButtonLabel, loginReturnUrlParam, identityEndpointPath }
}
