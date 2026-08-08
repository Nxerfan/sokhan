'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, Bot, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'

type Faq = { id: string; question: string; answer: string; enabled: boolean }

export function FaqPanel() {
  const locale = useLocale()
  const [faqs, setFaqs] = useState<Faq[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')

  async function load() {
    const res = await fetch('/api/faqs')
    const data = await res.json()
    setFaqs(data.faqs ?? [])
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function createFaq(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer, enabled: true }),
    })
    if (!res.ok) { toast.error('Failed'); return }
    toast.success(locale === 'fa' ? 'ذخیره شد' : 'Saved')
    setQuestion(''); setAnswer(''); setShowForm(false)
    load()
  }

  async function toggleFaq(id: string, enabled: boolean) {
    await fetch('/api/faqs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    })
    load()
  }

  async function deleteFaq(id: string) {
    await fetch(`/api/faqs?id=${id}`, { method: 'DELETE' })
    toast.success(locale === 'fa' ? 'حذف شد' : 'Deleted')
    load()
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight flex items-center gap-2">
          <Bot className="h-5 w-5" />
          {locale === 'fa' ? 'پاسخگوی هوشمند FAQ' : 'Smart FAQ Auto-Responder'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === 'fa' ? 'پرسش‌های متداول و پاسخ‌های خودکار. هوش مصنوعی پیام بازدیدکننده را با این پرسش‌ها تطبیق می‌دهد.' : 'Define Q&A pairs. AI matches visitor messages semantically and auto-sends the answer.'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="font-display text-base">{locale === 'fa' ? 'پرسش و پاسخ‌ها' : 'Q&A Pairs'}</CardTitle>
            <Button onClick={() => setShowForm(!showForm)} className="gap-2">
              <Plus className="h-4 w-4" />
              {locale === 'fa' ? 'افزودن' : 'Add'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {showForm && (
            <form onSubmit={createFaq} className="space-y-3 border-b border-border p-4">
              <div className="space-y-2">
                <Label>{locale === 'fa' ? 'سوال' : 'Question'}</Label>
                <Input value={question} onChange={e => setQuestion(e.target.value)} required dir="auto" />
              </div>
              <div className="space-y-2">
                <Label>{locale === 'fa' ? 'پاسخ' : 'Answer'}</Label>
                <Textarea value={answer} onChange={e => setAnswer(e.target.value)} required dir="auto" rows={3} />
              </div>
              <Button type="submit" className="gap-2">{locale === 'fa' ? 'ذخیره' : 'Save'}</Button>
            </form>
          )}
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{locale === 'fa' ? 'در حال بارگذاری...' : 'Loading...'}</div>
          ) : faqs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{locale === 'fa' ? 'هنوز پرسشی ثبت نشده است' : 'No Q&A pairs yet'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {faqs.map(faq => (
                <li key={faq.id} className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Switch checked={faq.enabled} onCheckedChange={(v) => toggleFaq(faq.id, v)} />
                      <span className="text-sm font-medium truncate">{faq.question}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground truncate">{faq.answer}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {faq.enabled ? (
                      <Badge variant="outline" className="h-5 px-1 text-[9px] text-turquoise border-turquoise">{locale === 'fa' ? 'فعال' : 'Active'}</Badge>
                    ) : (
                      <Badge variant="outline" className="h-5 px-1 text-[9px] text-muted-foreground">{locale === 'fa' ? 'غیرفعال' : 'Disabled'}</Badge>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteFaq(faq.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
