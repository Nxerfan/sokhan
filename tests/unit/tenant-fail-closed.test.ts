/// <reference types="bun-types" />
/**
 * Prisma fail-closed ARCHITECTURE tests (no database required).
 *
 * These verify the FAIL-CLOSED property of the exported `db` Proxy at the
 * access boundary — BEFORE any query reaches the database. They do NOT
 * connect to PostgreSQL and do NOT use the `if (!dbAvailable) return` skip
 * anti-pattern. The full DB-level override/isolation behaviors are covered
 * by `tests/db-boundary/tenant-isolation.test.ts` (executed against Docker
 * PostgreSQL in the docker-regression CI job).
 *
 * Mandatory property under test: NO tenantId → NO tenant-scoped
 * client/query. Accessing a tenant-scoped model delegate on the exported
 * `db` outside `withTenant(...)` throws `TenantContextRequiredError`
 * synchronously — the query never reaches the database.
 */

import { test, expect, describe } from 'bun:test'
import { db, withTenant, getCurrentTenantId, TenantContextRequiredError } from '@/lib/db'

/** A representative sample of tenant-scoped delegate names. */
const TENANT_SCOPED_DELEGATES = [
  'contact',
  'conversation',
  'message',
  'product',
  'membership',
  'department',
  'participant',
  'routingRule',
  'widgetDomain',
  'faqPair',
  'widgetConfig',
  'aiConfig',
  'connectorConfig',
  'subscription',
  'invoice',
]

/** Global models — must NOT throw without a tenant context. */
const GLOBAL_DELEGATES = ['tenant', 'user', 'plan', 'otpRequest', 'pendingSignup']

describe('Fail-closed: no tenant context', () => {
  test('getCurrentTenantId() is undefined outside withTenant', () => {
    expect(getCurrentTenantId()).toBeUndefined()
  })

  for (const delegate of TENANT_SCOPED_DELEGATES) {
    test(`db.${delegate} throws TenantContextRequiredError without context`, () => {
      // Accessing the delegate itself (not even calling a query method) must
      // throw — there is no path to silently execute an unscoped query.
      expect(() => {
        void (db as any)[delegate]
      }).toThrow(TenantContextRequiredError)
    })
  }

  test('db.contact.findMany() never reaches the DB without context (throws on delegate access)', () => {
    // The throw happens at the Proxy `get` trap when `db.contact` is read —
    // findMany() is never called. This is the fail-closed guarantee.
    let findManyCalled = false
    expect(() => {
      // Reading `.contact` throws before `.findMany` can be reached.
      void (db as any).contact.findMany
      findManyCalled = true
    }).toThrow(TenantContextRequiredError)
    expect(findManyCalled).toBe(false)
  })

  for (const delegate of GLOBAL_DELEGATES) {
    test(`db.${delegate} does NOT throw without context (global model)`, () => {
      // Global models route to the shared base client — no tenant context
      // needed. Accessing the delegate must not throw.
      expect(() => {
        const d = (db as any)[delegate]
        // The delegate object must be truthy.
        expect(d).toBeTruthy()
      }).not.toThrow()
    })
  }
})

describe('Fail-closed: withTenant activates context', () => {
  test('withTenant sets getCurrentTenantId() within its callback', async () => {
    expect(getCurrentTenantId()).toBeUndefined()
    const seen = await withTenant('tenant-A-test', async () => getCurrentTenantId())
    expect(seen).toBe('tenant-A-test')
    // Context is restored after the callback exits.
    expect(getCurrentTenantId()).toBeUndefined()
  })

  test('db.contact does NOT throw inside withTenant', async () => {
    // Inside withTenant the Proxy routes to the per-tenant extended client
    // — accessing the delegate must succeed (no throw).
    await withTenant('tenant-A-test', async () => {
      expect(() => {
        const d = (db as any).contact
        expect(d).toBeTruthy()
      }).not.toThrow()
    })
  })
})

describe('AsyncLocalStorage isolation', () => {
  test('concurrent withTenant A/B calls do not leak tenant context', async () => {
    const [a, b] = await Promise.all([
      withTenant('tenant-A-test', async () => {
        await new Promise((r) => setTimeout(r, 10))
        return getCurrentTenantId()
      }),
      withTenant('tenant-B-test', async () => {
        await new Promise((r) => setTimeout(r, 10))
        return getCurrentTenantId()
      }),
    ])
    expect(a).toBe('tenant-A-test')
    expect(b).toBe('tenant-B-test')
    expect(getCurrentTenantId()).toBeUndefined()
  })

  test('nested withTenant overrides the outer context', async () => {
    const result = await withTenant('outer', async () => {
      const inner = await withTenant('inner', async () => getCurrentTenantId())
      const after = getCurrentTenantId()
      return { inner, after }
    })
    expect(result.inner).toBe('inner')
    // After the inner withTenant returns, ALS restores the outer context.
    expect(result.after).toBe('outer')
  })
})
