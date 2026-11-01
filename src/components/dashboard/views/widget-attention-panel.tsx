'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Sparkles, Lock, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  ATTENTION_ANIMATIONS,
  BASIC_ATTENTION_ANIMATIONS,
  DEFAULT_ATTENTION_ANIMATION,
  isValidAttentionAnimation,
  type AttentionAnimation,
} from '@/lib/widget/effective-attention'

/**
 * Attention entitlements from the server.
 */
interface AttentionEntitlements {
  /** 'basic' (Free — none + pulse) or 'advanced' (paid — all five). */
  attentionAnimations: 'basic' | 'advanced'
}

/**
 * Effective attention — what the widget actually renders.
 */
interface EffectiveAttention {
  animation: AttentionAnimation
}

/**
 * The raw stored attention config (may include a paidAnimation on Free,
 * preserved for upgrade restore). null when no V2 attention selection exists.
 */
interface StoredAttention {
  animation: AttentionAnimation
  paidAnimation?: AttentionAnimation
}

/**
 * The attention data returned by GET /api/widget-config.
 */
interface AttentionData {
  entitlements: AttentionEntitlements
  /** Always non-null — the server always resolves the effective attention. */
  effective: EffectiveAttention
  /** The raw stored V2 attention config (may include paidAnimation). */
  stored: StoredAttention | null
}

interface WidgetAttentionPanelProps {
  slug: string
  attention: AttentionData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
  /**
   * The tenant's authorized effective accent (hex). Used for the Glow
   * preview keyframe so the dashboard matches the live widget. Comes
   * from the dashboard's already-resolved effective color data — no
   * independent color resolution is duplicated here.
   */
  effectiveAccent: string
}

/**
 * Convert a hex color to an rgba() string with the given alpha. Falls back
 * to the Sukhan default gold on invalid input so the preview never breaks.
 */
function hexToRgba(hex: string, alpha: number): string {
  const h = String(hex || '#E09A2B').replace('#', '')
  if (h.length === 3) {
    // Expand shorthand (#abc → #aabbcc).
    const expanded = h.split('').map((c) => c + c).join('')
    return hexToRgba('#' + expanded, alpha)
  }
  if (h.length !== 6) return `rgba(224,154,43,${alpha})`
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return `rgba(224,154,43,${alpha})`
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Build the inline keyframes + reduced-motion guard for the live preview,
 * using the tenant's effective accent for the Glow keyframe so the preview
 * matches the live widget.
 *
 * Mirrors the runtime CSS (slug/v1/NPM). Bounded, restrained, GPU-friendly.
 */
function buildPreviewStyles(accent: string): string {
  const glow0 = hexToRgba(accent, 0)
  const glow45 = hexToRgba(accent, 0.45)
  return `
@keyframes sk-attention-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.06);}}
@keyframes sk-attention-bounce{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
@keyframes sk-attention-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-3px);}75%{transform:translateX(3px);}}
@keyframes sk-attention-glow{0%,100%{box-shadow:0 8px 24px rgba(0,0,0,0.18),0 0 0 0 ${glow0};}50%{box-shadow:0 8px 24px rgba(0,0,0,0.18),0 0 14px 2px ${glow45};}}
.sk-preview-launcher.sk-attention-pulse{animation:sk-attention-pulse 2s ease-in-out infinite;}
.sk-preview-launcher.sk-attention-bounce{animation:sk-attention-bounce 1.8s ease-in-out infinite;}
.sk-preview-launcher.sk-attention-shake{animation:sk-attention-shake 1.2s ease-in-out infinite;}
.sk-preview-launcher.sk-attention-glow{animation:sk-attention-glow 2.4s ease-in-out infinite;}
@media (prefers-reduced-motion:reduce){
  .sk-preview-launcher.sk-attention-pulse,
  .sk-preview-launcher.sk-attention-bounce,
  .sk-preview-launcher.sk-attention-shake,
  .sk-preview-launcher.sk-attention-glow{animation:none !important;}
}
`
}

export function WidgetAttentionPanel({
  slug,
  attention,
  defaultDirection,
  onReload,
  effectiveAccent,
}: WidgetAttentionPanelProps) {
  // `slug` is accepted for prop-shape parity with the sibling panels; the
  // dashboard works against the current tenant via session.
  void slug

  const t = useTranslations('settings')
  const fa = defaultDirection === 'rtl'

  // Build the preview styles using the tenant's effective accent so the
  // Glow preview matches the live widget. Recomputed only when the accent
  // changes (e.g. after saving a Pro custom-color change + reload).
  const previewStyles = useMemo(
    () => buildPreviewStyles(effectiveAccent),
    [effectiveAccent],
  )

  // The authorized saved animation — always the effective animation from the
  // server (the resolver returns the authorized animation for both plans,
  // including paidAnimation restoration after upgrade). Used for both draft
  // initialization and discard().
  const savedAnimation: AttentionAnimation = useMemo(
    () => attention?.effective?.animation ?? DEFAULT_ATTENTION_ANIMATION,
    [attention],
  )

  const [draft, setDraft] = useState<AttentionAnimation>(DEFAULT_ATTENTION_ANIMATION)
  const [saving, setSaving] = useState(false)

  // Initialize draft when attention data loads (and on reload after save).
  // The effective animation is always authorized — no filtering needed.
  useEffect(() => {
    setDraft(savedAnimation)
  }, [savedAnimation])

  const entitlements = attention?.entitlements ?? { attentionAnimations: 'basic' as const }
  const canAdvanced = entitlements.attentionAnimations === 'advanced'

  // The animation to render in the preview = the current draft (always an
  // authorized selection — gating prevents selecting a locked animation).
  const previewAnimation: AttentionAnimation = draft

  // Dirty detection: compare the draft to the saved effective animation.
  const isDirty = draft !== savedAnimation

  // Select an animation (gated by entitlement).
  const selectAnimation = useCallback(
    (animation: AttentionAnimation) => {
      // Free can only select none + pulse; advanced-only motions are gated.
      if (!canAdvanced && !BASIC_ATTENTION_ANIMATIONS.includes(animation)) return
      setDraft(animation)
    },
    [canAdvanced],
  )

  // Save attention.
  const save = useCallback(async () => {
    if (!isValidAttentionAnimation(draft)) {
      toast.error(t('attention.invalidAnimation'))
      return
    }

    setSaving(true)
    try {
      const patchBody = { attention: { animation: draft } }

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
            : data.error === 'attention_not_authorized'
              ? t('customizationLockedHint')
              : data.error === 'attention_animation_not_allowed'
                ? t('attention.locked')
                : data.error === 'attention_animation_invalid' ||
                    data.error === 'attention_animation_missing'
                  ? t('attention.invalidAnimation')
                  : t('attention.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('attention.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('attention.saveFail'))
      setSaving(false)
    }
  }, [draft, t, onReload])

  // Discard: reset draft to the saved effective animation.
  const discard = useCallback(() => {
    setDraft(savedAnimation)
  }, [savedAnimation])

  return (
    <Card data-testid="attention-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-saffron" />
              {t('attention.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('attention.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('attention.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Inline preview styles — mirror the runtime keyframes, using the
            tenant's effective accent for the Glow keyframe. */}
        <style dangerouslySetInnerHTML={{ __html: previewStyles }} />

        <div className="grid gap-4 md:grid-cols-2" dir={defaultDirection}>
          {/* Controls */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">{t('attention.animation')}</Label>
              <div className="grid grid-cols-5 gap-2">
                {ATTENTION_ANIMATIONS.map((animation) => {
                  const selected = previewAnimation === animation
                  const allowed = canAdvanced || BASIC_ATTENTION_ANIMATIONS.includes(animation)
                  return (
                    <button
                      key={animation}
                      onClick={allowed ? () => selectAnimation(animation) : undefined}
                      disabled={!allowed}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors',
                        selected
                          ? 'border-saffron bg-saffron/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                        !allowed && 'cursor-not-allowed opacity-60',
                      )}
                      data-testid={`attention-animation-${animation}`}
                      aria-pressed={selected}
                      aria-disabled={!allowed}
                    >
                      <span className="flex items-center gap-1">
                        {!allowed && <Lock className="h-3 w-3" />}
                        {t(`animations.${animation}` as any)}
                      </span>
                    </button>
                  )
                })}
              </div>
              {!canAdvanced && (
                <p className="text-xs text-muted-foreground">{t('attention.upgradeHint')}</p>
              )}
            </div>

            {/* Save / Discard */}
            <div className="flex gap-2">
              <Button
                onClick={save}
                disabled={saving || !isDirty}
                className="flex-1 gap-2"
                data-testid="attention-save"
              >
                {saving ? '...' : t('attention.save')}
              </Button>
              <Button
                variant="outline"
                onClick={discard}
                disabled={saving || !isDirty}
                data-testid="attention-discard"
              >
                {t('attention.discard')}
              </Button>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <Label className="text-xs">{t('attention.preview')}</Label>
            <div
              className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-muted/40 to-background"
              dir={defaultDirection}
              style={{ minHeight: '12rem' }}
              data-testid="attention-preview-stage"
            >
              {/* Simulated site page (subtle, behind the widget) */}
              <div className="absolute inset-0 p-4 opacity-40 pointer-events-none">
                <div className="h-3 w-1/2 rounded bg-muted" />
                <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
                <div className="mt-4 h-20 w-full rounded bg-muted/60" />
              </div>

              {/* Mini widget: launcher at bottom-end with the live animation */}
              <button
                type="button"
                aria-label={t('attention.previewLabel')}
                data-testid="attention-preview-button"
                className={cn(
                  'sk-preview-launcher absolute end-4 bottom-4 flex items-center justify-center rounded-2xl shadow-lg',
                  previewAnimation !== 'none'
                    ? `sk-attention-${previewAnimation}`
                    : '',
                )}
                style={{
                  width: '52px',
                  height: '52px',
                  background: '#0E1116',
                  color: '#FAF7F2',
                  border: 'none',
                }}
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
              {t(`animations.${previewAnimation}` as any)}
              {!canAdvanced && attention?.stored?.paidAnimation && (
                <span className="ms-1 text-saffron/80">
                  {fa ? '· ' : '· '}
                  {t('attention.preservedHint')}
                </span>
              )}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
