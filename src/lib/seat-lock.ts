import type { Prisma } from '@prisma/client'

/**
 * Per-tenant seat-capacity serialization lock — FINAL BLOCKER fix.
 *
 * Takes an exclusive PostgreSQL ROW LOCK on the Tenant row, INSIDE the
 * enclosing `db.$transaction`, BEFORE reading seat usage. While the lock
 * is held, the transaction:
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
 * IMPLEMENTATION — model UPDATE, NOT $queryRaw
 * --------------------------------------------
 * The lock is taken via a model operation `tx.tenant.update(...)`, NOT a
 * raw `SELECT ... FOR UPDATE` via `$queryRaw`. Reason: raw queries on an
 * extended client's interactive transaction are NOT guaranteed to run on
 * the transaction's connection (observed in CI: the FOR UPDATE lock was
 * taken on a SEPARATE connection and released immediately — providing
 * zero serialization; the D7 concurrent-reissue behavioral test caught
 * it with a 200,200 overbooking outcome). Model operations on the
 * extended transaction client ARE guaranteed to run on the transaction
 * connection (proven by the existing claim+create atomicity in the
 * reissue transaction). A PostgreSQL UPDATE takes an exclusive row lock
 * on the updated row, held until the transaction commits/rolls back —
 * a concurrent `tx.tenant.update` on the same row BLOCKS until then.
 * This is the standard "dummy update" row-lock idiom.
 *
 * The only side effect is bumping `tenant.updatedAt` (bookkeeping) —
 * semantically harmless.
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
 * Deadlock-free: this is the ONLY row lock taken first in these
 * transactions, and no other transaction locks Tenant after locking
 * Invitation/Membership rows (single lock ordering).
 */
export async function acquireTenantSeatLock(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  // A no-op data UPDATE on the Tenant row takes an exclusive PostgreSQL
  // row lock, held until the enclosing transaction commits/rolls back.
  // Concurrent seat-reserving transactions for the same tenant BLOCK on
  // this UPDATE — the capacity count below is then serialized. If the
  // tenant row does not exist, update throws P2025 (fail loudly rather
  // than proceeding unsynchronized).
  await tx.tenant.update({
    where: { id: tenantId },
    data: { updatedAt: new Date() },
  })
}
