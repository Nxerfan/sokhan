'use client'

import { useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from './members-panel'

type Rule = {
  id: string
  name: string
  enabled: boolean
  priority: number
  trigger: { event: string; conditions?: { keyword?: string; businessHours?: { start: number; end: number } } }
  action: { type: string; departmentId?: string; userId?: string; tag?: string; text?: string }
}

export function RoutingRulesPanel({ departments }: { departments: { id: string; name: string }[] }) {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const locale = useLocale()
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  // New rule form state
  const [name, setName] = useState('')
  const [conditionType, setConditionType] = useState('always')
  const [keyword, setKeyword] = useState('')
  const [bhStart, setBhStart] = useState('9')
  const [bhEnd, setBhEnd] = useState('17')
  const [actionType, setActionType] = useState('assign_department')
  const [actionDeptId, setActionDeptId] = useState('')
  const [actionText, setActionText] = useState('')

  async function load() {
    const res = await fetch('/api/routing-rules')
    const data = await res.json()
    setRules(data.rules ?? [])
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function createRule(e: React.FormEvent) {
    e.preventDefault()
    const conditions: any = {}
    if (conditionType === 'keyword') conditions.keyword = keyword
    if (conditionType === 'businessHours') conditions.businessHours = { start: Number(bhStart), end: Number(bhEnd) }

    const action: any = { type: actionType }
    if (actionType === 'assign_department') action.departmentId = actionDeptId
    if (actionType === 'send_message') action.text = actionText

    const res = await fetch('/api/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        trigger: { event: 'conversation_created', conditions },
        action,
        priority: rules.length,
      }),
    })
    if (!res.ok) { toast.error('Failed'); return }
    toast.success(t('saved'))
    setName(''); setKeyword(''); setActionText('')
    setShowForm(false)
    load()
  }

  async function toggleRule(id: string, enabled: boolean) {
    await fetch('/api/routing-rules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    })
    load()
  }

  async function deleteRule(id: string) {
    await fetch(`/api/routing-rules?id=${id}`, { method: 'DELETE' })
    toast.success(t('saved'))
    load()
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('automationTitle') || t('widgetTitle')} hint={t('automationHint') || t('widgetHint')} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="font-display text-base">{locale === 'fa' ? 'قوانین مسیریابی' : 'Routing Rules'}</CardTitle>
              <CardDescription>{locale === 'fa' ? 'قوانین خودکار برای تخصیص گفت‌وگوها' : 'Automatic rules for conversation assignment'}</CardDescription>
            </div>
            <Button onClick={() => setShowForm(!showForm)} className="gap-2">
              <Plus className="h-4 w-4" />
              {tc('create')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {showForm && (
            <form onSubmit={createRule} className="space-y-4 border-b border-border p-4">
              <div className="space-y-2">
                <Label htmlFor="rule-name">{locale === 'fa' ? 'نام قانون' : 'Rule name'}</Label>
                <Input id="rule-name" value={name} onChange={e => setName(e.target.value)} required placeholder={locale === 'fa' ? 'مثال: تخصیص به فروش' : 'e.g. Assign to Sales'} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="rule-condition">{locale === 'fa' ? 'شرط' : 'Condition'}</Label>
                  <Select value={conditionType} onValueChange={setConditionType}>
                    <SelectTrigger id="rule-condition"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">{locale === 'fa' ? 'همیشه' : 'Always'}</SelectItem>
                      <SelectItem value="keyword">{locale === 'fa' ? 'کلمه کلیدی' : 'Keyword'}</SelectItem>
                      <SelectItem value="businessHours">{locale === 'fa' ? 'ساعات کاری' : 'Business hours'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-action">{locale === 'fa' ? 'عمل' : 'Action'}</Label>
                  <Select value={actionType} onValueChange={setActionType}>
                    <SelectTrigger id="rule-action"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="assign_department">{locale === 'fa' ? 'تخصیص به دپارتمان' : 'Assign department'}</SelectItem>
                      <SelectItem value="send_message">{locale === 'fa' ? 'ارسال پیام' : 'Send message'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {conditionType === 'keyword' && (
                <div className="space-y-2">
                  <Label htmlFor="rule-keyword">{locale === 'fa' ? 'کلمه کلیدی' : 'Keyword'}</Label>
                  <Input id="rule-keyword" value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="support" dir="ltr" />
                </div>
              )}
              {conditionType === 'businessHours' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>{locale === 'fa' ? 'شروع' : 'Start hour'}</Label>
                    <Input type="number" min="0" max="23" value={bhStart} onChange={e => setBhStart(e.target.value)} dir="ltr" />
                  </div>
                  <div className="space-y-2">
                    <Label>{locale === 'fa' ? 'پایان' : 'End hour'}</Label>
                    <Input type="number" min="0" max="23" value={bhEnd} onChange={e => setBhEnd(e.target.value)} dir="ltr" />
                  </div>
                </div>
              )}
              {actionType === 'assign_department' && (
                <div className="space-y-2">
                  <Label htmlFor="rule-department">{locale === 'fa' ? 'دپارتمان' : 'Department'}</Label>
                  <Select value={actionDeptId} onValueChange={setActionDeptId}>
                    <SelectTrigger id="rule-department"><SelectValue placeholder={locale === 'fa' ? 'انتخاب…' : 'Select…'} /></SelectTrigger>
                    <SelectContent>
                      {departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {actionType === 'send_message' && (
                <div className="space-y-2">
                  <Label htmlFor="rule-message">{locale === 'fa' ? 'متن پیام' : 'Message text'}</Label>
                  <Input id="rule-message" value={actionText} onChange={e => setActionText(e.target.value)} placeholder={locale === 'fa' ? 'سلام! به‌زودی پاسخ می‌دهیم.' : 'Hi! We will respond shortly.'} dir="auto" />
                </div>
              )}
              <Button type="submit" className="gap-2"><Zap className="h-4 w-4" />{tc('save')}</Button>
            </form>
          )}
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
          ) : rules.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {locale === 'fa' ? 'هنوز قانونی وجود ندارد' : 'No rules yet'}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rules.map(rule => (
                <li key={rule.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <Switch checked={rule.enabled} onCheckedChange={(v) => toggleRule(rule.id, v)} />
                    <div>
                      <p className="text-sm font-medium">{rule.name}</p>
                      <div className="mt-1 flex gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          {rule.trigger.conditions?.keyword ? `keyword: ${rule.trigger.conditions.keyword}` :
                           rule.trigger.conditions?.businessHours ? `hours: ${rule.trigger.conditions.businessHours.start}-${rule.trigger.conditions.businessHours.end}` :
                           locale === 'fa' ? 'همیشه' : 'always'}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {rule.action.type === 'assign_department' ? `→ ${departments.find(d => d.id === rule.action.departmentId)?.name || 'dept'}` :
                           rule.action.type === 'send_message' ? `→ ${locale === 'fa' ? 'پیام' : 'message'}` :
                           rule.action.type}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteRule(rule.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
