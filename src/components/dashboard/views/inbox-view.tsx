'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { io, type Socket } from 'socket.io-client'

// Note: useSession is already imported above and used below for the agent ID.
// The realtime connection depends on session status - it must not attempt to
// fetch /api/realtime-token until the session is authenticated.
import { RT_EVENTS, joinConversation, leaveConversation, sendTypingStart, sendTypingStop, sendRead } from '@/lib/realtime-client'
import {
  applyMessageToConversationList,
  mergeMessages,
  mergeSingle,
} from '@/lib/inbox-helpers'
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
  const { data: session, status: sessionStatus } = useSession()
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

  // Latest-value refs (16, 17): socket event handlers are registered ONCE
  // at mount and capture the values that existed at mount time. Without
  // these refs, the handlers would read STALE values (selectedId from
  // mount, loadConversations from mount, etc.) forever. The refs are kept
  // in sync with state via the small effects below, and the handlers read
  // from .current.
  const selectedIdRef = useRef<string | null>(null)
  const loadConversationsRef = useRef<(() => Promise<void>) | null>(null)
  const conversationsRef = useRef<Conversation[]>(conversations)
  const connectedRef = useRef(false)

  // (24) race-safety: bumped on each conversation switch. In-flight fetch
  // results check this generation before applying - a slow A response
  // cannot overwrite B's messages after the user switches.
  const msgReqGenRef = useRef(0)

  // (26) unread dedup: tracks message IDs whose unread-count effect has
  // already fired, so a duplicate delivery does not re-increment.
  const unreadSeenRef = useRef<Set<string>>(new Set())

  // Load conversation list (depends on current filter)
  const loadConversations = useCallback(async () => {
    const res = await fetch(`/api/conversations?status=${filter}`)
    const data = await res.json()
    setConversations(data.conversations ?? [])
    setLoading(false)
  }, [filter])

  // Keep refs in sync with state so socket handlers (registered once at
  // mount) read the CURRENT value without re-running the connect effect.
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { conversationsRef.current = conversations }, [conversations])
  useEffect(() => { loadConversationsRef.current = loadConversations }, [loadConversations])

  // Connect to realtime service - only when session is authenticated.
  // If we attempt the token fetch before the session is ready,
  // /api/realtime-token returns 401 and the socket never connects. This
  // was the root cause of Socket.IO delivery failing in the sandbox (the
  // dashboard mounted InboxView before useSession resolved, so the token
  // fetch 401'd silently).
  //
  // (18) socket cleanup: we OWN the socket via a LOCAL variable s (NOT
  // the React socket state, whose captured-closure value may still be
  // null when cleanup runs). The cleanup captures the local s and
  // disconnects the ACTUAL socket this effect created - no zombie
  // sockets after unmount / remount. React state is cleared ONLY if it
  // still refers to this effect's socket (so a newer mount that already
  // produced a fresher socket is not nulled out).
  useEffect(() => {
    if (sessionStatus !== 'authenticated') return
    let active = true
    let s: Socket | null = null
    ;(async () => {
      try {
        const tokenRes = await fetch('/api/realtime-token')
        if (!tokenRes.ok) return
        const { token } = await tokenRes.json()
        if (!active) return
        // CRITICAL: passing '/api/realtime' as the URL to io() makes Socket.IO
        // treat it as a NAMESPACE, not a path. On Vercel we pass an empty URL
        // (default namespace) and route via path: '/api/realtime' which
        // Vercel forwards to the root-level api/realtime.ts function.
        // Transports: websocket-only on Vercel (no polling fallback).
        const isVercel = process.env.NEXT_PUBLIC_VERCEL === '1' || process.env.VERCEL === '1'
        const explicit = process.env.NEXT_PUBLIC_REALTIME_URL
        const socketUrl = isVercel ? '' : (explicit || '/?XTransformPort=3003')
        const isApiRealtime = socketUrl.includes('/api/realtime')
        s = io(socketUrl, {
          path: isVercel || isApiRealtime ? '/api/realtime' : '/',
          addTrailingSlash: false,
          auth: { token },
          transports: isVercel || isApiRealtime ? ['websocket'] : ['websocket', 'polling'],
          reconnection: true,
        })
        if (!active) { s.disconnect(); s = null; return }

        s.on('connect', () => {
          connectedRef.current = true
          setConnected(true)
        })
        s.on('disconnect', () => {
          connectedRef.current = false
          setConnected(false)
          // (25) clear typing state on disconnect - don't leave a stale
          // 'visitor is typing' indicator pointing at the wrong conversation.
          setTyping(false)
        })

        // (23) reconnect room membership: re-join the CURRENTLY selected
        // conversation (using the latest selectedIdRef - never a stale
        // value from mount time). Also sendRead to reconcile unread
        // counts, and fetch history once to catch any messages missed
        // while disconnected. Do NOT rejoin a conversation that is no
        // longer selected (the ref reads the CURRENT value, so if the
        // user has switched away by the time reconnect fires, we skip).
        s.io.on('reconnect', () => {
          const conv = selectedIdRef.current
          if (conv) {
            joinConversation(s as Socket, conv)
            sendRead(s as Socket, conv)
            // (21) reconnect reconciliation - ONE immediate history fetch.
            fetch(`/api/conversations/${conv}/messages`)
              .then(r => r.json())
              .then(d => {
                // Guard against the user having switched away while the
                // fetch was in flight.
                if (conv !== selectedIdRef.current) return
                setMessages(prev => mergeMessages(prev, d.messages ?? []))
              })
              .catch(() => {})
          }
          // (22) reconnect reconciliation - ONE list reload to catch any
          // new conversations that arrived while disconnected.
          loadConversationsRef.current?.()
        })

        // New conversation arrives - (17) use the LATEST loadConversations
        // (with the CURRENT filter), NOT the stale closure from mount.
        s.on(RT_EVENTS.CONVERSATION_NEW, () => {
          loadConversationsRef.current?.()
        })
        s.on(RT_EVENTS.CONVERSATION_UPDATED, () => {
          loadConversationsRef.current?.()
        })

        // New message arrives
        s.on(RT_EVENTS.MESSAGE_NEW, (msg: Message) => {
          // (16) read the CURRENT selected conversation from the ref -
          // the effect closure captured the value at mount, which is
          // long-stale by the time a message actually arrives.
          const currentSelected = selectedIdRef.current
          const isSelected = msg.conversationId === currentSelected

          // (19 + 26) apply the pure helper: immutable move-to-top,
          // lastMessagePreview update, and unread-once-by-message-id.
          // Reads the latest conversations list from conversationsRef
          // (NOT a stale closure).
          const result = applyMessageToConversationList(
            conversationsRef.current,
            msg,
            isSelected,
            unreadSeenRef.current,
          )
          unreadSeenRef.current = result.seen

          if (result.isNew) {
            // Conversation not in the current list - reload (with the
            // current filter via the ref, NOT the stale closure).
            loadConversationsRef.current?.()
          } else {
            setConversations(result.list)
          }

          // (20 + 27) central message merge for the open thread: if
          // this message belongs to the selected conversation, merge it
          // in by ID. Same message delivered via POST response +
          // Socket.IO broadcast ends up exactly once (ID dedup).
          if (isSelected) {
            setMessages(prev => mergeSingle(prev, msg))
          }
        })

        // Typing indicator (16, 25): use the CURRENT selectedId from the
        // ref. A typing:start for conversation A must NEVER show while B
        // is open - the isSelected guard handles that. The
        // open-conversation effect below also clears any leftover typing
        // state on every switch.
        s.on(RT_EVENTS.TYPING_START, (data: { conversationId: string; senderType: string }) => {
          if (data.conversationId === selectedIdRef.current && data.senderType === 'visitor') {
            setTyping(true)
          }
        })
        s.on(RT_EVENTS.TYPING_STOP, (data: { conversationId: string; senderType: string }) => {
          if (data.conversationId === selectedIdRef.current) {
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
      const sock = s
      if (sock) {
        // Remove ALL listeners we registered (socket + Manager) so
        // reconnect handlers don't fire on a dead socket after teardown.
        sock.removeAllListeners()
        sock.io.removeAllListeners()
        sock.disconnect()
        // Clear React state ONLY if it still points at our socket -
        // a remount that already created a newer socket must not be
        // nulled out here.
        setSocket(prev => (prev === sock ? null : prev))
        setConnected(false)
        connectedRef.current = false
        setTyping(false)
      }
      // (25) clear the user's own typing-stop timeout on teardown so it
      // does not fire after the socket (and the component) are gone.
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus])

  // Reload when filter changes
  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  // (22) conversation-list polling - TRUE FALLBACK ONLY.
  // The interval runs continuously, but SKIPS work when Socket.IO is
  // connected. When realtime drops, the next tick picks up the slack.
  // Reconnect reconciliation (one list reload) is handled in the
  // 'reconnect' handler above - this interval does NOT double-fire on
  // reconnect. ONE interval per mount - no duplicates.
  useEffect(() => {
    const interval = setInterval(() => {
      if (connectedRef.current) return // realtime is up - no list polling
      loadConversationsRef.current?.()
    }, 10000)
    return () => clearInterval(interval)
  }, [])

  // Open-conversation effect: join room, fetch history, run fallback
  // message polling, and clean up typing state on switch / unmount.
  //
  // (24) race-safe: msgReqGenRef is bumped on every switch; in-flight
  // fetch results check the generation before applying - a slow A
  // response cannot overwrite B's messages after the user switches.
  //
  // (21) polling as fallback: the 8s interval runs continuously but
  // SKIPS work when realtime is connected. On reconnect, the
  // 'reconnect' handler does a one-shot reconciliation fetch.
  //
  // (25) typing cleanup: typing state is cleared on every switch; the
  // user's pending typing-stop timeout is fired (for the OLD
  // conversation) on cleanup, then cleared.
  useEffect(() => {
    if (!selectedId) return
    const gen = ++msgReqGenRef.current

    // (25) clear typing state when conversation changes - typing:start
    // from the OLD conversation must not linger in the NEW view.
    setTyping(false)

    // Join the conversation room (if the socket is already up)
    if (socket && socket.connected) {
      joinConversation(socket, selectedId)
      sendRead(socket, selectedId)
    }

    // Fetch message history - merge by ID with anything already in
    // state (e.g. a realtime message that arrived before this fetch
    // resolved - (20) protects against the history erasing it).
    fetch(`/api/conversations/${selectedId}/messages`)
      .then(r => r.json())
      .then(d => {
        if (gen !== msgReqGenRef.current) return // stale - user switched
        setMessages(prev => mergeMessages(prev, d.messages ?? []))
      })
      .catch(() => {})

    // Polling fallback for messages in the open conversation.
    // Socket.IO is primary; this ONLY fires when realtime is down.
    const msgInterval = setInterval(() => {
      if (connectedRef.current) return // realtime up - no polling
      const pollGen = msgReqGenRef.current
      fetch(`/api/conversations/${selectedId}/messages`)
        .then(r => r.json())
        .then(d => {
          if (pollGen !== msgReqGenRef.current) return // stale
          setMessages(prev => mergeMessages(prev, d.messages ?? []))
        })
        .catch(() => {})
    }, 8000)

    return () => {
      clearInterval(msgInterval)
      // (24) invalidate any in-flight fetch - its result must NOT
      // overwrite the NEXT conversation's messages.
      msgReqGenRef.current++

      // (25) if the user was typing in this conversation, fire typing:stop
      // for the OLD conversation (captured in this closure) before
      // clearing the timeout - otherwise the server thinks the user is
      // still typing in a conversation they have left.
      if (typingTimeoutRef.current && socket && socket.connected) {
        sendTypingStop(socket, selectedId)
        clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = null
      }
      // Leave the OLD conversation room
      if (socket && socket.connected) {
        leaveConversation(socket, selectedId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, socket])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Send reply - (27) reply echo dedup: the POST response and the
  // Socket.IO broadcast of the same message both go through the central
  // ID-based merge, so the message renders exactly once.
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
      // (20 + 27) merge via ID - if the Socket.IO echo arrives first,
      // this is a no-op (same ID, same/newer timestamp -> merge keeps
      // whichever is newer, ties go to incoming server view). If the
      // echo arrives later, the merge in the message:new handler is a
      // no-op. Either way: ONE render of the message.
      setMessages(prev => mergeSingle(prev, data.message as Message))
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
