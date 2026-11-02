'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EyeOff, AlertCircle, Plus, Trash2, Lock, Filter } from 'lucide-react'
import { toast } from 'sonner'

/**
 * V2 Page Visibility — Feature 8 dashboard panel.
 *
 * Mirrors the preChatForm panel wiring:
 *   - Reads `pageVisibility` from `/api/widget-config` (effective + stored +
 *     entitlements).
 *   - Free (basic): up to 3 rules, exact match only, NO device field.
 *   - Paid (advanced): up to 10 rules, exact + prefix, device-specific.
 *   - paidRules preserved on downgrade (restore-on-upgrade) — exposed via
 *     `stored.paidRules`, NEVER as `effective` for Free.
 *   - Dirty detection + Save / Discard.
 *   - Count display (current / max).
 *   - RTL/LTR via `defaultDirection`.
 *
 * The runtime (slug / v1 / NPM) consumes the EFFECTIVE rules exposed by
 * the public widget config (`pageVisibility.rules`) — the dashboard
 * writes the raw rules here, and the backend resolver filters them per
 * plan before they reach the browser.
 */

type RuleMatch = 'exact' | 'prefix'
type RuleAction = 'show' | 'hide'
type RuleDevice = 'desktop' | 'mobile'

interface PageVisibilityRule {
  pattern: string
  match: RuleMatch
  action: RuleAction
  device?: RuleDevice
}

interface PageVisibilityData {
  entitlements: { pageVisibility: 'none' | 'basic' | 'advanced' }
  effective: { rules: PageVisibilityRule[] }
  stored: { rules: PageVisibilityRule[]; paidRules?: PageVisibilityRule[] } | null
}

interface WidgetPageVisibilityPanelProps {
  slug: string
  pageVisibility: PageVisibilityData | null
  defaultDirection: 'rtl' | 'ltr'
  onReload: () => void
}

const FREE_MAX_RULES = 3
const ADVANCED_MAX_RULES = 10

// Empty-rule template — added when the visitor clicks "Add rule".
// Defaults to exact + hide + no device (the most common case: hide the
// widget on a specific page).
function newRule(): PageVisibilityRule {
  return { pattern: '/', match: 'exact', action: 'hide' }
}

// Stable rule identity for dirty comparison + duplicate detection.
function ruleKey(r: PageVisibilityRule): string {
  return `${r.pattern}|${r.match}|${r.action}|${r.device ?? 'any'}`
}

function rulesEqual(a: PageVisibilityRule[], b: PageVisibilityRule[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (ruleKey(a[i]) !== ruleKey(b[i])) return false
  }
  return true
}

export function WidgetPageVisibilityPanel({
  slug,
  pageVisibility,
  defaultDirection,
  onReload,
}: WidgetPageVisibilityPanelProps) {
  void slug
  const t = useTranslations('settings')

  // The SAVED rules — the effective rules from the backend (the public
  // widget sees the same `effective.rules`). When paidRules exist on a
  // Free plan, the dashboard still shows the EFFECTIVE rules (the
  // paid-only ones are filtered out by the resolver), with a hint that
  // advanced-only rules are preserved for restore-on-upgrade.
  const savedRules = useMemo(
    () => pageVisibility?.effective?.rules ?? [],
    [pageVisibility],
  )
  const [draftRules, setDraftRules] = useState<PageVisibilityRule[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Clone so draft edits don't mutate the saved snapshot.
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraftRules(savedRules.map(r => ({ ...r })))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [savedRules])

  const entitlements = pageVisibility?.entitlements ?? { pageVisibility: 'none' as const }
  const capability = entitlements.pageVisibility
  const canEdit = capability !== 'none'
  const maxRules = capability === 'advanced' ? ADVANCED_MAX_RULES : FREE_MAX_RULES

  // Free plan: exact match only, NO device field. The match selector is
  // locked to 'exact' and the device selector is hidden + forced to
  // undefined.
  const isAdvanced = capability === 'advanced'

  const isDirty = useMemo(() => !rulesEqual(draftRules, savedRules), [draftRules, savedRules])

  // Add a new rule — bounded by maxRules.
  const addRule = useCallback(() => {
    setDraftRules(prev => {
      if (prev.length >= maxRules) return prev
      // Free plan: force exact match (no prefix) + no device.
      const r = isAdvanced ? newRule() : { ...newRule(), match: 'exact' as const }
      return [...prev, r]
    })
  }, [maxRules, isAdvanced])

  // Remove a rule by index.
  const removeRule = useCallback((index: number) => {
    setDraftRules(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Update a single field on a rule. Free plan: match is locked to
  // 'exact' (changing it is a no-op) + device is forced to undefined.
  const updateRule = useCallback(
    (index: number, patch: Partial<PageVisibilityRule>) => {
      setDraftRules(prev =>
        prev.map((r, i) => {
          if (i !== index) return r
          const next: PageVisibilityRule = { ...r, ...patch }
          // Free (basic): no prefix, no device — strip them defensively.
          if (!isAdvanced) {
            next.match = 'exact'
            delete next.device
          }
          return next
        }),
      )
    },
    [isAdvanced],
  )

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/widget-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageVisibility: { rules: draftRules } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg =
          data.error === 'customization_locked' ? t('customizationLockedHint') :
          data.error === 'page_visibility_not_authorized' ? t('customizationLockedHint') :
          data.error === 'page_visibility_not_allowed' ? t('pageVisibility.locked') :
          data.error === 'page_visibility_limit_exceeded' ? t('pageVisibility.limitExceeded') :
          data.error === 'page_visibility_duplicate_rule' ? t('pageVisibility.duplicate') :
          data.error === 'page_visibility_rule_invalid' ? t('pageVisibility.invalidRule') :
          t('pageVisibility.saveFail')
        toast.error(msg)
        setSaving(false)
        return
      }
      toast.success(t('pageVisibility.saveSuccess'))
      setSaving(false)
      onReload()
    } catch {
      toast.error(t('pageVisibility.saveFail'))
      setSaving(false)
    }
  }, [draftRules, t, onReload])

  const discard = useCallback(() => {
    setDraftRules(savedRules.map(r => ({ ...r })))
  }, [savedRules])

  return (
    <Card data-testid="page-visibility-panel">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="font-display text-base flex items-center gap-2">
              <EyeOff className="h-4 w-4 text-saffron" />
              {t('pageVisibility.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('pageVisibility.hint')}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Filter className="h-3 w-3" />
              {draftRules.length}/{maxRules}
            </Badge>
            {isDirty && (
              <Badge variant="outline" className="gap-1 text-amber-600 border-amber-600/40">
                <AlertCircle className="h-3 w-3" />
                {t('pageVisibility.dirty')}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4" dir={defaultDirection}>
        <div className="space-y-3">
          {draftRules.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t('pageVisibility.empty')}</p>
            </div>
          )}
          {draftRules.map((rule, index) => {
            // Free plan: match selector is locked to 'exact' (no prefix).
            const isMatchLocked = !isAdvanced
            return (
              <div
                key={index}
                className="rounded-lg border border-border p-3 space-y-3"
                data-testid={`page-visibility-rule-${index}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    {t('pageVisibility.ruleNumber', { n: index + 1 })}
                  </Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRule(index)}
                    disabled={saving}
                    aria-label={t('pageVisibility.removeRule')}
                    data-testid={`page-visibility-remove-${index}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('pageVisibility.pattern')}</Label>
                    <Input
                      value={rule.pattern}
                      onChange={e => updateRule(index, { pattern: e.target.value })}
                      disabled={saving || !canEdit}
                      dir="ltr"
                      placeholder="/path/to/page"
                      data-testid={`page-visibility-pattern-${index}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('pageVisibility.match')}</Label>
                    <Select
                      value={rule.match}
                      onValueChange={v => updateRule(index, { match: v as RuleMatch })}
                      disabled={saving || !canEdit || !isAdvanced}
                    >
                      <SelectTrigger data-testid={`page-visibility-match-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="exact">{t('pageVisibility.matchExact')}</SelectItem>
                        <SelectItem value="prefix" disabled={!isAdvanced}>
                          <span className="flex items-center gap-1">
                            {!isAdvanced && <Lock className="h-3 w-3" />}
                            {t('pageVisibility.matchPrefix')}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {isMatchLocked && (
                      <p className="text-[10px] text-muted-foreground">{t('pageVisibility.matchLockedHint')}</p>
                    )}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('pageVisibility.action')}</Label>
                    <Select
                      value={rule.action}
                      onValueChange={v => updateRule(index, { action: v as RuleAction })}
                      disabled={saving || !canEdit}
                    >
                      <SelectTrigger data-testid={`page-visibility-action-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="show">{t('pageVisibility.actionShow')}</SelectItem>
                        <SelectItem value="hide">{t('pageVisibility.actionHide')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      <span className="flex items-center gap-1">
                        {t('pageVisibility.device')}
                        {!isAdvanced && <Lock className="h-3 w-3" />}
                      </span>
                    </Label>
                    <Select
                      value={rule.device ?? 'any'}
                      onValueChange={v =>
                        updateRule(index, {
                          device: v === 'any' ? undefined : (v as RuleDevice),
                        })
                      }
                      disabled={saving || !canEdit || !isAdvanced}
                    >
                      <SelectTrigger data-testid={`page-visibility-device-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">{t('pageVisibility.deviceAny')}</SelectItem>
                        <SelectItem value="desktop" disabled={!isAdvanced}>
                          <span className="flex items-center gap-1">
                            {!isAdvanced && <Lock className="h-3 w-3" />}
                            {t('pageVisibility.deviceDesktop')}
                          </span>
                        </SelectItem>
                        <SelectItem value="mobile" disabled={!isAdvanced}>
                          <span className="flex items-center gap-1">
                            {!isAdvanced && <Lock className="h-3 w-3" />}
                            {t('pageVisibility.deviceMobile')}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {canEdit && draftRules.length < maxRules && (
          <Button
            variant="outline"
            onClick={addRule}
            disabled={saving}
            className="w-full gap-2"
            data-testid="page-visibility-add"
          >
            <Plus className="h-4 w-4" />
            {t('pageVisibility.addRule')}
          </Button>
        )}

        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('pageVisibility.upgradeHint')}</p>
        )}

        <div className="flex gap-2">
          <Button
            onClick={save}
            disabled={saving || !isDirty || !canEdit}
            className="flex-1 gap-2"
            data-testid="page-visibility-save"
          >
            {saving ? '...' : t('pageVisibility.save')}
          </Button>
          <Button
            variant="outline"
            onClick={discard}
            disabled={saving || !isDirty}
            data-testid="page-visibility-discard"
          >
            {t('pageVisibility.discard')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
