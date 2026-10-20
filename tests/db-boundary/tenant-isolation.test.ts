/// <reference types="bun-types" />
/**
 * Real-PostgreSQL fail-closed tenant boundary tests.
 *
 * Executed against Docker PostgreSQL in the `docker-regression` CI job
 * (Full + Lite). The CI step sets DATABASE_URL + DIRECT_URL to the exposed
 * Docker Postgres port. These tests do NOT use the `if (!dbAvailable) return`
 * skip anti-pattern — if the database is unreachable, the test FAILS (which
 * is the correct signal, not a silent skip reported as PASS).
 *
 * Coverage (PR #3 section 2):
 *   - tenant-scoped query without tenant context -> rejected before DB access
 *   - tenant-scoped create without tenant scope -> rejected
 *   - withTenant(A) findMany -> only A's rows
 *   - create with attempted tenantId=B -> row stamped tenantId=A (override)
 *   - update with attempted tenantId=B -> row stays in A (cannot move)
 *   - updateMany attempted tenant override -> prevented
 *   - upsert attempted tenant override (create path) -> prevented
 *   - createMany -> every row stamped tenantId=A
 *   - concurrent A/B scoped operations -> isolated
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant, getCurrentTenantId, TenantContextRequiredError } from '@/lib/db'
import type { Prisma } from '@prisma/client'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }

/** Bare-minimum Contact payload (tenantId is injected by the extension). */
function contactPayload(identifier: string): Prisma.ContactCreateInput {
  return {
    identifier,
    identifierType: 'visitorId',
    name: `test-${identifier}`,
    metadata: {},
  } as unknown as Prisma.ContactCreateInput
}

beforeAll(async () => {
  // Two real tenants -- created via the GLOBAL client (no tenant context
  // needed for global models). Cascade delete cleans up their contacts.
  tenantA = await globalDb.tenant.create({
    data: {
      slug: `dbb-a-${RUN_ID}`,
      name: `DB Boundary A ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })
  tenantB = await globalDb.tenant.create({
    data: {
      slug: `dbb-b-${RUN_ID}`,
      name: `DB Boundary B ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'free',
    },
    select: { id: true, slug: true },
  })
})

afterAll(async () => {
  if (tenantA?.id) await globalDb.tenant.deleteMany({ where: { id: tenantA.id } }).catch(() => {})
  if (tenantB?.id) await globalDb.tenant.deleteMany({ where: { id: tenantB.id } }).catch(() => {})
  await db.$disconnect().catch(() => {})
})

describe('§2.1 tenant-scoped query without tenant context -> rejected before DB access', () => {
  test('findMany without context throws TenantContextRequiredError', () => {
    expect(getCurrentTenantId()).toBeUndefined()
    expect(() => (db as any).contact.findMany()).toThrow(TenantContextRequiredError)
  })

  test('create without context throws TenantContextRequiredError', () => {
    expect(() => (db as any).contact.create({ data: contactPayload('no-ctx') })).toThrow(
      TenantContextRequiredError,
    )
  })

  test('updateMany without context throws TenantContextRequiredError', () => {
    expect(() =>
      (db as any).conversation.updateMany({ where: { id: 'x' }, data: { status: 'closed' } }),
    ).toThrow(TenantContextRequiredError)
  })
})

describe('§2.2 withTenant(A) findMany -> only A rows', () => {
  test('scoped findMany returns only the current tenant rows', async () => {
    const idA = `find-A-${RUN_ID}`
    const idB = `find-B-${RUN_ID}`
    await withTenant(tenantA.id, async () => {
      await db.contact.create({ data: contactPayload(idA) })
    })
    await withTenant(tenantB.id, async () => {
      await db.contact.create({ data: contactPayload(idB) })
    })

    await withTenant(tenantA.id, async () => {
      const rows = await db.contact.findMany({
        where: { identifier: { in: [idA, idB] } },
      })
      expect(rows.length).toBe(1)
      expect(rows[0].tenantId).toBe(tenantA.id)
      expect(rows[0].identifier).toBe(idA)
    })

    await withTenant(tenantB.id, async () => {
      const rows = await db.contact.findMany({
        where: { identifier: { in: [idA, idB] } },
      })
      expect(rows.length).toBe(1)
      expect(rows[0].tenantId).toBe(tenantB.id)
      expect(rows[0].identifier).toBe(idB)
    })
  })
})

describe('§2.3 create with attempted tenantId=B -> cannot create B', () => {
  test('attempted tenant override on create is stamped to context tenant', async () => {
    const identifier = `override-create-${RUN_ID}`
    await withTenant(tenantA.id, async () => {
      const created = await db.contact.create({
        data: { ...contactPayload(identifier), tenantId: tenantB.id } as any,
      })
      expect(created.tenantId).toBe(tenantA.id)
    })

    await withTenant(tenantA.id, async () => {
      const row = await db.contact.findFirst({ where: { identifier } })
      expect(row).not.toBeNull()
      expect(row!.tenantId).toBe(tenantA.id)
    })
    await withTenant(tenantB.id, async () => {
      const row = await db.contact.findFirst({ where: { identifier } })
      expect(row).toBeNull()
    })
  })
})

describe('§2.4 update with attempted tenantId=B -> cannot move row', () => {
  test('update strips tenantId from data -- row stays in A', async () => {
    const identifier = `override-update-${RUN_ID}`
    let contactId = ''
    await withTenant(tenantA.id, async () => {
      const created = await db.contact.create({ data: contactPayload(identifier) })
      contactId = created.id
    })

    await withTenant(tenantA.id, async () => {
      const updated = await db.contact.update({
        where: { id: contactId },
        data: { tenantId: tenantB.id, name: 'moved-to-B' } as any,
      })
      expect(updated.tenantId).toBe(tenantA.id)
      expect(updated.name).toBe('moved-to-B')
    })

    await withTenant(tenantB.id, async () => {
      const row = await db.contact.findUnique({ where: { id: contactId } })
      expect(row).toBeNull()
    })
    await withTenant(tenantA.id, async () => {
      const row = await db.contact.findUnique({ where: { id: contactId } })
      expect(row).not.toBeNull()
      expect(row!.tenantId).toBe(tenantA.id)
    })
  })
})

describe('§2.5 updateMany attempted tenant override -> prevented', () => {
  test('updateMany scopes where to A and strips tenantId from data', async () => {
    const identifier = `override-updateMany-${RUN_ID}`
    let contactId = ''
    await withTenant(tenantA.id, async () => {
      const created = await db.contact.create({ data: contactPayload(identifier) })
      contactId = created.id
    })

    await withTenant(tenantA.id, async () => {
      const res = await db.contact.updateMany({
        where: { id: contactId },
        data: { tenantId: tenantB.id, name: 'many-moved' } as any,
      })
      expect(res.count).toBe(1)
    })

    await withTenant(tenantB.id, async () => {
      const row = await db.contact.findUnique({ where: { id: contactId } })
      expect(row).toBeNull()
    })
    await withTenant(tenantA.id, async () => {
      const row = await db.contact.findUnique({ where: { id: contactId } })
      expect(row).not.toBeNull()
      expect(row!.tenantId).toBe(tenantA.id)
    })
  })
})

describe('§2.6 upsert attempted tenant override -> prevented', () => {
  test('upsert create-path forces context tenant (override prevented)', async () => {
    const identifier = `override-upsert-${RUN_ID}`
    await withTenant(tenantA.id, async () => {
      const created = await db.contact.upsert({
        where: { id: 'nonexistent-upsert-id-' + RUN_ID },
        create: {
          ...contactPayload(identifier),
          tenantId: tenantB.id,
        } as any,
        update: {},
      })
      expect(created.tenantId).toBe(tenantA.id)
    })

    await withTenant(tenantB.id, async () => {
      const row = await db.contact.findFirst({ where: { identifier } })
      expect(row).toBeNull()
    })
    await withTenant(tenantA.id, async () => {
      const row = await db.contact.findFirst({ where: { identifier } })
      expect(row).not.toBeNull()
      expect(row!.tenantId).toBe(tenantA.id)
    })
  })
})

describe('§2.7 createMany -> all rows stamped tenant A', () => {
  test('createMany stamps every row with the context tenant', async () => {
    const id1 = `many-1-${RUN_ID}`
    const id2 = `many-2-${RUN_ID}`
    const id3 = `many-3-${RUN_ID}`
    await withTenant(tenantA.id, async () => {
      const res = await db.contact.createMany({
        data: [
          { ...contactPayload(id1), tenantId: tenantB.id } as any,
          { ...contactPayload(id2), tenantId: tenantB.id } as any,
          { ...contactPayload(id3), tenantId: tenantB.id } as any,
        ],
      })
      expect(res.count).toBe(3)
    })

    await withTenant(tenantA.id, async () => {
      const rows = await db.contact.findMany({
        where: { identifier: { in: [id1, id2, id3] } },
      })
      expect(rows.length).toBe(3)
      for (const r of rows) expect(r.tenantId).toBe(tenantA.id)
    })
    await withTenant(tenantB.id, async () => {
      const rows = await db.contact.findMany({
        where: { identifier: { in: [id1, id2, id3] } },
      })
      expect(rows.length).toBe(0)
    })
  })
})

describe('§2.8 concurrent A/B scoped operations -> isolated', () => {
  test('parallel withTenant A/B writes do not leak across tenants', async () => {
    const idA = `conc-A-${RUN_ID}`
    const idB = `conc-B-${RUN_ID}`

    await Promise.all([
      withTenant(tenantA.id, async () => {
        await db.contact.create({ data: contactPayload(idA) })
        await new Promise((r) => setTimeout(r, 20))
        const rows = await db.contact.findMany({
          where: { identifier: { in: [idA, idB] } },
        })
        expect(rows.length).toBe(1)
        expect(rows[0].tenantId).toBe(tenantA.id)
        expect(rows[0].identifier).toBe(idA)
      }),
      withTenant(tenantB.id, async () => {
        await db.contact.create({ data: contactPayload(idB) })
        await new Promise((r) => setTimeout(r, 20))
        const rows = await db.contact.findMany({
          where: { identifier: { in: [idA, idB] } },
        })
        expect(rows.length).toBe(1)
        expect(rows[0].tenantId).toBe(tenantB.id)
        expect(rows[0].identifier).toBe(idB)
      }),
    ])
  })
})
