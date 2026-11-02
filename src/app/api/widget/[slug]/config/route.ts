import { NextResponse } from 'next/server'
import { db, globalDb } from '@/lib/db'
import { getEffectiveWidgetConfig } from '@/lib/payments/free-plan'
import { checkMessageLimit } from '@/lib/payments/free-plan'
import { getRequestDomain, isDomainAllowed } from '@/lib/payments/domain-validation'
import { resolveRealtimeConfig } from '@/lib/realtime-config'
import { publicAccessConfig } from '@/lib/widget-access-policy'
import { getEntitlements } from '@/lib/payments/widget-entitlements'
import {
  resolveAllEffectivePositioning,
  deriveLegacyPosition,
  type StoredPositioningInput,
} from '@/lib/widget/effective-positioning'
import {
  resolveEffectiveColors,
  getStoredColorTheme,
  type StoredColorInput,
} from '@/lib/widget/effective-colors'
import {
  resolveEffectiveLauncher,
  type StoredLauncherInput,
} from '@/lib/widget/effective-launcher'
import {
  resolveEffectiveAttention,
  type StoredAttentionInput,
} from '@/lib/widget/effective-attention'
import {
  resolveEffectiveMessagePreview,
  type StoredMessagePreviewInput,
} from '@/lib/widget/effective-message-preview'
import {
  resolveEffectiveQuickReplies,
  type StoredQuickRepliesInput,
} from '@/lib/widget/effective-quick-replies'
import {
  resolveEffectivePreChatForm,
  type StoredPreChatFormInput,
} from '@/lib/widget/effective-pre-chat-form'
import {
  resolveEffectivePageVisibility,
  type StoredPageVisibilityInput,
} from '@/lib/widget/effective-page-visibility'
import {
  resolveEffectiveAlternativeContactButtons,
  type StoredAlternativeContactInput,
} from '@/lib/widget/effective-alternative-contacts'

/** CORS headers for widget API responses. */
function widgetHeaders(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  // Prevent browser caching so V2 positioning changes propagate immediately.
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } })
}

/** Force dynamic rendering — never cache the config response (V2 positioning
 * changes must propagate immediately to the widget script). */
export const dynamic = 'force-dynamic'

/**
 * Public widget configuration, resolved by tenant slug.
 * Free plan: returns LOCKED defaults (Sukhan brand, no customization).
 * Paid plans: returns the tenant's configured values.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const tenant = await db.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, defaultLocale: true, defaultDirection: true, plan: true },
  })
  if (!tenant) {
    return widgetHeaders(NextResponse.json({ error: 'not_found' }, { status: 404 }))
  }

  // Domain validation
  const domain = getRequestDomain(req)
  const domainAllowed = await isDomainAllowed(tenant.id, domain)
  if (!domainAllowed) {
    return widgetHeaders(NextResponse.json({ error: 'domain_not_allowed' }, { status: 403 }))
  }

  // Free plan trial expiry check
  const messageCheck = await checkMessageLimit(tenant.id)
  if (!messageCheck.allowed && messageCheck.reason === 'trial_expired') {
    return widgetHeaders(NextResponse.json({ error: 'trial_expired' }, { status: 403 }))
  }

  // Get effective VISUAL config (locked for free plan, custom for paid). The
  // visual customization plan-locking is INDEPENDENT of the visitor access
  // policy — a FREE tenant may have locked Sukhan visuals while still having
  // accessMode=verified_visitor (or site_user_only). Never force anonymous
  // merely because the tenant is on the free plan.
  const config = await getEffectiveWidgetConfig(tenant.id)
  if (!config) {
    return widgetHeaders(NextResponse.json({ error: 'not_configured' }, { status: 404 }))
  }

  // Fetch the REAL stored visitor access policy from WidgetConfig (NOT derived
  // from getEffectiveWidgetConfig — that returns visual-only fields). The
  // public route runs without a tenant session, so use globalDb (unscoped) for
  // the tenant-scoped WidgetConfig read (the lookup is by the unique tenantId).
  // Also select the stored appearanceV2 + position for V2 positioning resolution.
  const widgetConfig = await globalDb.widgetConfig.findUnique({
    where: { tenantId: tenant.id },
    select: {
      accessMode: true,
      policyVersion: true,
      loginUrl: true,
      loginButtonLabel: true,
      loginReturnUrlParam: true,
      identityEndpointPath: true,
      position: true,
      appearanceV2: true,
      accentColor: true,
      launcherShape: true,
    },
  })
  if (!widgetConfig) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }
  // publicAccessConfig strictly parses accessMode + policyVersion AND validates
  // the persisted public login fields against the SAME contract as dashboard
  // PATCH. A legacy unsafe value fail-closes -> null -> 503 policy_unavailable.
  // NEVER fabricates a fallback (anonymous) policy.
  const publicPolicy = publicAccessConfig(widgetConfig)
  if (!publicPolicy) {
    return widgetHeaders(NextResponse.json({ error: 'policy_unavailable' }, { status: 503 }))
  }

  // Additive: realtime endpoint config so the cross-origin NPM widget does
  // not need to know deployment topology. Older clients ignore the field.
  const realtime = resolveRealtimeConfig()

  // V2 positioning: resolve the EFFECTIVE positioning for desktop + mobile
  // from the stored V2/V1 + the server-authoritative plan entitlements.
  // The public config exposes ONLY validated effective positioning —
  // offsets are included only for plans entitled to precise positioning.
  // Stored paid offsets are NEVER exposed to Free visitors.
  const entitlements = getEntitlements(tenant.plan)
  const storedPosInput: StoredPositioningInput = {
    position: widgetConfig.position ?? null,
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectivePos = resolveAllEffectivePositioning(storedPosInput, entitlements)

  // Derive the V1 `position` for legacy consumers from the effective desktop
  // positioning. V1 only supports bottom-start/bottom-end; bottom-center
  // maps to bottom-end (the canonical product default).
  const legacyPosition = deriveLegacyPosition(effectivePos.desktop)
  // V2 colors: resolve effective colors from stored V2/V1 + entitlements.
  // The public config exposes ONLY effective colors permitted by the plan.
  // Stored paid custom colors are NEVER exposed to Free visitors.
  const colorInput: StoredColorInput = {
    accentColor: widgetConfig.accentColor ?? null,
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveColors = resolveEffectiveColors(colorInput, entitlements)
  // Check if the tenant has an explicit V2 color selection OR is a paid plan
  // with a stored V1 accent. If neither (e.g., Free with no V2 colors), do
  // NOT include `colors` in the public response — the widget uses its
  // hardcoded pre-V2 colors (preserving existing appearance for tenants
  // who haven't adopted V2 colors).
  const storedColorTheme = getStoredColorTheme(colorInput)
  const hasV2ColorSelection = storedColorTheme !== null
  const isPaidPlan = entitlements?.legacyCustomizationUnlocked ?? false
  const hasStoredV1Accent = !!(widgetConfig.accentColor && /^#[0-9a-fA-F]{6}$/.test(widgetConfig.accentColor))
  const shouldExposeColors = hasV2ColorSelection || (isPaidPlan && hasStoredV1Accent)

  // Derive the V1 `accentColor` for legacy consumers.
  // When V2 colors ARE exposed: use the V2 effective accent.
  // When V2 colors are NOT exposed: use `config.accentColor` from
  // getEffectiveWidgetConfig() — this is the AUTHORIZED effective accent
  // that respects the plan lock. For Free, it returns '#E09A2B' (Sukhan
  // default), NOT the raw stored V1 accent from a previous paid period.
  // For paid without V2, it returns the stored accent. For unknown plans,
  // it returns the locked default. The raw `widgetConfig.accentColor` is
  // NEVER directly exposed to unauthorized plans.
  const legacyAccent = shouldExposeColors
    ? effectiveColors.tokens.accent
    : config.accentColor

  // V2 launcher: resolve effective launcher from stored V2/V1 + entitlements.
  const launcherInput: StoredLauncherInput = {
    launcherShape: widgetConfig.launcherShape ?? null,
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveLauncher = resolveEffectiveLauncher(launcherInput, entitlements)
  // Derive the V1 `launcherShape` for legacy consumers from the effective launcher.
  const legacyLauncherShape = effectiveLauncher.shape

  // V2 attention: resolve effective attention from stored V2 + entitlements.
  // The public config exposes ONLY the effective authorized animation —
  // never the raw stored paidAnimation. For Free with a stored paid-only
  // animation (and no basic selection), the resolver returns 'none' so the
  // launcher never renders an unauthorized paid motion. When no V2 attention
  // selection exists, the resolver returns 'none' (legacy unanimated).
  const attentionInput: StoredAttentionInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveAttention = resolveEffectiveAttention(attentionInput, entitlements)

  // V2 message preview: resolve effective from stored V2 + entitlements.
  // The public config exposes ONLY the effective authorized boolean —
  // never the raw stored preference. Free with a stored `true` (from a
  // prior paid period) exposes `false`. The public config never contains
  // message text or conversation history.
  const messagePreviewInput: StoredMessagePreviewInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveMessagePreview = resolveEffectiveMessagePreview(messagePreviewInput, entitlements)

  // V2 quick replies: resolve effective items from stored V2 + entitlements.
  // The public config exposes ONLY the effective authorized items — never
  // paidItems. Free with stored paid-only items exposes only the first `max`.
  const quickRepliesInput: StoredQuickRepliesInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveQuickReplies = resolveEffectiveQuickReplies(quickRepliesInput, entitlements)

  // V2 pre-chat form: resolve effective fields from stored V2 + entitlements.
  // The public config exposes ONLY the effective authorized fields — never
  // paidFields. Free with stored advanced-only fields exposes only name/email.
  const preChatFormInput: StoredPreChatFormInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectivePreChatForm = resolveEffectivePreChatForm(preChatFormInput, entitlements)

  // V2 page visibility: resolve effective rules from stored V2 + entitlements.
  // The public config exposes ONLY the effective authorized rules — never
  // paidRules. Free with stored prefix/device rules exposes only exact-match
  // rules (≤3). The public `pageVisibility` contains ONLY `{ rules }`.
  const pageVisibilityInput: StoredPageVisibilityInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectivePageVisibility = resolveEffectivePageVisibility(pageVisibilityInput, entitlements)

  // V2 alternative contact buttons: resolve effective items from stored V2 +
  // entitlements. The public config exposes ONLY the effective authorized
  // items — never paidItems. Free with stored paid-only items exposes only
  // the first `max`. The public `alternativeContactButtons` contains ONLY
  // `{ items }`.
  const alternativeContactInput: StoredAlternativeContactInput = {
    appearanceV2: widgetConfig.appearanceV2,
  }
  const effectiveAlternativeContactButtons = resolveEffectiveAlternativeContactButtons(alternativeContactInput, entitlements)

  const configWithPosition = { ...config, position: legacyPosition, accentColor: legacyAccent, launcherShape: legacyLauncherShape }

  // Build the response — conditionally include `colors` only when the tenant
  // has an explicit V2 color selection or a paid V1 accent. This preserves
  // the pre-V2 widget appearance for Free tenants who haven't adopted V2.
  const responseBody: Record<string, unknown> = {
    slug,
    name: tenant.name,
    ...configWithPosition,
    ...publicPolicy,
    realtime,
    positioning: {
      desktop: effectivePos.desktop,
      mobile: effectivePos.mobile,
    },
  }
  if (shouldExposeColors) {
    responseBody.colors = effectiveColors
  }
  // V2 launcher (additive — older clients use the legacy `launcherShape` field).
  responseBody.launcher = effectiveLauncher
  // V2 attention (additive — always present as { animation }).
  // 'none' preserves the legacy unanimated launcher for tenants who haven't
  // adopted V2 attention. Older consumers ignore the field.
  responseBody.attention = effectiveAttention
  // V2 message preview (additive — always present as { enabled }).
  // `false` for Free / unknown / no-V2-selection. Older consumers ignore
  // the field. Never contains message text or conversation history.
  responseBody.messagePreview = effectiveMessagePreview
  // V2 quick replies (additive — always present as { items }).
  // Empty array for Free / unknown / no-V2-selection. Older consumers ignore
  // the field. Never exposes paidItems.
  responseBody.quickReplies = effectiveQuickReplies
  // V2 pre-chat form (additive — always present as { fields }).
  // Empty array for Free / unknown / no-V2-selection. Older consumers ignore
  // the field. Never exposes paidFields.
  responseBody.preChatForm = effectivePreChatForm
  // V2 page visibility (additive — always present as { rules }).
  // Empty array for Free / unknown / no-V2-selection. Older consumers ignore
  // the field. Never exposes paidRules — the public `pageVisibility` object
  // contains ONLY `{ rules }` (resolveEffectivePageVisibility never returns
  // paidRules).
  responseBody.pageVisibility = effectivePageVisibility
  // V2 alternative contact buttons (additive — always present as { items }).
  // Empty array for Free / unknown / no-V2-selection. Older consumers ignore
  // the field. Never exposes paidItems — the public
  // `alternativeContactButtons` object contains ONLY `{ items }`
  // (resolveEffectiveAlternativeContactButtons never returns paidItems).
  responseBody.alternativeContactButtons = effectiveAlternativeContactButtons

  // Additive: the safe public access-policy fields. Existing clients continue
  // working (additive top-level fields). NEVER expose the raw integration
  // secret, integrationSecretHash, or any server-only credential — only the
  // explicitly safe policy fields selected above.
  return widgetHeaders(NextResponse.json(responseBody))
}
