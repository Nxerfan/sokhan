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
import {
  resolveEffectiveColors,
  getStoredColorTheme,
  type StoredColorInput,
} from '@/lib/widget/effective-colors'
import {
  validateColorPatch,
  mergeColorPatch,
  hasColorField,
  type ColorPatchData,
} from '@/lib/widget/color-patch'
import {
  resolveEffectiveLauncher,
  getStoredLauncherShape,
  type StoredLauncherInput,
} from '@/lib/widget/effective-launcher'
import {
  validateLauncherPatch,
  mergeLauncherPatch,
  hasLauncherField,
  type LauncherPatchData,
} from '@/lib/widget/launcher-patch'
import {
  resolveEffectiveAttention,
  getStoredAttention,
  type StoredAttentionInput,
} from '@/lib/widget/effective-attention'
import {
  validateAttentionPatch,
  mergeAttentionPatch,
  hasAttentionField,
  type AttentionPatchData,
} from '@/lib/widget/attention-patch'
import {
  resolveEffectiveMessagePreview,
  getStoredMessagePreview,
  type StoredMessagePreviewInput,
} from '@/lib/widget/effective-message-preview'
import {
  validateMessagePreviewPatch,
  mergeMessagePreviewPatch,
  hasMessagePreviewField,
  type MessagePreviewPatchData,
} from '@/lib/widget/message-preview-patch'
import {
  resolveEffectiveQuickReplies,
  getStoredQuickReplies,
  type StoredQuickRepliesInput,
} from '@/lib/widget/effective-quick-replies'
import {
  validateQuickRepliesPatch,
  mergeQuickRepliesPatch,
  hasQuickRepliesField,
  type QuickRepliesPatchData,
} from '@/lib/widget/quick-replies-patch'
import {
  resolveEffectivePreChatForm,
  getStoredPreChatForm,
  type StoredPreChatFormInput,
} from '@/lib/widget/effective-pre-chat-form'
import {
  validatePreChatFormPatch,
  mergePreChatFormPatch,
  hasPreChatFormField,
  type PreChatFormPatchData,
} from '@/lib/widget/pre-chat-form-patch'
import {
  resolveEffectivePageVisibility,
  getStoredPageVisibility,
  type StoredPageVisibilityInput,
} from '@/lib/widget/effective-page-visibility'
import {
  validatePageVisibilityPatch,
  mergePageVisibilityPatch,
  hasPageVisibilityField,
  type PageVisibilityPatchData,
} from '@/lib/widget/page-visibility-patch'
import {
  resolveEffectiveAlternativeContactButtons,
  getStoredAlternativeContactButtons,
  type StoredAlternativeContactInput,
} from '@/lib/widget/effective-alternative-contacts'
import {
  validateAlternativeContactButtonsPatch,
  mergeAlternativeContactButtonsPatch,
  hasAlternativeContactButtonsField,
  type AlternativeContactButtonsPatchData,
} from '@/lib/widget/alternative-contact-patch'
import {
  resolveEffectiveSmartAvoidance,
  getStoredSmartAvoidance,
  type StoredSmartAvoidanceInput,
} from '@/lib/widget/effective-smart-avoidance'
import {
  validateSmartAvoidancePatch,
  mergeSmartAvoidancePatch,
  hasSmartAvoidanceField,
  type SmartAvoidancePatchData,
} from '@/lib/widget/smart-avoidance-patch'

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

    // V2 colors: resolve effective + stored.
    const colorInput: StoredColorInput = {
      accentColor: stored?.accentColor ?? null,
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveColors = resolveEffectiveColors(colorInput, entitlements)
    const storedColors = getStoredColorTheme(colorInput)

    // V2 launcher: resolve effective + stored.
    const launcherInput: StoredLauncherInput = {
      launcherShape: stored?.launcherShape ?? null,
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveLauncher = resolveEffectiveLauncher(launcherInput, entitlements)
    const storedLauncherShape = getStoredLauncherShape(launcherInput)

    // V2 attention: resolve effective + stored.
    const attentionInput: StoredAttentionInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveAttention = resolveEffectiveAttention(attentionInput, entitlements)
    const storedAttention = getStoredAttention(attentionInput)

    // V2 message preview: resolve effective + stored.
    const messagePreviewInput: StoredMessagePreviewInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveMessagePreview = resolveEffectiveMessagePreview(messagePreviewInput, entitlements)
    const storedMessagePreview = getStoredMessagePreview(messagePreviewInput)

    // V2 quick replies: resolve effective + stored.
    const quickRepliesInput: StoredQuickRepliesInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveQuickReplies = resolveEffectiveQuickReplies(quickRepliesInput, entitlements)
    const storedQuickReplies = getStoredQuickReplies(quickRepliesInput)

    // V2 pre-chat form: resolve effective + stored.
    // The dashboard `effective` must match the public widget. The raw stored
    // `paidFields` is exposed ONLY via `stored` (for restore-on-upgrade),
    // NEVER as `effective` for Free (the resolver filters to name/email).
    const preChatFormInput: StoredPreChatFormInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectivePreChatForm = resolveEffectivePreChatForm(preChatFormInput, entitlements)
    const storedPreChatForm = getStoredPreChatForm(preChatFormInput)

    // V2 page visibility: resolve effective + stored.
    // The dashboard `effective` must match the public widget. The raw stored
    // `paidRules` is exposed ONLY via `stored` (for restore-on-upgrade),
    // NEVER as `effective` for Free (the resolver filters to exact-match, ≤3).
    const pageVisibilityInput: StoredPageVisibilityInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectivePageVisibility = resolveEffectivePageVisibility(pageVisibilityInput, entitlements)
    const storedPageVisibility = getStoredPageVisibility(pageVisibilityInput)

    // V2 alternative contact buttons: resolve effective + stored.
    // The dashboard `effective` must match the public widget. The raw stored
    // `paidItems` is exposed ONLY via `stored` (for restore-on-upgrade),
    // NEVER as `effective` for Free (the resolver truncates to the plan max).
    const alternativeContactInput: StoredAlternativeContactInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveAlternativeContactButtons = resolveEffectiveAlternativeContactButtons(alternativeContactInput, entitlements)
    const storedAlternativeContactButtons = getStoredAlternativeContactButtons(alternativeContactInput)

    // V2 smart avoidance: resolve effective + stored (Feature 10).
    // The dashboard `effective` must match the public widget. The raw stored
    // preference is exposed ONLY via `stored` (for the dashboard to show
    // "saved but locked / restore on upgrade"), NEVER as `effective` for
    // Free (the resolver returns false for Free even if stored is true).
    const smartAvoidanceInput: StoredSmartAvoidanceInput = {
      appearanceV2: stored?.appearanceV2,
    }
    const effectiveSmartAvoidance = resolveEffectiveSmartAvoidance(smartAvoidanceInput, entitlements)
    const storedSmartAvoidance = getStoredSmartAvoidance(smartAvoidanceInput)

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
      colors: {
        entitlements: {
          presetColors: entitlements?.presetColors ?? false,
          customColors: entitlements?.customColors ?? false,
        },
        // The dashboard `effective` must match what the PUBLIC widget
        // actually renders. When the plan is not entitled to customColors
        // AND the stored mode is 'custom', the public widget does NOT
        // apply the custom tokens (they're preserved but not applied).
        // In this case, `effective` must reflect the authorized fallback
        // (not the stored custom tokens).
        effective: (() => {
          // No stored colors at all + Free → legacy (null).
          if (storedColors === null && !(entitlements?.legacyCustomizationUnlocked ?? false)) {
            return null
          }
          // Stored custom but not entitled → use the resolver's effective
          // (which already strips custom tokens for non-entitled plans).
          return effectiveColors
        })(),
        stored: storedColors,
      },
      // V2 launcher: resolve effective + stored.
      // BLOCKER 3: The dashboard effective must ALWAYS match the public widget
      // config's effective launcher. The public config always exposes the
      // effective launcher (from resolveEffectiveLauncher), so the dashboard
      // must too — even for Free with only a V1 launcherShape and no V2
      // selection. The old null-for-Free logic caused a preview mismatch.
      launcher: {
        entitlements: {
          launcherSelection: entitlements?.launcherSelection ?? 'limited',
        },
        effective: effectiveLauncher,
        stored: storedLauncherShape,
      },
      // V2 attention: resolve effective + stored.
      // The dashboard `effective` must match what the PUBLIC widget actually
      // renders. The public config always exposes the effective attention
      // (from resolveEffectiveAttention), so the dashboard must too. The raw
      // stored paid preference is exposed ONLY via `stored` (for the dashboard
      // to show "saved but locked / restore on upgrade"), NEVER as `effective`.
      attention: {
        entitlements: {
          attentionAnimations: entitlements?.attentionAnimations ?? 'basic',
        },
        effective: effectiveAttention,
        stored: storedAttention,
      },
      // V2 message preview: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw
      // stored preference is exposed ONLY via `stored` (for the dashboard to
      // show "saved but locked / restore on upgrade"), NEVER as `effective`
      // for Free (the resolver returns false for Free even if stored is true).
      messagePreview: {
        entitlements: {
          messagePreview: entitlements?.messagePreview ?? false,
        },
        effective: effectiveMessagePreview,
        stored: storedMessagePreview,
      },
      // V2 quick replies: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw stored
      // `paidItems` is exposed ONLY via `stored` (for restore-on-upgrade),
      // NEVER as `effective` for Free (the resolver truncates to the plan max).
      quickReplies: {
        entitlements: {
          max: entitlements?.quickReplies ?? 0,
        },
        effective: effectiveQuickReplies,
        stored: storedQuickReplies,
      },
      // V2 pre-chat form: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw stored
      // `paidFields` is exposed ONLY via `stored` (for restore-on-upgrade),
      // NEVER as `effective` for Free (the resolver filters to name/email).
      preChatForm: {
        entitlements: { preChatForm: entitlements?.preChatForm ?? 'none' },
        effective: effectivePreChatForm,
        stored: storedPreChatForm,
      },
      // V2 page visibility: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw stored
      // `paidRules` is exposed ONLY via `stored` (for restore-on-upgrade),
      // NEVER as `effective` for Free (the resolver filters to exact-match, ≤3).
      pageVisibility: {
        entitlements: { pageVisibility: entitlements?.pageVisibility ?? 'none' },
        effective: effectivePageVisibility,
        stored: storedPageVisibility,
      },
      // V2 alternative contact buttons: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw stored
      // `paidItems` is exposed ONLY via `stored` (for restore-on-upgrade),
      // NEVER as `effective` for Free (the resolver truncates to the plan max).
      alternativeContactButtons: {
        entitlements: { max: entitlements?.alternativeContactButtons ?? 0 },
        effective: effectiveAlternativeContactButtons,
        stored: storedAlternativeContactButtons,
      },
      // V2 smart avoidance: resolve effective + stored.
      // The dashboard `effective` must match the public widget. The raw stored
      // preference is exposed ONLY via `stored` (for the dashboard to show
      // "saved but locked / restore on upgrade"), NEVER as `effective` for
      // Free (the resolver returns false for Free even if stored is true).
      smartAvoidance: {
        entitlements: { enabled: entitlements?.smartAvoidance ?? false },
        effective: effectiveSmartAvoidance,
        stored: storedSmartAvoidance,
      },
    } as const
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({
    config: result.result.stored,
    effective: result.result.effective,
    isLocked: result.result.isLocked,
    positioning: result.result.positioning,
    colors: result.result.colors,
    launcher: result.result.launcher,
    attention: result.result.attention,
    messagePreview: result.result.messagePreview,
    quickReplies: result.result.quickReplies,
    preChatForm: result.result.preChatForm,
    pageVisibility: result.result.pageVisibility,
    alternativeContactButtons: result.result.alternativeContactButtons,
    smartAvoidance: result.result.smartAvoidance,
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

/** Color-specific error codes → HTTP status mapping. */
const COLOR_ERROR_STATUS: Record<string, number> = {
  colors_not_authorized: 403,
  colors_not_object: 400,
  colors_mode_missing: 400,
  colors_mode_invalid: 400,
  colors_preset_id_missing: 400,
  colors_preset_id_invalid: 400,
  colors_custom_not_allowed: 403,
  colors_custom_missing: 400,
  colors_custom_invalid: 400,
  colors_custom_unexpected_key: 400,
  colors_unexpected_key: 400,
  colors_no_fields: 400,
}

/** Launcher-specific error codes → HTTP status mapping. */
const LAUNCHER_ERROR_STATUS: Record<string, number> = {
  launcher_not_authorized: 403,
  launcher_not_object: 400,
  launcher_shape_missing: 400,
  launcher_shape_invalid: 400,
  launcher_shape_not_allowed: 403,
  launcher_unexpected_key: 400,
  launcher_no_fields: 400,
}

/** Attention-specific error codes → HTTP status mapping. */
const ATTENTION_ERROR_STATUS: Record<string, number> = {
  attention_not_authorized: 403,        // unknown plan / no attention entitlement
  attention_not_object: 400,
  attention_animation_missing: 400,
  attention_animation_invalid: 400,
  attention_animation_not_allowed: 403, // Free attempting advanced motion → 403
  attention_unexpected_key: 400,
  attention_no_fields: 400,
}

/** Message-preview-specific error codes → HTTP status mapping. */
const MESSAGE_PREVIEW_ERROR_STATUS: Record<string, number> = {
  message_preview_not_authorized: 403,
  message_preview_not_object: 400,
  message_preview_enabled_missing: 400,
  message_preview_enabled_invalid: 400,
  message_preview_not_allowed: 403,
  message_preview_unexpected_key: 400,
  message_preview_no_fields: 400,
}

/** Quick-replies-specific error codes → HTTP status mapping. */
const QUICK_REPLIES_ERROR_STATUS: Record<string, number> = {
  quick_replies_not_authorized: 403,
  quick_replies_not_object: 400,
  quick_replies_items_missing: 400,
  quick_replies_items_not_array: 400,
  quick_replies_item_invalid: 400,
  quick_replies_limit_exceeded: 403, // exceeding plan max → 403
  quick_replies_duplicate: 400,
  quick_replies_unexpected_key: 400,
  quick_replies_no_fields: 400,
}

/** Pre-chat-form-specific error codes → HTTP status mapping. */
const PRE_CHAT_FORM_ERROR_STATUS: Record<string, number> = {
  pre_chat_form_not_authorized: 403,
  pre_chat_form_not_object: 400,
  pre_chat_form_fields_missing: 400,
  pre_chat_form_fields_not_array: 400,
  pre_chat_form_field_invalid: 400,
  pre_chat_form_not_allowed: 403,
  pre_chat_form_limit_exceeded: 403,
  pre_chat_form_duplicate_key: 400,
  pre_chat_form_unexpected_key: 400,
  pre_chat_form_no_fields: 400,
}

/** Page-visibility-specific error codes → HTTP status mapping. */
const PAGE_VISIBILITY_ERROR_STATUS: Record<string, number> = {
  page_visibility_not_authorized: 403,
  page_visibility_not_object: 400,
  page_visibility_rules_missing: 400,
  page_visibility_rules_not_array: 400,
  page_visibility_rule_invalid: 400,
  page_visibility_not_allowed: 403,
  page_visibility_limit_exceeded: 403,
  page_visibility_duplicate_rule: 400,
  page_visibility_unexpected_key: 400,
  page_visibility_no_fields: 400,
}

/** Alternative-contact-buttons-specific error codes → HTTP status mapping. */
const ALTERNATIVE_CONTACT_BUTTONS_ERROR_STATUS: Record<string, number> = {
  alt_contact_not_authorized: 403,
  alt_contact_not_object: 400,
  alt_contact_items_missing: 400,
  alt_contact_items_not_array: 400,
  alt_contact_item_invalid: 400,
  alt_contact_limit_exceeded: 403,
  alt_contact_duplicate_kind: 400,
  alt_contact_unexpected_key: 400,
  alt_contact_no_fields: 400,
}

/** Smart-avoidance-specific error codes → HTTP status mapping. */
const SMART_AVOIDANCE_ERROR_STATUS: Record<string, number> = {
  smart_avoidance_not_authorized: 403,  // unknown plan / no entitlement set
  smart_avoidance_not_object: 400,
  smart_avoidance_enabled_missing: 400,
  smart_avoidance_enabled_invalid: 400,
  smart_avoidance_not_allowed: 403,     // Free attempting a paid capability → 403
  smart_avoidance_unexpected_key: 400,
  smart_avoidance_no_fields: 400,
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
    const hasColors = hasColorField(body)
    const hasLauncher = hasLauncherField(body)
    const hasAttention = hasAttentionField(body)
    const hasMessagePreview = hasMessagePreviewField(body)
    const hasQuickReplies = hasQuickRepliesField(body)
    const hasPreChatForm = hasPreChatFormField(body)
    const hasPageVisibility = hasPageVisibilityField(body)
    const hasAlternativeContactButtons = hasAlternativeContactButtonsField(body)
    const hasSmartAvoidance = hasSmartAvoidanceField(body)
    const hasOtherFields = hasOtherCustomizationFields(body)

    // Reject unrecognized top-level fields when the request contains
    // positioning, colors, launcher, attention, messagePreview, quickReplies,
    // preChatForm, pageVisibility, alternativeContactButtons, or
    // smartAvoidance.
    if ((hasPositioning || hasColors || hasLauncher || hasAttention || hasMessagePreview || hasQuickReplies || hasPreChatForm || hasPageVisibility || hasAlternativeContactButtons || hasSmartAvoidance) && hasUnrecognizedFields(body)) {
      return { badRequest: true as const, code: 'unrecognized_field' }
    }

    // If Free sends non-positioning/non-color customization (with or
    // without positioning/colors), reject with 402 — no bypass by mixing.
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

    // ---- Validate colors (if present) ----
    let colorPatch: ColorPatchData | null = null
    if (hasColors) {
      const colorResult = validateColorPatch({ colors: body.colors }, entitlements)
      if (!colorResult.ok) {
        return { colorError: true as const, code: colorResult.code }
      }
      colorPatch = colorResult.data
    }

    // ---- Validate launcher (if present) ----
    let launcherPatch: LauncherPatchData | null = null
    if (hasLauncher) {
      const launcherResult = validateLauncherPatch({ launcher: body.launcher }, entitlements)
      if (!launcherResult.ok) {
        return { launcherError: true as const, code: launcherResult.code }
      }
      launcherPatch = launcherResult.data
    }

    // ---- Validate attention (if present) ----
    let attentionPatch: AttentionPatchData | null = null
    if (hasAttention) {
      const attentionResult = validateAttentionPatch({ attention: body.attention }, entitlements)
      if (!attentionResult.ok) {
        return { attentionError: true as const, code: attentionResult.code }
      }
      attentionPatch = attentionResult.data
    }

    // ---- Validate message preview (if present) ----
    let messagePreviewPatch: MessagePreviewPatchData | null = null
    if (hasMessagePreview) {
      const mpResult = validateMessagePreviewPatch({ messagePreview: body.messagePreview }, entitlements)
      if (!mpResult.ok) {
        return { messagePreviewError: true as const, code: mpResult.code }
      }
      messagePreviewPatch = mpResult.data
    }

    // ---- Validate quick replies (if present) ----
    let quickRepliesPatch: QuickRepliesPatchData | null = null
    if (hasQuickReplies) {
      const qrResult = validateQuickRepliesPatch({ quickReplies: body.quickReplies }, entitlements)
      if (!qrResult.ok) {
        return { quickRepliesError: true as const, code: qrResult.code }
      }
      quickRepliesPatch = qrResult.data
    }

    // ---- Validate pre-chat form (if present) ----
    let preChatFormPatch: PreChatFormPatchData | null = null
    if (hasPreChatForm) {
      const pcfResult = validatePreChatFormPatch({ preChatForm: body.preChatForm }, entitlements)
      if (!pcfResult.ok) {
        return { preChatFormError: true as const, code: pcfResult.code }
      }
      preChatFormPatch = pcfResult.data
    }

    // ---- Validate page visibility (if present) ----
    let pageVisibilityPatch: PageVisibilityPatchData | null = null
    if (hasPageVisibility) {
      const pvResult = validatePageVisibilityPatch({ pageVisibility: body.pageVisibility }, entitlements)
      if (!pvResult.ok) {
        return { pageVisibilityError: true as const, code: pvResult.code }
      }
      pageVisibilityPatch = pvResult.data
    }

    // ---- Validate alternative contact buttons (if present) ----
    let alternativeContactButtonsPatch: AlternativeContactButtonsPatchData | null = null
    if (hasAlternativeContactButtons) {
      const acbResult = validateAlternativeContactButtonsPatch({ alternativeContactButtons: body.alternativeContactButtons }, entitlements)
      if (!acbResult.ok) {
        return { alternativeContactButtonsError: true as const, code: acbResult.code }
      }
      alternativeContactButtonsPatch = acbResult.data
    }

    // ---- Validate smart avoidance (if present) ----
    // NOTE: smartAvoidance is deliberately NOT in OTHER_CUSTOMIZATION_KEYS —
    // a Free PATCH containing ONLY smartAvoidance must reach THIS validation
    // (→ 403 smart_avoidance_not_allowed), not the legacy 402 plan lock, so
    // the dashboard gets the specific entitlement error.
    let smartAvoidancePatch: SmartAvoidancePatchData | null = null
    if (hasSmartAvoidance) {
      const saResult = validateSmartAvoidancePatch({ smartAvoidance: body.smartAvoidance }, entitlements)
      if (!saResult.ok) {
        return { smartAvoidanceError: true as const, code: saResult.code }
      }
      smartAvoidancePatch = saResult.data
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

    // ---- Apply color patch (if validated) ----
    // IMPORTANT: if both positioning + color patches are present, the color
    // merge reads the ALREADY-MERGED appearanceV2 (from positioning merge)
    // so positioning is preserved. If only color is present, it reads the
    // existing stored appearanceV2.
    if (colorPatch) {
      // If positioning was already applied, use the merged result; otherwise
      // read from DB.
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedColors = mergeColorPatch(baseAppearanceV2, colorPatch)
      data.appearanceV2 = mergedColors as unknown as string // Prisma Json field
    }

    // ---- Apply launcher patch (if validated) ----
    if (launcherPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedLauncher = mergeLauncherPatch(baseAppearanceV2, launcherPatch, entitlements)
      data.appearanceV2 = mergedLauncher as unknown as string // Prisma Json field
    }

    // ---- Apply attention patch (if validated) ----
    // Reads the already-merged appearanceV2 (from positioning/color/launcher
    // patches, if any) so all neighboring V2 capabilities are preserved.
    if (attentionPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedAttention = mergeAttentionPatch(baseAppearanceV2, attentionPatch, entitlements)
      data.appearanceV2 = mergedAttention as unknown as string // Prisma Json field
    }

    // ---- Apply message preview patch (if validated) ----
    // Reads the already-merged appearanceV2 (from prior patches, if any) so
    // all neighboring V2 capabilities are preserved.
    if (messagePreviewPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedMessagePreview = mergeMessagePreviewPatch(baseAppearanceV2, messagePreviewPatch)
      data.appearanceV2 = mergedMessagePreview as unknown as string // Prisma Json field
    }

    // ---- Apply quick replies patch (if validated) ----
    if (quickRepliesPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedQuickReplies = mergeQuickRepliesPatch(baseAppearanceV2, quickRepliesPatch, entitlements)
      data.appearanceV2 = mergedQuickReplies as unknown as string // Prisma Json field
    }

    // ---- Apply pre-chat form patch (if validated) ----
    // Reads the already-merged appearanceV2 (from prior patches, if any) so
    // all neighboring V2 capabilities are preserved.
    if (preChatFormPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedPreChatForm = mergePreChatFormPatch(baseAppearanceV2, preChatFormPatch, entitlements)
      data.appearanceV2 = mergedPreChatForm as unknown as string // Prisma Json field
    }

    // ---- Apply page visibility patch (if validated) ----
    // Reads the already-merged appearanceV2 (from prior patches, if any) so
    // all neighboring V2 capabilities are preserved.
    if (pageVisibilityPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedPageVisibility = mergePageVisibilityPatch(baseAppearanceV2, pageVisibilityPatch, entitlements)
      data.appearanceV2 = mergedPageVisibility as unknown as string // Prisma Json field
    }

    // ---- Apply alternative contact buttons patch (if validated) ----
    // Reads the already-merged appearanceV2 (from prior patches, if any) so
    // all neighboring V2 capabilities are preserved.
    if (alternativeContactButtonsPatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedAlternativeContactButtons = mergeAlternativeContactButtonsPatch(baseAppearanceV2, alternativeContactButtonsPatch, entitlements)
      data.appearanceV2 = mergedAlternativeContactButtons as unknown as string // Prisma Json field
    }

    // ---- Apply smart avoidance patch (if validated) ----
    // Reads the already-merged appearanceV2 (from prior patches, if any) so
    // all neighboring V2 capabilities are preserved.
    if (smartAvoidancePatch) {
      let baseAppearanceV2: unknown = data.appearanceV2 ?? undefined
      if (baseAppearanceV2 === undefined) {
        const existing = await db.widgetConfig.findUnique({
          where: { tenantId: tid },
          select: { appearanceV2: true },
        })
        baseAppearanceV2 = existing?.appearanceV2
      }
      const mergedSmartAvoidance = mergeSmartAvoidancePatch(baseAppearanceV2, smartAvoidancePatch, entitlements)
      data.appearanceV2 = mergedSmartAvoidance as unknown as string // Prisma Json field
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
  if ('colorError' in r) {
    const status = COLOR_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('launcherError' in r) {
    const status = LAUNCHER_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('attentionError' in r) {
    const status = ATTENTION_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('messagePreviewError' in r) {
    const status = MESSAGE_PREVIEW_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('quickRepliesError' in r) {
    const status = QUICK_REPLIES_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('preChatFormError' in r) {
    const status = PRE_CHAT_FORM_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('pageVisibilityError' in r) {
    const status = PAGE_VISIBILITY_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('alternativeContactButtonsError' in r) {
    const status = ALTERNATIVE_CONTACT_BUTTONS_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('smartAvoidanceError' in r) {
    const status = SMART_AVOIDANCE_ERROR_STATUS[r.code as string] ?? 400
    return NextResponse.json({ error: r.code }, { status })
  }
  if ('badRequest' in r) return NextResponse.json({ error: r.code }, { status: 400 })
  return NextResponse.json({ config: r.config })
}
