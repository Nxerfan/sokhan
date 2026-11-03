'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FlaskConical, Monitor, Smartphone, Languages, RotateCcw, ShieldCheck, Lock, MessageSquare, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  getPlaygroundCapabilities,
  createPlaygroundDraft,
  sanitizePlaygroundDraft,
  type PlaygroundDraft,
  type PlaygroundDevice,
  type PlaygroundLocale,
  type PlaygroundShape,
} from '@/lib/widget/playground-policy'
import { COLOR_PALETTES, getPaletteById, isValidColor } from '@/lib/widget/color-palettes'
import type { PositioningAnchor } from '@/lib/widget/positioning-geometry'
import {
  computeLauncherPosition,
  computePanelVerticalPosition,
  computePanelHorizontalPosition,
  POSITIONING_ANCHORS,
  OFFSET_MIN,
  OFFSET_MAX,
} from '@/lib/widget/positioning-geometry'
import type { WidgetEntitlements } from '@/lib/payments/widget-entitlements'

/**
 * V2 Playground — Feature 12 dashboard panel.
 *
 * An interactive, private, LOCAL-ONLY simulation of the Sukhan widget
 * inside the dashboard Widget area. The owner can:
 *   - switch desktop / mobile previews,
 *   - switch Persian RTL / English LTR,
 *   - select a different canonical positioning anchor,
 *   - experiment with the 10 canonical palettes,
 *   - try permitted launcher shapes (pill is paid-only),
 *   - experiment with precise X/Y offsets + a custom accent when entitled,
 *   - open/close a simulated chat panel and type simulated messages,
 *   - reset everything to the current server-effective baseline.
 *
 * ISOLATION CONTRACT (central security rule):
 *   - Interacting with the playground NEVER triggers a PATCH/POST/PUT/
 *     DELETE to /api/widget-config, a visitor message POST, a /contact
 *     bootstrap, a conversation, message persistence, a realtime socket,
 *     an AI response, a billing change, a visitor identity, a public
 *     widget script injection, or LocalStorage/sessionStorage writes.
 *   - This component renders ZERO network calls — every control change
 *     is pure local React state, and every value it renders comes from
 *     the already-authenticated GET /api/widget-config response passed
 *     in via props.
 *   - Simulated messages are rendered as React TEXT (never innerHTML /
 *     dangerouslySetInnerHTML), so HTML like `<img src=x onerror=…>`
 *     displays as literal text and can never execute.
 *   - The draft is validated through the strict policy sanitizer before
 *     it reaches the preview surface; an invalid draft falls back to the
 *     safe server-effective baseline.
 *   - A hard reload discards all experiments by construction (in-memory
 *     state only); the Reset button restores the same baseline.
 *
 * The preview reuses the canonical catalogs + shared positioning geometry
 * (computeLauncherPosition / computePanelVerticalPosition /
 * computePanelHorizontalPosition) bounded to the preview viewport — it is
 * a realistic but SIMPLIFIED simulation, not pixel-perfect production
 * rendering, and is clearly labeled as such.
 */

// ---------------------------------------------------------------------------
// Prop types (mirroring the GET /api/widget-config data the parent holds)
// ---------------------------------------------------------------------------

/** V2 playground data (from GET /api/widget-config `playground` field). */
interface PlaygroundData {
  entitlements: { enabled: boolean }
}

interface PlaygroundPositioningData {
  entitlements: { presetPositioning: boolean; precisePositioning: boolean }
  effective: {
    desktop: { anchor: string; offsetX: number; offsetY: number }
    mobile: { anchor: string; offsetX: number; offsetY: number }
  }
  stored: unknown
}

interface PlaygroundColorsData {
  entitlements: { presetColors: boolean; customColors: boolean }
  effective: {
    mode: 'preset' | 'custom'
    presetId?: string
    tokens: Record<string, string>
  } | null
  stored: unknown
}

interface PlaygroundLauncherData {
  entitlements: { launcherSelection: 'limited' | 'all' }
  effective: { shape: 'tab' | 'rounded' | 'pill' }
  stored: unknown
}

interface WidgetPlaygroundPanelProps {
  playground: PlaygroundData | null
  positioning: PlaygroundPositioningData | null
  colors: PlaygroundColorsData | null
  launcher: PlaygroundLauncherData | null
  effectiveConfig: {
    defaultLocale: string
    greetingTexts: Record<string, string>
  } | null
  isLocked: boolean
}

// ---------------------------------------------------------------------------
// Preview constants (bounded simulation viewport)
// ---------------------------------------------------------------------------

/** Simulated surface sizes (px) per device. */
const SURFACE_SIZES = {
  desktop: { w: 640, h: 460 },
  mobile: { w: 360, h: 560 },
} as const

/** Simulated chat panel preferred sizes (px) per device. */
const PANEL_PREFERRED = {
  desktop: { w: 340, h: 360 },
  mobile: { w: 300, h: 420 },
} as const

/** Same base margin the production widget uses. */
const BASE_MARGIN = 20
/** Same gaps the production widget uses. */
const PANEL_GAP = 12
const VIEWPORT_MARGIN = 20
/** Height of the Free "Powered by Sukhan" strip inside the surface. */
const BRANDING_STRIP = 22

/** Canonical launcher dimensions per shape (same as the runtime). */
function launcherDims(shape: PlaygroundShape): { w: number; h: number } {
  if (shape === 'tab') return { w: 60, h: 52 }
  if (shape === 'pill') return { w: 64, h: 48 }
  return { w: 52, h: 52 }
}

/** Canonical launcher border-radius per shape (same as the runtime). */
function launcherRadius(shape: PlaygroundShape): string {
  if (shape === 'tab') return '14px 14px 4px 14px'
  if (shape === 'pill') return '999px'
  return '16px'
}

/**
 * Re-validate a draft/baseline anchor string against the canonical catalog
 * and narrow it for the typed internal state. The strict policy sanitizer
 * already guarantees canonical values — this is a typed boundary check
 * (fail-closed to the product default) for the preview geometry.
 */
function toAnchor(value: string): PositioningAnchor {
  return (POSITIONING_ANCHORS as readonly string[]).includes(value)
    ? (value as PositioningAnchor)
    : 'bottom-end'
}

/** The localized strings INSIDE the simulated widget (by simulation locale). */
function previewStrings(locale: PlaygroundLocale) {
  if (locale === 'fa') {
    return {
      chatTitle: 'گفت‌وگو',
      launcherLabel: 'گفت‌وگو',
      closeLabel: 'بستن',
      sendLabel: 'ارسال پیام آزمایشی',
      placeholder: 'یک پیام آزمایشی بنویسید…',
      poweredBy: 'نیرو گرفته از سُخن',
      sampleAgent: 'سلام! این یک پیام نمونه از کارشناس است.',
      sampleVisitor: 'این یک پیام نمونه از بازدیدکننده است.',
      chromeHint: 'پیش‌نمایش شبیه‌سازی‌شده — example.com',
    }
  }
  return {
    chatTitle: 'Chat',
    launcherLabel: 'Open chat',
    closeLabel: 'Close',
    sendLabel: 'Send simulated message',
    placeholder: 'Type a simulated message…',
    poweredBy: 'Powered by Sukhan',
    sampleAgent: 'Hello! This is a sample agent message.',
    sampleVisitor: 'This is a sample visitor message.',
    chromeHint: 'Simulated preview — example.com',
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WidgetPlaygroundPanel({
  playground,
  positioning,
  colors,
  launcher,
  effectiveConfig,
  isLocked,
}: WidgetPlaygroundPanelProps) {
  const t = useTranslations('settings')

  // ---- Entitlements (server-resolved, reconstructed for the policy) ----
  // Reconstructed ONLY from the entitlement fields the authenticated
  // dashboard API already exposes (fail-closed defaults for missing
  // data). Fields the playground policy never reads get fail-closed
  // placeholders — the playground must never widen capabilities. The
  // `playground` flag itself gates the whole view; unknown/invalid plans
  // fail closed (enabled: false from the server).
  const entitlements = useMemo<WidgetEntitlements | null>(() => {
    if (!playground?.entitlements?.enabled) return null
    return {
      presetPositioning: positioning?.entitlements?.presetPositioning ?? false,
      precisePositioning: positioning?.entitlements?.precisePositioning ?? false,
      presetColors: colors?.entitlements?.presetColors ?? false,
      customColors: colors?.entitlements?.customColors ?? false,
      launcherSelection: launcher?.entitlements?.launcherSelection ?? 'limited',
      playground: true,
      messagePreview: false,
      attentionAnimations: 'basic',
      quickReplies: 0,
      preChatForm: 'none',
      pageVisibility: 'none',
      alternativeContactButtons: 0,
      smartAvoidance: false,
      contextChat: false,
      brandingRemoval: false,
      legacyCustomizationUnlocked: false,
    }
  }, [playground, positioning, colors, launcher])

  const caps = useMemo(() => getPlaygroundCapabilities(entitlements), [entitlements])

  // ---- Server-effective baseline snapshot ----
  const baselineSnapshot = useMemo(
    () => ({
      defaultLocale: effectiveConfig?.defaultLocale,
      positioning: positioning?.effective ?? null,
      colors: colors?.effective ?? null,
      launcher: launcher?.effective ?? null,
    }),
    [effectiveConfig, positioning, colors, launcher],
  )

  const baselineDesktop = useMemo(
    () => createPlaygroundDraft(baselineSnapshot, entitlements, 'desktop'),
    [baselineSnapshot, entitlements],
  )
  const baselineMobile = useMemo(
    () => createPlaygroundDraft(baselineSnapshot, entitlements, 'mobile'),
    [baselineSnapshot, entitlements],
  )

  // ---- Local-only experiment state (browser memory only) ----
  const [device, setDevice] = useState<PlaygroundDevice>('desktop')
  const [locale, setLocale] = useState<PlaygroundLocale>(baselineDesktop.locale)
  const [paletteId, setPaletteId] = useState<string>(baselineDesktop.paletteId)
  const [shape, setShape] = useState<PlaygroundShape>(baselineDesktop.shape)
  const [accentRaw, setAccentRaw] = useState<string>(baselineDesktop.customAccent ?? '')
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<string[]>([])
  const [messageInput, setMessageInput] = useState('')
  const [posByDevice, setPosByDevice] = useState<{
    desktop: { anchor: PositioningAnchor; offsetX: number; offsetY: number }
    mobile: { anchor: PositioningAnchor; offsetX: number; offsetY: number }
  }>({
    desktop: {
      anchor: toAnchor(baselineDesktop.anchor),
      offsetX: baselineDesktop.offsetX,
      offsetY: baselineDesktop.offsetY,
    },
    mobile: {
      anchor: toAnchor(baselineMobile.anchor),
      offsetX: baselineMobile.offsetX,
      offsetY: baselineMobile.offsetY,
    },
  })

  // ---- Live measured preview size (responsive containment) ----
  // The preview surface requests a fixed design size (SURFACE_SIZES) but
  // applies `maxWidth: '100%'`, so on a narrow dashboard the actually
  // rendered width can shrink below the nominal 640px desktop / 360px
  // mobile design size. A ResizeObserver tracks the live border-box size
  // so the shared canonical geometry runs against the REAL rendered
  // surface — otherwise the launcher / chat panel are positioned for the
  // nominal size and clipped outside the visible preview on narrow screens
  // (the open chat panel's right edge would land past the preview).
  //
  // The observer is created once per enabled state and disconnected on
  // unmount (or when the playground becomes unavailable). It only stores a
  // local measured size — no network, no persistence, no production widget
  // positioning change.
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [measuredSize, setMeasuredSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!caps.enabled) return
    const el = surfaceRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.max(0, Math.round(rect.width))
      const h = Math.max(0, Math.round(rect.height))
      // Only update when the rounded integer actually changes — avoids
      // spurious re-renders from sub-pixel fluctuations and any feedback
      // loop between the observer and React state.
      setMeasuredSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure() // capture the initial rendered size before the first observer tick
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [caps.enabled])

  const currentPos = posByDevice[device]

  // ---- The canonical local draft (always rendered through the sanitizer) ----
  const customAccent = isValidColor(accentRaw) ? accentRaw : null
  const draft: PlaygroundDraft = {
    device,
    locale,
    anchor: currentPos.anchor,
    offsetX: currentPos.offsetX,
    offsetY: currentPos.offsetY,
    paletteId,
    shape,
    customAccent,
    open,
  }
  // Strict boundary validation — the preview only ever renders a draft the
  // canonical sanitizer accepts; anything else falls back to the safe
  // server-effective baseline for the current device (defense in depth).
  // Pure + cheap (plain object validation), recomputed on every render.
  const view =
    sanitizePlaygroundDraft(draft, entitlements) ??
    (device === 'desktop' ? baselineDesktop : baselineMobile)

  // ---- Control handlers (pure local state — zero network calls) ----

  const commitPos = useCallback(
    (patch: Partial<{ anchor: PositioningAnchor; offsetX: number; offsetY: number }>) => {
      setPosByDevice((prev) => ({ ...prev, [device]: { ...prev[device], ...patch } }))
    },
    [device],
  )

  const onOffsetXChange = useCallback(
    (raw: string) => {
      if (raw === '') return // ignore transient empty input
      const n = Number(raw)
      if (Number.isInteger(n) && n >= OFFSET_MIN && n <= OFFSET_MAX) {
        commitPos({ offsetX: n })
      }
    },
    [commitPos],
  )

  const onOffsetYChange = useCallback(
    (raw: string) => {
      if (raw === '') return
      const n = Number(raw)
      if (Number.isInteger(n) && n >= OFFSET_MIN && n <= OFFSET_MAX) {
        commitPos({ offsetY: n })
      }
    },
    [commitPos],
  )

  // Send a LOCAL simulated message — appends a preview bubble only.
  // MUST NOT call any backend endpoint.
  const send = useCallback(() => {
    if (!messageInput) return
    setMessages((prev) => [...prev, messageInput])
    setMessageInput('')
  }, [messageInput])

  // Reset: restore the CURRENT server-effective baseline (both devices'
  // positioning + shared appearance), close the simulated chat, and clear
  // all locally simulated messages. Nothing is persisted — this is the
  // same state a hard reload would produce.
  const reset = useCallback(() => {
    const d = createPlaygroundDraft(baselineSnapshot, entitlements, 'desktop')
    const m = createPlaygroundDraft(baselineSnapshot, entitlements, 'mobile')
    setLocale(d.locale)
    setPaletteId(d.paletteId)
    setShape(d.shape)
    setAccentRaw(d.customAccent ?? '')
    setOpen(false)
    setMessages([])
    setMessageInput('')
    setPosByDevice({
      desktop: { anchor: toAnchor(d.anchor), offsetX: d.offsetX, offsetY: d.offsetY },
      mobile: { anchor: toAnchor(m.anchor), offsetX: m.offsetX, offsetY: m.offsetY },
    })
    // The current device is kept — its baseline positioning is restored.
  }, [baselineSnapshot, entitlements])

  // ---- Preview derivation (canonical catalogs + shared geometry) ----

  const pv = previewStrings(view.locale)
  const dir: 'rtl' | 'ltr' = view.locale === 'fa' ? 'rtl' : 'ltr'
  const showBranding = isLocked // Free plan: "Powered by Sukhan" (CUST-F contract)
  const surface = view.device === 'mobile' ? SURFACE_SIZES.mobile : SURFACE_SIZES.desktop
  const panelPref = view.device === 'mobile' ? PANEL_PREFERRED.mobile : PANEL_PREFERRED.desktop
  const dims = launcherDims(view.shape)

  // Effective geometry viewport = the ACTUAL rendered surface, clamped to
  // the nominal design size (the CSS `width` never exceeds it) and floored
  // at 0. Until the first ResizeObserver observation lands (or under SSR),
  // fall back to the nominal design size. The `Math.min(measured, nominal)`
  // clamp also protects against a stale reading from the previous device
  // widening the viewport past the current design size, and the `Math.max`
  // floor guarantees a finite, non-negative width even for a zero-size
  // surface (no NaN, no negative panel width, no clipping).
  const effectiveW = measuredSize ? Math.max(0, Math.min(measuredSize.w, surface.w)) : surface.w
  const effectiveH = measuredSize ? Math.max(0, Math.min(measuredSize.h, surface.h)) : surface.h

  const greetingText =
    effectiveConfig?.greetingTexts?.[view.locale] ||
    (view.locale === 'fa' ? 'سلام! چطور می‌تونم کمکتون کنم؟' : 'Hi there! How can I help?')

  const palette = getPaletteById(view.paletteId) ?? COLOR_PALETTES[0]
  const tokens = palette.tokens
  // A paid custom-accent experiment overrides the accent token only —
  // the palette itself stays selected (data-playground-palette).
  const accent = view.customAccent ?? tokens.accent

  // Shared production geometry, bounded to the EFFECTIVE preview viewport
  // (the real rendered size, not the nominal design size). The Free
  // branding strip is reserved like a safe-area inset so the launcher
  // never overlaps it.
  const safeAreaBottom = showBranding ? BRANDING_STRIP : 0
  const launcherPos = computeLauncherPosition({
    anchor: toAnchor(view.anchor),
    offsetX: view.offsetX,
    offsetY: view.offsetY,
    dir,
    viewportWidth: effectiveW,
    viewportHeight: effectiveH,
    launcherWidth: dims.w,
    launcherHeight: dims.h,
    safeAreaBottom,
    baseMargin: BASE_MARGIN,
  })
  const panelV = computePanelVerticalPosition({
    rootBottom: launcherPos.bottom,
    launcherHeight: dims.h,
    viewportHeight: effectiveH,
    panelGap: PANEL_GAP,
    panelPreferredHeight: panelPref.h,
    safeAreaBottom,
  })
  // Preferred panel width clamped to the measured available width before
  // invoking the horizontal helper — the helper clamps internally too, this
  // is an explicit, defensive clamp so the preferred size can never exceed
  // the real surface (keeps the panel inside the visible preview bounds).
  const panelPreferredWidth = Math.min(panelPref.w, Math.max(0, effectiveW - VIEWPORT_MARGIN * 2))
  const panelHPos = computePanelHorizontalPosition({
    launcherLeft: launcherPos.left,
    launcherWidth: dims.w,
    panelPreferredWidth,
    viewportWidth: effectiveW,
    panelSide: launcherPos.panelSide,
    viewportMargin: VIEWPORT_MARGIN,
  })
  const panelHeight = Math.min(panelPref.h, panelV.maxHeight)

  // Greeting teaser (chat closed): floats just above the launcher, aligned
  // to the launcher's side of the surface (physical left/right), clamped so
  // the bubble always stays inside the effective preview viewport.
  const onLeftHalf = launcherPos.left + dims.w / 2 < effectiveW / 2
  const teaserStyle: CSSProperties = {
    bottom: launcherPos.bottom + dims.h + 8,
    background: tokens.panelBg,
    color: tokens.panelText,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    ...(onLeftHalf
      ? { left: Math.max(8, Math.min(launcherPos.left, effectiveW - 196)) }
      : { right: Math.max(8, Math.min(effectiveW - launcherPos.left - dims.w, effectiveW - 196)) }),
  }

  const selectClass =
    'h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'

  const anchorLabels: Record<string, string> = {
    'bottom-start': t('playground.anchorBottomStart'),
    'bottom-end': t('playground.anchorBottomEnd'),
    'bottom-center': t('playground.anchorBottomCenter'),
  }
  const shapeLabels: Record<string, string> = {
    tab: t('playground.shapeTab'),
    rounded: t('playground.shapeRounded'),
    pill: t('playground.shapePill'),
  }

  return (
    <Card data-testid="playground-panel">
      <CardHeader>
        <CardTitle className="font-display text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-saffron" aria-hidden="true" />
          {t('playground.title')}
        </CardTitle>
        <CardDescription>{t('playground.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Non-live disclosure — the playground is a local simulation. */}
        <div
          data-testid="playground-not-live"
          className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-500/5 p-3"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-muted-foreground">{t('playground.notLive')}</p>
        </div>

        {!caps.enabled ? (
          // Unknown/invalid plan — fail closed: no usable options.
          <p className="text-sm text-muted-foreground">{t('playground.unavailable')}</p>
        ) : (
          <>
            {/* Device + simulation-locale switchers */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-1.5" role="group" aria-label={t('playground.device')}>
                <Monitor className="me-1 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <button
                  type="button"
                  data-testid="playground-device-desktop"
                  onClick={() => setDevice('desktop')}
                  aria-pressed={view.device === 'desktop'}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                    view.device === 'desktop'
                      ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('playground.desktop')}
                </button>
                <button
                  type="button"
                  data-testid="playground-device-mobile"
                  onClick={() => setDevice('mobile')}
                  aria-pressed={view.device === 'mobile'}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                    view.device === 'mobile'
                      ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('playground.mobile')}
                </button>
              </div>
              <div className="flex items-center gap-1.5" role="group" aria-label={t('playground.language')}>
                <Languages className="me-1 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <button
                  type="button"
                  data-testid="playground-locale-fa"
                  onClick={() => setLocale('fa')}
                  aria-pressed={view.locale === 'fa'}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                    view.locale === 'fa'
                      ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  فارسی
                </button>
                <button
                  type="button"
                  data-testid="playground-locale-en"
                  onClick={() => setLocale('en')}
                  aria-pressed={view.locale === 'en'}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                    view.locale === 'en'
                      ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  English
                </button>
              </div>
            </div>

            {/* Anchor / palette / shape — native selects for keyboard + automation */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="playground-anchor" className="text-sm">
                  {t('playground.anchor')}
                </Label>
                <select
                  id="playground-anchor"
                  data-testid="playground-anchor"
                  value={view.anchor}
                  onChange={(e) => commitPos({ anchor: e.target.value as PositioningAnchor })}
                  className={selectClass}
                >
                  {caps.anchors.map((a) => (
                    <option key={a} value={a}>
                      {anchorLabels[a] ?? a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playground-palette" className="text-sm">
                  {t('playground.palette')}
                </Label>
                <select
                  id="playground-palette"
                  data-testid="playground-palette"
                  value={view.paletteId}
                  onChange={(e) => setPaletteId(e.target.value)}
                  className={selectClass}
                >
                  {caps.paletteIds.map((id) => (
                    <option key={id} value={id}>
                      {getPaletteById(id)?.name ?? id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playground-shape" className="text-sm">
                  {t('playground.shape')}
                </Label>
                <select
                  id="playground-shape"
                  data-testid="playground-shape"
                  value={view.shape}
                  onChange={(e) => setShape(e.target.value as PlaygroundShape)}
                  className={selectClass}
                >
                  {caps.launcherShapes.map((s) => (
                    <option key={s} value={s}>
                      {shapeLabels[s] ?? s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Precise offsets + custom accent — paid experiments only */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="playground-offset-x" className="text-sm">
                  {t('playground.offsetX')}
                </Label>
                <input
                  id="playground-offset-x"
                  type="number"
                  data-testid="playground-offset-x"
                  value={String(view.offsetX)}
                  min={OFFSET_MIN}
                  max={OFFSET_MAX}
                  step={1}
                  disabled={!caps.precisePositioning}
                  onChange={(e) => onOffsetXChange(e.target.value)}
                  className={cn(selectClass, 'font-mono')}
                />
                {!caps.precisePositioning && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    {t('playground.paidOnly')}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playground-offset-y" className="text-sm">
                  {t('playground.offsetY')}
                </Label>
                <input
                  id="playground-offset-y"
                  type="number"
                  data-testid="playground-offset-y"
                  value={String(view.offsetY)}
                  min={OFFSET_MIN}
                  max={OFFSET_MAX}
                  step={1}
                  disabled={!caps.precisePositioning}
                  onChange={(e) => onOffsetYChange(e.target.value)}
                  className={cn(selectClass, 'font-mono')}
                />
                {!caps.precisePositioning && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    {t('playground.paidOnly')}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="playground-custom-accent" className="text-sm">
                  {t('playground.customAccent')}
                </Label>
                <input
                  id="playground-custom-accent"
                  type="text"
                  data-testid="playground-custom-accent"
                  value={accentRaw}
                  placeholder="#RRGGBB"
                  maxLength={7}
                  disabled={!caps.customColors}
                  onChange={(e) => setAccentRaw(e.target.value)}
                  className={cn(selectClass, 'font-mono')}
                />
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {!caps.customColors && <Lock className="h-3 w-3" aria-hidden="true" />}
                  {caps.customColors ? t('playground.customAccentHint') : t('playground.paidOnly')}
                </p>
              </div>
            </div>

            {/* Reset — restores the server-effective baseline */}
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={reset} data-testid="playground-reset" className="gap-2">
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t('playground.reset')}
              </Button>
              <span className="text-[11px] text-muted-foreground">{t('playground.simulationNote')}</span>
            </div>

            {/* ---------------- Preview surface (bounded simulation) ---------------- */}
            <div
              ref={surfaceRef}
              data-testid="playground-surface"
              data-playground-device={view.device}
              data-playground-palette={view.paletteId}
              data-playground-custom-accent={view.customAccent ?? undefined}
              dir={dir}
              className="relative mx-auto overflow-hidden rounded-xl border border-border bg-neutral-100"
              style={{ width: surface.w, height: surface.h, maxWidth: '100%' }}
            >
              {/* Simulated browser chrome (decoration only) */}
              <div
                className="absolute inset-x-0 top-0 z-10 flex h-7 items-center gap-1.5 border-b border-black/5 bg-white/80 px-3"
                aria-hidden="true"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                <span className="ms-2 truncate text-[10px] text-neutral-400">{pv.chromeHint}</span>
              </div>

              {/* Greeting teaser — visible while the chat is closed */}
              {!view.open && (
                <div
                  data-testid="playground-greeting"
                  className="absolute z-10 max-w-[188px] rounded-2xl px-3 py-2 text-xs"
                  style={teaserStyle}
                >
                  {greetingText}
                </div>
              )}

              {/* Simulated launcher */}
              <button
                type="button"
                data-testid="playground-launcher"
                data-playground-shape={view.shape}
                aria-label={pv.launcherLabel}
                aria-expanded={view.open}
                onClick={() => setOpen((o) => !o)}
                className="absolute z-10 flex cursor-pointer items-center justify-center border-none p-0 shadow-lg transition-transform hover:scale-105"
                style={{
                  left: launcherPos.left,
                  bottom: launcherPos.bottom,
                  width: dims.w,
                  height: dims.h,
                  background: tokens.launcherBg,
                  color: tokens.launcherFg,
                  borderRadius: launcherRadius(view.shape),
                  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                }}
              >
                <MessageSquare style={{ width: 22, height: 22 }} aria-hidden="true" />
              </button>

              {/* Simulated chat panel — rendered only while opened */}
              {view.open && (
                <div
                  data-testid="playground-chat"
                  className="absolute z-20 flex flex-col overflow-hidden"
                  style={{
                    left: launcherPos.left + panelHPos.left,
                    bottom: launcherPos.bottom + panelV.bottom,
                    width: panelHPos.width,
                    height: panelHeight,
                    background: tokens.panelBg,
                    borderRadius: '16px',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
                  }}
                >
                  {/* Header */}
                  <div
                    className="flex shrink-0 items-center gap-2.5 px-4 py-3"
                    style={{ background: tokens.headerBg, color: tokens.headerText }}
                  >
                    <div
                      className="flex h-7 w-7 items-center justify-center rounded-full"
                      style={{ background: 'rgba(255,255,255,.25)' }}
                      aria-hidden="true"
                    >
                      <MessageSquare style={{ width: 16, height: 16 }} aria-hidden="true" />
                    </div>
                    <div className="flex-1 text-sm font-semibold">{pv.chatTitle}</div>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      aria-label={pv.closeLabel}
                      className="cursor-pointer border-none bg-transparent p-0 text-xl leading-none"
                      style={{ color: tokens.headerText }}
                    >
                      ×
                    </button>
                  </div>

                  {/* Transcript */}
                  <div
                    className="flex flex-1 flex-col gap-2 overflow-y-auto p-4"
                    style={{ background: tokens.panelBg }}
                  >
                    {/* Greeting (system-style) — the single playground-greeting
                        element while the chat is open. */}
                    <div data-testid="playground-greeting" className="self-center py-1 text-[11px]" style={{ color: '#888' }}>
                      {greetingText}
                    </div>
                    {/* Sample agent + visitor bubbles (static demonstration) */}
                    <div
                      className="max-w-[75%] self-start break-words px-3 py-2 text-[13px]"
                      style={{
                        background: tokens.agentBubbleBg,
                        color: tokens.agentBubbleText,
                        borderRadius: '12px 12px 12px 4px',
                      }}
                    >
                      {pv.sampleAgent}
                    </div>
                    <div
                      className="max-w-[75%] self-end break-words px-3 py-2 text-[13px]"
                      style={{
                        background: tokens.visitorBubbleBg,
                        color: tokens.visitorBubbleText,
                        borderRadius: '12px 12px 4px 12px',
                      }}
                    >
                      {pv.sampleVisitor}
                    </div>
                    {/* Local simulated messages — React TEXT rendering only
                        (never innerHTML): HTML payloads display literally. */}
                    {messages.map((m, i) => (
                      <div
                        key={i}
                        data-testid="playground-message"
                        className="max-w-[75%] self-end break-words px-3 py-2 text-[13px]"
                        style={{
                          background: tokens.visitorBubbleBg,
                          color: tokens.visitorBubbleText,
                          borderRadius: '12px 12px 4px 12px',
                        }}
                      >
                        {m}
                      </div>
                    ))}
                  </div>

                  {/* Composer — local state only; Send never calls a backend */}
                  <div
                    className="flex shrink-0 gap-2 p-2.5"
                    style={{ background: tokens.panelBg, borderTop: '1px solid rgba(0,0,0,.06)' }}
                  >
                    <input
                      type="text"
                      data-testid="playground-message-input"
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          send()
                        }
                      }}
                      placeholder={pv.placeholder}
                      className="h-8 flex-1 rounded-lg border-none px-3 text-[13px] outline-none"
                      style={{ background: 'rgba(0,0,0,.04)', color: tokens.panelText }}
                    />
                    <button
                      type="button"
                      data-testid="playground-send"
                      onClick={send}
                      aria-label={pv.sendLabel}
                      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none text-white"
                      style={{ background: accent }}
                    >
                      <Send style={{ width: 14, height: 14 }} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}

              {/* Free-plan branding strip (CUST-F) — outside the chat panel so
                  it is visible in the closed state too. The launcher's safe
                  area keeps it uncovered. */}
              {showBranding && (
                <div
                  data-testid="playground-branding"
                  className="absolute inset-x-0 bottom-0 z-0 flex items-center justify-center bg-white/85 text-[10px] text-neutral-400"
                  style={{ height: BRANDING_STRIP }}
                >
                  {pv.poweredBy}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
