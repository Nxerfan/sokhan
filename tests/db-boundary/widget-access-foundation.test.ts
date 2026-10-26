/// <reference types="bun-types" />
/**
 * Widget Access — DB constraints + migration + external identity foundation.
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Uses globalDb (global models) + withTenant (tenant-scoped models) against
 * real PostgreSQL. Does NOT mock unique indexes, CHECK constraints, or
 * transactions.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { db, globalDb, withTenant } from '@/lib/db'
import {
  generateIntegrationSecret,
  hashIntegrationSecret,
  verifyIntegrationSecret,
  resolveTenantByIntegrationSecret,
} from '@/lib/widget-integration-credential'
import crypto from 'crypto'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantA: { id: string; slug: string }
let tenantB: { id: string; slug: string }
let widgetConfigA: string

beforeAll(async () => {
  tenantA = await globalDb.tenant.create({
    data: { slug: `wam-a-${RUN_ID}`, name: `WAM A ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  tenantB = await globalDb.tenant.create({
    data: { slug: `wam-b-${RUN_ID}`, name: `WAM B ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
    select: { id: true, slug: true },
  })
  // Create WidgetConfig rows for both tenants (simulating post-migration state)
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantA.id, accessMode: 'verified_visitor', policyVersion: 1 },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'anonymous', policyVersion: 1 },
  })
})

afterAll(async () => {
  await globalDb.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } })
})

// === DB CONSTRAINT TESTS ===

describe('WidgetOtpRequest — DB state invariants', () => {
  let contactId: string

  beforeAll(async () => {
    const c = await withTenant(tenantA.id, async () => {
      return db.contact.create({
        data: { tenantId: tenantA.id, identifier: `v-constraint-${RUN_ID}`, identifierType: 'visitorId', name: 'Test', metadata: {} },
      })
    })
    contactId = c.id
  })

  test('active + verified=false accepted', async () => {
    const otp = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({
        data: { tenantId: tenantA.id, contactId, email: `test-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-active-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
      })
    })
    expect(otp.status).toBe('active')
    expect(otp.verified).toBe(false)
    await withTenant(tenantA.id, async () => { await db.widgetOtpRequest.delete({ where: { id: otp.id } }) })
  })

  test('verified + verified=true + verifiedAt accepted', async () => {
    const otp = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({
        data: { tenantId: tenantA.id, contactId, email: `test-v-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-verified-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'verified', verified: true, verifiedAt: new Date() },
      })
    })
    expect(otp.status).toBe('verified')
    await withTenant(tenantA.id, async () => { await db.widgetOtpRequest.delete({ where: { id: otp.id } }) })
  })

  test('active + verified=true REJECTED (CHECK constraint)', async () => {
    try {
      await withTenant(tenantA.id, async () => {
        await db.widgetOtpRequest.create({
          data: { tenantId: tenantA.id, contactId, email: `bad-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-bad1-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: true },
        })
      })
      throw new Error('should have been rejected')
    } catch (e: any) {
      expect(e.message).not.toContain('should have been rejected')
    }
  })

  test('verified + verified=false REJECTED (CHECK constraint)', async () => {
    try {
      await withTenant(tenantA.id, async () => {
        await db.widgetOtpRequest.create({
          data: { tenantId: tenantA.id, contactId, email: `bad2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-bad2-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'verified', verified: false },
        })
      })
      throw new Error('should have been rejected')
    } catch (e: any) {
      expect(e.message).not.toContain('should have been rejected')
    }
  })

  test('two active rows for same (tenantId, contactId) REJECTED (partial unique index)', async () => {
    const otp1 = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({
        data: { tenantId: tenantA.id, contactId, email: `dup1-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-dup1-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
      })
    })
    try {
      await withTenant(tenantA.id, async () => {
        await db.widgetOtpRequest.create({
          data: { tenantId: tenantA.id, contactId, email: `dup2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-dup2-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
        })
      })
      throw new Error('should have been rejected by partial unique index')
    } catch (e: any) {
      expect(e.message).not.toContain('should have been rejected by partial unique')
    } finally {
      await withTenant(tenantA.id, async () => { await db.widgetOtpRequest.delete({ where: { id: otp1.id } }) })
    }
  })

  test('different Contacts may each have an active row', async () => {
    const c2 = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: `v-constraint2-${RUN_ID}`, identifierType: 'visitorId', name: 'Test2', metadata: {} } })
    })
    const otp1 = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({ data: { tenantId: tenantA.id, contactId, email: `d1-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-d1-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    })
    const otp2 = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({ data: { tenantId: tenantA.id, contactId: c2.id, email: `d2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-d2-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    })
    expect(otp1.status).toBe('active')
    expect(otp2.status).toBe('active')
    await withTenant(tenantA.id, async () => {
      await db.widgetOtpRequest.delete({ where: { id: otp1.id } })
      await db.widgetOtpRequest.delete({ where: { id: otp2.id } })
    })
  })

  test('superseding an active row frees the partial unique slot', async () => {
    const otp1 = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({ data: { tenantId: tenantA.id, contactId, email: `s1-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-s1-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    })
    await withTenant(tenantA.id, async () => {
      await db.widgetOtpRequest.update({ where: { id: otp1.id }, data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() } })
    })
    const otp2 = await withTenant(tenantA.id, async () => {
      return db.widgetOtpRequest.create({ data: { tenantId: tenantA.id, contactId, email: `s2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-s2-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    })
    expect(otp2.status).toBe('active')
    await withTenant(tenantA.id, async () => {
      await db.widgetOtpRequest.delete({ where: { id: otp1.id } })
      await db.widgetOtpRequest.delete({ where: { id: otp2.id } })
    })
  })
})

// === EXTERNAL IDENTITY FOUNDATION ===

describe('External identity — Contact namespace isolation', () => {
  test('anonymous visitorId == externalUserId → TWO separate Contacts', async () => {
    const sharedId = `shared-${RUN_ID}-${Math.random()}`
    const anon = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: sharedId, identifierType: 'visitorId', name: 'Visitor', metadata: {} } })
    })
    const ext = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: sharedId, name: 'Auth User', metadata: {} } })
    })
    expect(anon.id).not.toBe(ext.id)
    expect(anon.identifierType).toBe('visitorId')
    expect(anon.externalUserId).toBeNull()
    expect(ext.identifierType).toBe('externalUser')
    expect(ext.externalUserId).toBe(sharedId)
  })

  test('same tenant + same externalUserId → same Contact (upsert)', async () => {
    const extId = `ext-stable-${RUN_ID}-${Math.random()}`
    const c1 = await withTenant(tenantA.id, async () => {
      return db.contact.upsert({
        where: { tenantId_externalUserId: { tenantId: tenantA.id, externalUserId: extId } },
        create: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: extId, name: 'User1', metadata: {} },
        update: {},
        select: { id: true },
      })
    })
    const c2 = await withTenant(tenantA.id, async () => {
      return db.contact.upsert({
        where: { tenantId_externalUserId: { tenantId: tenantA.id, externalUserId: extId } },
        create: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: extId, name: 'User2', metadata: {} },
        update: {},
        select: { id: true },
      })
    })
    expect(c1.id).toBe(c2.id)
  })

  test('same email + different externalUserIds → different Contacts', async () => {
    const email = `same-email-${RUN_ID}@x.test`
    const c1 = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: `e1-${RUN_ID}`, email, name: 'E1', metadata: {} } })
    })
    const c2 = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: `e2-${RUN_ID}`, email, name: 'E2', metadata: {} } })
    })
    expect(c1.id).not.toBe(c2.id)
    expect(c1.email).toBe(email)
    expect(c2.email).toBe(email)
  })

  test('same externalUserId across tenants → isolated Contacts', async () => {
    const extId = `cross-tenant-${RUN_ID}`
    const cA = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: extId, metadata: {} } })
    })
    const cB = await withTenant(tenantB.id, async () => {
      return db.contact.create({ data: { tenantId: tenantB.id, identifier: 'ext_' + crypto.randomUUID(), identifierType: 'externalUser', externalUserId: extId, metadata: {} } })
    })
    expect(cA.id).not.toBe(cB.id)
    expect(cA.tenantId).toBe(tenantA.id)
    expect(cB.tenantId).toBe(tenantB.id)
  })

  test('multiple NULL externalUserId rows allowed', async () => {
    const c1 = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: `anon1-${RUN_ID}`, identifierType: 'visitorId', metadata: {} } })
    })
    const c2 = await withTenant(tenantA.id, async () => {
      return db.contact.create({ data: { tenantId: tenantA.id, identifier: `anon2-${RUN_ID}`, identifierType: 'visitorId', metadata: {} } })
    })
    expect(c1.externalUserId).toBeNull()
    expect(c2.externalUserId).toBeNull()
  })
})

// === INTEGRATION CREDENTIAL ===

describe('Integration credential — direct lookup + rotate + revoke', () => {
  test('generate → hash → verify → direct lookup → rotate → revoke', async () => {
    const raw = generateIntegrationSecret()
    expect(raw.length).toBeGreaterThan(40)

    const hash = hashIntegrationSecret(raw)
    expect(hash).toHaveLength(64) // SHA-256 hex

    expect(verifyIntegrationSecret(raw, hash)).toBe(true)
    expect(verifyIntegrationSecret('wrong', hash)).toBe(false)
    expect(verifyIntegrationSecret(raw, null)).toBe(false)

    // Install the secret on tenantA's WidgetConfig
    await globalDb.widgetConfig.update({
      where: { tenantId: tenantA.id },
      data: { integrationSecretHash: hash, integrationSecretRotatedAt: new Date() },
    })

    // Direct indexed lookup
    const resolved = await resolveTenantByIntegrationSecret(raw)
    expect(resolved).not.toBeNull()
    expect(resolved!.tenantId).toBe(tenantA.id)

    // Wrong secret → null
    const wrong = await resolveTenantByIntegrationSecret('wrong-secret')
    expect(wrong).toBeNull()

    // Rotate: new secret invalidates old
    const raw2 = generateIntegrationSecret()
    const hash2 = hashIntegrationSecret(raw2)
    await globalDb.widgetConfig.update({
      where: { tenantId: tenantA.id },
      data: { integrationSecretHash: hash2, integrationSecretRotatedAt: new Date() },
    })
    const oldResolved = await resolveTenantByIntegrationSecret(raw)
    expect(oldResolved).toBeNull()
    const newResolved = await resolveTenantByIntegrationSecret(raw2)
    expect(newResolved!.tenantId).toBe(tenantA.id)

    // Revoke
    await globalDb.widgetConfig.update({
      where: { tenantId: tenantA.id },
      data: { integrationSecretHash: null, integrationSecretRotatedAt: null },
    })
    const revoked = await resolveTenantByIntegrationSecret(raw2)
    expect(revoked).toBeNull()
  })
})

// === MIGRATION PROOF ===

describe('Migration proof — WidgetConfig defaults', () => {
  test('existing WidgetConfig rows have accessMode set', async () => {
    const config = await globalDb.widgetConfig.findUnique({ where: { tenantId: tenantA.id } })
    expect(config).not.toBeNull()
    expect(['anonymous', 'verified_visitor', 'site_user_only']).toContain(config!.accessMode)
  })

  test('new WidgetConfig with omitted accessMode defaults to verified_visitor', async () => {
    const t = await globalDb.tenant.create({
      data: { slug: `wam-default-${RUN_ID}`, name: `WAM Default ${RUN_ID}`, defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' },
      select: { id: true },
    })
    const config = await globalDb.widgetConfig.create({
      data: { tenantId: t.id }, // accessMode omitted — should default to verified_visitor
    })
    expect(config.accessMode).toBe('verified_visitor')
    expect(config.policyVersion).toBe(1)
    await globalDb.tenant.delete({ where: { id: t.id } })
  })
})
