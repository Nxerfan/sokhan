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
    data: { tenantId: tenantA.id, accessMode: 'verified_visitor', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
  })
  await globalDb.widgetConfig.create({
    data: { tenantId: tenantB.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' } },
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
      data: { tenantId: t.id, greetingTexts: { fa: "", en: "" } }, // accessMode omitted — should default to verified_visitor
    })
    expect(config.accessMode).toBe('verified_visitor')
    expect(config.policyVersion).toBe(1)
    await globalDb.tenant.delete({ where: { id: t.id } })
  })
})

// === CONSTRAINT MATRIX COMPLETION (#2) ===
// Explicit reject/accept for ALL status/verified combos + purpose CHECK + FK
// enforcement + FK cascade + providerRequestId @unique + integration-secret
// hash uniqueness/nullability. These COMPLETE the constraint matrix started
// in the 'WidgetOtpRequest — DB state invariants' describe above (which
// covers active+false accept, verified+true accept, active+true reject,
// verified+false reject, partial-unique active reject, different-contacts
// accept, supersede-frees-slot). Uses globalDb for the negative creates so
// the fail-closed tenant proxy cannot mask a raw FK/CHECK/unique violation.

describe('WidgetOtpRequest — constraint matrix completion', () => {
  let contactId: string

  beforeAll(async () => {
    const c = await globalDb.contact.create({
      data: { tenantId: tenantA.id, identifier: `v-matrix-${RUN_ID}`, identifierType: 'visitorId', name: 'Matrix', metadata: {} },
    })
    contactId = c.id
  })
  afterAll(async () => {
    await globalDb.contact.deleteMany({ where: { id: contactId } })
  })

  async function expectRejected(label: string, fn: () => Promise<unknown>) {
    try {
      await fn()
      throw new Error(`should have been rejected: ${label}`)
    } catch (e: any) {
      expect(e.message).not.toContain(`should have been rejected: ${label}`)
    }
  }

  test('superseded + verified=false ACCEPTED', async () => {
    const otp = await globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId, email: `sup-f-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-supf-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'superseded', verified: false, verifiedAt: null },
    })
    expect(otp.status).toBe('superseded')
    expect(otp.verified).toBe(false)
    await globalDb.widgetOtpRequest.delete({ where: { id: otp.id } })
  })

  test('superseded + verified=true REJECTED (status_verified CHECK)', async () => {
    await expectRejected('superseded+true', () => globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId, email: `sup-t-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-supt-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'superseded', verified: true },
    }))
  })

  test('purpose != widget_verify REJECTED (purpose CHECK)', async () => {
    await expectRejected('purpose=login', () => globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId, email: `login-${RUN_ID}@x.test`, purpose: 'login', providerRequestId: `pr-login-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    }))
  })

  test('non-existent tenantId REJECTED (FK)', async () => {
    await expectRejected('bad tenantId', () => globalDb.widgetOtpRequest.create({
      data: { tenantId: 'nonexistent-tenant-cuid-xyz', contactId, email: `fkt-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-fkt-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    }))
  })

  test('non-existent contactId REJECTED (FK)', async () => {
    await expectRejected('bad contactId', () => globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId: 'nonexistent-contact-cuid-xyz', email: `fkc-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-fkc-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    }))
  })

  test('duplicate providerRequestId REJECTED (@unique)', async () => {
    const prId = `pr-duppr-${RUN_ID}-${Math.random()}`
    // Second contact so the partial-unique on (tenant,contact) WHERE active
    // does NOT fire — isolating the providerRequestId @unique constraint.
    const c2 = await globalDb.contact.create({ data: { tenantId: tenantA.id, identifier: `v-matrix2-${RUN_ID}`, identifierType: 'visitorId', name: 'M2', metadata: {} } })
    const otp1 = await globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId, email: `duppr1-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: prId, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    })
    await expectRejected('dup providerRequestId', () => globalDb.widgetOtpRequest.create({
      data: { tenantId: tenantA.id, contactId: c2.id, email: `duppr2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: prId, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    }))
    await globalDb.widgetOtpRequest.delete({ where: { id: otp1.id } })
    await globalDb.contact.delete({ where: { id: c2.id } })
  })

  test('FK cascade: deleting a Contact removes its WidgetOtpRequests', async () => {
    const t = await globalDb.tenant.create({ data: { slug: `wam-casc-${RUN_ID}-${Math.random()}`, name: 'Casc', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const c = await globalDb.contact.create({ data: { tenantId: t.id, identifier: `casc-${RUN_ID}`, identifierType: 'visitorId', name: 'C', metadata: {} } })
    const otp = await globalDb.widgetOtpRequest.create({ data: { tenantId: t.id, contactId: c.id, email: `casc-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-casc-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    expect(otp.id).toBeTruthy()
    await globalDb.contact.delete({ where: { id: c.id } })
    expect(await globalDb.widgetOtpRequest.findUnique({ where: { id: otp.id } })).toBeNull()
    await globalDb.tenant.delete({ where: { id: t.id } })
  })

  test('FK cascade: deleting a Tenant removes Contacts + WidgetOtpRequests', async () => {
    const t = await globalDb.tenant.create({ data: { slug: `wam-casc2-${RUN_ID}-${Math.random()}`, name: 'Casc2', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const c = await globalDb.contact.create({ data: { tenantId: t.id, identifier: `casc2-${RUN_ID}`, identifierType: 'visitorId', name: 'C2', metadata: {} }, select: { id: true } })
    const otp = await globalDb.widgetOtpRequest.create({ data: { tenantId: t.id, contactId: c.id, email: `casc2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `pr-casc2-${RUN_ID}-${Math.random()}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false }, select: { id: true } })
    await globalDb.tenant.delete({ where: { id: t.id } })
    expect(await globalDb.contact.findUnique({ where: { id: c.id } })).toBeNull()
    expect(await globalDb.widgetOtpRequest.findUnique({ where: { id: otp.id } })).toBeNull()
  })
})

// === INTEGRATION CREDENTIAL — DB UNIQUENESS + NULLABILITY (#5 partial) ===

describe('Integration credential — DB uniqueness + nullability', () => {
  test('duplicate integrationSecretHash REJECTED (WidgetConfig_integrationSecretHash_key)', async () => {
    const t1 = await globalDb.tenant.create({ data: { slug: `wam-iu1-${RUN_ID}-${Math.random()}`, name: 'IU1', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const t2 = await globalDb.tenant.create({ data: { slug: `wam-iu2-${RUN_ID}-${Math.random()}`, name: 'IU2', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const sharedHash = `dup-hash-${RUN_ID}-${Math.random()}`
    await globalDb.widgetConfig.create({ data: { tenantId: t1.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: sharedHash } })
    try {
      await globalDb.widgetConfig.create({ data: { tenantId: t2.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: sharedHash } })
      throw new Error('should have been rejected by unique index')
    } catch (e: any) {
      expect(e.message).not.toContain('should have been rejected by unique')
    } finally {
      await globalDb.tenant.deleteMany({ where: { id: { in: [t1.id, t2.id] } } })
    }
  })

  test('multiple NULL integrationSecretHash allowed (unique index — nulls distinct)', async () => {
    const t1 = await globalDb.tenant.create({ data: { slug: `wam-nu1-${RUN_ID}-${Math.random()}`, name: 'NU1', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const t2 = await globalDb.tenant.create({ data: { slug: `wam-nu2-${RUN_ID}-${Math.random()}`, name: 'NU2', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' }, select: { id: true } })
    const c1 = await globalDb.widgetConfig.create({ data: { tenantId: t1.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: null } })
    const c2 = await globalDb.widgetConfig.create({ data: { tenantId: t2.id, accessMode: 'anonymous', policyVersion: 1, greetingTexts: { fa: '', en: '' }, integrationSecretHash: null } })
    expect(c1.integrationSecretHash).toBeNull()
    expect(c2.integrationSecretHash).toBeNull()
    await globalDb.tenant.deleteMany({ where: { id: { in: [t1.id, t2.id] } } })
  })
})
