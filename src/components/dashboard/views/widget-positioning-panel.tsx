'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Monitor, Smartphone, Lock, RotateCcw, Move, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  computeLauncherPosition,
  offsetXFromAbsoluteLeft,
  DEFAULT_BASE_MARGIN,
  OFFSET_MIN,
  OFFSET_MAX,
  type PositioningAnchor,
  type EffectivePositioning,
} from '@/lib/widget/positioning-geometry'

/**
 * Positioning entitlements from the server.
 */
interface PositioningEntitlements {
  presetPositioning: boolean
  precisePositioning: boolean
}

/**
 * Stored positioning for a device (may include paid offsets even for Free).
 */
interface StoredDevicePositioning {
  anchor: PositioningAnchor
  offsetX?: number
  offsetY?: number
}

/**
 * The positioning data returned by GET /api/widget-config.
 */
interface PositioningData {
  entitlements: PositioningEntitlements
  effective: {
    desktop: EffectivePositioning
    mobile: EffectivePositioning
  }
  stored: {
    desktop: StoredDevicePositioning | null
    mobile: StoredDevicePositioning | null
  }
}

const ANCHORS: PositioningAnchor[] = ['bottom-start', 'bottom-end', 'bottom-center']

/** Preview dimensions (simulated viewport). */
const PREVIEW_DESKTOP = { width: 600, height: 320 }
const PREVIEW_MOBILE = { width: 280, height: 400 }
const LAUNCHER_DIMS = { width: 52, height: 52 }

interface WidgetPositioningPanelProps {
  slug: string
  positioning: PositioningData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

export function WidgetPositioningPanel({
  slug,
  positioning,
  defaultDirection,
  onReload,
}: WidgetPositioningPanelProps) {
  const t = useTranslations('settings')
  const locale = useLocale()
  const fa = locale === 'fa'

  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Draft state: the user's edits (before save). Initialized from stored.
  // Each device has its own draft anchor + offsets.
  const [draftDesktop, setDraftDesktop] = useState<StoredDevicePositioning | null>(null)
  const [draftMobile, setDraftMobile] = useState<StoredDevicePositioning | null>(null)

  // Refs for drag handling.
  const previewRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ startX: number; startY: number; startLeft: number; startBottom: number } | null>(null)

  // Initialize drafts when positioning data loads.
  useEffect(() => {
    if (!positioning) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraftDesktop(positioning.stored.desktop ? { ...positioning.stored.desktop } : null)
    setDraftMobile(positioning.stored.mobile ? { ...positioning.stored.mobile } : null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [positioning])

  // Get the current draft for the selected device.
  const currentDraft = device === 'desktop' ? draftDesktop : draftMobile
  const setCurrentDraft = device === 'desktop' ? setDraftDesktop : setDraftMobile

  // Get the effective positioning for the selected device (what the widget renders).
  const effective = positioning?.effective[device] ?? { anchor: 'bottom-end' as PositioningAnchor, offsetX: 0, offsetY: 0 }

  const entitlements = positioning?.entitlements ?? { presetPositioning: false, precisePositioning: false }
  const canPosition = entitlements.presetPositioning
  const canOffset = entitlements.precisePositioning

  // The anchor to display in the preview: use the draft if editing, else effective.
  const previewAnchor = currentDraft?.anchor ?? effective.anchor
  const previewOffsetX = canOffset ? (currentDraft?.offsetX ?? 0) : 0
  const previewOffsetY = canOffset ? (currentDraft?.offsetY ?? 0) : 0

  // Preview dimensions based on device.
  const previewDims = device === 'desktop' ? PREVIEW_DESKTOP : PREVIEW_MOBILE
  const dir = defaultDirection

  // Compute the launcher position in the preview using the SAME geometry as production.
  const previewPos = computeLauncherPosition({
    anchor: previewAnchor,
    offsetX: previewOffsetX,
    offsetY: previewOffsetY,
    dir,
    viewportWidth: previewDims.width,
    viewportHeight: previewDims.height,
    launcherWidth: LAUNCHER_DIMS.width,
    launcherHeight: LAUNCHER_DIMS.height,
    safeAreaBottom: 0,
    baseMargin: DEFAULT_BASE_MARGIN,
  })

  // Dirty state: compare draft to stored.
  const isDirty = (() => {
    if (!positioning) return false
    const dDesktop = draftDesktop
    const dMobile = draftMobile
    const sDesktop = positioning.stored.desktop
    const sMobile = positioning.stored.mobile
    if (!dDesktop && !sDesktop) {
      // both null → not dirty for desktop
    } else if (!dDesktop || !sDesktop) {
      return true
    } else {
      if (dDesktop.anchor !== sDesktop.anchor) return true
      if ((dDesktop.offsetX ?? 0) !== (sDesktop.offsetX ?? 0)) return true
      if ((dDesktop.offsetY ?? 0) !== (sDesktop.offsetY ?? 0)) return true
    }
    if (!dMobile && !sMobile) {
      // both null → not dirty
    } else if (!dMobile || !sMobile) {
      return true
    } else {
      if (dMobile.anchor !== sMobile.anchor) return true
      if ((dMobile.offsetX ?? 0) !== (sMobile.offsetX ?? 0)) return true
      if ((dMobile.offsetY ?? 0) !== (sMobile.offsetY ?? 0)) return true
    }
    return false
  })()

  // The effective anchor for the current device — used as the default
  // when creating a new draft (preserves the V1 fallback rather than
  // silently introducing bottom-end).
  const effectiveAnchor = effective.anchor

  // Update the anchor for the current device.
  const setAnchor = useCallback((anchor: PositioningAnchor) => {
    setCurrentDraft((prev) => {
      const base = prev ?? { anchor: effectiveAnchor }
      return { ...base, anchor }
    })
  }, [setCurrentDraft, effectiveAnchor])

  // Update an offset for the current device (paid only).
  const setOffset = useCallback((key: 'offsetX' | 'offsetY', value: number) => {
    if (!canOffset) return
    if (!Number.isInteger(value) || value < OFFSET_MIN || value > OFFSET_MAX) return
    setCurrentDraft((prev) => {
      const base = prev ?? { anchor: effectiveAnchor }
      return { ...base, [key]: value }
    })
  }, [canOffset, setCurrentDraft, effectiveAnchor])

  // Reset offsets to 0 (keep the anchor). Sets offsetX/Y to 0 (not delete)
  // so the save explicitly persists 0 — the true-patch merge would preserve
  // the old value if the field is omitted.
  const resetOffsets = useCallback(() => {
    setCurrentDraft((prev) => {
      const base = prev ?? { anchor: effectiveAnchor }
      return { ...base, offsetX: 0, offsetY: 0 }
    })
  }, [setCurrentDraft, effectiveAnchor])

  // Drag handler: update offsetX/offsetY based on pointer movement.
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if (!canOffset || !previewRef.current) return
    e.preventDefault()
    setDragging(true)
    const rect = previewRef.current.getBoundingClientRect()
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: previewPos.left,
      startBottom: previewPos.bottom,
    }
    // Capture pointer for smooth dragging.
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [canOffset, previewPos.left, previewPos.bottom])

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || !dragStartRef.current || !previewRef.current) return
    // The preview container is rendered at a responsive size that may
    // differ from the logical preview dimensions. Scale the screen-pixel
    // delta to logical-pixel delta so drag movement matches the preview.
    const rect = previewRef.current.getBoundingClientRect()
    const scaleX = rect.width > 0 ? previewDims.width / rect.width : 1
    const scaleY = rect.height > 0 ? previewDims.height / rect.height : 1

    // Screen-pixel deltas.
    const screenDeltaX = e.clientX - dragStartRef.current.startX
    // Vertical: screen Y increases downward. offsetY positive = up.
    // So dragging UP (screenDeltaY < 0) → offsetY increases (positive).
    // deltaY = -(screenDeltaY) = startY - currentY.
    const screenDeltaY = e.clientY - dragStartRef.current.startY
    const deltaY = -screenDeltaY // up = positive

    // Scale to logical preview pixels.
    const logicalDeltaX = screenDeltaX * scaleX
    const logicalDeltaY = deltaY * scaleY

    // Compute the new desired left position (in logical preview pixels).
    const newLeft = dragStartRef.current.startLeft + logicalDeltaX
    // Clamp to preview bounds.
    const clampedLeft = Math.max(0, Math.min(newLeft, previewDims.width - LAUNCHER_DIMS.width))

    // Back-compute offsetX from the desired left (using the corrected
    // inverse function — mathematically consistent with the forward
    // geometry for ALL anchors + RTL/LTR).
    const newOffsetX = offsetXFromAbsoluteLeft(
      previewAnchor,
      clampedLeft,
      dir,
      previewDims.width,
      LAUNCHER_DIMS.width,
      DEFAULT_BASE_MARGIN,
    )

    // offsetY: positive = up. Dragging up increases offsetY.
    // bottom = baseMargin + offsetY, so newBottom = startBottom + logicalDeltaY.
    const newBottom = dragStartRef.current.startBottom + logicalDeltaY
    const clampedBottom = Math.max(0, Math.min(newBottom, previewDims.height - LAUNCHER_DIMS.height))
    // newOffsetY = clampedBottom - baseMargin (since bottom = baseMargin + offsetY)
    const newOffsetY = clampedBottom - DEFAULT_BASE_MARGIN

    // Apply (clamp to bounds, round to integer).
    setOffset('offsetX', Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(newOffsetX))))
    setOffset('offsetY', Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(newOffsetY))))
  }, [dragging, dragStartRef, previewDims, previewAnchor, dir, setOffset])

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    setDragging(false)
    dragStartRef.current = null
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }, [])

  // Save positioning.
  const save = useCallback(async () => {
    if (!canPosition) return
    setSaving(true)
    try {
      const patchBody: Record<string, unknown> = { positioning: {} }
      const dDesktop = draftDesktop
      const dMobile = draftMobile

      if (dDesktop) {
        const desk: Record<string, unknown> = { anchor: dDesktop.anchor }
        if (canOffset && dDesktop.offsetX !== undefined) desk.offsetX = dDesktop.offsetX
        if (canOffset && dDesktop.offsetY !== undefined) desk.offsetY = dDesktop.offsetY
        ;(patchBody.positioning as Record<string, unknown>).desktop = desk
      }
      if (dMobile) {
        const mob: Record<string, unknown> = { anchor: dMobile.anchor }
        if (canOffset && dMobile.offsetX !== undefined) mob.offsetX = dMobile.offsetX
        if (canOffset && dMobile.offsetY !== undefined) mob.offsetY = dMobile.offsetY
        ;(patchBody.positioning as Record<string, unknown>).mobile = mob
      }

      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = data.error === 'customization_locked'
          ? t('customizationLockedHint')
          : data.error === 'positioning_offset_not_allowed'
            ? t('positioning.offsetsLocked')
            : fa ? 'ذخیره موقعیت ناموفق بود' : 'Failed to save positioning'
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('positioning.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(fa ? 'ذخیره موقعیت ناموفق بود' : 'Failed to save positioning')
      setSaving(false)
    }
  }, [canPosition, canOffset, draftDesktop, draftMobile, t, fa, onReload])

  // Discard: reset drafts to stored.
  const discard = useCallback(() => {
    if (!positioning) return
    setDraftDesktop(positioning.stored.desktop ? { ...positioning.stored.desktop } : null)
    setDraftMobile(positioning.stored.mobile ? { ...positioning.stored.mobile } : null)
  }, [positioning])

  if (!canPosition) {
    return (
      <Card data-testid="positioning-locked" className="border-amber-600/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 p-4">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t('positioning.positioningLocked')}</p>
            <p className="text-xs text-muted-foreground">{t('customizationLockedHint')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // The preview launcher position (scaled to the preview container).
  const launcherStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${(previewPos.left / previewDims.width) * 100}%`,
    bottom: `${(previewPos.bottom / previewDims.height) * 100}%`,
    width: `${(LAUNCHER_DIMS.width / previewDims.width) * 100}%`,
    height: `${(LAUNCHER_DIMS.height / previewDims.height) * 100}%`,
  }

  return (
    <Card data-testid="positioning-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Move className="h-4 w-4 text-saffron" />
              {t('positioning.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('positioning.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('positioning.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Desktop / Mobile toggle */}
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
          <button
            onClick={() => setDevice('desktop')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              device === 'desktop' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid="positioning-device-desktop"
          >
            <Monitor className="h-4 w-4" />
            {t('positioning.desktop')}
          </button>
          <button
            onClick={() => setDevice('mobile')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              device === 'mobile' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid="positioning-device-mobile"
          >
            <Smartphone className="h-4 w-4" />
            {t('positioning.mobile')}
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Controls */}
          <div className="space-y-4">
            {/* Preset selection */}
            <div className="space-y-2">
              <Label>{t('positioning.presets')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {ANCHORS.map((anchor) => (
                  <button
                    key={anchor}
                    onClick={() => setAnchor(anchor)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border p-3 text-xs font-medium transition-colors',
                      previewAnchor === anchor
                        ? 'border-saffron bg-saffron/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                    )}
                    data-testid={`positioning-anchor-${anchor}`}
                  >
                    <span className="text-base">
                      {anchor === 'bottom-start' ? '↙' : anchor === 'bottom-end' ? '↘' : '↓'}
                    </span>
                    {t(`positions.${anchor}` as any)}
                  </button>
                ))}
              </div>
            </div>

            {/* Offsets (paid only) */}
            {canOffset ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('positioning.offsetX')}</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={OFFSET_MIN}
                      max={OFFSET_MAX}
                      value={currentDraft?.offsetX ?? 0}
                      onChange={(e) => setOffset('offsetX', parseInt(e.target.value, 10))}
                      className="flex-1 cursor-pointer"
                      data-testid="positioning-offsetX-slider"
                    />
                    <Input
                      type="number"
                      value={currentDraft?.offsetX ?? 0}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        if (!isNaN(v)) setOffset('offsetX', v)
                      }}
                      className="w-20 font-mono text-xs"
                      dir="ltr"
                      data-testid="positioning-offsetX-input"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('positioning.offsetXHint')}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('positioning.offsetY')}</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={OFFSET_MIN}
                      max={OFFSET_MAX}
                      value={currentDraft?.offsetY ?? 0}
                      onChange={(e) => setOffset('offsetY', parseInt(e.target.value, 10))}
                      className="flex-1 cursor-pointer"
                      data-testid="positioning-offsetY-slider"
                    />
                    <Input
                      type="number"
                      value={currentDraft?.offsetY ?? 0}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        if (!isNaN(v)) setOffset('offsetY', v)
                      }}
                      className="w-20 font-mono text-xs"
                      dir="ltr"
                      data-testid="positioning-offsetY-input"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('positioning.offsetYHint')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetOffsets}
                  className="gap-1 text-xs"
                  data-testid="positioning-reset"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t('positioning.reset')}
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" />
                  {t('positioning.offsetsLocked')}
                </div>
              </div>
            )}

            {/* Save / Discard */}
            <div className="flex gap-2">
              <Button
                onClick={save}
                disabled={saving || !isDirty}
                className="flex-1 gap-2"
                data-testid="positioning-save"
              >
                {saving ? '...' : t('positioning.save')}
              </Button>
              <Button
                variant="outline"
                onClick={discard}
                disabled={saving || !isDirty}
                data-testid="positioning-discard"
              >
                {t('positioning.discard')}
              </Button>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label className="text-xs">{fa ? 'پیش‌نمایش' : 'Preview'}</Label>
            <div
              ref={previewRef}
              className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-muted/40 to-background"
              style={{
                aspectRatio: `${previewDims.width} / ${previewDims.height}`,
                maxWidth: previewDims.width,
              }}
              dir={dir}
            >
              {/* Simulated page content */}
              <div className="absolute inset-0 p-3 opacity-30">
                <div className="h-2 w-1/2 rounded bg-muted" />
                <div className="mt-1.5 h-2 w-1/3 rounded bg-muted" />
                <div className="mt-3 h-16 w-full rounded bg-muted/60" />
              </div>

              {/* Launcher button (draggable for paid) */}
              <button
                type="button"
                onPointerDown={canOffset ? handleDragStart : undefined}
                onPointerMove={canOffset ? handleDragMove : undefined}
                onPointerUp={canOffset ? handleDragEnd : undefined}
                onPointerCancel={canOffset ? handleDragEnd : undefined}
                className={cn(
                  'flex items-center justify-center rounded-xl bg-ink text-ink-foreground shadow-lg transition-transform',
                  canOffset ? 'cursor-move hover:scale-105' : 'cursor-default',
                  dragging && 'scale-105',
                )}
                style={launcherStyle}
                aria-label={fa ? 'دکمه گفت‌وگو' : 'Chat launcher'}
                data-testid="positioning-preview-launcher"
              >
                <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>

              {/* Panel preview (if open position indicator) */}
              <div
                className={cn(
                  'absolute rounded-lg border border-border bg-card shadow-xl',
                  previewPos.panelSide === 'right' && 'left-0',
                  previewPos.panelSide === 'left' && 'right-0',
                  previewPos.panelSide === 'center' && 'left-1/2 -translate-x-1/2',
                )}
                style={{
                  bottom: `calc(${(previewPos.bottom / previewDims.height) * 100}% + ${(LAUNCHER_DIMS.height / previewDims.height) * 100}% + 4px)`,
                  width: '60%',
                  maxWidth: '180px',
                  height: '40%',
                }}
                data-testid="positioning-preview-panel"
              >
                <div className="flex items-center gap-1 border-b border-border p-1.5" style={{ backgroundColor: '#E09A2B22' }}>
                  <div className="h-3 w-3 rounded-full bg-saffron" />
                  <span className="text-[8px] font-medium">{fa ? 'گفت‌وگو' : 'Chat'}</span>
                </div>
                <div className="p-1.5">
                  <div className="max-w-[80%] rounded bg-muted p-1 text-[7px]">{fa ? 'سلام!' : 'Hi!'}</div>
                </div>
              </div>
            </div>
            {canOffset && (
              <p className="text-xs text-muted-foreground">{t('positioning.dragHint')}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
