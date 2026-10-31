'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Palette, Lock, RotateCcw, AlertCircle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  COLOR_PALETTES,
  COLOR_TOKEN_NAMES,
  DEFAULT_PALETTE_ID,
  DEFAULT_COLOR_TOKENS,
  getPaletteById,
  isValidColor,
  meetsContrastAA,
  contrastRatio,
  type ColorTokens,
  type ColorTokenName,
} from '@/lib/widget/color-palettes'

/**
 * Color entitlements from the server.
 */
interface ColorEntitlements {
  presetColors: boolean
  customColors: boolean
}

/**
 * Effective color theme — what the widget actually renders.
 * The `tokens` field is typed as a plain record because it comes from the
 * untyped JSON API response; we narrow to `ColorTokens` at use sites.
 */
interface EffectiveColorTheme {
  mode: 'preset' | 'custom'
  presetId?: string
  tokens: Record<string, string>
}

/**
 * Stored color theme — raw stored values (may include paid custom tokens
 * even on Free, preserved for upgrade restore).
 */
interface StoredColorTheme {
  mode: 'preset' | 'custom'
  presetId?: string
  custom?: Record<string, string>
}

/**
 * The colors data returned by GET /api/widget-config.
 */
interface ColorsData {
  entitlements: ColorEntitlements
  /** null when the widget runtime uses pre-V2 hardcoded colors (Free without V2 selection). */
  effective: EffectiveColorTheme | null
  stored: StoredColorTheme | null
}

/**
 * Draft color theme — the user's edits before save.
 * `null` means "no edits yet" (matches stored=null → use effective preview).
 */
interface DraftColors {
  mode: 'preset' | 'custom'
  presetId?: string
  custom?: ColorTokens
}

interface WidgetColorsPanelProps {
  slug: string
  colors: ColorsData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

/**
 * Foreground/background pairs to check for WCAG AA contrast.
 * Each pair is [fgToken, bgToken, isLargeText].
 */
const CONTRAST_PAIRS: ReadonlyArray<[ColorTokenName, ColorTokenName, boolean]> = [
  ['launcherFg', 'launcherBg', true],   // launcher icon — large UI element
  ['headerText', 'headerBg', false],    // header text — body text
  ['panelText', 'panelBg', false],      // panel body text
  ['visitorBubbleText', 'visitorBubbleBg', false],
  ['agentBubbleText', 'agentBubbleBg', false],
]

/**
 * The pre-V2 hardcoded widget colors. When the dashboard's `colors.effective`
 * is null (Free without V2 color selection), the widget runtime uses these
 * hardcoded colors. The preview must show these to match the deployed widget.
 */
const LEGACY_COLOR_TOKENS: ColorTokens = {
  accent: '#E09A2B',
  launcherBg: '#0E1116',
  launcherFg: '#FAF7F2',
  headerBg: '#E09A2B',
  headerText: '#FFFFFF',
  panelBg: '#FFFFFF',
  panelText: '#0E1116',
  visitorBubbleBg: '#0E1116',
  visitorBubbleText: '#FAF7F2',
  agentBubbleBg: '#FFFFFF',
  agentBubbleText: '#0E1116',
}

/**
 * Convert a token name to a translation key under `settings.colors.tokens`.
 */
function tokenLabelKey(name: ColorTokenName): string {
  return `colors.tokens.${name}` as const
}

/**
 * Normalize a loose record (from the untyped JSON API response) into a
 * complete `ColorTokens` object. Missing or non-string keys are filled
 * with the corresponding default palette value, so the preview always has
 * a complete set of tokens even if the server payload is partial.
 */
function normalizeTokens(input: Record<string, string> | undefined | null): ColorTokens {
  const base = { ...DEFAULT_COLOR_TOKENS }
  if (!input) return base
  for (const name of COLOR_TOKEN_NAMES) {
    const v = input[name]
    if (typeof v === 'string' && isValidColor(v)) {
      base[name] = v
    }
  }
  return base
}

export function WidgetColorsPanel({
  slug,
  colors,
  defaultDirection,
  onReload,
}: WidgetColorsPanelProps) {
  const t = useTranslations('settings')
  const locale = useLocale()
  const fa = locale === 'fa'

  const [draft, setDraft] = useState<DraftColors | null>(null)
  const [saving, setSaving] = useState(false)

  // Initialize draft when colors data loads.
  useEffect(() => {
    if (!colors) return
    /* eslint-disable react-hooks/set-state-in-effect */
    if (colors.stored) {
      setDraft({
        mode: colors.stored.mode,
        presetId: colors.stored.presetId,
        custom: colors.stored.custom ? normalizeTokens(colors.stored.custom) : undefined,
      })
    } else {
      // Stored is null → draft is null (matches positioning panel pattern).
      // The preview falls back to `colors.effective`.
      setDraft(null)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [colors])

  const entitlements = colors?.entitlements ?? { presetColors: false, customColors: false }
  const canPreset = entitlements.presetColors
  const canCustom = entitlements.customColors

  // The selected mode + preset for display (falls back to effective when no draft).
  // When `colors.effective` is null (Free without V2 → legacy runtime), the
  // mode is 'preset' with no presetId (showing the legacy appearance).
  const selectedMode: 'preset' | 'custom' = draft?.mode ?? colors?.effective?.mode ?? 'preset'
  const selectedPresetId: string = draft?.presetId ?? colors?.effective?.presetId ?? DEFAULT_PALETTE_ID

  // The tokens to render in the preview.
  const previewTokens: ColorTokens = useMemo(() => {
    if (draft?.mode === 'custom' && draft.custom) {
      return draft.custom
    }
    // Preset mode (draft or effective): look up the palette.
    const presetId = draft?.mode === 'preset' ? draft.presetId : colors?.effective?.presetId
    if (presetId) {
      const p = getPaletteById(presetId)
      if (p) return p.tokens
    }
    // Fall back to effective tokens (normalized to a complete ColorTokens).
    if (colors?.effective?.tokens) {
      return normalizeTokens(colors.effective.tokens)
    }
    // No V2 effective colors (Free without V2 selection) → use the pre-V2
    // legacy colors so the preview matches the deployed widget.
    return LEGACY_COLOR_TOKENS
  }, [draft, colors])

  // Dirty detection: compare draft to stored (canonical).
  const isDirty = (() => {
    if (!colors) return false
    const d = draft
    const s = colors.stored
    // Both null → not dirty.
    if (!d && !s) return false
    // One null, other non-null → dirty.
    if (!d || !s) return true
    // Both non-null → compare mode + preset/custom.
    if (d.mode !== s.mode) return true
    if (d.mode === 'preset') {
      if (d.presetId !== s.presetId) return true
    } else {
      // mode === 'custom'
      const dc = d.custom
      const sc = s.custom
      if (!dc || !sc) return true // shouldn't happen — defensive
      for (const name of COLOR_TOKEN_NAMES) {
        if (dc[name] !== sc[name]) return true
      }
    }
    return false
  })()

  // Select a palette (preset mode).
  const selectPalette = useCallback((presetId: string) => {
    if (!canPreset) return
    setDraft({ mode: 'preset', presetId })
  }, [canPreset])

  // Switch to custom mode (paid only). Seed custom tokens from the current
  // preview tokens so the user starts from a sensible state.
  const enableCustom = useCallback(() => {
    if (!canCustom) return
    setDraft((prev) => ({
      mode: 'custom',
      custom: prev?.custom ? { ...prev.custom } : { ...previewTokens },
    }))
  }, [canCustom, previewTokens])

  // Switch back to preset mode (keep the last selected preset).
  const disableCustom = useCallback(() => {
    setDraft((prev) => ({
      mode: 'preset',
      presetId: prev?.presetId ?? selectedPresetId,
    }))
  }, [selectedPresetId])

  // Update a single custom token (paid only).
  const setToken = useCallback((name: ColorTokenName, value: string) => {
    if (!canCustom) return
    // Always store the raw value; validation is surfaced separately so the
    // user can type freely and see inline warnings.
    setDraft((prev) => {
      const base: ColorTokens = prev?.custom ? { ...prev.custom } : { ...previewTokens }
      base[name] = value
      return { mode: 'custom', custom: base }
    })
  }, [canCustom, previewTokens])

  // Reset: switch back to preset mode (keeps current preset selection).
  const resetToPalette = useCallback(() => {
    setDraft({ mode: 'preset', presetId: selectedPresetId })
  }, [selectedPresetId])

  // Save colors.
  const save = useCallback(async () => {
    if (!draft) return
    if (!canPreset) return
    // Validate custom tokens before sending (paid only).
    if (draft.mode === 'custom') {
      if (!canCustom) return
      if (!draft.custom) return
      for (const name of COLOR_TOKEN_NAMES) {
        if (!isValidColor(draft.custom[name])) {
          toast.error(t('colors.invalidColor'))
          return
        }
      }
    } else {
      // Preset mode — presetId required.
      if (!draft.presetId) return
    }

    setSaving(true)
    try {
      const colorsBody: Record<string, unknown> = { mode: draft.mode }
      if (draft.mode === 'preset') {
        colorsBody.presetId = draft.presetId
      } else {
        colorsBody.custom = draft.custom
      }
      const patchBody = { colors: colorsBody }

      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg =
          data.error === 'customization_locked'
            ? t('customizationLockedHint')
            : data.error === 'colors_not_authorized'
              ? t('customizationLockedHint')
              : data.error === 'colors_custom_not_allowed'
                ? t('colors.customLocked')
                : data.error === 'colors_custom_invalid'
                  ? t('colors.invalidColor')
                  : t('colors.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('colors.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('colors.saveFail'))
      setSaving(false)
    }
  }, [draft, canPreset, canCustom, t, onReload])

  // Discard: reset draft to stored.
  const discard = useCallback(() => {
    if (!colors) return
    if (colors.stored) {
      setDraft({
        mode: colors.stored.mode,
        presetId: colors.stored.presetId,
        custom: colors.stored.custom ? normalizeTokens(colors.stored.custom) : undefined,
      })
    } else {
      setDraft(null)
    }
  }, [colors])

  if (!canPreset) {
    return (
      <Card data-testid="colors-locked" className="border-amber-600/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 p-4">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t('colors.customLockedTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('customizationLockedHint')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Compute contrast warnings for custom mode.
  const contrastWarnings: Array<{ token: ColorTokenName; ratio: number }> = []
  if (draft?.mode === 'custom' && draft.custom) {
    for (const [fg, bg, large] of CONTRAST_PAIRS) {
      const fgVal = draft.custom[fg]
      const bgVal = draft.custom[bg]
      if (isValidColor(fgVal) && isValidColor(bgVal)) {
        if (!meetsContrastAA(fgVal, bgVal, large)) {
          contrastWarnings.push({ token: fg, ratio: contrastRatio(fgVal, bgVal) })
        }
      }
    }
  }

  // Whether any custom token is currently invalid (typed but not a valid hex).
  const hasInvalidCustom = (() => {
    if (draft?.mode !== 'custom' || !draft.custom) return false
    for (const name of COLOR_TOKEN_NAMES) {
      if (!isValidColor(draft.custom[name])) return true
    }
    return false
  })()

  return (
    <Card data-testid="colors-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Palette className="h-4 w-4 text-saffron" />
              {t('colors.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('colors.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('colors.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Preset / Custom toggle */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
            <button
              onClick={disableCustom}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                selectedMode === 'preset'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid="colors-mode-preset"
            >
              {t('colors.preset')}
            </button>
            <button
              onClick={canCustom ? enableCustom : undefined}
              disabled={!canCustom}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                selectedMode === 'custom'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
                !canCustom && 'cursor-not-allowed opacity-50',
              )}
              data-testid="colors-custom-toggle"
            >
              {!canCustom && <Lock className="h-3 w-3" />}
              {t('colors.custom')}
            </button>
          </div>

          {/* Paid custom toggle (alt control: a Switch) — only enabled for paid plans */}
          {canCustom && (
            <div className="flex items-center gap-2">
              <Switch
                checked={selectedMode === 'custom'}
                onCheckedChange={(checked) => (checked ? enableCustom() : disableCustom())}
                aria-label={t('colors.custom')}
                data-testid="colors-custom-switch"
              />
              <span className="text-xs text-muted-foreground">
                {selectedMode === 'custom' ? t('colors.custom') : t('colors.preset')}
              </span>
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2" dir={defaultDirection}>
          {/* Controls */}
          <div className="space-y-4">
            {/* Palette grid (shown for preset mode and as a backdrop for custom) */}
            {selectedMode === 'preset' && (
              <div className="space-y-2">
                <Label className="text-xs">{t('colors.preset')}</Label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-96 overflow-y-auto scroll-thin p-1">
                  {COLOR_PALETTES.map((p) => {
                    const selected = selectedPresetId === p.id && selectedMode === 'preset'
                    return (
                      <button
                        key={p.id}
                        onClick={() => selectPalette(p.id)}
                        className={cn(
                          'flex flex-col gap-1.5 rounded-lg border p-2 text-xs font-medium transition-colors',
                          selected
                            ? 'border-saffron bg-saffron/10 text-foreground'
                            : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                        )}
                        data-testid={`colors-palette-${p.id}`}
                        aria-pressed={selected}
                      >
                        {/* Mini preview: 4 dots — accent, launcherBg, headerBg, panelBg */}
                        <div className="flex gap-1">
                          <span
                            className="h-4 w-4 rounded-full border border-black/10"
                            style={{ backgroundColor: p.tokens.accent }}
                          />
                          <span
                            className="h-4 w-4 rounded-full border border-black/10"
                            style={{ backgroundColor: p.tokens.launcherBg }}
                          />
                          <span
                            className="h-4 w-4 rounded-full border border-black/10"
                            style={{ backgroundColor: p.tokens.headerBg }}
                          />
                          <span
                            className="h-4 w-4 rounded-full border border-black/10"
                            style={{ backgroundColor: p.tokens.panelBg }}
                          />
                        </div>
                        <span className="truncate">{p.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Custom tokens editor (paid only) */}
            {selectedMode === 'custom' && canCustom ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{t('colors.custom')}</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetToPalette}
                    className="gap-1 text-xs"
                    data-testid="colors-reset"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('colors.reset')}
                  </Button>
                </div>

                {/* Contrast warnings */}
                {contrastWarnings.length > 0 && (
                  <div className="rounded-lg border border-amber-600/40 bg-amber-500/5 p-2 space-y-1">
                    {contrastWarnings.map((w) => (
                      <div
                        key={w.token}
                        className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400"
                      >
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        <span>
                          {t(tokenLabelKey(w.token) as any)} — {w.ratio.toFixed(2)}:1
                        </span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{t('colors.contrastWarning')}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[28rem] overflow-y-auto scroll-thin p-1">
                  {COLOR_TOKEN_NAMES.map((name) => {
                    const value = draft?.custom?.[name] ?? ''
                    const valid = isValidColor(value)
                    return (
                      <div key={name} className="space-y-1">
                        <Label className="text-xs">{t(tokenLabelKey(name) as any)}</Label>
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={valid ? value : '#000000'}
                            onChange={(e) => setToken(name, e.target.value.toUpperCase())}
                            className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent"
                            data-testid={`colors-token-${name}-picker`}
                            aria-label={t(tokenLabelKey(name) as any)}
                          />
                          <Input
                            value={value}
                            onChange={(e) => setToken(name, e.target.value)}
                            placeholder="#RRGGBB"
                            dir="ltr"
                            className={cn(
                              'flex-1 font-mono text-xs',
                              !valid && 'border-destructive/60 focus-visible:ring-destructive/30',
                            )}
                            data-testid={`colors-token-${name}-input`}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {hasInvalidCustom && (
                  <p className="text-xs text-destructive flex items-center gap-1.5">
                    <AlertCircle className="h-3 w-3" />
                    {t('colors.invalidColor')}
                  </p>
                )}
              </div>
            ) : selectedMode === 'custom' && !canCustom ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" />
                  {t('colors.customLocked')}
                </div>
              </div>
            ) : null}

            {/* Save / Discard */}
            <div className="flex gap-2">
              <Button
                onClick={save}
                disabled={saving || !isDirty || hasInvalidCustom}
                className="flex-1 gap-2"
                data-testid="colors-save"
              >
                {saving ? '...' : t('colors.save')}
              </Button>
              <Button
                variant="outline"
                onClick={discard}
                disabled={saving || !isDirty}
                data-testid="colors-discard"
              >
                {t('colors.discard')}
              </Button>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label className="text-xs">{t('colors.preview')}</Label>
            <div
              className="relative overflow-hidden rounded-xl border border-border shadow-inner"
              style={{ backgroundColor: previewTokens.panelBg }}
              dir={defaultDirection}
            >
              {/* Simulated site page (subtle, behind the widget) */}
              <div className="absolute inset-0 opacity-[0.06] pointer-events-none">
                <div className="h-2 w-1/2 rounded bg-current" />
                <div className="mt-1.5 h-2 w-1/3 rounded bg-current" />
                <div className="mt-3 h-16 w-full rounded bg-current" />
              </div>

              {/* Mini widget: launcher at bottom-end */}
              <button
                type="button"
                className="absolute end-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-full shadow-lg"
                style={{
                  backgroundColor: previewTokens.launcherBg,
                  color: previewTokens.launcherFg,
                }}
                data-testid="colors-preview-launcher"
                aria-label={t('colors.previewLauncher')}
              >
                <svg
                  width="50%"
                  height="50%"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>

              {/* Mini widget: chat panel (above the launcher) */}
              <div
                className="absolute end-3 bottom-14 w-48 rounded-xl border border-black/10 shadow-xl overflow-hidden"
                style={{ backgroundColor: previewTokens.panelBg }}
                data-testid="colors-preview-panel"
              >
                {/* Header */}
                <div
                  className="flex items-center gap-2 p-2"
                  style={{
                    backgroundColor: previewTokens.headerBg,
                    color: previewTokens.headerText,
                  }}
                  data-testid="colors-preview-header"
                >
                  <span
                    className="h-4 w-4 rounded-full"
                    style={{ backgroundColor: previewTokens.accent }}
                  />
                  <span className="text-[10px] font-semibold truncate">
                    {t('colors.previewHeader')}
                  </span>
                </div>
                {/* Body — visitor + agent bubbles */}
                <div className="flex flex-col gap-1.5 p-2" style={{ color: previewTokens.panelText }}>
                  <div
                    className="max-w-[80%] self-start rounded-lg rounded-bs-sm px-2 py-1 text-[9px]"
                    style={{
                      backgroundColor: previewTokens.visitorBubbleBg,
                      color: previewTokens.visitorBubbleText,
                    }}
                    data-testid="colors-preview-visitor-bubble"
                  >
                    {fa ? 'سلام!' : 'Hi!'}
                  </div>
                  <div
                    className="max-w-[80%] self-end rounded-lg rounded-be-sm px-2 py-1 text-[9px]"
                    style={{
                      backgroundColor: previewTokens.agentBubbleBg,
                      color: previewTokens.agentBubbleText,
                    }}
                    data-testid="colors-preview-agent-bubble"
                  >
                    {fa ? 'سلام، چطور می‌تونم کمک کنم؟' : 'Hello, how can I help?'}
                  </div>
                </div>
              </div>

              {/* Token swatch strip (subtle, at the very bottom) */}
              <div
                className="absolute inset-x-0 bottom-0 flex h-1 opacity-80"
                aria-hidden="true"
              >
                {COLOR_TOKEN_NAMES.map((name) => {
                  const v = previewTokens[name]
                  return (
                    <span
                      key={name}
                      className="flex-1"
                      style={{ backgroundColor: isValidColor(v) ? v : '#000000' }}
                    />
                  )
                })}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedMode === 'preset'
                ? (getPaletteById(selectedPresetId)?.name ?? selectedPresetId)
                : t('colors.custom')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
