'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { MessageCircle, Plus, Trash2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * Quick Replies entitlements from the server.
 */
interface QuickRepliesEntitlements {
  max: number
}

/**
 * The quick-replies data returned by GET /api/widget-config.
 */
interface QuickRepliesData {
  entitlements: QuickRepliesEntitlements
  effective: { items: string[] }
  stored: { items: string[]; paidItems?: string[] } | null
}

interface WidgetQuickRepliesPanelProps {
  slug: string
  quickReplies: QuickRepliesData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

export function WidgetQuickRepliesPanel({
  slug,
  quickReplies,
  defaultDirection,
  onReload,
}: WidgetQuickRepliesPanelProps) {
  void slug

  const t = useTranslations('settings')

  // The authorized saved items — always the effective items from the server.
  const savedItems: string[] = useMemo(
    () => quickReplies?.effective?.items ?? [],
    [quickReplies],
  )

  const [draft, setDraft] = useState<string[]>([])
  const [inputValue, setInputValue] = useState('')
  const [saving, setSaving] = useState(false)

  // Initialize draft when data loads (and on reload after save).
  useEffect(() => {
    setDraft(savedItems)
  }, [savedItems])

  const entitlements = quickReplies?.entitlements ?? { max: 0 }
  const max = entitlements.max
  const canEdit = max > 0

  // Dirty detection: compare draft to the saved effective items.
  const isDirty = useMemo(() => {
    if (draft.length !== savedItems.length) return true
    for (let i = 0; i < draft.length; i++) {
      if (draft[i] !== savedItems[i]) return true
    }
    return false
  }, [draft, savedItems])

  const atLimit = draft.length >= max

  const addItem = useCallback(() => {
    const text = inputValue.trim()
    if (!text || atLimit) return
    // Case-insensitive duplicate check.
    const lower = text.toLowerCase()
    if (draft.some(item => item.toLowerCase() === lower)) {
      toast.error(t('quickReplies.duplicate'))
      return
    }
    if (Array.from(text).length > 80) {
      toast.error(t('quickReplies.tooLong'))
      return
    }
    setDraft([...draft, text])
    setInputValue('')
  }, [inputValue, draft, atLimit, t])

  const removeItem = useCallback((index: number) => {
    setDraft(draft.filter((_, i) => i !== index))
  }, [draft])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quickReplies: { items: draft } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg =
          data.error === 'customization_locked'
            ? t('customizationLockedHint')
            : data.error === 'quick_replies_limit_exceeded'
              ? t('quickReplies.limitExceeded')
              : data.error === 'quick_replies_not_authorized'
                ? t('customizationLockedHint')
                : data.error === 'quick_replies_duplicate'
                  ? t('quickReplies.duplicate')
                  : data.error === 'quick_replies_item_invalid'
                    ? t('quickReplies.invalidItem')
                    : t('quickReplies.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('quickReplies.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('quickReplies.saveFail'))
      setSaving(false)
    }
  }, [draft, t, onReload])

  const discard = useCallback(() => {
    setDraft(savedItems)
    setInputValue('')
  }, [savedItems])

  return (
    <Card data-testid="quick-replies-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-saffron" />
              {t('quickReplies.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('quickReplies.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('quickReplies.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4" dir={defaultDirection}>
        {/* Count + limit */}
        <div className="flex items-center justify-between">
          <Label className="text-xs">
            {t('quickReplies.count', { current: draft.length, max })}
          </Label>
          {!canEdit && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              {t('quickReplies.locked')}
            </span>
          )}
        </div>

        {/* Input + Add */}
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                addItem()
              }
            }}
            placeholder={t('quickReplies.placeholder')}
            disabled={!canEdit || atLimit || saving}
            maxLength={80}
            data-testid="quick-replies-input"
            className="flex-1"
          />
          <Button
            onClick={addItem}
            disabled={!canEdit || atLimit || saving || !inputValue.trim()}
            variant="outline"
            size="sm"
            data-testid="quick-replies-add"
            className="gap-1"
          >
            <Plus className="h-4 w-4" />
            {t('quickReplies.add')}
          </Button>
        </div>

        {/* Current items */}
        <div className="space-y-2">
          {draft.map((item, index) => (
            <div
              key={index}
              data-testid={`quick-replies-row-${index}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="text-sm truncate flex-1">{item}</span>
              <Button
                onClick={() => removeItem(index)}
                disabled={saving}
                variant="ghost"
                size="sm"
                data-testid={`quick-replies-remove-${index}`}
                className="gap-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {draft.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">{t('quickReplies.empty')}</p>
          )}
        </div>

        {/* Save / Discard */}
        <div className="flex gap-2">
          <Button
            onClick={save}
            disabled={saving || !isDirty}
            className="flex-1 gap-2"
            data-testid="quick-replies-save"
          >
            {saving ? '...' : t('quickReplies.save')}
          </Button>
          <Button
            variant="outline"
            onClick={discard}
            disabled={saving || !isDirty}
            data-testid="quick-replies-discard"
          >
            {t('quickReplies.discard')}
          </Button>
        </div>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('quickReplies.upgradeHint')}</p>
        )}
        {canEdit && atLimit && (
          <p className="text-xs text-muted-foreground">{t('quickReplies.atLimit', { max })}</p>
        )}
      </CardContent>
    </Card>
  )
}
