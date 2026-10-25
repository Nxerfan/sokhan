import 'server-only'
import { db, getCurrentTenantId } from '@/lib/db'

export const ACCESS_MODES = ['anonymous', 'verified_visitor', 'site_user_only'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]
export const IDENTITY_LEVELS = ['anonymous', 'verified_contact', 'external_user'] as const
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number]
export const DEFAULT_ACCESS_MODE_NEW: AccessMode = 'verified_visitor'
export const DEFAULT_ACCESS_MODE_EXISTING: AccessMode = 'anonymous'

export function parseAccessMode(value: unknown): AccessMode | null {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value) ? (value as AccessMode) : null
}
export function parseIdentityLevel(value: unknown): IdentityLevel | null {
  return typeof value === 'string' && (IDENTITY_LEVELS as readonly string[]).includes(value) ? (value as IdentityLevel) : null
}
export function parsePolicyVersion(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null
  return value
}
export function coerceAccessMode(value: unknown): AccessMode { return parseAccessMode(value) ?? 'anonymous' }
export function coerceIdentityLevel(value: unknown): IdentityLevel { return parseIdentityLevel(value) ?? 'anonymous' }

export function isIdentitySufficient(accessMode: AccessMode, identityLevel: IdentityLevel): boolean {
  if (accessMode === 'anonymous') return true
  if (accessMode === 'verified_visitor') return identityLevel === 'verified_contact' || identityLevel === 'external_user'
  return identityLevel === 'external_user'
}
export function requiresVerification(accessMode: AccessMode): boolean { return accessMode !== 'anonymous' }
export function isPolicyVersionCurrent(presented: number | undefined | null, current: number): boolean {
  const p = parsePolicyVersion(presented); return p !== null && p === current
}

export type AuthorizationDecision =
  | { allowed: true; accessMode: AccessMode; identityLevel: IdentityLevel }
  | { allowed: false; reason: AuthorizationDenyReason; accessMode: AccessMode | null }
export type AuthorizationDenyReason = 'verification_required' | 'website_login_required' | 'identity_token_invalid' | 'identity_token_expired' | 'policy_changed' | 'integration_unavailable' | 'policy_unavailable'

export function resolveLegacyTokenIdentity(args: { currentAccessMode: AccessMode; tokenIdentityLevel: unknown; tokenPolicyVersion: unknown }): IdentityLevel | null {
  const level = parseIdentityLevel(args.tokenIdentityLevel)
  const pv = parsePolicyVersion(args.tokenPolicyVersion)
  if (level !== null && pv !== null) return level
  if (args.currentAccessMode === 'anonymous') return 'anonymous'
  return null
}

export function evaluateSendAuthorization(args: { accessMode: unknown; currentPolicyVersion: unknown; identityLevel: unknown; presentedPolicyVersion?: number | null }): AuthorizationDecision {
  const accessMode = parseAccessMode(args.accessMode)
  if (accessMode === null) return { allowed: false, reason: 'policy_unavailable', accessMode: null }
  const currentPolicyVersion = parsePolicyVersion(args.currentPolicyVersion)
  if (currentPolicyVersion === null) return { allowed: false, reason: 'policy_unavailable', accessMode }
  const identityLevel = parseIdentityLevel(args.identityLevel)
  if (identityLevel === null) return { allowed: false, reason: 'policy_unavailable', accessMode }
  if (requiresVerification(accessMode) && !isPolicyVersionCurrent(args.presentedPolicyVersion, currentPolicyVersion)) return { allowed: false, reason: 'policy_changed', accessMode }
  if (isIdentitySufficient(accessMode, identityLevel)) return { allowed: true, accessMode, identityLevel }
  const reason: AuthorizationDenyReason = accessMode === 'verified_visitor' ? 'verification_required' : accessMode === 'site_user_only' ? 'website_login_required' : 'verification_required'
  return { allowed: false, reason, accessMode }
}

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
  return { accessMode, policyVersion, loginUrl: config.loginUrl ?? null, loginButtonLabel: config.loginButtonLabel ?? null, loginReturnUrlParam: config.loginReturnUrlParam ?? null, identityEndpointPath: config.identityEndpointPath ?? null }
}
