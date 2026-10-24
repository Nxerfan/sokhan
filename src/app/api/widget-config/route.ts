import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { getPlan } from '@/lib/payments/plans'
import { getEffectiveWidgetConfig } from '@/lib/payments/free-plan'

/**
 * GET /api/widget-config — dashboard widget configuration.
 *
 * Truthful contract (stabilization audit, CUST-A/D):
 * returns the STORED config, the EFFECTIVE config (what the public widget
 * actually serves — locked Sukhan-brand defaults when the tenant's plan
 * does not include customization), and `isLocked` so the dashboard can
 * gate its controls and preview the EFFECTIVE widget state.
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    const [stored, tenant] = await Promise.all([
      db.widgetConfig.findUnique({ where: { tenantId: tid } }),
      db.tenant.findUnique({ where: { id: tid }, select: { plan: true } }),
    ])
    const plan = getPlan(tenant?.plan ?? 'free')
    const isLocked = !plan?.customization
    const effective = await getEffectiveWidgetConfig(tid)
    return { stored, isLocked, effective } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({
    config: result.result.stored,
    effective: result.result.effective,
    isLocked: result.result.isLocked,
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

/**
 * PATCH /api/widget-config — update widget customization.
 *
 * Truthful contract (stabilization audit, CUST-A/B/E):
 * - Role: admin+ (owner/admin). Manager/agent/viewer → 403.
 * - Plan gate: customization is a paid-plan capability. When the tenant's
 *   plan does not include customization (free), the PATCH is REJECTED with
 *   402 `customization_locked` — persisting values the public widget would
 *   never serve would be a deceptive "saved and applied" UX. Free stays
 *   locked (no unlock without an explicit plan-contract change).
 * - Strict validation (no silent coercion): invalid values → 400 with a
 *   specific error code; garbage is never coerced into persisted settings.
 * - TRUE-patch semantics: only fields present in the request body are
 *   updated — omitting a field keeps its current value (the old full-update
 *   semantics silently reset omitted fields, e.g. nulling avatarUrl).
 */
export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    const tid = getCurrentTenantId()!

    // ---- Plan gate (CUST-A): locked plans cannot customize ----
    const tenant = await db.tenant.findUnique({ where: { id: tid }, select: { plan: true } })
    const plan = getPlan(tenant?.plan ?? 'free')
    if (!plan?.customization) {
      return { planLocked: true as const }
    }

    // ---- Strict validation (CUST-E) ----
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return { badRequest: true as const, code: 'invalid_json' }
    }
    if (typeof body !== 'object' || body === null) {
      return { badRequest: true as const, code: 'invalid_body' }
    }

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
      // Canonical product default is 'bottom-end' (CUST-C) — but stored
      // explicit positions are never rewritten; we only persist what the
      // client explicitly sent.
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
      // Only the fa/en keys are part of the contract — extra keys are
      // dropped (never silently persisted).
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
  if ('badRequest' in r) return NextResponse.json({ error: r.code }, { status: 400 })
  return NextResponse.json({ config: r.config })
}
