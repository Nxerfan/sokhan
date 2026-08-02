'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { io, type Socket } from 'socket.io-client'
import { RT_EVENTS, joinConversation, leaveConversation, sendTypingStart, sendTypingStop, sendRead } from '@/lib/realtime-client'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Search, Inbox as InboxIcon, Circle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type Contact = { id: string; name: string | null; email: string | null; avatarUrl: string | null }
type Conversation = {
  id: string
  status: string
  channel: string
  lastMessagePreview: string
  lastMessageAt: string
  unreadCount: number
  assignedUserId: string | null
  departmentId: string | null
  contact: Contact
  assignedUser: { id: string; name: string | null } | null
  department: { id: string; name: string } | null
}
type Message = {
  id: string
  conversationId: string
  senderType: string
  senderUserId: string | null
  contentType: string
  content: { text?: string; attachments?: Array<{ url: string; type: string; name: string }> }
  createdAt: string
}

export function InboxView() {
  const t = useTranslations()
  const { data: session } = useSession()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [replyText, setReplyText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [typing, setTyping] = useState(false)
  const [filter, setFilter] = useState('open')
  const [search, setSearch] = useState('')
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Load conversation list
  const loadConversations = useCallback(async () => {
    const res = await fetch(`/api/conversations?status=${filter}`)
    const data = await res.json()
    setConversations(data.conversations ?? [])
    setLoading(false)
  }, [filter])

  // Connect to realtime service
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const tokenRes = await fetch('/api/realtime-token')
        if (!tokenRes.ok) return
        const { token } = await tokenRes.json()
        const s = io('/?XTransformPort=3003', {
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnection: true,
        })
        if (!active) { s.disconnect(); return }
        s.on('connect', () => setConnected(true))
        s.on('disconnect', () => setConnected(false))
        // New conversation arrives
        s.on(RT_EVENTS.CONVERSATION_NEW, () => loadConversations())
        // Conversation updated (assignment/status change)
        s.on(RT_EVENTS.CONVERSATION_UPDATED, () => loadConversations())
        // New message arrives
        s.on(RT_EVENTS.MESSAGE_NEW, (msg: Message & { isNewConversation?: boolean }) => {
          // Update conversation list (bump to top, update preview)
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id === msg.conversationId)
            if (idx === -1) {
              // New conversation — reload the list
              loadConversations()
              return prev
            }
            const updated = [...prev]
            const conv = updated[idx]
            updated[idx] = {
              ...conv,
              lastMessagePreview: msg.content?.text?.slice(0, 120) || '[attachment]',
              lastMessageAt: msg.createdAt,
              unreadCount: msg.senderType === 'contact' && msg.conversationId !== selectedId
                ? conv.unreadCount + 1
                : conv.unreadCount,
            }
            // Move to top
            updated.splice(idx, 1)
            updated.unshift(updated[0])
            return updated
          })
          // If this message is for the currently open conversation, append it
          if (msg.conversationId === selectedId) {
            setMessages(prev => [...prev, msg])
          }
        })
        // Typing indicator
        s.on(RT_EVENTS.TYPING_START, (data: { conversationId: string; senderType: string }) => {
          if (data.conversationId === selectedId && data.senderType === 'visitor') {
            setTyping(true)
          }
        })
        s.on(RT_EVENTS.TYPING_STOP, (data: { conversationId: string; senderType: string }) => {
          if (data.conversationId === selectedId) {
            setTyping(false)
          }
        })
        setSocket(s)
      } catch (e) {
        console.error('realtime connect failed', e)
      }
    })()
    return () => {
      active = false
      if (socket) { socket.disconnect(); setSocket(null) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload when filter changes
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  // Polling fallback — reload conversations every 5 seconds.
  // This ensures the dashboard picks up new conversations even if the Socket.IO
  // real-time connection fails (e.g., through Caddy in certain environments).
  // In production with Redis + direct WebSocket, this is a safety net, not the
  // primary delivery path.
  useEffect(() => {
    const interval = setInterval(() => {
      loadConversations()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadConversations])

  // Load messages when conversation selected
  useEffect(() => {
    if (!selectedId) return
    // Join the conversation room
    if (socket && socket.connected) {
      joinConversation(socket, selectedId)
      sendRead(socket, selectedId)
    }
    // Fetch message history
    fetch(`/api/conversations/${selectedId}/messages`)
      .then(r => r.json())
      .then(d => setMessages(d.messages ?? []))

    // Polling fallback for messages in the open conversation (3s)
    const msgInterval = setInterval(() => {
      fetch(`/api/conversations/${selectedId}/messages`)
        .then(r => r.json())
        .then(d => {
          if (d.messages && d.messages.length !== messages.length) {
            setMessages(d.messages)
          }
        })
        .catch(() => {})
    }, 3000)

    return () => {
      clearInterval(msgInterval)
      if (socket && socket.connected) {
        leaveConversation(socket, selectedId)
      }
    }
  }, [selectedId, socket])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Send reply
  const sendReply = async () => {
    if (!replyText.trim() || !selectedId) return
    setSending(true)
    if (socket) sendTypingStop(socket, selectedId)
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: replyText.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to send')
        return
      }
      setMessages(prev => [...prev, data.message])
      setReplyText('')
      loadConversations()
    } finally {
      setSending(false)
    }
  }

  // Handle typing in the reply box
  const onReplyInput = (value: string) => {
    setReplyText(value)
    if (!socket || !selectedId) return
    sendTypingStart(socket, selectedId)
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    typingTimeoutRef.current = setTimeout(() => {
      sendTypingStop(socket, selectedId)
    }, 1500)
  }

  // Change conversation status
  const changeStatus = async (status: string) => {
    if (!selectedId) return
    await fetch(`/api/conversations/${selectedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    loadConversations()
  }

  const filteredConversations = conversations.filter(c =>
    !search || c.contact.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.lastMessagePreview.toLowerCase().includes(search.toLowerCase())
  )

  const selected = conversations.find(c => c.id === selectedId)

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Conversation list */}
      <div className="flex w-72 shrink-0 flex-col border-e border-border bg-card/30 lg:w-80">
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t('dashboard.openConversations')}</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="all">{t('nav.contacts')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="h-8 ps-8"
            />
          </div>
        </div>
        <ScrollArea className="flex-1 scroll-thin">
          {loading ? (
            <div className="p-4 text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <InboxIcon className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t('dashboard.noConversations')}</p>
            </div>
          ) : (
            <ul>
              {filteredConversations.map(conv => (
                <li key={conv.id}>
                  <button
                    onClick={() => setSelectedId(conv.id)}
                    className={cn(
                      'flex w-full items-start gap-3 border-b border-border p-3 text-start transition-colors hover:bg-sidebar-accent/50',
                      selectedId === conv.id && 'bg-sidebar-accent',
                    )}
                  >
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarFallback className="bg-saffron/15 text-xs">
                        {(conv.contact.name || conv.contact.email || '?').slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {conv.contact.name || conv.contact.email || 'Visitor'}
                        </span>
                        {conv.unreadCount > 0 && (
                          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-saffron px-1 text-[10px] font-semibold text-saffron-foreground animate-saffron-pulse">
                            {conv.unreadCount}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {conv.lastMessagePreview || '—'}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <Circle className={cn('h-1.5 w-1.5', conv.status === 'open' ? 'fill-turquoise text-turquoise' : 'fill-muted-foreground text-muted-foreground')} />
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {conv.assignedUser && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px]">
                            {conv.assignedUser.name || 'Agent'}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>

      {/* Thread view */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <InboxIcon className="mx-auto h-12 w-12 text-muted-foreground/30" />
              <p className="mt-2 text-sm text-muted-foreground">{t('dashboard.noConversations')}</p>
              <p className="mt-1 text-xs text-muted-foreground/60">{t('dashboard.noConversationsHint')}</p>
              {!connected && (
                <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('common.loading')}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-saffron/15 text-[10px]">
                    {(selected.contact.name || selected.contact.email || '?').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <span className="text-sm font-medium">{selected.contact.name || selected.contact.email || 'Visitor'}</span>
                  {selected.contact.email && (
                    <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{selected.contact.email}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selected.status} onValueChange={changeStatus}>
                  <SelectTrigger className="h-7 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 scroll-thin">
              <div className="space-y-3 p-4">
                {messages.map(msg => (
                  <MessageBubble key={msg.id} msg={msg} agentId={session?.user?.id} />
                ))}
                {typing && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: '0ms' }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: '150ms' }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: '300ms' }} />
                    </span>
                    {t('dashboard.comingSoon')}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Reply box */}
            <div className="border-t border-border p-3">
              <div className="flex items-end gap-2">
                <Input
                  value={replyText}
                  onChange={e => onReplyInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      sendReply()
                    }
                  }}
                  placeholder={t('command.placeholder')}
                  className="flex-1"
                  dir="auto"
                />
                <Button onClick={sendReply} disabled={sending || !replyText.trim()} size="icon" className="h-9 w-9 shrink-0 bg-ink text-ink-foreground hover:bg-ink/90">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MessageBubble({ msg, agentId }: { msg: Message; agentId?: string }) {
  const isAgent = msg.senderType === 'agent'
  const isSystem = msg.senderType === 'system'
  const isOwn = isAgent && msg.senderUserId === agentId

  if (isSystem) {
    return (
      <div className="text-center text-xs text-muted-foreground py-1">
        {msg.content.text}
      </div>
    )
  }

  return (
    <div className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
          isOwn
            ? 'bg-ink text-ink-foreground rounded-be-sm'
            : 'bg-muted rounded-bs-sm',
        )}
        dir="auto"
      >
        {msg.content.text && <p>{msg.content.text}</p>}
        {msg.content.attachments?.map((att, i) => (
          <div key={i} className="mt-1">
            {att.type === 'image' ? (
              <img src={att.url} alt={att.name} className="max-w-full rounded-lg" />
            ) : (
              <a href={att.url} download={att.name} className="text-xs underline">
                {att.name}
              </a>
            )}
          </div>
        ))}
        <span className={cn('mt-1 block text-[10px]', isOwn ? 'text-ink-foreground/60' : 'text-muted-foreground')}>
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}
