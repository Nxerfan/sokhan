'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Lock, AlertCircle, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

type FieldKey = 'name' | 'email' | 'phone' | 'company'

interface PreChatField {
  key: FieldKey
  required: boolean
}

interface PreChatFormData {
  entitlements: { preChatForm: 'none' | 'basic' | 'advanced' }
  effective: { fields: PreChatField[] }
  stored: { fields: PreChatField[]; paidFields?: PreChatField[] } | null
}

interface WidgetPreChatFormPanelProps {
  slug: string
  preChatForm: PreChatFormData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

const ALL_FIELDS: FieldKey[] = ['name', 'email', 'phone', 'company']
const BASIC_FIELDS: FieldKey[] = ['name', 'email']

export function WidgetPreChatFormPanel({
  slug,
  preChatForm,
  defaultDirection,
  onReload,
}: WidgetPreChatFormPanelProps) {
  void slug
  const t = useTranslations('settings')

  const savedFields = useMemo(() => preChatForm?.effective?.fields ?? [], [preChatForm])
  const [draftFields, setDraftFields] = useState<PreChatField[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraftFields(savedFields)
  }, [savedFields])

  const entitlements = preChatForm?.entitlements ?? { preChatForm: 'none' as const }
  const capability = entitlements.preChatForm
  const canEdit = capability !== 'none'

  const isDirty = useMemo(() => {
    if (draftFields.length !== savedFields.length) return true
    for (let i = 0; i < draftFields.length; i++) {
      if (draftFields[i].key !== savedFields[i]?.key || draftFields[i].required !== savedFields[i]?.required) return true
    }
    return false
  }, [draftFields, savedFields])

  const isFieldEnabled = useCallback((key: FieldKey) => {
    return draftFields.some(f => f.key === key)
  }, [draftFields])

  const isFieldRequired = useCallback((key: FieldKey) => {
    return draftFields.some(f => f.key === key && f.required)
  }, [draftFields])

  const isFieldAllowed = useCallback((key: FieldKey) => {
    if (capability === 'advanced') return true
    return BASIC_FIELDS.includes(key)
  }, [capability])

  const toggleField = useCallback((key: FieldKey) => {
    if (!isFieldAllowed(key)) return
    setDraftFields(prev => {
      const existing = prev.find(f => f.key === key)
      if (existing) {
        return prev.filter(f => f.key !== key)
      }
      const maxFields = capability === 'advanced' ? 4 : 2
      if (prev.length >= maxFields) return prev
      return [...prev, { key, required: false }]
    })
  }, [isFieldAllowed, capability])

  const toggleRequired = useCallback((key: FieldKey) => {
    setDraftFields(prev => prev.map(f => f.key === key ? { ...f, required: !f.required } : f))
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preChatForm: { fields: draftFields } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = data.error === 'customization_locked' ? t('customizationLockedHint') :
          data.error === 'pre_chat_form_not_allowed' ? t('preChatForm.locked') :
          data.error === 'pre_chat_form_not_authorized' ? t('customizationLockedHint') :
          data.error === 'pre_chat_form_limit_exceeded' ? t('preChatForm.limitExceeded') :
          t('preChatForm.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('preChatForm.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('preChatForm.saveFail'))
      setSaving(false)
    }
  }, [draftFields, t, onReload])

  const discard = useCallback(() => {
    setDraftFields(savedFields)
  }, [savedFields])

  return (
    <Card data-testid="pre-chat-form-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-saffron" />
              {t('preChatForm.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('preChatForm.hint')}</CardDescription>
          </div>
          {isDirty && (
            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
              <AlertCircle className="h-3 w-3" />
              {t('preChatForm.dirty')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4" dir={defaultDirection}>
        <div className="space-y-3">
          {ALL_FIELDS.map(key => {
            const enabled = isFieldEnabled(key)
            const required = isFieldRequired(key)
            const allowed = isFieldAllowed(key)
            return (
              <div key={key} className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => toggleField(key)}
                    disabled={!allowed || saving}
                    data-testid={`pre-chat-form-enabled-${key}`}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
                      enabled ? 'bg-saffron' : 'bg-muted',
                      !allowed && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    {!allowed && <Lock className="absolute h-2.5 w-2.5 text-muted-foreground" style={{ insetInlineStart: '50%', transform: 'translateX(-50%)' }} />}
                    <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', enabled ? 'translate-x-4' : 'translate-x-0')} />
                  </button>
                  <Label className="text-sm">
                    {t(`preChatForm.fields.${key}` as any)}
                  </Label>
                </div>
                {enabled && (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={required}
                    onClick={() => toggleRequired(key)}
                    disabled={saving}
                    data-testid={`pre-chat-form-required-${key}`}
                    className={cn(
                      'text-xs px-2 py-1 rounded border transition-colors',
                      required ? 'border-saffron bg-saffron/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {required ? t('preChatForm.required') : t('preChatForm.optional')}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('preChatForm.upgradeHint')}</p>
        )}

        <div className="flex gap-2">
          <Button onClick={save} disabled={saving || !isDirty} className="flex-1 gap-2" data-testid="pre-chat-form-save">
            {saving ? '...' : t('preChatForm.save')}
          </Button>
          <Button variant="outline" onClick={discard} disabled={saving || !isDirty} data-testid="pre-chat-form-discard">
            {t('preChatForm.discard')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
