'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Rocket, Lock, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  LAUNCHER_SHAPES,
  FREE_LAUNCHER_SHAPES,
  DEFAULT_LAUNCHER_SHAPE,
  isValidLauncherShape,
  type LauncherShape,
} from '@/lib/widget/effective-launcher'

/**
 * Launcher entitlements from the server.
 */
interface LauncherEntitlements {
  /** 'limited' (Free — tab + rounded) or 'all' (paid — tab + rounded + pill). */
  launcherSelection: 'limited' | 'all'
}

/**
 * Effective launcher — what the widget actually renders.
 */
interface EffectiveLauncher {
  shape: LauncherShape
}

/**
 * The launcher data returned by GET /api/widget-config.
 */
interface LauncherData {
  entitlements: LauncherEntitlements
  /** null when the widget runtime uses pre-V2 hardcoded shape (Free without V2 selection). */
  effective: EffectiveLauncher | null
  /** The raw stored V2 launcher shape (may include a paid-only shape on Free, preserved for upgrade restore). */
  stored: LauncherShape | null
}

interface WidgetLauncherPanelProps {
  slug: string
  launcher: LauncherData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

/**
 * The pre-V2 hardcoded launcher shape. When the dashboard's
 * `launcher.effective` is null (Free without V2 launcher selection), the
 * widget runtime uses this default. The preview must show this to match
 * the deployed widget.
 *
 * Matches `DEFAULT_LAUNCHER_SHAPE` in src/lib/widget/effective-launcher.ts
 * and the runtime fallback in packages/widget-npm/src/widget.ts
 * (`config.launcher?.shape || config.launcherShape || 'tab'`).
 */
const LEGACY_LAUNCHER_SHAPE: LauncherShape = DEFAULT_LAUNCHER_SHAPE

/**
 * Build the inline style for a launcher shape preview.
 *
 * Matches the runtime dimensions + border-radius from
 * packages/widget-npm/src/widget.ts:
 *   - tab:     60×52, border-radius:14px, border-bottom-start-radius:4px
 *   - rounded: 52×52, border-radius:16px
 *   - pill:    64×48, border-radius:999px
 *
 * The runtime uses the LOGICAL CSS property `border-bottom-start-radius`
 * for the 'tab' shape. In LTR, start=left; in RTL, start=right. We compute
 * the physical corner here so the preview matches the deployed widget in
 * both directions.
 *
 * Colors come from the pre-V2 hardcoded launcher tokens (matching the
 * `LEGACY_COLOR_TOKENS.launcherBg/launcherFg` in widget-colors-panel.tsx)
 * so the launcher preview matches the deployed widget's appearance.
 */
function launcherPreviewStyle(shape: LauncherShape, isRtl: boolean): React.CSSProperties {
  // Base colors — match the legacy hardcoded launcher colors.
  const base: React.CSSProperties = {
    backgroundColor: '#0E1116',
    color: '#FAF7F2',
  }
  if (shape === 'tab') {
    // border-radius:14px; border-bottom-start-radius:4px
    const startCorner = isRtl
      ? { borderBottomRightRadius: '4px' }
      : { borderBottomLeftRadius: '4px' }
    return {
      ...base,
      width: '60px',
      height: '52px',
      borderRadius: '14px',
      ...startCorner,
    }
  }
  if (shape === 'pill') {
    return {
      ...base,
      width: '64px',
      height: '48px',
      borderRadius: '999px',
    }
  }
  // rounded
  return {
    ...base,
    width: '52px',
    height: '52px',
    borderRadius: '16px',
  }
}

export function WidgetLauncherPanel({
  slug,
  launcher,
  defaultDirection,
  onReload,
}: WidgetLauncherPanelProps) {
  // `slug` is intentionally accepted for prop-shape parity with the
  // sibling positioning/colors panels; the dashboard works against the
  // current tenant via session, so it isn't used in the fetch.
  void slug

  const t = useTranslations('settings')
  const locale = useLocale()
  const fa = locale === 'fa'

  const [draft, setDraft] = useState<LauncherShape | null>(null)
  const [saving, setSaving] = useState(false)

  // Entitlement-aware draft initialization. Used by both useEffect (initial
  // load) and discard() (reset). When the plan is NOT entitled to a paid
  // shape (e.g., Free after downgrade from Pro with stored 'pill'), do NOT
  // initialize the draft from the stored paid shape — the preview must
  // reflect the authorized appearance. The stored paid shape remains for
  // upgrade restore (preserved in appearanceV2.launcher.paidShape).
  const buildAuthorizedDraft = useCallback(
    (launcherData: LauncherData | null): LauncherShape | null => {
      if (!launcherData || !launcherData.stored) return null
      const ent = launcherData.entitlements
      const canAll = ent.launcherSelection === 'all'
      // Free with stored paid-only shape ('pill') → do NOT load into draft.
      if (!canAll && !FREE_LAUNCHER_SHAPES.includes(launcherData.stored)) {
        return null
      }
      return launcherData.stored
    },
    [],
  )

  // Initialize draft when launcher data loads.
  useEffect(() => {
    if (!launcher) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraft(buildAuthorizedDraft(launcher))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [launcher, buildAuthorizedDraft])

  const entitlements = launcher?.entitlements ?? { launcherSelection: 'limited' as const }
  const canAll = entitlements.launcherSelection === 'all'

  // The shape to render in the preview.
  const previewShape: LauncherShape = useMemo(() => {
    // Draft overrides when present.
    if (draft) {
      // If the draft somehow holds a paid-only shape on a 'limited' plan,
      // fall back to the legacy default (matches the runtime behavior).
      // This is defensive — selectShape() prevents this from happening.
      if (!FREE_LAUNCHER_SHAPES.includes(draft) && !canAll) {
        return LEGACY_LAUNCHER_SHAPE
      }
      return draft
    }
    // No draft → use effective.
    if (launcher?.effective) {
      return launcher.effective.shape
    }
    // No effective (Free without V2 → legacy runtime).
    return LEGACY_LAUNCHER_SHAPE
  }, [draft, launcher, canAll])

  // Dirty detection: compare draft to the authorized representation of
  // stored launcher (not the raw stored values). When Free has stored
  // 'pill' but is not entitled to it, the authorized representation is
  // null (same as the initial draft), so the dirty state is false.
  const isDirty = (() => {
    if (!launcher) return false
    const d = draft
    const s = buildAuthorizedDraft(launcher)
    // Both null → not dirty.
    if (!d && !s) return false
    // One null, other non-null → dirty.
    if (!d || !s) return true
    // Both non-null → compare shapes.
    return d !== s
  })()

  // Select a shape (gated by entitlement).
  const selectShape = useCallback(
    (shape: LauncherShape) => {
      // Free can only select tab + rounded; pill is gated behind paid.
      if (!canAll && !FREE_LAUNCHER_SHAPES.includes(shape)) return
      setDraft(shape)
    },
    [canAll],
  )

  // Save launcher.
  const save = useCallback(async () => {
    if (!draft) return
    if (!isValidLauncherShape(draft)) {
      toast.error(t('launcher.invalidShape'))
      return
    }

    setSaving(true)
    try {
      // The PATCH body for launcher is: { launcher: { shape: 'tab' } }
      const patchBody = { launcher: { shape: draft } }

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
            : data.error === 'launcher_not_authorized'
              ? t('customizationLockedHint')
              : data.error === 'launcher_shape_not_allowed'
                ? t('launcher.locked')
                : data.error === 'launcher_shape_invalid' ||
                    data.error === 'launcher_shape_missing' ||
                    data.error === 'launcher_shape_not_allowed'
                  ? t('launcher.invalidShape')
                  : t('launcher.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('launcher.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('launcher.saveFail'))
      setSaving(false)
    }
  }, [draft, t, onReload])

  // Discard: reset draft to the authorized stored selection (not
  // unauthorized stored paid shape). Uses the same buildAuthorizedDraft
  // logic as initial load.
  const discard = useCallback(() => {
    setDraft(buildAuthorizedDraft(launcher))
  }, [launcher, buildAuthorizedDraft])

  return (
    <Card data-testid="launcher-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Rocket className="h-4 w-4 text-saffron" />
              {t('launcher.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('launcher.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('launcher.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2" dir={defaultDirection}>
          {/* Controls */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">{t('launcher.shape')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {LAUNCHER_SHAPES.map((shape) => {
                  const selected = previewShape === shape
                  const allowed = canAll || FREE_LAUNCHER_SHAPES.includes(shape)
                  return (
                    <button
                      key={shape}
                      onClick={allowed ? () => selectShape(shape) : undefined}
                      disabled={!allowed}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors',
                        selected
                          ? 'border-saffron bg-saffron/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                        !allowed && 'cursor-not-allowed opacity-60',
                      )}
                      data-testid={`launcher-shape-${shape}`}
                      aria-pressed={selected}
                      aria-disabled={!allowed}
                    >
                      {/* Mini shape preview */}
                      <span
                        aria-hidden="true"
                        className="block bg-ink"
                        style={launcherPreviewStyle(shape, fa)}
                      />
                      <span className="flex items-center gap-1">
                        {!allowed && <Lock className="h-3 w-3" />}
                        {t(`shapes.${shape}` as any)}
                      </span>
                    </button>
                  )
                })}
              </div>
              {!canAll && (
                <p className="text-xs text-muted-foreground">{t('launcher.upgradeHint')}</p>
              )}
            </div>

            {/* Save / Discard */}
            <div className="flex gap-2">
              <Button
                onClick={save}
                disabled={saving || !isDirty}
                className="flex-1 gap-2"
                data-testid="launcher-save"
              >
                {saving ? '...' : t('launcher.save')}
              </Button>
              <Button
                variant="outline"
                onClick={discard}
                disabled={saving || !isDirty}
                data-testid="launcher-discard"
              >
                {t('launcher.discard')}
              </Button>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label className="text-xs">{t('launcher.preview')}</Label>
            <div
              className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-muted/40 to-background"
              dir={defaultDirection}
              style={{ minHeight: '12rem' }}
              data-testid="launcher-preview-stage"
            >
              {/* Simulated site page (subtle, behind the widget) */}
              <div className="absolute inset-0 p-4 opacity-40 pointer-events-none">
                <div className="h-3 w-1/2 rounded bg-muted" />
                <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
                <div className="mt-4 h-20 w-full rounded bg-muted/60" />
              </div>

              {/* Mini widget: launcher at bottom-end — matches the runtime rendering */}
              <button
                type="button"
                aria-label={t('launcher.previewLabel')}
                data-testid="launcher-preview-button"
                className="absolute end-4 bottom-4 flex items-center justify-center shadow-lg transition-transform hover:scale-105"
                style={launcherPreviewStyle(previewShape, fa)}
              >
                <svg
                  width="40%"
                  height="40%"
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
            </div>
            <p className="text-xs text-muted-foreground">
              {t(`shapes.${previewShape}` as any)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
