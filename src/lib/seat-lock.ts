import type { Prisma } from '@prisma/client'

/**
 * Per-tenant seat-capacity serialization lock — FINAL BLOCKER fix.
 *
 * PostgreSQL row-level lock (`SELECT ... FOR UPDATE`) on the Tenant row,
 * acquired INSIDE a `db.$transaction` BEFORE reading seat usage. While
 * the lock is held, the transaction:
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
 * This serializes concurrent seat-increasing transactions for the same
 * tenant even when they touch DIFFERENT Invitation rows (two concurrent
 * creates, or two concurrent reissues of different revoked invitations)
 * — they both block on the same Tenant row, so the second transaction's
 * capacity count sees the first one's committed write.
 *
 * DATABASE-BACKED + CROSS-INSTANCE SAFE
 * -------------------------------------
 * The lock is a PostgreSQL row lock, NOT an application-process mutex.
 * Multiple Vercel serverless instances / Node processes / app containers
 * all serialize on the same database row lock. No process-local state.
 *
 * Acceptance (pending → active) does NOT increase usage (it is a
 * conversion) and keeps its existing transactional downgrade/cap
 * validation without taking this lock.
 *
 * USAGE
 * -----
 *   await db.$transaction(async (tx) => {
 *     await acquireTenantSeatLock(tx, tenantId)
 *     // ... serialized capacity count + seat-increasing write ...
 *   })
 *
 * The lock is held until the transaction commits or rolls back.
 * Deadlock-free: this is the ONLY row lock taken first in these
 * transactions, and no other transaction locks Tenant after locking
 * Invitation/Membership rows (single lock ordering).
 */
export async function acquireTenantSeatLock(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  // FOR UPDATE takes an exclusive row lock on the Tenant row, held until
  // the enclosing transaction commits/rolls back. Concurrent transactions
  // executing this statement for the same tenant BLOCK here.
  // The interpolated value is a Prisma parameterized value (SQL-injection safe).
  const locked = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`
  if (!locked || locked.length === 0) {
    // The tenant row must exist (we are inside an authenticated tenant
    // context). If it does not, fail loudly rather than proceeding
    // unsynchronized.
    throw new Error('seat-lock: tenant row not found for seat reservation')
  }
}
