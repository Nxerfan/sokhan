/// <reference types="bun-types" />
/**
 * Widget Customization V2 Foundation — DB migration + compatibility proof.
 * (feat/widget-customization-v2 — real PostgreSQL)
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Uses globalDb (global models) against real PostgreSQL.
 *
 * Proves:
 *   1. The appearanceV2 column exists + is nullable (additive migration).
 *   2. Existing WidgetConfig rows preserve their V1 flat-field values (no
 *      destructive rewrite).
 *   3. New WidgetConfig rows get appearanceV2 = null (V1 behavior by default).
 *   4. The appearanceV2 field can be set with a valid V2 config + read back.
 *   5. No identity/access changes (accessMode, policyVersion unchanged).
 *   6. New-workspace appearance defaults don't change identity defaults.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { globalDb } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { parseAppearanceV2 } from '@/lib/widget/appearance-v2'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantId: string

beforeAll(async () => {
  const tenant = await globalDb.tenant.create({
    data: {
      slug: `cust-v2-${RUN_ID}`,
      name: `Cust V2 ${RUN_ID}`,
      defaultLocale: 'fa',
      defaultDirection: 'rtl',
      plan: 'pro',
    },
    select: { id: true },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await globalDb.tenant.delete({ where: { id: tenantId } }).catch(() => {})
})

describe('Widget Customization V2 Foundation — migration + compatibility', () => {
  test('new WidgetConfig row: appearanceV2 defaults to null (V1 behavior)', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#0066FF',
        launcherShape: 'rounded',
        position: 'bottom-start',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
      },
      select: { id: true, appearanceV2: true, accentColor: true, accessMode: true, policyVersion: true },
    })
    expect(wc.appearanceV2).toBeNull() // V1 behavior (no V2 config)
    expect(wc.accentColor).toBe('#0066FF') // V1 flat field preserved
    expect(wc.accessMode).toBe('verified_visitor') // identity unchanged
    expect(wc.policyVersion).toBe(1) // policy unchanged
    // Cleanup
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('appearanceV2 can be set with a valid V2 config + read back', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        greetingTexts: { fa: '', en: '' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: { version: 1, desktop: {}, mobile: {} },
      },
      select: { id: true, appearanceV2: true },
    })
    expect(wc.appearanceV2).not.toBeNull()
    const parsed = parseAppearanceV2(wc.appearanceV2)
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(1)
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  // EVIDENCE NOTE: This test creates a NEW record after the migration has
  // already run. It proves POST-MIGRATION COEXISTENCE (V1 flat fields +
  // appearanceV2 can coexist on the same row) — NOT that a PRE-EXISTING
  // row was preserved DURING the migration. The migration-time preservation
  // guarantee is the idempotent additive SQL: `ALTER TABLE "WidgetConfig"
  // ADD COLUMN IF NOT EXISTS "appearanceV2" JSONB` — a nullable column add
  // that does NOT rewrite or touch existing rows. A dedicated migration test
  // (seed a row before the migration, run the migration SQL, verify the row
  // is untouched) would require a baseline PostgreSQL snapshot — not
  // available in this test environment. The additive SQL is the guarantee.
  test('post-migration coexistence: V1 flat fields + appearanceV2 on the same row', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#FF0000',
        launcherShape: 'pill',
        position: 'bottom-end',
        avatarUrl: 'https://example.com/a.png',
        logoUrl: null,
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        defaultLocale: 'en',
        accessMode: 'site_user_only',
        policyVersion: 3,
        appearanceV2: { version: 1 },
      },
      select: {
        id: true, accentColor: true, launcherShape: true, position: true,
        avatarUrl: true, logoUrl: true, greetingTexts: true, defaultLocale: true,
        accessMode: true, policyVersion: true, appearanceV2: true,
      },
    })
    // V1 flat fields preserved.
    expect(wc.accentColor).toBe('#FF0000')
    expect(wc.launcherShape).toBe('pill')
    expect(wc.position).toBe('bottom-end')
    expect(wc.avatarUrl).toBe('https://example.com/a.png')
    expect(wc.logoUrl).toBeNull()
    expect(wc.greetingTexts).toEqual({ fa: 'سلام', en: 'Hi' })
    expect(wc.defaultLocale).toBe('en')
    // Identity/access fields unchanged.
    expect(wc.accessMode).toBe('site_user_only')
    expect(wc.policyVersion).toBe(3)
    // V2 field present.
    expect(wc.appearanceV2).not.toBeNull()
    expect(parseAppearanceV2(wc.appearanceV2)?.version).toBe(1)
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('appearanceV2 can be updated independently of V1 flat fields + identity', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#0066FF',
        greetingTexts: { fa: '', en: '' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
      },
      select: { id: true },
    })
    // Update only appearanceV2 (true-patch — other fields unchanged).
    const updated = await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: { version: 1, desktop: {}, mobile: {} } },
      select: { accentColor: true, accessMode: true, policyVersion: true, appearanceV2: true },
    })
    expect(updated.accentColor).toBe('#0066FF') // unchanged
    expect(updated.accessMode).toBe('verified_visitor') // unchanged
    expect(updated.policyVersion).toBe(1) // unchanged
    expect(updated.appearanceV2).not.toBeNull() // set
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('appearanceV2 can be cleared (set to null) without affecting other fields', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#0066FF',
        greetingTexts: { fa: '', en: '' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: { version: 1 },
      },
      select: { id: true },
    })
    const cleared = await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: Prisma.JsonNull },
      select: { accentColor: true, accessMode: true, appearanceV2: true },
    })
    expect(cleared.appearanceV2).toBeNull() // cleared
    expect(cleared.accentColor).toBe('#0066FF') // unchanged
    expect(cleared.accessMode).toBe('verified_visitor') // unchanged
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('new-workspace appearance defaults do NOT change identity defaults', async () => {
    // A new WidgetConfig (simulating signup) with the DB defaults: accessMode
    // = verified_visitor (DB default), policyVersion = 1, appearanceV2 = null.
    const wc = await globalDb.widgetConfig.create({
      data: { tenantId, greetingTexts: { fa: '', en: '' } },
      select: { id: true, accessMode: true, policyVersion: true, appearanceV2: true },
    })
    expect(wc.accessMode).toBe('verified_visitor') // identity default preserved
    expect(wc.policyVersion).toBe(1) // policy default preserved
    expect(wc.appearanceV2).toBeNull() // V1 behavior (no V2 config)
    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })
})
