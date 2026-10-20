/// <reference types="bun-types" />
/**
 * Real-PostgreSQL boundary tests for the DepartmentMember safe internal ops
 * (`src/lib/department-members.ts`).
 *
 * Executed against Docker PostgreSQL in the `docker-regression` CI job
 * (Full + Lite). The CI step sets DATABASE_URL + DIRECT_URL to the exposed
 * Docker Postgres port. These tests do NOT use the `if (!dbAvailable) return`
 * skip anti-pattern — if the database is unreachable, the test FAILS (which
 * is the correct signal, not a silent skip reported as PASS).
 *
 * `DepartmentMember` is a GLOBAL Prisma model (no `tenantId` column). The
 * fail-closed Prisma extension in `src/lib/db.ts` does NOT scope it, so a
 * raw `db.departmentMember.create/delete` could mutate rows pointing at ANY
 * tenant's department. The boundary functions in `src/lib/department-members.ts`
 * re-validate Department ownership + User active Membership (using the
 * tenant-scoped `db.department` / `db.membership` delegates) BEFORE touching
 * the global `DepartmentMember` table. These tests prove every rejection path.
 *
 * Coverage (PR #3 §5):
 *   §5.1  foreign department  -> addDepartmentMember rejects (department_not_found)
 *   §5.2  foreign user        -> addDepartmentMember rejects (user_not_active_member)
 *   §5.3  inactive (invited) user -> addDepartmentMember rejects (user_not_active_member)
 *   §5.4  valid same-tenant active user -> addDepartmentMember succeeds + row exists
 *   §5.5  duplicate add      -> already_member
 *   §5.6  remove foreign department -> removeDepartmentMember rejects (department_not_found)
 *   §5.7  remove valid -> ok; remove again -> not_found
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import {
  addDepartmentMember,
  removeDepartmentMember,
  DepartmentMemberError,
} from '@/lib/department-members'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let aDeptId: string
let bDeptId: string
let aActiveUserId: string
let bActiveUserId: string
let aInvitedUserId: string

beforeAll(async () => {
  // --- Two real tenants (global client — Tenant is a global model). ---
  tenantA = await globalDb.tenant.create({
    data: {
      slug: `dbb-dm-a-${RUN_ID}`,
      name: `DB Boundary DM A ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })
  tenantB = await globalDb.tenant.create({
    data: {
      slug: `dbb-dm-b-${RUN_ID}`,
      name: `DB Boundary DM B ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })

  // --- A department in each tenant. Created via globalDb (we explicitly
  //     set tenantId; the extension is bypassed). ---
  const aDept = await globalDb.department.create({
    data: { tenantId: tenantA.id, name: `Dept A ${RUN_ID}` },
    select: { id: true },
  })
  aDeptId = aDept.id
  const bDept = await globalDb.department.create({
    data: { tenantId: tenantB.id, name: `Dept B ${RUN_ID}` },
    select: { id: true },
  })
  bDeptId = bDept.id

  // --- Three users: an active member in A, an active member in B, and an
  //     INVITED (status='invited') membership in A. All created via
  //     globalDb (User is global; Membership is tenant-scoped but globalDb
  //     bypasses the extension so we explicitly set tenantId). ---
  const aActive = await globalDb.user.create({
    data: {
      email: `dm-a-active-${RUN_ID}@example.test`,
      name: `A active ${RUN_ID}`,
    },
    select: { id: true },
  })
  aActiveUserId = aActive.id
  await globalDb.membership.create({
    data: {
      userId: aActiveUserId,
      tenantId: tenantA.id,
      role: 'agent',
      status: 'active',
    },
  })

  const bActive = await globalDb.user.create({
    data: {
      email: `dm-b-active-${RUN_ID}@example.test`,
      name: `B active ${RUN_ID}`,
    },
    select: { id: true },
  })
  bActiveUserId = bActive.id
  await globalDb.membership.create({
    data: {
      userId: bActiveUserId,
      tenantId: tenantB.id,
      role: 'agent',
      status: 'active',
    },
  })

  const aInvited = await globalDb.user.create({
    data: {
      email: `dm-a-invited-${RUN_ID}@example.test`,
      name: `A invited ${RUN_ID}`,
    },
    select: { id: true },
  })
  aInvitedUserId = aInvited.id
  await globalDb.membership.create({
    data: {
      userId: aInvitedUserId,
      tenantId: tenantA.id,
      role: 'agent',
      status: 'invited',
    },
  })
})

afterAll(async () => {
  // Cascade: deleting the tenant cascades to Department (onDelete:Cascade)
  // which cascades to DepartmentMember (onDelete:Cascade), and to Membership
  // (onDelete:Cascade). User rows are global and not FK-linked to
  // DepartmentMember, so we delete them explicitly.
  if (tenantA?.id) await globalDb.tenant.deleteMany({ where: { id: tenantA.id } }).catch(() => {})
  if (tenantB?.id) await globalDb.tenant.deleteMany({ where: { id: tenantB.id } }).catch(() => {})
  if (aActiveUserId) await globalDb.user.deleteMany({ where: { id: aActiveUserId } }).catch(() => {})
  if (bActiveUserId) await globalDb.user.deleteMany({ where: { id: bActiveUserId } }).catch(() => {})
  if (aInvitedUserId) await globalDb.user.deleteMany({ where: { id: aInvitedUserId } }).catch(() => {})
  await db.$disconnect().catch(() => {})
})

describe('§5.1 foreign department -> addDepartmentMember rejects (department_not_found)', () => {
  test('tenant A user + tenant B department -> department_not_found', async () => {
    await withTenant(tenantA.id, async () => {
      // aActiveUserId is a real active member of A — so this rejection is
      // purely because bDeptId belongs to tenant B (findUnique scoped to A
      // returns null). The user-membership check is never reached.
      await expect(addDepartmentMember(bDeptId, aActiveUserId)).rejects.toMatchObject({
        code: 'department_not_found',
        name: 'DepartmentMemberError',
      })
    })
  })
})

describe('§5.2 foreign user -> addDepartmentMember rejects (user_not_active_member)', () => {
  test('tenant A department + tenant B user -> user_not_active_member', async () => {
    await withTenant(tenantA.id, async () => {
      // aDeptId belongs to A (passes boundary 1). bActiveUserId is a real
      // active member of B, NOT of A — membership.findFirst scoped to A
      // returns null.
      await expect(addDepartmentMember(aDeptId, bActiveUserId)).rejects.toMatchObject({
        code: 'user_not_active_member',
        name: 'DepartmentMemberError',
      })
    })
  })
})

describe('§5.3 inactive (invited) user -> addDepartmentMember rejects (user_not_active_member)', () => {
  test('tenant A department + tenant A INVITED user -> user_not_active_member', async () => {
    await withTenant(tenantA.id, async () => {
      // aInvitedUserId HAS a Membership row in tenant A, but its status is
      // 'invited' — the findFirst filter on status:'active' returns null.
      await expect(addDepartmentMember(aDeptId, aInvitedUserId)).rejects.toMatchObject({
        code: 'user_not_active_member',
        name: 'DepartmentMemberError',
      })
    })
  })
})

describe('§5.4 valid same-tenant active user -> addDepartmentMember succeeds', () => {
  test('tenant A department + tenant A active user -> row created', async () => {
    let result: { departmentId: string; userId: string } | null = null
    await withTenant(tenantA.id, async () => {
      result = await addDepartmentMember(aDeptId, aActiveUserId)
      expect(result).toEqual({ departmentId: aDeptId, userId: aActiveUserId })
    })

    // Verify the row actually exists in the global DepartmentMember table.
    // Use globalDb (no tenant scope needed — DepartmentMember is global).
    const row = await globalDb.departmentMember.findUnique({
      where: {
        departmentId_userId: { departmentId: aDeptId, userId: aActiveUserId },
      },
    })
    expect(row).not.toBeNull()
    expect(row!.departmentId).toBe(aDeptId)
    expect(row!.userId).toBe(aActiveUserId)
  })
})

describe('§5.5 duplicate add -> already_member', () => {
  test('adding the same valid pair twice -> second call rejects already_member', async () => {
    const deptB = await globalDb.department.create({
      data: { tenantId: tenantA.id, name: `Dept A dup ${RUN_ID}` },
      select: { id: true },
    })
    const userB = await globalDb.user.create({
      data: {
        email: `dm-a-dup-${RUN_ID}@example.test`,
        name: `A dup ${RUN_ID}`,
      },
      select: { id: true },
    })
    await globalDb.membership.create({
      data: {
        userId: userB.id,
        tenantId: tenantA.id,
        role: 'agent',
        status: 'active',
      },
    })

    await withTenant(tenantA.id, async () => {
      const first = await addDepartmentMember(deptB.id, userB.id)
      expect(first).toEqual({ departmentId: deptB.id, userId: userB.id })

      // Second call must fail with already_member — the (departmentId, userId)
      // pair already exists (P2002 unique-constraint violation).
      await expect(addDepartmentMember(deptB.id, userB.id)).rejects.toMatchObject({
        code: 'already_member',
        name: 'DepartmentMemberError',
      })
    })

    // Cleanup the extra user (the tenant cascade will clean up the department
    // + DepartmentMember row).
    await globalDb.user.deleteMany({ where: { id: userB.id } }).catch(() => {})
  })
})

describe('§5.6 remove foreign department -> removeDepartmentMember rejects (department_not_found)', () => {
  test('inside withTenant(A) with tenant B departmentId -> department_not_found', async () => {
    await withTenant(tenantA.id, async () => {
      await expect(removeDepartmentMember(bDeptId, aActiveUserId)).rejects.toMatchObject({
        code: 'department_not_found',
        name: 'DepartmentMemberError',
      })
    })
  })
})

describe('§5.7 remove valid -> ok; remove again -> not_found', () => {
  test('remove the §5.4 row -> ok; remove again -> not_found', async () => {
    // First remove — the row created in §5.4 should still exist (no test
    // between §5.4 and here deleted it).
    await withTenant(tenantA.id, async () => {
      const res = await removeDepartmentMember(aDeptId, aActiveUserId)
      expect(res).toEqual({ ok: true })

      // Verify the row is actually gone.
      const row = await globalDb.departmentMember.findUnique({
        where: {
          departmentId_userId: { departmentId: aDeptId, userId: aActiveUserId },
        },
      })
      expect(row).toBeNull()

      // Second remove — P2025 -> not_found domain error.
      await expect(removeDepartmentMember(aDeptId, aActiveUserId)).rejects.toMatchObject({
        code: 'not_found',
        name: 'DepartmentMemberError',
      })
    })
  })
})
