import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { getPlan } from '@/lib/payments/plans'
import { getEffectiveWidgetConfig } from '@/lib/payments/free-plan'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import {
  resolveAllEffectivePositioning,
  getStoredPositioning,
  deriveLegacyPosition,
  type StoredPositioningInput,
} from '@/lib/widget/effective-positioning'
import {
  validatePositioningPatch,
  mergePositioningPatch,
  hasOtherCustomizationFields,
  hasPositioningField,
  hasUnrecognizedFields,
  type PositioningPatchData,
} from '@/lib/widget/positioning-patch'

/**
 * GET /api/widget-config — dashboard widget configuration.
 *
 * Truthful contract (stabilization audit, CUST-A/D):
 * returns the STORED config, the EFFECTIVE config (what the public widget
 * actually serves — locked Sukhan-brand defaults when the tenant's plan
 * does not include customization), and `isLocked` so the dashboard can
 * gate its controls and preview the EFFECTIVE widget state.
 *
 * V2 positioning (Phase 2): also returns `positioning` with:
 *   - `entitlements`: server-derived plan capabilities (presetPositioning,
 *     precisePositioning).
 *   - `effective`: the effective positioning for desktop + mobile (what
 *     the widget renders — offsets only for entitled plans).
 *   - `stored`: the raw stored positioning for desktop + mobile (includes
 *     paid offsets even for Free, so the dashboard can show them as
 *     "saved but locked" / "restore on upgrade").
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const [stored, tenant] = await Promise.all([
      db.widgetConfig.findUnique({ where: { tenantId: tid } }),
      db.tenant.findUnique({ where: { id: tid }, select: { plan: true } }),
    ])
    const planSlug = tenant?.plan ?? 'free'
    const plan = getPlan(planSlug)
    const isLocked = !plan?.customization
    const effective = await getEffectiveWidgetConfig(tid)
    const entitlements = getEntitlements(planSlug)

    // V2 positioning: resolve effective + stored for both devices.
    const storedInput: StoredPositioningInput = {
      position: stored?.position ?? null,
      appearanceV2: stored?.appearanceV2,
    }
    const effectivePos = resolveAllEffectivePositioning(storedInput, entitlements)
    const storedDesktop = getStoredPositioning(storedInput, 'desktop')
    const storedMobile = getStoredPositioning(storedInput, 'mobile')

    return {
      stored,
      isLocked,
      effective,
      positioning: {
        entitlements: {
          presetPositioning: entitlements?.presetPositioning ?? false,
          precisePositioning: entitlements?.precisePositioning ?? false,
        },
        effective: {
          desktop: effectivePos.desktop,
          mobile: effectivePos.mobile,
        },
        stored: {
          desktop: storedDesktop,
          mobile: storedMobile,
        },
      },
    } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({
    config: result.result.stored,
    effective: result.result.effective,
    isLocked: result.result.isLocked,
    positioning: result.result.positioning,
  })
}

/**
 * Validate an optional image URL setting (avatarUrl / logoUrl).
 *
 * Security contract (stabilization audit, CUST-B):
 * - null or '' → null (cleared)
 * - must be an ABSOLUTE http(s) URL (rejects javascript:, data:, and
 *   every other scheme; rejects relative URLs)
 * - length capped at 500
 * Returns { ok, value } — never throws; callers translate !ok into a 400.
 */
function parseImageSetting(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'must_be_string' }
  if (value.length > 500) return { ok: false, error: 'too_long' }
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: 'invalid_scheme' }
  try {
    // Absolute http(s) URL — the regex above already pins the scheme;
    // URL() rejects malformed hosts/ports.
    new URL(value)
  } catch {
    return { ok: false, error: 'invalid_url' }
  }
  return { ok: true, value }
}

/** Positioning-specific error codes → HTTP status mapping. */
const POSITIONING_ERROR_STATUS: Record<string, number> = {
  positioning_not_authorized: 403,     // unknown plan / no preset positioning capability
  positioning_not_object: 400,
  positioning_device_not_object: 400,
  positioning_anchor_missing: 400,
  positioning_anchor_invalid: 400,
  positioning_offset_not_allowed: 403, // Free attempting paid capability → 403
  positioning_offset_invalid: 400,
  positioning_offset_out_of_bounds: 400,
  positioning_unexpected_key: 400,
  positioning_no_fields: 400,
}

/**
 * PATCH /api/widget-config — update widget customization.
 *
 * Truthful contract (stabilization audit, CUST-A/B/E):
 * - Role: admin+ (owner/admin). Manager/agent/viewer → 403.
 * - Plan gate: customization is a paid-plan capability. When the tenant's
 *   plan does not include customization (free), non-positioning PATCH is
 *   REJECTED with 402 `customization_locked`.
 *
 * V2 positioning (Phase 2):
 * - Free CAN edit positioning presets (anchor) per device — this is the
 *   one Free capability unlocked by the V2 entitlement model.
 * - Free CANNOT edit offsetX/offsetY (→ 403 positioning_offset_not_allowed).
 * - Free CANNOT mix positioning + other customization (→ 402
 *   customization_locked — no bypass by mixing allowed + forbidden fields).
 * - Paid CAN edit positioning (anchor + bounded offsets) + other
 *   customization in the same PATCH.
 * - True-patch: editing desktop doesn't reset mobile (or vice versa).
 * - Paid offsets are preserved when Free edits only the anchor.
 */
export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    const tid = getCurrentTenantId()!

    // ---- Tenant + entitlements ----
    const tenant = await db.tenant.findUnique({ where: { id: tid }, select: { plan: true } })
    const planSlug = tenant?.plan ?? 'free'
    const plan = getPlan(planSlug)
    const entitlements = getEntitlements(planSlug)
    const isPlanLocked = !plan?.customization // legacy Free lock

    // ---- Parse body ----
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return { badRequest: true as const, code: 'invalid_json' }
    }
    if (typeof body !== 'object' || body === null) {
      return { badRequest: true as const, code: 'invalid_body' }
    }

    // ---- Determine the request type ----
    const hasPositioning = hasPositioningField(body)
    const hasOtherFields = hasOtherCustomizationFields(body)

    // Reject unrecognized top-level fields ONLY on isolated positioning
    // requests (when `positioning` is present). This prevents bypass via
    // unknown keys on the positioning contract without breaking existing
    // customization PATCHes (which may send the full WidgetConfig object
    // including non-customization fields like id, tenantId, etc.).
    if (hasPositioning && hasUnrecognizedFields(body)) {
      return { badRequest: true as const, code: 'unrecognized_field' }
    }

    // If Free sends non-positioning customization (with or without
    // positioning), reject with 402 — no bypass by mixing.
    if (isPlanLocked && hasOtherFields) {
      return { planLocked: true as const }
    }

    // ---- Validate positioning (if present) ----
    let positioningPatch: PositioningPatchData | null = null
    if (hasPositioning) {
      const posResult = validatePositioningPatch({ positioning: body.positioning }, entitlements)
      if (!posResult.ok) {
        return { positioningError: true as const, code: posResult.code }
      }
      positioningPatch = posResult.data
    }

    // ---- Validate + collect other customization fields (paid only) ----
    const data: Record<string, unknown> = {}

    if (body.accentColor !== undefined) {
      if (typeof body.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.accentColor)) {
        return { badRequest: true as const, code: 'invalid_accent_color' }
      }
      data.accentColor = body.accentColor
    }

    if (body.launcherShape !== undefined) {
      if (!['tab', 'rounded', 'pill'].includes(body.launcherShape as string)) {
        return { badRequest: true as const, code: 'invalid_launcher_shape' }
      }
      data.launcherShape = body.launcherShape
    }

    if (body.position !== undefined) {
      if (!['bottom-start', 'bottom-end'].includes(body.position as string)) {
        return { badRequest: true as const, code: 'invalid_position' }
      }
      data.position = body.position
    }

    if (body.avatarUrl !== undefined) {
      const parsed = parseImageSetting(body.avatarUrl)
      if (!parsed.ok) return { badRequest: true as const, code: 'invalid_avatar_url' }
      data.avatarUrl = parsed.value
    }

    if (body.logoUrl !== undefined) {
      const parsed = parseImageSetting(body.logoUrl)
      if (!parsed.ok) return { badRequest: true as const, code: 'invalid_logo_url' }
      data.logoUrl = parsed.value
    }

    if (body.greetingTexts !== undefined) {
      const g = body.greetingTexts as Record<string, unknown>
      if (typeof g !== 'object' || g === null || Array.isArray(g)) {
        return { badRequest: true as const, code: 'invalid_greeting_texts' }
      }
      const fa = g.fa
      const en = g.en
      if (fa !== undefined && (typeof fa !== 'string' || fa.length > 200)) {
        return { badRequest: true as const, code: 'invalid_greeting_fa' }
      }
      if (en !== undefined && (typeof en !== 'string' || en.length > 200)) {
        return { badRequest: true as const, code: 'invalid_greeting_en' }
      }
      data.greetingTexts = {
        fa: (fa as string) ?? '',
        en: (en as string) ?? '',
      }
    }

    if (body.defaultLocale !== undefined) {
      if (body.defaultLocale !== 'fa' && body.defaultLocale !== 'en') {
        return { badRequest: true as const, code: 'invalid_locale' }
      }
      data.defaultLocale = body.defaultLocale
    }

    // ---- Apply positioning patch (if validated) ----
    if (positioningPatch) {
      // Read existing appearanceV2 + V1 position (for merge — preserves
      // the other device, paid offsets, AND the historical V1 anchor when
      // the first V2 edit is offset-only).
      const existing = await db.widgetConfig.findUnique({
        where: { tenantId: tid },
        select: { appearanceV2: true, position: true },
      })
      const merged = mergePositioningPatch(
        existing?.appearanceV2,
        positioningPatch,
        existing?.position ?? null,
      )
      data.appearanceV2 = merged as unknown as string // Prisma Json field
    }

    if (Object.keys(data).length === 0) {
      return { badRequest: true as const, code: 'no_fields' }
    }

    // The WidgetConfig row is created at signup; update only.
    const config = await db.widgetConfig.update({ where: { tenantId: tid }, data })
    return { config } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const r = result.result
  if ('forbidden' in r) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('planLocked' in r) {
    return NextResponse.json(
      {
        error: 'customization_locked',
        message: 'Widget customization is not available on your current plan. The widget uses the Sukhan brand look.',
      },
      { status: 402 },
    )
  }
  if ('positioningError' in r) {
    const status = POSITIONING_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('badRequest' in r) return NextResponse.json({ error: r.code }, { status: 400 })
  return NextResponse.json({ config: r.config })
}
