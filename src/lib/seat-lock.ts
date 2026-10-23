import type { Prisma } from '@prisma/client'

/**
 * Per-tenant seat-capacity serialization lock — FINAL BLOCKER fix.
 *
 * Takes an exclusive PostgreSQL ROW LOCK, INSIDE the enclosing
 * `db.$transaction`, BEFORE reading seat usage. While the lock is held,
 * the transaction:
 *   1. resolves the effective plan
 *   2. counts active memberships
 *   3. counts unexpired pending invitations
 *   4. verifies capacity
 *   5. performs the seat-increasing write
 *   6. commits (releasing the lock)
 *
 * EVERY operation that INCREASES logical agent-seat usage must acquire
 * this SAME tenant lock before capacity counting:
 *   - POST /api/invitations (new pending invitation creation)
 *   - POST /api/invitations/reissue (revoked → new pending)
 *
 * IMPLEMENTATION — lock on the OWNER MEMBERSHIP row (tenant-scoped model)
 * ----------------------------------------------------------------------
 * The lock is a `tx.membership.updateMany({ where: { tenantId, role:
 * 'owner' }, data: { updatedAt } })` — an UPDATE on the tenant OWNER's
 * membership row. This is deliberately a TENANT-SCOPED model operation:
 *
 *   - The fail-closed Prisma extension intercepts tenant-scoped models
 *     and executes them via `query(args)` ON THE TRANSACTION CONNECTION —
 *     so the row lock is held by the transaction until commit (the same
 *     code path as the reissue conditional claim, whose same-row blocking
 *     is PROVEN by the E8 single-winner test).
 *   - Passthrough operations are NOT guaranteed to run on the transaction
 *     connection: CI proved that BOTH `tx.$queryRaw` (FOR UPDATE) AND
 *     `tx.tenant.update` (a global-model update) executed on a SEPARATE
 *     autocommit connection — the lock was released immediately,
 *     providing ZERO serialization (the D7 concurrent-reissue behavioral
 *     test caught both with 200,200 overbooking outcomes).
 *
 * Every tenant has exactly ONE owner membership (created at signup;
 * `canManageRole` prevents assigning 'owner' via invitations/members
 * endpoints) — a single shared row per tenant, so ALL seat-increasing
 * transactions for a tenant serialize on it, even when they touch
 * DIFFERENT Invitation rows.
 *
 * Side effect: bumping the owner membership's `updatedAt` (bookkeeping).
 *
 * DATABASE-BACKED + CROSS-INSTANCE SAFE
 * -------------------------------------
 * PostgreSQL row lock, not an application-process mutex. Multiple Vercel
 * serverless instances / Node processes / app containers all serialize on
 * the same database row lock.
 *
 * Acceptance (pending → active) does NOT increase usage (conversion) and
 * keeps its existing transactional downgrade/cap validation without this
 * lock.
 *
 * Deadlock-free: the owner-membership row lock is the ONLY lock taken
 * FIRST in the seat-reserving transactions; the accept/reactivation path
 * locks other membership rows (never the owner row — the owner cannot
 * accept an invitation to their own tenant: `already_member` blocks it)
 * and never takes this lock after locking something else.
 */
export async function acquireTenantSeatLock(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  // Update the OWNER membership row. A PostgreSQL UPDATE takes an
  // exclusive row lock on the matched row(s), held until the enclosing
  // transaction commits/rolls back. Concurrent seat-reserving
  // transactions for the same tenant BLOCK here — the capacity count
  // below is then serialized.
  const locked = await tx.membership.updateMany({
    where: { tenantId, role: 'owner' },
    data: { updatedAt: new Date() },
  })
  if (locked.count === 0) {
    // Every tenant has an owner membership — missing means data
    // corruption. Fail loudly rather than proceeding unsynchronized.
    throw new Error('seat-lock: owner membership row not found for tenant')
  }
}
