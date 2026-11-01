'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { MessageSquare, Lock, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * Message Preview entitlements from the server.
 */
interface MessagePreviewEntitlements {
  messagePreview: boolean
}

/**
 * The message-preview data returned by GET /api/widget-config.
 */
interface MessagePreviewData {
  entitlements: MessagePreviewEntitlements
  effective: { enabled: boolean }
  stored: { enabled: boolean } | null
}

interface WidgetMessagePreviewPanelProps {
  slug: string
  messagePreview: MessagePreviewData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

export function WidgetMessagePreviewPanel({
  slug,
  messagePreview,
  defaultDirection,
  onReload,
}: WidgetMessagePreviewPanelProps) {
  void slug

  const t = useTranslations('settings')

  // The authorized saved state — always the effective value from the server.
  // For Free, effective is always false (the resolver enforces the entitlement).
  // For Pro, effective = stored.enabled (default false).
  const savedEnabled: boolean = useMemo(
    () => messagePreview?.effective?.enabled ?? false,
    [messagePreview],
  )

  const [draft, setDraft] = useState<boolean>(false)
  const [saving, setSaving] = useState(false)

  // Initialize draft when data loads (and on reload after save).
  useEffect(() => {
    setDraft(savedEnabled)
  }, [savedEnabled])

  const entitlements = messagePreview?.entitlements ?? { messagePreview: false }
  const canEdit = entitlements.messagePreview

  // Dirty detection: compare the draft to the saved effective state.
  const isDirty = draft !== savedEnabled

  const toggle = useCallback(() => {
    if (!canEdit) return
    setDraft((d) => !d)
  }, [canEdit])

  // Save.
  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messagePreview: { enabled: draft } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg =
          data.error === 'customization_locked'
            ? t('customizationLockedHint')
            : data.error === 'message_preview_not_allowed'
              ? t('messagePreview.locked')
              : data.error === 'message_preview_not_authorized'
                ? t('customizationLockedHint')
                : t('messagePreview.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('messagePreview.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('messagePreview.saveFail'))
      setSaving(false)
    }
  }, [draft, t, onReload])

  // Discard: reset draft to the saved effective state.
  const discard = useCallback(() => {
    setDraft(savedEnabled)
  }, [savedEnabled])

  return (
    <Card data-testid="message-preview-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-saffron" />
              {t('messagePreview.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('messagePreview.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('messagePreview.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4" dir={defaultDirection}>
          <div className="space-y-1">
            <Label className="text-sm">{t('messagePreview.enable')}</Label>
            <p className="text-xs text-muted-foreground">{t('messagePreview.enableHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft}
            onClick={toggle}
            disabled={!canEdit || saving}
            data-testid="message-preview-enabled"
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
              draft ? 'bg-saffron' : 'bg-muted',
              !canEdit && 'cursor-not-allowed opacity-60',
              saving && 'cursor-wait',
            )}
          >
            {!canEdit && <Lock className="absolute h-3 w-3 text-muted-foreground" style={{ insetInlineStart: '50%', transform: 'translateX(-50%)' }} />}
            <span
              className={cn(
                'inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform',
                draft ? 'translate-x-5' : 'translate-x-0',
              )}
              style={draft ? { transform: defaultDirection === 'rtl' ? 'translateX(-20px)' : 'translateX(20px)' } : undefined}
            />
          </button>
        </div>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('messagePreview.upgradeHint')}</p>
        )}

        {/* Save / Discard */}
        <div className="flex gap-2">
          <Button
            onClick={save}
            disabled={saving || !isDirty}
            className="flex-1 gap-2"
            data-testid="message-preview-save"
          >
            {saving ? '...' : t('messagePreview.save')}
          </Button>
          <Button
            variant="outline"
            onClick={discard}
            disabled={saving || !isDirty}
            data-testid="message-preview-discard"
          >
            {t('messagePreview.discard')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
