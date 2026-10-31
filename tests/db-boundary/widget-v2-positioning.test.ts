/// <reference types="bun-types" />
/**
 * Widget V2 Positioning — DB + effective resolution proof.
 *
 * Runs in BOTH Full and Lite docker-regression CI via `bun test tests/db-boundary/`.
 * Uses globalDb (global models) against real PostgreSQL.
 *
 * Proves:
 *   1. appearanceV2 with positioning can be stored + read back (parsed correctly).
 *   2. True-patch: editing desktop positioning doesn't reset mobile.
 *   3. Free vs paid effective positioning: offsets only for entitled plans.
 *   4. Downgrade/upgrade: paid offsets preserved when Free edits anchor.
 *   5. V1 fallback: null appearanceV2 → V1 position used.
 *   6. No identity/access changes from positioning edits.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { globalDb } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { parseAppearanceV2 } from '@/lib/widget/appearance-v2'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import {
  resolveAllEffectivePositioning,
  getStoredPositioning,
  deriveLegacyPosition,
  type StoredPositioningInput,
} from '@/lib/widget/effective-positioning'
import {
  mergePositioningPatch,
  type PositioningPatchData,
} from '@/lib/widget/positioning-patch'

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

let tenantId: string

beforeAll(async () => {
  const tenant = await globalDb.tenant.create({
    data: {
      slug: `pos-v2-${RUN_ID}`,
      name: `Pos V2 ${RUN_ID}`,
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

describe('Widget V2 Positioning — DB storage + effective resolution', () => {
  test('positioning can be stored in appearanceV2 + read back', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-center', offsetX: 100, offsetY: 50 } },
          mobile: { positioning: { anchor: 'bottom-start' } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true },
    })

    const parsed = parseAppearanceV2(wc.appearanceV2)
    expect(parsed).not.toBeNull()
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-center')
    expect(parsed!.desktop?.positioning?.offsetX).toBe(100)
    expect(parsed!.desktop?.positioning?.offsetY).toBe(50)
    expect(parsed!.mobile?.positioning?.anchor).toBe('bottom-start')

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('null appearanceV2 → V1 position fallback', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-start',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        // appearanceV2 = null (default)
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    const storedInput: StoredPositioningInput = {
      position: wc.position,
      appearanceV2: wc.appearanceV2,
    }
    const ent = getEntitlements('pro')
    const eff = resolveAllEffectivePositioning(storedInput, ent)
    expect(eff.desktop.anchor).toBe('bottom-start') // V1 fallback
    expect(eff.desktop.offsetX).toBe(0)
    expect(eff.mobile.anchor).toBe('bottom-start') // V1 fallback
    expect(eff.mobile.offsetX).toBe(0)

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('true-patch: editing desktop does NOT reset mobile in storage', async () => {
    // Create with both devices configured.
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-end', offsetX: 100 } },
          mobile: { positioning: { anchor: 'bottom-center' } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true },
    })

    // Simulate a PATCH that updates only the desktop anchor.
    const patch: PositioningPatchData = {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    }
    const merged = mergePositioningPatch(wc.appearanceV2, patch)

    // Update in DB.
    await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: merged as unknown as Prisma.InputJsonValue },
    })

    // Read back + verify mobile is unchanged.
    const updated = await globalDb.widgetConfig.findUnique({
      where: { id: wc.id },
      select: { appearanceV2: true },
    })
    const parsed = parseAppearanceV2(updated!.appearanceV2)
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-start') // updated
    expect(parsed!.desktop?.positioning?.offsetX).toBe(100) // preserved
    expect(parsed!.mobile?.positioning?.anchor).toBe('bottom-center') // unchanged

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('Free effective: stored paid offsets NOT applied (downgrade scenario)', async () => {
    // Store positioning with paid offsets on a Pro plan.
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-end', offsetX: 200, offsetY: 100 } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    const storedInput: StoredPositioningInput = {
      position: wc.position,
      appearanceV2: wc.appearanceV2,
    }

    // Free entitlements: offsets NOT applied.
    const freeEnt = getEntitlements('free')
    const freeEff = resolveAllEffectivePositioning(storedInput, freeEnt)
    expect(freeEff.desktop.anchor).toBe('bottom-end')
    expect(freeEff.desktop.offsetX).toBe(0) // NOT applied
    expect(freeEff.desktop.offsetY).toBe(0) // NOT applied

    // But stored offsets are preserved.
    const storedPos = getStoredPositioning(storedInput, 'desktop')
    expect(storedPos?.offsetX).toBe(200)
    expect(storedPos?.offsetY).toBe(100)

    // Pro entitlements: offsets applied.
    const proEnt = getEntitlements('pro')
    const proEff = resolveAllEffectivePositioning(storedInput, proEnt)
    expect(proEff.desktop.offsetX).toBe(200)
    expect(proEff.desktop.offsetY).toBe(100)

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('Downgrade/upgrade: Free edits anchor without destroying paid offsets', async () => {
    // Store Pro positioning with offsets.
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-center', offsetX: 200, offsetY: 100 } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    // Simulate: Free edits anchor to bottom-start (anchor-only patch).
    const patch: PositioningPatchData = {
      hasAny: true,
      desktop: { anchor: 'bottom-start', hasFields: true },
    }
    const merged = mergePositioningPatch(wc.appearanceV2, patch)

    await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: merged as unknown as Prisma.InputJsonValue },
    })

    const updated = await globalDb.widgetConfig.findUnique({
      where: { id: wc.id },
      select: { appearanceV2: true, position: true },
    })

    const storedInput: StoredPositioningInput = {
      position: updated!.position,
      appearanceV2: updated!.appearanceV2,
    }

    // Free effective: new anchor, no offsets.
    const freeEnt = getEntitlements('free')
    const freeEff = resolveAllEffectivePositioning(storedInput, freeEnt)
    expect(freeEff.desktop.anchor).toBe('bottom-start') // updated
    expect(freeEff.desktop.offsetX).toBe(0) // NOT applied

    // But stored offsets are preserved.
    const storedPos = getStoredPositioning(storedInput, 'desktop')
    expect(storedPos?.offsetX).toBe(200) // preserved!
    expect(storedPos?.offsetY).toBe(100) // preserved!

    // Upgrade to Pro: new anchor + restored offsets.
    const proEnt = getEntitlements('pro')
    const proEff = resolveAllEffectivePositioning(storedInput, proEnt)
    expect(proEff.desktop.anchor).toBe('bottom-start') // new anchor
    expect(proEff.desktop.offsetX).toBe(200) // restored!
    expect(proEff.desktop.offsetY).toBe(100) // restored!

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('positioning edit does NOT change identity/access fields', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
      },
      select: { id: true, appearanceV2: true, accessMode: true, policyVersion: true },
    })

    // Apply a positioning patch.
    const patch: PositioningPatchData = {
      hasAny: true,
      desktop: { anchor: 'bottom-center', hasFields: true },
    }
    const merged = mergePositioningPatch(null, patch)

    await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: merged as unknown as Prisma.InputJsonValue },
    })

    const updated = await globalDb.widgetConfig.findUnique({
      where: { id: wc.id },
      select: { accessMode: true, policyVersion: true, appearanceV2: true },
    })

    expect(updated!.accessMode).toBe('verified_visitor') // unchanged
    expect(updated!.policyVersion).toBe(1) // unchanged

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('legacy V1 position derived from effective desktop positioning', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-end',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-center' } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    const storedInput: StoredPositioningInput = {
      position: wc.position,
      appearanceV2: wc.appearanceV2,
    }
    const ent = getEntitlements('pro')
    const eff = resolveAllEffectivePositioning(storedInput, ent)
    const legacy = deriveLegacyPosition(eff.desktop)
    expect(legacy).toBe('bottom-end') // bottom-center → bottom-end for V1

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('unknown plan → fail closed to default positioning', async () => {
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-start',
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        appearanceV2: {
          version: 1,
          desktop: { positioning: { anchor: 'bottom-center', offsetX: 100 } },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    const storedInput: StoredPositioningInput = {
      position: wc.position,
      appearanceV2: wc.appearanceV2,
    }
    // null entitlements (unknown plan) → fail closed.
    const eff = resolveAllEffectivePositioning(storedInput, null)
    expect(eff.desktop.anchor).toBe('bottom-end') // default
    expect(eff.desktop.offsetX).toBe(0)
    expect(eff.mobile.anchor).toBe('bottom-end') // default

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })

  test('BLOCKER 4: V1 anchor preserved on first offset-only V2 edit', async () => {
    // Store a WidgetConfig with V1 position = bottom-start, no V2.
    const wc = await globalDb.widgetConfig.create({
      data: {
        tenantId,
        accentColor: '#E09A2B',
        launcherShape: 'tab',
        position: 'bottom-start', // V1 anchor
        greetingTexts: { fa: 'سلام', en: 'Hi' },
        accessMode: 'verified_visitor',
        policyVersion: 1,
        // appearanceV2 = null (no V2 yet)
      },
      select: { id: true, appearanceV2: true, position: true },
    })

    // First V2 edit is offset-only (no anchor in the patch).
    const patch: PositioningPatchData = {
      hasAny: true,
      desktop: { offsetX: 100, hasFields: true },
    }
    // Pass the V1 position so the merge preserves it.
    const merged = mergePositioningPatch(wc.appearanceV2, patch, wc.position)

    await globalDb.widgetConfig.update({
      where: { id: wc.id },
      data: { appearanceV2: merged as unknown as Prisma.InputJsonValue },
    })

    const updated = await globalDb.widgetConfig.findUnique({
      where: { id: wc.id },
      select: { appearanceV2: true, position: true },
    })

    const parsed = parseAppearanceV2(updated!.appearanceV2)
    // The anchor must be bottom-start (from V1), NOT bottom-end.
    expect(parsed!.desktop?.positioning?.anchor).toBe('bottom-start')
    expect(parsed!.desktop?.positioning?.offsetX).toBe(100)
    // V1 position field unchanged.
    expect(updated!.position).toBe('bottom-start')

    await globalDb.widgetConfig.delete({ where: { id: wc.id } })
  })
})
