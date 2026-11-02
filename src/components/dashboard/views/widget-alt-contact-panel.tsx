'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Phone, Mail, MessageCircle, Send, Globe, Plus, Trash2, AlertCircle, Filter } from 'lucide-react'
import { toast } from 'sonner'

/**
 * V2 Alternative Contact Buttons — Feature 9 dashboard panel.
 *
 * Mirrors the pageVisibility panel wiring:
 *   - Reads `alternativeContactButtons` from `/api/widget-config`
 *     (effective + stored + entitlements).
 *   - Free: up to 2 items.
 *   - Paid: up to 5 items.
 *   - Duplicate KIND prevention (each kind appears at most once).
 *   - Dirty detection + Save / Discard.
 *   - Count display (current / max).
 *   - RTL/LTR via `defaultDirection`.
 *
 * The runtime (slug / v1 / NPM) consumes the EFFECTIVE items exposed by the
 * public widget config (`alternativeContactButtons.items`) — the dashboard
 * writes the raw items here, and the backend resolver filters them per plan
 * before they reach the browser. The runtime renders one
 * `<a class="sk-alt-contact-link">` per item inside the open panel; the links
 * NEVER send a Sukhan message, complete a pre-chat form, or bypass
 * authorization. They are plain anchor elements handled natively by the
 * visitor's browser.
 */

type AltContactKind = 'phone' | 'email' | 'whatsapp' | 'telegram' | 'website'

interface AltContactItem {
  kind: AltContactKind
  label: string
  value: string
}

interface AltContactData {
  entitlements: { max: number }
  effective: { items: AltContactItem[] }
  stored: { items: AltContactItem[]; paidItems?: AltContactItem[] } | null
}

interface WidgetAltContactPanelProps {
  slug: string
  alternativeContactButtons: AltContactData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

const FREE_MAX_ITEMS = 2
const PAID_MAX_ITEMS = 5

const KINDS: AltContactKind[] = ['phone', 'email', 'whatsapp', 'telegram', 'website']

// Empty-item template — added when the visitor clicks "Add".
// Defaults to 'phone' (the most common case: a phone number to call).
function newItem(): AltContactItem {
  return { kind: 'phone', label: '', value: '' }
}

// Stable item identity for dirty comparison + duplicate-kind detection.
function itemKey(it: AltContactItem): string {
  return `${it.kind}|${it.label}|${it.value}`
}

function itemsEqual(a: AltContactItem[], b: AltContactItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (itemKey(a[i]) !== itemKey(b[i])) return false
  }
  return true
}

export function WidgetAltContactPanel({
  slug,
  alternativeContactButtons,
  defaultDirection,
  onReload,
}: WidgetAltContactPanelProps) {
  void slug
  const t = useTranslations('settings')

  // The SAVED items — the effective items from the backend (the public
  // widget sees the same `effective.items`). When paidItems exist on a Free
  // plan, the dashboard still shows the EFFECTIVE items (the paid-only ones
  // are filtered out by the resolver), with a hint that paid-only items are
  // preserved for restore-on-upgrade.
  const savedItems = useMemo(
    () => alternativeContactButtons?.effective?.items ?? [],
    [alternativeContactButtons],
  )
  const [draftItems, setDraftItems] = useState<AltContactItem[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Clone so draft edits don't mutate the saved snapshot.
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraftItems(savedItems.map(it => ({ ...it })))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [savedItems])

  const entitlements = alternativeContactButtons?.entitlements ?? { max: 0 }
  const max = entitlements.max
  const canEdit = max > 0
  const maxItems = max > 0 ? max : FREE_MAX_ITEMS

  const isDirty = useMemo(() => !itemsEqual(draftItems, savedItems), [draftItems, savedItems])

  // Duplicate-kind detection — each kind may appear at most once across the
  // draft. Mirrors the backend's `alt_contact_duplicate_kind` check so the
  // visitor gets immediate feedback (the Save button stays disabled + a
  // hint is shown on the offending row).
  const duplicateKinds = useMemo(() => {
    const seen = new Set<string>()
    const dups = new Set<number>()
    for (let i = 0; i < draftItems.length; i++) {
      const k = draftItems[i].kind
      if (seen.has(k)) dups.add(i)
      else seen.add(k)
    }
    return dups
  }, [draftItems])

  // Add a new item — bounded by maxItems.
  const addItem = useCallback(() => {
    setDraftItems(prev => {
      if (prev.length >= maxItems) return prev
      // Prefer the first kind that is NOT already used (so the visitor can
      // fill all five slots without manually changing the kind). Falls back
      // to 'phone' when all kinds are already in use (which can only happen
      // when the draft is at the limit — the Add button is disabled then).
      const usedKinds = new Set(prev.map(it => it.kind))
      const nextKind = (KINDS.find(k => !usedKinds.has(k)) ?? 'phone') as AltContactKind
      return [...prev, { ...newItem(), kind: nextKind }]
    })
  }, [maxItems])

  // Remove an item by index.
  const removeItem = useCallback((index: number) => {
    setDraftItems(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Update a single field on an item.
  const updateItem = useCallback((index: number, patch: Partial<AltContactItem>) => {
    setDraftItems(prev =>
      prev.map((it, i) => (i !== index ? it : { ...it, ...patch })),
    )
  }, [])

  const save = useCallback(async () => {
    // Block save on duplicate kinds — the backend would reject with
    // `alt_contact_duplicate_kind` anyway; we fail fast here so the toast
    // matches the local validation message.
    if (duplicateKinds.size > 0) {
      toast.error(t('altContact.duplicateKind'))
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alternativeContactButtons: { items: draftItems } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg =
          data.error === 'customization_locked' ? t('customizationLockedHint') :
          data.error === 'alt_contact_not_authorized' ? t('customizationLockedHint') :
          data.error === 'alt_contact_limit_exceeded' ? t('altContact.limitExceeded') :
          data.error === 'alt_contact_duplicate_kind' ? t('altContact.duplicateKind') :
          data.error === 'alt_contact_item_invalid' ? t('altContact.invalidItem') :
          data.error === 'alt_contact_unexpected_key' ? t('altContact.invalidItem') :
          data.error === 'alt_contact_no_fields' ? t('altContact.invalidItem') :
          t('altContact.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('altContact.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('altContact.saveFail'))
      setSaving(false)
    }
  }, [draftItems, duplicateKinds, t, onReload])

  const discard = useCallback(() => {
    setDraftItems(savedItems.map(it => ({ ...it })))
  }, [savedItems])

  return (
    <Card data-testid="alt-contact-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-saffron" />
              {t('altContact.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('altContact.hint')}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Filter className="h-3 w-3" />
              {draftItems.length}/{maxItems}
            </Badge>
            {isDirty && (
              <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
                <AlertCircle className="h-3 w-3" />
                {t('altContact.dirty')}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4" dir={defaultDirection}>
        <div className="space-y-3">
          {draftItems.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t('altContact.empty')}</p>
            </div>
          )}
          {draftItems.map((item, index) => {
            const isDuplicateKind = duplicateKinds.has(index)
            return (
              <div
                key={index}
                className="rounded-lg border border-border p-3 space-y-3"
                data-testid={`alt-contact-item-${index}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    {t('altContact.itemNumber', { n: index + 1 })}
                  </Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeItem(index)}
                    disabled={saving}
                    aria-label={t('altContact.removeItem')}
                    data-testid={`alt-contact-remove-${index}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('altContact.kind')}</Label>
                    <Select
                      value={item.kind}
                      onValueChange={v => updateItem(index, { kind: v as AltContactKind })}
                      disabled={saving || !canEdit}
                    >
                      <SelectTrigger data-testid={`alt-contact-kind-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="phone">
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {t('altContact.kinds.phone')}
                          </span>
                        </SelectItem>
                        <SelectItem value="email">
                          <span className="flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {t('altContact.kinds.email')}
                          </span>
                        </SelectItem>
                        <SelectItem value="whatsapp">
                          <span className="flex items-center gap-1">
                            <MessageCircle className="h-3 w-3" />
                            {t('altContact.kinds.whatsapp')}
                          </span>
                        </SelectItem>
                        <SelectItem value="telegram">
                          <span className="flex items-center gap-1">
                            <Send className="h-3 w-3" />
                            {t('altContact.kinds.telegram')}
                          </span>
                        </SelectItem>
                        <SelectItem value="website">
                          <span className="flex items-center gap-1">
                            <Globe className="h-3 w-3" />
                            {t('altContact.kinds.website')}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('altContact.label')}</Label>
                    <Input
                      value={item.label}
                      onChange={e => updateItem(index, { label: e.target.value })}
                      disabled={saving || !canEdit}
                      dir={defaultDirection}
                      placeholder={t('altContact.labelPlaceholder')}
                      maxLength={40}
                      data-testid={`alt-contact-label-${index}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('altContact.value')}</Label>
                    <Input
                      value={item.value}
                      onChange={e => updateItem(index, { value: e.target.value })}
                      disabled={saving || !canEdit}
                      dir="ltr"
                      placeholder={valuePlaceholder(item.kind, t)}
                      maxLength={500}
                      data-testid={`alt-contact-value-${index}`}
                    />
                  </div>
                </div>
                {isDuplicateKind && (
                  <p className="text-[10px] text-destructive">{t('altContact.duplicateKind')}</p>
                )}
              </div>
            )
          })}
        </div>

        {canEdit && draftItems.length < maxItems && (
          <Button
            variant="outline"
            onClick={addItem}
            disabled={saving}
            className="w-full gap-2"
            data-testid="alt-contact-add"
          >
            <Plus className="h-4 w-4" />
            {t('altContact.addItem')}
          </Button>
        )}

        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('altContact.upgradeHint')}</p>
        )}

        <div className="flex gap-2">
          <Button
            onClick={save}
            disabled={saving || !isDirty || !canEdit || duplicateKinds.size > 0}
            className="flex-1 gap-2"
            data-testid="alt-contact-save"
          >
            {saving ? '...' : t('altContact.save')}
          </Button>
          <Button
            variant="outline"
            onClick={discard}
            disabled={saving || !isDirty}
            data-testid="alt-contact-discard"
          >
            {t('altContact.discard')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Per-kind value placeholder (LTR always — values are technical strings
 * like phone numbers, URLs, emails, usernames).
 */
function valuePlaceholder(kind: AltContactKind, t: ReturnType<typeof useTranslations>): string {
  switch (kind) {
    case 'phone':
      return t('altContact.valuePlaceholders.phone')
    case 'email':
      return t('altContact.valuePlaceholders.email')
    case 'whatsapp':
      return t('altContact.valuePlaceholders.whatsapp')
    case 'telegram':
      return t('altContact.valuePlaceholders.telegram')
    case 'website':
      return t('altContact.valuePlaceholders.website')
    default:
      return ''
  }
}
