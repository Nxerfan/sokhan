import { db, getCurrentTenantId } from '@/lib/db'
import { Prisma } from '@prisma/client'

/**
 * Safe internal boundary operations for the `DepartmentMember` model.
 *
 * DESIGN CONTRACT (PR #3 §5):
 *   `DepartmentMember` has NO `tenantId` column — it is a global model with a
 *   composite PK `[departmentId, userId]`. The fail-closed Prisma extension
 *   in `src/lib/db.ts` does NOT scope it (it is not in `TENANT_SCOPED_MODELS`),
 *   so a raw `db.departmentMember.create/delete` would happily mutate a row
 *   pointing at ANY tenant's department — including a foreign tenant's.
 *
 *   To prevent that, application code MUST go through THESE operations. They
 *   re-validate the tenant ownership of the Department (and, for creation,
 *   the tenant membership of the target User) using tenant-scoped lookups
 *   BEFORE touching the global DepartmentMember table.
 *
 *   The boundary works because `db.department.findUnique({ where: { id } })`
 *   inside `withTenant(tenantId, ...)` is auto-scoped to that tenant: a
 *   foreign tenant's departmentId returns null. Same for
 *   `db.membership.findFirst({ where: { userId, status: 'active' } })` — a
 *   foreign userId (no Membership row in this tenant) returns null, and an
 *   invited/inactive membership also returns null.
 *
 *   These functions are INTERNAL (no public API route is added). Department
 *   management routes call them; they do NOT call `db.departmentMember.*`
 *   directly.
 */

/**
 * Error thrown by every `department-members` boundary violation. Every
 * failure mode carries a stable `code` so callers (and tests) can branch on
 * the cause without parsing the message string.
 */
export class DepartmentMemberError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'DepartmentMemberError'
  }
}

/**
 * Add a user to a department — but only after verifying:
 *   1. There IS an active tenant context (caller is inside `withTenant`).
 *   2. The `departmentId` belongs to the CURRENT tenant (foreign tenant's
 *      department is rejected).
 *   3. The `userId` has an ACTIVE Membership in the CURRENT tenant (foreign
 *      user OR invited/inactive membership is rejected).
 *
 * MUST be called inside `withTenant(tenantId, ...)`. Throws
 * `DepartmentMemberError('no_tenant_context')` otherwise.
 */
export async function addDepartmentMember(
  departmentId: string,
  userId: string,
): Promise<{ departmentId: string; userId: string }> {
  const tenantId = getCurrentTenantId()
  if (tenantId === undefined) {
    throw new DepartmentMemberError(
      'Tenant context required',
      'no_tenant_context',
    )
  }

  // Boundary 1 — Department belongs to the current tenant. `db.department`
  // is tenant-scoped, so a foreign departmentId resolves to null.
  const department = await db.department.findUnique({
    where: { id: departmentId },
    select: { id: true },
  })
  if (!department) {
    throw new DepartmentMemberError(
      'Department not found in this tenant',
      'department_not_found',
    )
  }

  // Boundary 2 — User is an ACTIVE member of the current tenant.
  // `db.membership` is tenant-scoped; foreign user OR status !== 'active'
  // resolves to null.
  const membership = await db.membership.findFirst({
    where: { userId, status: 'active' },
    select: { id: true },
  })
  if (!membership) {
    throw new DepartmentMemberError(
      'User is not an active member of this tenant',
      'user_not_active_member',
    )
  }

  // Boundary passed — safe to mutate the global DepartmentMember table.
  try {
    await db.departmentMember.create({
      data: { departmentId, userId },
    })
  } catch (err) {
    // P2002 — unique constraint violation: the (departmentId, userId) pair
    // already exists. Surface as a domain error, not a raw Prisma error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new DepartmentMemberError(
        'User is already a member of this department',
        'already_member',
      )
    }
    throw err
  }

  return { departmentId, userId }
}

/**
 * Remove a user from a department — but only after verifying:
 *   1. There IS an active tenant context.
 *   2. The `departmentId` belongs to the CURRENT tenant (foreign tenant's
 *      department is rejected — you cannot delete rows anchored to another
 *      tenant's department).
 *
 * MUST be called inside `withTenant(tenantId, ...)`. Throws
 * `DepartmentMemberError('no_tenant_context')` otherwise.
 *
 * NOTE: We do NOT re-check the user's membership here — a DepartmentMember
 * row's existence is anchored on the department's tenant ownership (which we
 * DO check). If the row doesn't exist, P2025 is translated to a domain error.
 */
export async function removeDepartmentMember(
  departmentId: string,
  userId: string,
): Promise<{ ok: true }> {
  const tenantId = getCurrentTenantId()
  if (tenantId === undefined) {
    throw new DepartmentMemberError(
      'Tenant context required',
      'no_tenant_context',
    )
  }

  // Boundary — Department belongs to the current tenant.
  const department = await db.department.findUnique({
    where: { id: departmentId },
    select: { id: true },
  })
  if (!department) {
    throw new DepartmentMemberError(
      'Department not found in this tenant',
      'department_not_found',
    )
  }

  try {
    await db.departmentMember.delete({
      where: {
        departmentId_userId: { departmentId, userId },
      },
    })
  } catch (err) {
    // P2025 — row to delete not found. Either the pair was never linked, or
    // it was deleted concurrently. Surface as a domain error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      throw new DepartmentMemberError(
        'DepartmentMember not found',
        'not_found',
      )
    }
    throw err
  }

  return { ok: true as const }
}
