/**
 * Shared role-authorisation helpers (PR #11).
 *
 * Role hierarchy:
 *   owner: 5, admin: 4, manager: 3, agent: 2, viewer: 1
 *
 * Rules:
 *   owner   may manage admin / manager / agent / viewer (not owner)
 *   admin   may manage manager / agent / viewer (not owner / admin)
 *   manager may manage agent / viewer (not owner / admin / manager)
 *   agent   no membership management
 *   viewer  no membership management
 *
 * Nobody may assign 'owner' through the membership / invitation endpoints.
 *
 * IMPORTANT: this module must NOT import from '@/lib/db' or any module
 * that uses server-only APIs (AsyncLocalStorage, Prisma, etc.). The
 * ROLE_RANK constant and hasRole function are duplicated here to keep
 * this module safe for client-side imports (e.g. members-panel.tsx).
 */

/** Role rank mapping (duplicated from src/lib/db.ts for client-safe import). */
export const ROLE_RANK: Record<string, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  agent: 2,
  viewer: 1,
}

/** Roles that can be assigned via the members/invitations endpoints. Owner is excluded. */
export const VALID_ROLES = ['admin', 'manager', 'agent', 'viewer']

/** Check if current role meets or exceeds required role. */
export function hasRole(current: string, required: string): boolean {
  return (ROLE_RANK[current] ?? 0) >= (ROLE_RANK[required] ?? 0)
}

/**
 * Returns true if `actorRole` is allowed to manage a membership / invitation
 * whose target role is `targetRole`.
 */
export function canManageRole(actorRole: string, targetRole: string): boolean {
  if (targetRole === 'owner') return false
  if (!hasRole(actorRole, 'manager')) return false
  const actorRank = ROLE_RANK[actorRole] ?? 0
  const targetRank = ROLE_RANK[targetRole] ?? 0
  return targetRank < actorRank
}
