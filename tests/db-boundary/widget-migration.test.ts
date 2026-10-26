/// <reference types="bun-types" />
/**
 * Widget access — REAL release migration test (#7-#10).
 * (feat/widget-visitor-access-modes — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 *
 * Proves the release-critical contract:
 *   main/pre-feature database -> feature migration -> preserved data + final constraints
 *
 * Uses a SEPARATE temporary PostgreSQL database (CREATE DATABASE) on the same
 * Docker Postgres instance, so it does NOT mutate the already-current
 * docker-regression `sukhan` database. Applies the REAL migration history:
 *   1. apply migrations through the pre-feature/main baseline (20240101,
 *      20241102, 20241103 — everything EXCEPT 20241104)
 *   2. seed representative pre-feature data (raw SQL — the pre-feature schema
 *      has no accessMode/externalUserId/etc., so the feature Prisma client
 *      cannot seed; raw SQL matches the pre-feature columns)
 *   3. apply 20241104000000_widget_visitor_access_modes
 *   4. assert final schema/data + preservation + DB defaults + constraints
 *      using the CURRENT Prisma Client (proves the migrated DB is compatible
 *      with the shipped client — not merely inspecting migration SQL strings)
 *   5. destroy the temporary database
 *
 * Baseline: main @ 7caa28d7468852c094881bbda75eb6dcaa5762cf (pre-feature).
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const TEMP_DB_NAME = `sukhan_mig_${RUN_ID.replace(/[^0-9a-z]/gi, '_').toLowerCase()}`
const CI_DB_URL = process.env.DATABASE_URL || ''
const TEMP_DB_URL = CI_DB_URL.replace(/\/sukhan(\?|$)/, `/${TEMP_DB_NAME}$1`)
const TEMP_PRISMA_DIR = `/tmp/prisma-mig-${RUN_ID}`

// Fixed IDs for the pre-feature seed (so preservation can assert exact IDs).
const TENANT_ID = `mig-tenant-${RUN_ID}`
const WIDGETCONFIG_ID = `mig-wc-${RUN_ID}`
const CONTACT_ID = `mig-contact-${RUN_ID}`
const CONVERSATION_ID = `mig-conv-${RUN_ID}`
const MESSAGE_ID = `mig-msg-${RUN_ID}`
const WIDGETDOMAIN_ID = `mig-wd-${RUN_ID}`
const TENANT_SLUG = `mig-${RUN_ID}`

// Maintenance client (connects to the default `sukhan` DB to CREATE/DROP the temp DB).
const maintClient = new PrismaClient({ datasources: { db: { url: CI_DB_URL } } })
// Feature client (connected to the temp DB after migration — proves the current
// client can read/write the migrated DB).
let featureClient: PrismaClient

function runMigrateDeploy(schemaPath: string | null, dbUrl: string): { code: number; stderr: string; stdout: string } {
  const args = ['bunx', 'prisma', 'migrate', 'deploy']
  if (schemaPath) args.push('--schema', schemaPath)
  const r = Bun.spawnSync(args, {
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, NIXIFY_MOCK: '' },
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: r.exitCode ?? -1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  }
}

beforeAll(async () => {
  // 1. CREATE a fresh isolated database.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await maintClient.$executeRawUnsafe(`CREATE DATABASE "${TEMP_DB_NAME}"`)

  // 2. Copy the prisma folder to a temp location + remove the feature migration
  //    so Run 1 applies ONLY the pre-feature migrations.
  fs.cpSync(path.join(process.cwd(), 'prisma'), TEMP_PRISMA_DIR, { recursive: true })
  fs.rmSync(path.join(TEMP_PRISMA_DIR, 'migrations', '20241104000000_widget_visitor_access_modes'), { recursive: true, force: true })

  // 3. Run 1: apply pre-feature migrations (20240101, 20241102, 20241103).
  const run1 = runMigrateDeploy(path.join(TEMP_PRISMA_DIR, 'schema.prisma'), TEMP_DB_URL)
  if (run1.code !== 0) throw new Error(`pre-feature migrate deploy failed (code ${run1.code}): ${run1.stderr}\n${run1.stdout}`)

  // 4. Seed representative pre-feature data (raw SQL — pre-feature schema).
  const seedClient = new PrismaClient({ datasources: { db: { url: TEMP_DB_URL } } })
  try {
    // Tenant (pre-feature columns: id, slug, name, defaultLocale, defaultDirection, plan).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id","slug","name","defaultLocale","defaultDirection","plan","workspaceCreatedAt","createdAt","updatedAt") VALUES ('${TENANT_ID}','${TENANT_SLUG}','Migration Test','fa','rtl','free',NOW(),NOW(),NOW())`,
    )
    // WidgetConfig (pre-feature columns — NO accessMode/policyVersion/integrationSecretHash).
    // Representative customization values: accentColor, launcherShape, position, greetingTexts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "WidgetConfig" ("id","tenantId","accentColor","launcherShape","position","greetingTexts","defaultLocale","createdAt","updatedAt") VALUES ('${WIDGETCONFIG_ID}','${TENANT_ID}','#FF5500','round','bottom-end','{"fa":"\\u0633\\u0644\\u0627\\u0645","en":"Hello"}'::jsonb,'fa',NOW(),NOW())`,
    )
    // Contact (pre-feature columns — NO externalUserId/emailVerifiedAt).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "Contact" ("id","tenantId","identifier","identifierType","name","email","locale","metadata","lastSeenAt","createdAt","updatedAt") VALUES ('${CONTACT_ID}','${TENANT_ID}','mig-visitor-${RUN_ID}','visitorId','Pre-feature Visitor','pre@x.test','fa','{}'::jsonb,NOW(),NOW(),NOW())`,
    )
    // Conversation (pre-feature).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("id","tenantId","contactId","status","priority","channel","tags","lastMessageAt","lastMessagePreview","unreadCount","createdAt","updatedAt") VALUES ('${CONVERSATION_ID}','${TENANT_ID}','${CONTACT_ID}','open','normal','widget','[]'::jsonb,NOW(),'hello',0,NOW(),NOW())`,
    )
    // Message (pre-feature).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "Message" ("id","conversationId","tenantId","senderType","contentType","content","status","createdAt") VALUES ('${MESSAGE_ID}','${CONVERSATION_ID}','${TENANT_ID}','contact','text','{"text":"hello"}'::jsonb,'sent',NOW())`,
    )
    // WidgetDomain (pre-feature).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedClient.$executeRawUnsafe(
      `INSERT INTO "WidgetDomain" ("id","tenantId","domain","createdAt") VALUES ('${WIDGETDOMAIN_ID}','${TENANT_ID}','mig-${RUN_ID}.example.test',NOW())`,
    )
  } finally {
    await seedClient.$disconnect()
  }

  // 5. Run 2: apply the feature migration (20241104) — the only pending one.
  const run2 = runMigrateDeploy(path.join(process.cwd(), 'prisma', 'schema.prisma'), TEMP_DB_URL)
  if (run2.code !== 0) throw new Error(`feature migrate deploy failed (code ${run2.code}): ${run2.stderr}\n${run2.stdout}`)

  // 6. Feature client (current Prisma Client) against the migrated DB.
  featureClient = new PrismaClient({ datasources: { db: { url: TEMP_DB_URL } } })
})

afterAll(async () => {
  try { if (featureClient) await featureClient.$disconnect() } catch { /* ignore */ }
  try {
    // DROP the temp database (with FORCE to disconnect any lingering sessions).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maintClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}" WITH (FORCE)`)
  } catch { /* ignore */ }
  try { await maintClient.$disconnect() } catch { /* ignore */ }
  try { fs.rmSync(TEMP_PRISMA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// === #8 DATA PRESERVATION PROOF ===

describe('Migration — data preservation (#8)', () => {
  test('seeded rows survive with exact IDs + values; existing WidgetConfig.accessMode = anonymous', async () => {
    // Tenant preserved.
    const t = await featureClient.tenant.findUnique({ where: { id: TENANT_ID } })
    expect(t).not.toBeNull()
    expect(t!.slug).toBe(TENANT_SLUG)
    expect(t!.name).toBe('Migration Test')
    expect(t!.defaultLocale).toBe('fa')

    // Contact preserved (new columns backfilled: externalUserId=NULL, emailVerifiedAt=NULL).
    const c = await featureClient.contact.findUnique({ where: { id: CONTACT_ID } })
    expect(c).not.toBeNull()
    expect(c!.identifier).toBe(`mig-visitor-${RUN_ID}`)
    expect(c!.identifierType).toBe('visitorId')
    expect(c!.name).toBe('Pre-feature Visitor')
    expect(c!.email).toBe('pre@x.test')
    expect(c!.externalUserId).toBeNull() // backfilled NULL
    expect(c!.emailVerifiedAt).toBeNull() // backfilled NULL

    // Conversation + Message preserved.
    const conv = await featureClient.conversation.findUnique({ where: { id: CONVERSATION_ID } })
    expect(conv).not.toBeNull()
    expect(conv!.lastMessagePreview).toBe('hello')
    const msg = await featureClient.message.findUnique({ where: { id: MESSAGE_ID } })
    expect(msg).not.toBeNull()

    // WidgetDomain preserved.
    const wd = await featureClient.widgetDomain.findUnique({ where: { id: WIDGETDOMAIN_ID } })
    expect(wd).not.toBeNull()
    expect(wd!.domain).toBe(`mig-${RUN_ID}.example.test`)

    // EXISTING WidgetConfig backfilled: accessMode = 'anonymous' (EXACTLY — not
    // merely one of the valid modes), policyVersion = 1 (DB default), integrationSecretHash NULL.
    const wc = await featureClient.widgetConfig.findUnique({ where: { id: WIDGETCONFIG_ID } })
    expect(wc).not.toBeNull()
    expect(wc!.accessMode).toBe('anonymous') // deterministic backfill (NOT the column default verified_visitor)
    expect(wc!.policyVersion).toBe(1) // DB default for existing rows
    expect(wc!.integrationSecretHash).toBeNull()
    // Representative customization values preserved.
    expect(wc!.accentColor).toBe('#FF5500')
    expect(wc!.launcherShape).toBe('round')
    expect(wc!.position).toBe('bottom-end')
  })
})

// === #9 DB DEFAULT PROOF ===

describe('Migration — database default (#9)', () => {
  test('NEW WidgetConfig with omitted accessMode defaults to verified_visitor (DB default, not Prisma app default)', async () => {
    // Insert via RAW SQL omitting accessMode — the DB DEFAULT (verified_visitor)
    // must apply. This is a DB-default proof (raw SQL bypasses Prisma's app
    // default), proving the migration's `ALTER COLUMN ... SET DEFAULT 'verified_visitor'`.
    const newWcId = `mig-new-wc-${RUN_ID}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seedClient = new PrismaClient({ datasources: { db: { url: TEMP_DB_URL } } })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await seedClient.$executeRawUnsafe(
        `INSERT INTO "WidgetConfig" ("id","tenantId","greetingTexts","defaultLocale","createdAt","updatedAt") VALUES ('${newWcId}','${TENANT_ID}','{}'::jsonb,'fa',NOW(),NOW())`,
      )
    } finally {
      await seedClient.$disconnect()
    }
    // Read via the feature client — accessMode must be 'verified_visitor' (DB default).
    const wc = await featureClient.widgetConfig.findUnique({ where: { id: newWcId } })
    expect(wc).not.toBeNull()
    expect(wc!.accessMode).toBe('verified_visitor')
    expect(wc!.policyVersion).toBe(1)
  })
})

// === #10 SCHEMA / CONSTRAINT PROOF (via the current Prisma Client) ===

describe('Migration — schema + constraints (#10)', () => {
  test('Contact: externalUserId + emailVerifiedAt columns + uniqueness + nullability', async () => {
    // externalUserId exists (the column is queryable).
    const c = await featureClient.contact.findUnique({ where: { id: CONTACT_ID }, select: { externalUserId: true, emailVerifiedAt: true } })
    expect(c).not.toBeNull()
    expect(c!.externalUserId).toBeNull()
    expect(c!.emailVerifiedAt).toBeNull()

    // Multiple NULL externalUserIds allowed (unique index — nulls distinct).
    const cid1 = `mig-null1-${RUN_ID}`, cid2 = `mig-null2-${RUN_ID}`
    await featureClient.contact.create({ data: { id: cid1, tenantId: TENANT_ID, identifier: `mig-null1-id-${RUN_ID}`, identifierType: 'visitorId', metadata: {} } })
    await featureClient.contact.create({ data: { id: cid2, tenantId: TENANT_ID, identifier: `mig-null2-id-${RUN_ID}`, identifierType: 'visitorId', metadata: {} } })

    // Same externalUserId across TENANTS allowed (the unique is (tenantId, externalUserId)).
    const t2 = await featureClient.tenant.create({ data: { slug: `mig-t2-${RUN_ID}`, name: 'T2', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' } })
    const sharedExt = `mig-shared-ext-${RUN_ID}`
    await featureClient.contact.create({ data: { tenantId: TENANT_ID, identifier: `mig-ext-a-${RUN_ID}`, identifierType: 'externalUser', externalUserId: sharedExt, metadata: {} } })
    await featureClient.contact.create({ data: { tenantId: t2.id, identifier: `mig-ext-b-${RUN_ID}`, identifierType: 'externalUser', externalUserId: sharedExt, metadata: {} } })

    // Same tenant + same externalUserId -> REJECTED (unique).
    await expect(
      featureClient.contact.create({ data: { tenantId: TENANT_ID, identifier: `mig-ext-dup-${RUN_ID}`, identifierType: 'externalUser', externalUserId: `dup-${RUN_ID}`, metadata: {} } }),
    ).rejects.toThrow()
    // (a second one with the same externalUserId in the SAME tenant must fail)
    await expect(
      featureClient.contact.create({ data: { tenantId: TENANT_ID, identifier: `mig-ext-dup2-${RUN_ID}`, identifierType: 'externalUser', externalUserId: `dup-${RUN_ID}`, metadata: {} } }),
    ).rejects.toThrow()
    await featureClient.tenant.delete({ where: { id: t2.id } }).catch(() => {})
  })

  test('WidgetConfig: accessMode NOT NULL + integrationSecretHash uniqueness + policyVersion', async () => {
    // accessMode is NOT NULL — inserting NULL via raw SQL must fail.
    const rawNullId = `mig-null-wc-${RUN_ID}`
    const rawClient = new PrismaClient({ datasources: { db: { url: TEMP_DB_URL } } })
    try {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rawClient as any).$executeRawUnsafe(
          `INSERT INTO "WidgetConfig" ("id","tenantId","greetingTexts","defaultLocale","accessMode","createdAt","updatedAt") VALUES ('${rawNullId}','${TENANT_ID}','{}'::jsonb,'fa',NULL,NOW(),NOW())`,
        ),
      ).rejects.toThrow()
    } finally {
      await rawClient.$disconnect()
    }

    // integrationSecretHash uniqueness: two WidgetConfigs with the same hash -> REJECTED.
    const sharedHash = `dup-hash-${RUN_ID}`
    const tA = await featureClient.tenant.create({ data: { slug: `mig-iu-a-${RUN_ID}`, name: 'IUA', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' } })
    const tB = await featureClient.tenant.create({ data: { slug: `mig-iu-b-${RUN_ID}`, name: 'IUB', defaultLocale: 'fa', defaultDirection: 'rtl', plan: 'free' } })
    await featureClient.widgetConfig.create({ data: { tenantId: tA.id, greetingTexts: { fa: '', en: '' }, integrationSecretHash: sharedHash } })
    await expect(
      featureClient.widgetConfig.create({ data: { tenantId: tB.id, greetingTexts: { fa: '', en: '' }, integrationSecretHash: sharedHash } }),
    ).rejects.toThrow()
    // Multiple NULL integrationSecretHash allowed.
    await featureClient.widgetConfig.create({ data: { tenantId: tB.id, greetingTexts: { fa: '', en: '' }, integrationSecretHash: null } })
    await featureClient.tenant.delete({ where: { id: tA.id } }).catch(() => {})
    await featureClient.tenant.delete({ where: { id: tB.id } }).catch(() => {})
  })

  test('WidgetOtpRequest: table + columns + CHECKs + partial unique + FKs + indexes', async () => {
    // Create a Contact to attach OTP requests to.
    const oc = await featureClient.contact.create({ data: { tenantId: TENANT_ID, identifier: `mig-otp-contact-${RUN_ID}`, identifierType: 'visitorId', metadata: {} } })

    // Valid active request (active + verified=false) accepted.
    const otp1 = await featureClient.widgetOtpRequest.create({
      data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-otp1-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr1-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false },
    })
    expect(otp1.status).toBe('active')
    expect(otp1.verified).toBe(false)
    expect(otp1.attempts).toBe(0)
    expect(otp1.resendCount).toBe(0)
    expect(otp1.pendingName).toBeNull()

    // status/verified consistency CHECK: active+verified=true REJECTED.
    await expect(
      featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-bad-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr-bad-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: true } }),
    ).rejects.toThrow()

    // purpose CHECK: purpose != 'widget_verify' REJECTED.
    await expect(
      featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-login-${RUN_ID}@x.test`, purpose: 'login', providerRequestId: `mig-pr-login-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } }),
    ).rejects.toThrow()

    // providerRequestId @unique: duplicate REJECTED.
    await expect(
      featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-dup-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr1-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'superseded', verified: false } }),
    ).rejects.toThrow()

    // Partial unique (active per (tenant, contact)): two active same contact REJECTED.
    await expect(
      featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-dup2-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr2-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } }),
    ).rejects.toThrow()

    // FK: non-existent contactId REJECTED.
    await expect(
      featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: 'nonexistent-contact', email: `mig-fk-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr-fk-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } }),
    ).rejects.toThrow()

    // Superseding frees the partial-unique slot (index is queryable + functional).
    await featureClient.widgetOtpRequest.update({ where: { id: otp1.id }, data: { status: 'superseded', verified: false, verifiedAt: null, expiresAt: new Date() } })
    const otp2 = await featureClient.widgetOtpRequest.create({ data: { tenantId: TENANT_ID, contactId: oc.id, email: `mig-sup-${RUN_ID}@x.test`, purpose: 'widget_verify', providerRequestId: `mig-pr3-${RUN_ID}`, expiresAt: new Date(Date.now() + 600000), status: 'active', verified: false } })
    expect(otp2.status).toBe('active')

    // Composite indexes are queryable (tenantId+contactId, tenantId+purpose+email).
    const byTc = await featureClient.widgetOtpRequest.findMany({ where: { tenantId: TENANT_ID, contactId: oc.id }, select: { id: true } })
    expect(byTc.length).toBeGreaterThanOrEqual(2)
    const byTpe = await featureClient.widgetOtpRequest.findMany({ where: { tenantId: TENANT_ID, purpose: 'widget_verify', email: `mig-sup-${RUN_ID}@x.test` }, select: { id: true } })
    expect(byTpe.length).toBe(1)
  })
})
