'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Search, Users, MessageSquare, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'

type Contact = {
  id: string
  name: string | null
  email: string | null
  avatarUrl: string | null
  identifier: string
  identifierType: string
  lastSeenAt: string
  createdAt: string
  _count?: { conversations: number }
}

export function ContactsPanel() {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const locale = useLocale()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/contacts')
    const data = await res.json()
    setContacts(data.contacts ?? [])
    setLoading(false)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const filtered = contacts.filter(c =>
    !search ||
    c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase()) ||
    c.identifier.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {locale === 'fa' ? 'مخاطبین' : 'Contacts'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === 'fa' ? 'بازدیدکنندگان و مشتریانی که با آن‌ها گفت‌وگو کرده‌اید.' : 'Visitors and customers you have chatted with.'}
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={tc('search')}
          className="ps-8"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Users className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {locale === 'fa' ? 'هنوز مخاطبی وجود ندارد' : 'No contacts yet'}
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-[calc(100vh-280px)] scroll-thin">
              <ul className="divide-y divide-border">
                {filtered.map(contact => (
                  <li key={contact.id}>
                    <ContactRow contact={contact} locale={locale} />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ContactRow({ contact, locale }: { contact: Contact; locale: string }) {
  const [expanded, setExpanded] = useState(false)
  const [conversations, setConversations] = useState<any[]>([])
  const [loadingConvs, setLoadingConvs] = useState(false)

  async function loadConversations() {
    if (expanded) { setExpanded(false); return }
    setLoadingConvs(true)
    const res = await fetch(`/api/contacts/${contact.id}/conversations`)
    const data = await res.json()
    setConversations(data.conversations ?? [])
    setLoadingConvs(false)
    setExpanded(true)
  }

  const displayName = contact.name || contact.email || 'Visitor'
  const initials = displayName.slice(0, 2).toUpperCase()

  return (
    <div>
      <button
        onClick={loadConversations}
        className="flex w-full items-center gap-3 p-4 text-start transition-colors hover:bg-sidebar-accent/50"
      >
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarFallback className="bg-saffron/15 text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {new Date(contact.lastSeenAt).toLocaleDateString(locale === 'fa' ? 'fa-IR' : 'en-US')}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            {contact.email ? (
              <span className="truncate text-xs text-muted-foreground" dir="ltr">{contact.email}</span>
            ) : (
              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                {locale === 'fa' ? 'بازدیدکننده' : 'visitor'}
              </Badge>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border bg-muted/30 p-4">
          {loadingConvs ? (
            <div className="text-sm text-muted-foreground">{locale === 'fa' ? 'در حال بارگذاری...' : 'Loading...'}</div>
          ) : conversations.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {locale === 'fa' ? 'گفت‌وگویی یافت نشد' : 'No conversations found'}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                {locale === 'fa' ? 'گفت‌وگوها' : 'Conversations'} ({conversations.length})
              </p>
              {conversations.map(conv => (
                <div key={conv.id} className="flex items-center gap-2 rounded-lg border border-border bg-card p-2 text-sm">
                  <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{conv.lastMessagePreview || '—'}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-4 px-1 text-[9px]',
                      conv.status === 'open' && 'border-turquoise text-turquoise',
                      conv.status === 'closed' && 'text-muted-foreground',
                    )}
                  >
                    {conv.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(conv.lastMessageAt).toLocaleDateString(locale === 'fa' ? 'fa-IR' : 'en-US')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
