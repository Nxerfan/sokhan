/**
 * Sukhan Widget — UI rendering.
 *
 * Self-contained widget rendered with vanilla DOM (no framework dependency).
 *
 * Reliability contract:
 *   - Realtime config comes from the BACKEND `config.realtime` field
 *     (with optional `SukhanOptions.realtime` override taking priority).
 *     The widget passes the resolved config EXPLICITLY to `SukhanSocket`
 *     — no `window.__sukhan_api_url` global coupling.
 *   - ONE central message-merge function (`mergeMessages` / `ingestMessage`)
 *     keyed by `Message.id` is used for ALL ingestion paths: POST response,
 *     socket `message:new`, polling, history reload. Same id appears once.
 *   - Polling is a REAL fallback (only when socket disconnected; stops on
 *     reconnect + one immediate history reconcile).
 *   - Reconnect gap recovery: re-join current conversation + reconcile
 *     history once.
 *   - `destroy()` is idempotent + clears polling/typing/socket/DOM. Every
 *     async callback checks `this.destroyed` before touching state.
 */

import { ApiClient } from './api'
import { SukhanSocket } from './socket'
import type { SukhanSocketOptions } from './types'
import type { SukhanSocketDeps } from './socket'
import { mergeMessages, mergeMessage } from './merge'
import {
  HOSTED_API_URL,
  HOSTED_REALTIME_CONFIG,
  resolveRealtimeFromConfig,
  buildSocketIoScriptUrl,
  type RealtimeEndpointConfig,
} from './realtime-resolve'
import type {
  WidgetConfig,
  SukhanOptions,
  SukhanInstance,
  Message,
  SenderType,
} from './types'

const POWERED_BY: Record<'fa' | 'en', string> = {
  fa: 'نیرو گرفته از سُخن',
  en: 'Powered by Sukhan',
}

// ---------- Small DOM helpers (vanilla, no framework) ----------

type StyleProps = Partial<CSSStyleDeclaration>

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html != null) e.innerHTML = html
  return e
}

function css(node: HTMLElement, props: StyleProps): void {
  for (const k in props) {
    ;(node.style as unknown as Record<string, string>)[k] = String(
      (props as unknown as Record<string, unknown>)[k],
    )
  }
}

function hexA(hex: string, a: number): string {
  const h = (hex || '#E09A2B').replace('#', '')
  const padded = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(padded.slice(0, 2), 16)
  const g = parseInt(padded.slice(2, 4), 16)
  const b = parseInt(padded.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

function fmt(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function shapeClass(s: string): string {
  if (s === 'pill') return 'sk-pill'
  if (s === 'rounded') return 'sk-rounded'
  return 'sk-tab'
}

function storageKey(slug: string): string {
  return 'sukhan_visitor_' + slug
}

function getVisitorId(slug: string, override?: string): string {
  if (override) return override
  try {
    const key = storageKey(slug)
    const v = localStorage.getItem(key)
    if (v) return v
    const fresh = generateVisitorId()
    localStorage.setItem(key, fresh)
    return fresh
  } catch {
    return generateVisitorId()
  }
}

function generateVisitorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'vis_' + crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return 'vis_' + Date.now() + '_' + hex
  }
  return 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 14)
}

// ---------- Widget class ----------

interface WidgetInternalState {
  open: boolean
  config: WidgetConfig | null
  contactId: string | null
  conversationId: string | null
  token: string | null
  messages: Message[]
  connected: boolean
  locale: 'fa' | 'en'
  dir: 'rtl' | 'ltr'
  typingTimer?: ReturnType<typeof setTimeout>
}

/** Injected dependencies — production leaves undefined (uses real impls). */
export interface SukhanWidgetDeps {
  /** Custom ApiClient (for tests). */
  apiClient?: ApiClient
  /** Custom SukhanSocket constructor (for tests). */
  socketCtor?: new (opts: SukhanSocketOptions, deps?: SukhanSocketDeps) => SukhanSocket
}

export class SukhanWidget implements SukhanInstance {
  config: WidgetConfig | null = null
  private api: ApiClient
  private socket: SukhanSocket | null = null
  private readonly SocketCtor: new (opts: SukhanSocketOptions, deps?: SukhanSocketDeps) => SukhanSocket
  private container: HTMLElement
  private locale: 'fa' | 'en' | undefined
  private direction: 'rtl' | 'ltr' | undefined
  private disablePolling: boolean
  private visitorOverride?: { name?: string; email?: string; visitorId?: string }
  private options: SukhanOptions

  /**
   * Realtime config resolved from the backend `config.realtime` field
   * (with `SukhanOptions.realtime` override taking priority). Computed
   * in `init()` after `fetchConfig()` returns.
   */
  private clientScriptUrl: string = HOSTED_API_URL + '/socket.io.min.js'
  private realtimeConfig: RealtimeEndpointConfig = HOSTED_REALTIME_CONFIG

  /** Set by destroy() — every async callback checks this before touching state. */
  private destroyed = false

  private state: WidgetInternalState = {
    open: false,
    config: null,
    contactId: null,
    conversationId: null,
    token: null,
    messages: [],
    connected: false,
    locale: 'fa',
    dir: 'rtl',
  }

  // DOM refs (created in mount)
  private root!: HTMLElement
  private bodyEl!: HTMLElement
  private inputEl!: HTMLInputElement
  private sendBtn!: HTMLButtonElement
  private typingEl!: HTMLElement
  private launcher!: HTMLButtonElement
  private panel!: HTMLElement
  private pulseDot!: HTMLElement
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private csatShown = false
  private rootEl: HTMLElement | null = null

  constructor(options: SukhanOptions, __deps?: SukhanWidgetDeps) {
    const apiKey =
      options.apiKey ||
      (typeof window !== 'undefined'
        ? (window as unknown as { __SUKHAN_API_KEY?: string }).__SUKHAN_API_KEY
        : undefined) ||
      (typeof process !== 'undefined' && process.env ? process.env.SUKHAN_API_KEY : undefined)
    if (!apiKey) {
      throw new Error(
        'sukhan: apiKey is required. Pass it to initSukhan({ apiKey }) or set SUKHAN_API_KEY.',
      )
    }
    this.options = options
    this.api = __deps?.apiClient ?? new ApiClient(apiKey, options.apiUrl)
    this.SocketCtor = (__deps?.socketCtor ?? SukhanSocket) as typeof SukhanSocket
    // NOTE: NO window.__sukhan_api_url write — the socket receives its
    // config explicitly via SukhanSocketOptions (clientScriptUrl +
    // realtimeUrl + realtimePath + transports + addTrailingSlash).
    this.container = options.container || (typeof document !== 'undefined' ? document.body : ({} as HTMLElement))
    this.locale = options.locale
    this.direction = options.direction
    this.disablePolling = !!options.disablePolling
    this.visitorOverride = options.visitor
  }

  /** Fetch config + mount the widget. Idempotent (guarded by `__sukhan_mounted`). */
  async init(): Promise<void> {
    if (this.destroyed) return
    if (typeof document === 'undefined') return
    if ((window as unknown as { __sukhan_mounted?: boolean }).__sukhan_mounted) return
    ;(window as unknown as { __sukhan_mounted?: boolean }).__sukhan_mounted = true

    try {
      this.config = await this.api.fetchConfig()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sukhan] config fetch failed', e)
      return
    }
    if (this.destroyed) return // guard: destroy during async fetch
    // Compute the realtime endpoint config from the backend response,
    // with the optional SukhanOptions.realtime override taking priority.
    this.realtimeConfig = resolveRealtimeFromConfig(
      this.api.apiUrl,
      this.config?.realtime ?? null,
      this.options.realtime ?? null,
    )
    this.clientScriptUrl = buildSocketIoScriptUrl(this.api.apiUrl)
    if (this.destroyed) return
    this.mount(this.config)
  }

  /** Mount the launcher + panel onto the page. */
  private mount(config: WidgetConfig): void {
    this.state.config = config
    const locale = this.locale || (config.defaultLocale === 'en' ? 'en' : 'fa')
    this.state.locale = locale as 'fa' | 'en'
    const dir = this.direction || (config.defaultDirection === 'ltr' ? 'ltr' : 'rtl')
    this.state.dir = dir as 'rtl' | 'ltr'
    const accent = config.accentColor || '#E09A2B'
    const pos = config.position || 'bottom-start'
    let side: 'left' | 'right' = pos === 'bottom-start' ? 'left' : 'right'
    if (this.state.dir === 'rtl') side = pos === 'bottom-start' ? 'right' : 'left'

    this.injectStyles(accent)

    const root = el('div', 'sk-root') as HTMLElement
    root.setAttribute('dir', this.state.dir)
    css(root, { position: 'fixed', bottom: '20px', zIndex: '2147483000' })
    root.style[side] = '20px'
    this.root = root
    this.rootEl = root

    const launcher = el('button', 'sk-launcher ' + shapeClass(config.launcherShape)) as HTMLButtonElement
    launcher.setAttribute('aria-label', this.state.locale === 'fa' ? 'گفت‌وگو' : 'Open chat')
    css(launcher, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0E1116',
      color: '#FAF7F2',
      cursor: 'pointer',
      border: 'none',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      transition: 'transform .15s ease',
      padding: '0',
      position: 'relative',
    })
    launcher.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    launcher.onclick = () => this.toggle()
    this.launcher = launcher

    const pulseDot = el('span', 'sk-pulse')
    css(pulseDot, {
      position: 'absolute',
      top: '-2px',
      right: '-2px',
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      background: accent,
      border: '2px solid #fff',
    })
    pulseDot.style.display = 'none'
    launcher.appendChild(pulseDot)
    this.pulseDot = pulseDot

    const panel = el('div', 'sk-panel')
    css(panel, {
      position: 'absolute',
      bottom: '64px',
      width: '360px',
      maxWidth: 'calc(100vw - 40px)',
      height: '500px',
      maxHeight: 'calc(100vh - 100px)',
      background: '#fff',
      borderRadius: '16px',
      boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
      overflow: 'hidden',
      fontFamily: 'Vazirmatn,system-ui,sans-serif',
      display: 'flex',
      flexDirection: 'column',
      opacity: '0',
      transform: 'translateY(8px) scale(.98)',
      pointerEvents: 'none',
      transition: 'opacity .18s ease, transform .18s ease',
    })
    panel.style[side] = '0'
    this.panel = panel

    const header = el('div', 'sk-header')
    css(header, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '12px 16px',
      color: '#fff',
      background: accent,
      flexShrink: '0',
    })
    const logo = el('div', 'sk-logo')
    css(logo, {
      width: '28px',
      height: '28px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,.25)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: '0',
    })
    logo.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    const titleText = el('div', '')
    // SECURITY: config.name is tenant-controlled — use textContent, NEVER innerHTML.
    titleText.textContent = config.name || (this.state.locale === 'fa' ? 'گفت‌وگو' : 'Chat')
    css(titleText, { fontSize: '14px', fontWeight: '600', flex: '1' })
    const closeBtn = el('button', '', '×')
    css(closeBtn, {
      background: 'none',
      border: 'none',
      color: '#fff',
      fontSize: '20px',
      cursor: 'pointer',
      padding: '0',
      lineHeight: '1',
    })
    closeBtn.onclick = () => this.close()
    header.appendChild(logo)
    header.appendChild(titleText)
    header.appendChild(closeBtn)

    const bodyEl = el('div', 'sk-body')
    css(bodyEl, {
      flex: '1',
      overflowY: 'auto',
      padding: '16px',
      background: '#f7f5f1',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    })
    this.bodyEl = bodyEl

    const greeting = config.greetingTexts && config.greetingTexts[this.state.locale]
    if (greeting) {
      this.state.messages.push({
        id: 'greeting',
        conversationId: '',
        senderType: 'system' as SenderType,
        contentType: 'text',
        content: { text: greeting },
        createdAt: new Date().toISOString(),
      })
    }

    const typingEl = el('div', 'sk-typing')
    css(typingEl, {
      display: 'none',
      padding: '4px 16px',
      fontSize: '11px',
      color: '#888',
      background: '#f7f5f1',
    })
    typingEl.innerHTML =
      '<span style="display:inline-flex;gap:3px"><span class="sk-dot"></span><span class="sk-dot"></span><span class="sk-dot"></span></span>'
    this.typingEl = typingEl
    bodyEl.appendChild(typingEl)

    const inputBar = el('div', 'sk-input')
    css(inputBar, {
      display: 'flex',
      padding: '10px 12px',
      background: '#fff',
      borderTop: '1px solid #eee',
      gap: '8px',
      flexShrink: '0',
    })
    const inputEl = el('input') as HTMLInputElement
    inputEl.setAttribute(
      'placeholder',
      this.state.locale === 'fa' ? 'پیام بنویسید…' : 'Type a message…',
    )
    css(inputEl, {
      flex: '1',
      border: 'none',
      outline: 'none',
      fontSize: '14px',
      background: 'transparent',
      color: '#0E1116',
      fontFamily: 'inherit',
    })
    inputEl.setAttribute('autocomplete', 'off')
    this.inputEl = inputEl

    const sendBtn = el('button', '', '') as HTMLButtonElement
    sendBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>'
    css(sendBtn, {
      background: accent,
      color: '#fff',
      border: 'none',
      borderRadius: '8px',
      width: '34px',
      height: '34px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: '0',
    })
    sendBtn.onclick = () => this.sendMessage()
    this.sendBtn = sendBtn
    inputEl.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendMessage()
      }
    }
    inputEl.oninput = () => {
      if (this.socket && this.state.conversationId) {
        this.socket.send('typing:start', { conversationId: this.state.conversationId })
        clearTimeout(this.state.typingTimer)
        this.state.typingTimer = setTimeout(() => {
          this.socket?.send('typing:stop', { conversationId: this.state.conversationId })
        }, 1500)
      }
    }
    inputBar.appendChild(inputEl)
    inputBar.appendChild(sendBtn)

    panel.appendChild(header)
    panel.appendChild(bodyEl)

    if (this.isFreePlan()) {
      const badge = el('a', 'sk-powered')
      badge.href = 'https://sukhan.chat'
      badge.target = '_blank'
      badge.rel = 'noopener noreferrer'
      css(badge, {
        display: 'block',
        padding: '4px 12px 6px',
        background: '#fff',
        borderTop: '1px solid #f0eee9',
        fontSize: '10px',
        color: '#999',
        textAlign: 'center',
        textDecoration: 'none',
        flexShrink: '0',
      })
      badge.textContent = POWERED_BY[this.state.locale]
      panel.appendChild(badge)
    }

    panel.appendChild(inputBar)
    root.appendChild(panel)
    root.appendChild(launcher)
    this.container.appendChild(root)

    this.renderMessages()
    this.identifyVisitor()
  }

  private isFreePlan(): boolean {
    return !this.config?.plan || this.config.plan === 'free'
  }

  // ---------- Panel open/close ----------
  toggle(): void {
    this.state.open ? this.close() : this.open()
  }
  open(): void {
    this.state.open = true
    css(this.panel, {
      opacity: '1',
      transform: 'translateY(0) scale(1)',
      pointerEvents: 'auto',
    })
    this.pulseDot.style.display = 'none'
    setTimeout(() => this.inputEl && this.inputEl.focus(), 200)
  }
  close(): void {
    this.state.open = false
    css(this.panel, {
      opacity: '0',
      transform: 'translateY(8px) scale(.98)',
      pointerEvents: 'none',
    })
  }

  // ---------- Visitor identification ----------
  private identifyVisitor(): void {
    if (this.destroyed) return
    const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
    this.api
      .identifyVisitor({
        visitorId,
        email: this.visitorOverride?.email,
        name: this.visitorOverride?.name,
      })
      .then((data) => {
        if (this.destroyed) return // guard: destroy during async identify
        this.state.contactId = data.contactId
        this.state.conversationId = data.conversationId
        this.state.token = data.realtimeToken
        this.connectSocket()
        if (data.conversationId) this.loadMessages()
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[sukhan] identify failed', e)
      })
  }

  private loadMessages(): void {
    if (this.destroyed) return
    if (!this.state.conversationId || !this.state.token) return
    this.api.loadMessages(this.state.token, this.state.conversationId).then((messages) => {
      if (this.destroyed) return // guard: destroy during async load
      // Central merge: dedup by id, stable chronological order.
      this.state.messages = mergeMessages(this.state.messages, messages)
      this.renderMessages()
    })
  }

  /**
   * Central message ingestion — used by ALL ingestion paths (POST
   * response, socket `message:new`, polling). Dedup by id; server-updated
   * copy replaces stale local; stable chronological order.
   */
  private ingestMessage(m: Message): void {
    if (this.destroyed) return
    if (!m || !m.id) return
    this.state.messages = mergeMessage(this.state.messages, m)
    this.renderMessages()
    if (!this.state.open && this.pulseDot) {
      this.pulseDot.style.display = 'block'
    }
    if (
      m.senderType === 'system' &&
      m.content &&
      m.content.text &&
      (m.content.text.indexOf('closed') >= 0 ||
        m.content.text.indexOf('بسته') >= 0 ||
        m.content.text.indexOf('resolved') >= 0 ||
        m.content.text.indexOf('حل') >= 0)
    ) {
      this.showCsatSurvey()
    }
  }

  // ---------- Socket ----------
  private connectSocket(): void {
    if (this.destroyed) return
    if (!this.state.token) return
    if (this.socket) return
    this.socket = new this.SocketCtor({
      token: this.state.token,
      clientScriptUrl: this.clientScriptUrl,
      realtimeUrl: this.realtimeConfig.url,
      realtimePath: this.realtimeConfig.path,
      transports: this.realtimeConfig.transports,
      addTrailingSlash: this.realtimeConfig.addTrailingSlash,
    })
    this.socket.onConnect = () => {
      if (this.destroyed) return
      this.state.connected = true
      this.stopPolling() // socket connected → no polling
      if (this.state.conversationId) {
        this.socket?.send('conversation:join', this.state.conversationId)
      }
    }
    this.socket.onReconnect = () => {
      if (this.destroyed) return
      this.state.connected = true
      this.stopPolling() // socket reconnected → stop polling
      // Reconnect gap recovery: (1) re-join current conversation room,
      // (2) fetch/reconcile history once (dedup by id).
      if (this.state.conversationId) {
        this.socket?.send('conversation:join', this.state.conversationId)
      }
      this.reconcileHistory()
    }
    this.socket.onTokenExpired = async () => {
      if (this.destroyed) return null
      try {
        const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
        const data = await this.api.identifyVisitor({
          visitorId,
          email: this.visitorOverride?.email,
          name: this.visitorOverride?.name,
        })
        if (this.destroyed) return null
        this.state.token = data.realtimeToken
        if (data.conversationId && !this.state.conversationId) {
          this.state.conversationId = data.conversationId
        }
        return data.realtimeToken
      } catch {
        return null
      }
    }
    this.socket.on('disconnect', () => {
      if (this.destroyed) return
      this.state.connected = false
      this.maybeStartPolling() // socket disconnected → enable fallback
    })
    this.socket.on('message:new', (msg) => {
      this.ingestMessage(msg as Message)
    })
    this.socket.on('conversation:updated', (data) => {
      if (this.destroyed) return
      const d = data as { changes?: { status?: string } }
      if (d && d.changes && d.changes.status === 'closed') {
        this.showCsatSurvey()
      }
    })
    this.socket.on('typing:start', (data) => {
      if (this.destroyed) return
      const d = data as { senderType?: string }
      if (d && d.senderType === 'agent') {
        this.typingEl.style.display = 'block'
        this.scrollBody()
      }
    })
    this.socket.on('typing:stop', () => {
      if (this.destroyed) return
      this.typingEl.style.display = 'none'
    })
    this.socket.connect()
  }

  /**
   * Reconnect gap recovery: fetch the current conversation history once
   * and dedup with the local state (server-updated copies replace stale
   * local copies). Best-effort — silent on failure.
   */
  private reconcileHistory(): void {
    if (this.destroyed) return
    if (!this.state.conversationId || !this.state.token) return
    this.api
      .loadMessages(this.state.token, this.state.conversationId)
      .then((messages) => {
        if (this.destroyed) return
        this.state.messages = mergeMessages(this.state.messages, messages)
        this.renderMessages()
      })
      .catch(() => {
        // silent — best-effort reconcile
      })
  }

  // ---------- Send ----------
  send(text: string): Promise<void> {
    if (this.inputEl) this.inputEl.value = text
    return this.sendMessage()
  }

  private sendMessage(): Promise<void> {
    if (this.destroyed) return Promise.resolve()
    if (!this.inputEl) return Promise.resolve()
    const text = this.inputEl.value.trim()
    if (!text || !this.state.token) return Promise.resolve()
    this.inputEl.value = ''
    return this.api
      .sendMessage(this.state.token, text)
      .then((data) => {
        if (this.destroyed) return // guard: destroy during async send
        if (data.message) {
          // Central merge — POST response dedups against any socket
          // delivery of the same message id.
          this.ingestMessage(data.message)
        }
        if (data.conversationId && data.conversationId !== this.state.conversationId) {
          this.state.conversationId = data.conversationId
          if (this.socket && this.socket.isConnected()) {
            this.socket.send('conversation:join', this.state.conversationId)
          }
        }
        if (!this.state.connected) {
          this.maybeStartPolling()
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[sukhan] send failed', e)
      })
  }

  // ---------- Polling fallback ----------
  /**
   * Single-flight polling starter. Only starts if: not destroyed, polling
   * not disabled, no pollTimer already running, socket NOT connected,
   * and we have a conversationId + token. NEVER creates multiple
   * intervals (the `if (this.pollTimer) return` guard is the
   * single-flight check).
   */
  private maybeStartPolling(): void {
    if (this.destroyed) return
    if (this.disablePolling) return
    if (this.pollTimer) return // single-flight
    if (this.state.connected) return // socket connected → no polling
    if (!this.state.conversationId || !this.state.token) return
    this.pollTimer = setInterval(() => this.pollOnce(), 10_000)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * One poll cycle. Only fetches if the socket is currently disconnected
   * (socket connected → no polling). Uses the central merge function for
   * dedup against any socket/POST delivery of the same message id.
   */
  private pollOnce(): void {
    if (this.destroyed) return
    if (this.state.connected) return // socket connected → no polling
    if (!this.state.conversationId || !this.state.token) return
    this.api
      .loadMessages(this.state.token, this.state.conversationId)
      .then((messages) => {
        if (this.destroyed) return
        this.state.messages = mergeMessages(this.state.messages, messages)
        this.renderMessages()
        if (!this.state.open && this.pulseDot) {
          this.pulseDot.style.display = 'block'
        }
      })
      .catch(() => {
        // polling is a safety net — silent failure
      })
  }

  // ---------- Rendering ----------
  private renderMessages(): void {
    const body = this.bodyEl
    if (!body) return
    const children = body.children
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i] !== this.typingEl) body.removeChild(children[i])
    }
    for (const msg of this.state.messages) {
      const isVisitor = msg.senderType === 'contact'
      const isSystem = msg.senderType === 'system'
      const bubble = el('div', 'sk-msg ' + (isSystem ? 'sk-sys' : isVisitor ? 'sk-vis' : 'sk-agt'))
      if (isSystem) {
        css(bubble, {
          alignSelf: 'center',
          background: 'transparent',
          color: '#888',
          fontSize: '11px',
          padding: '4px 0',
        })
        bubble.textContent = (msg.content && msg.content.text) || ''
      } else {
        const align = isVisitor ? 'flex-end' : 'flex-start'
        const bg = isVisitor ? '#0E1116' : '#fff'
        const color = isVisitor ? '#FAF7F2' : '#0E1116'
        const radius = isVisitor ? '12px 12px 4px 12px' : '12px 12px 12px 4px'
        css(bubble, {
          alignSelf: align,
          background: bg,
          color,
          borderRadius: radius,
          padding: '8px 12px',
          fontSize: '13px',
          maxWidth: '75%',
          boxShadow: '0 1px 2px rgba(0,0,0,.06)',
          wordBreak: 'break-word',
        })
        bubble.setAttribute('dir', 'auto')
        if (msg.content && msg.content.text) {
          const p = el('p', '')
          p.textContent = msg.content.text
          css(p, { margin: '0' })
          bubble.appendChild(p)
        }
        if (msg.content && msg.content.attachments) {
          for (const att of msg.content.attachments) {
            if (att.type === 'image') {
              const img = el('img')
              img.src = att.url
              img.alt = att.name
              css(img, { maxWidth: '100%', borderRadius: '8px', marginTop: '4px', display: 'block' })
              bubble.appendChild(img)
            } else {
              const a = el('a', '') as HTMLAnchorElement
              a.textContent = att.name
              a.href = att.url
              a.setAttribute('download', att.name)
              css(a, {
                display: 'block',
                marginTop: '4px',
                fontSize: '11px',
                color: isVisitor ? '#FAF7F2' : '#1F8F8F',
              })
              bubble.appendChild(a)
            }
          }
        }
        const ts = el('span', '')
        ts.textContent = fmt(msg.createdAt)
        css(ts, { display: 'block', fontSize: '10px', marginTop: '2px', opacity: '.6' })
        bubble.appendChild(ts)
      }
      body.insertBefore(bubble, this.typingEl)
    }
    this.scrollBody()
  }

  private scrollBody(): void {
    if (this.bodyEl) this.bodyEl.scrollTop = this.bodyEl.scrollHeight
  }

  // ---------- CSAT ----------
  private showCsatSurvey(): void {
    if (this.destroyed) return
    if (this.csatShown || !this.state.conversationId || !this.state.token) return
    this.csatShown = true
    const accent = (this.config && this.config.accentColor) || '#E09A2B'
    const overlay = el('div', 'sk-csat')
    css(overlay, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      background: 'rgba(0,0,0,.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '10',
      opacity: '0',
      transition: 'opacity .2s ease',
    })
    const card = el('div', 'sk-csat-card')
    css(card, {
      background: '#fff',
      borderRadius: '16px',
      padding: '24px',
      maxWidth: '280px',
      width: '90%',
      textAlign: 'center',
      fontFamily: 'inherit',
      boxShadow: '0 20px 60px rgba(0,0,0,.3)',
    })
    const title = el(
      'div',
      '',
      this.state.locale === 'fa' ? 'چقدر راضی بودید؟' : 'How satisfied were you?',
    )
    css(title, { fontSize: '16px', fontWeight: '600', marginBottom: '16px', color: '#0E1116' })
    const stars = el('div', 'sk-csat-stars')
    css(stars, { display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '16px' })

    for (let i = 1; i <= 5; i++) {
      const star = el('button', 'sk-star') as HTMLButtonElement
      star.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>'
      css(star, {
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '0',
        transition: 'transform .1s',
      })
      star.onmouseenter = () => {
        star.style.transform = 'scale(1.2)'
      }
      star.onmouseleave = () => {
        star.style.transform = 'scale(1)'
      }
      star.onclick = () => {
        const allSvgs = stars.querySelectorAll('.sk-star svg')
        for (let s = 0; s < allSvgs.length; s++) {
          if (s < i) {
            allSvgs[s].setAttribute('stroke', accent)
            allSvgs[s].setAttribute('fill', accent)
          } else {
            allSvgs[s].setAttribute('stroke', '#ccc')
            allSvgs[s].setAttribute('fill', 'none')
          }
        }
        setTimeout(() => this.submitCsat(i, null), 300)
      }
      stars.appendChild(star)
    }

    const skip = el('button', '', this.state.locale === 'fa' ? 'نادیده بگیر' : 'Skip')
    css(skip, {
      background: 'none',
      border: 'none',
      color: '#888',
      fontSize: '12px',
      cursor: 'pointer',
      marginTop: '8px',
    })
    skip.onclick = () => removeCsat()

    card.appendChild(title)
    card.appendChild(stars)
    card.appendChild(skip)
    overlay.appendChild(card)
    this.panel.appendChild(overlay)
    setTimeout(() => {
      overlay.style.opacity = '1'
    }, 10)

    const removeCsat = () => {
      overlay.style.opacity = '0'
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      }, 200)
    }
  }

  private submitCsat(rating: number, comment: string | null): void {
    if (this.destroyed) return
    if (!this.state.token || !this.state.conversationId) return
    this.api
      .submitCsat(this.state.token, this.state.conversationId, rating, comment)
      .then(() => {
        // success — silent
      })
      .catch(() => {
        // silent
      })
  }

  // ---------- Styles ----------
  private injectStyles(accent: string): void {
    const style = el('style')
    style.textContent =
      '.sk-root{font-family:Vazirmatn,system-ui,sans-serif;}' +
      '.sk-launcher.sk-tab{width:60px;height:52px;border-radius:14px;border-bottom-start-radius:4px;}' +
      '.sk-launcher.sk-rounded{width:52px;height:52px;border-radius:16px;}' +
      '.sk-launcher.sk-pill{width:64px;height:48px;border-radius:999px;}' +
      '.sk-pulse{animation:skpulse 2s ease-in-out infinite;}' +
      '@keyframes skpulse{0%,100%{box-shadow:0 0 0 0 ' +
      hexA(accent, 0.5) +
      ';}50%{box-shadow:0 0 0 6px ' +
      hexA(accent, 0) +
      ';}}' +
      '.sk-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#888;animation:skbounce 1.4s infinite ease-in-out both;}' +
      '.sk-dot:nth-child(1){animation-delay:-0.32s;} .sk-dot:nth-child(2){animation-delay:-0.16s;}' +
      '@keyframes skbounce{0%,80%,100%{transform:scale(0);}40%{transform:scale(1);}}' +
      '.sk-body::-webkit-scrollbar{width:4px;} .sk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px;}'
    document.head.appendChild(style)
  }

  // ---------- Teardown ----------
  /**
   * Idempotent teardown. Disconnects socket, clears polling interval,
   * clears typing timer, removes DOM root. Safe to call multiple times.
   *
   * The `destroyed` flag is checked at the start of every async
   * callback (init's fetchConfig.then, identifyVisitor.then,
   * loadMessages.then, sendMessage.then, pollOnce.then,
   * reconcileHistory.then, onTokenExpired) so a delayed async callback
   * after destroy() does NOT remount/update a destroyed widget.
   */
  destroy(): void {
    if (this.destroyed) return // idempotent: calling twice is a no-op
    this.destroyed = true
    // 1. Clear polling interval
    this.stopPolling()
    // 2. Clear typing timer
    if (this.state.typingTimer) {
      clearTimeout(this.state.typingTimer)
      this.state.typingTimer = undefined
    }
    // 3. Disconnect socket (idempotent internally)
    if (this.socket) {
      try {
        this.socket.disconnect()
      } catch {
        // ignore
      }
      this.socket = null
    }
    // 4. Remove DOM root
    if (this.rootEl && this.rootEl.parentNode) {
      this.rootEl.parentNode.removeChild(this.rootEl)
    }
    this.rootEl = null
    // 5. Reset mounted flag (allows a new initSukhan to mount)
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __sukhan_mounted?: boolean }).__sukhan_mounted = false
    }
  }

  // ---------- Test-only helpers (internal) ----------
  /** @internal — current messages (for assertions in tests). */
  __getMessages(): Message[] { return this.state.messages }
  /** @internal — current socket (for triggering events in tests). */
  __getSocket(): SukhanSocket | null { return this.socket }
  /** @internal — set conversationId (for reconnect tests). */
  __setConversationId(id: string | null): void { this.state.conversationId = id }
  /** @internal — set connected flag (for polling tests). */
  __setConnected(connected: boolean): void { this.state.connected = connected }
  /** @internal — simulate message ingestion from any path. */
  __ingestMessage(m: Message): void { this.ingestMessage(m) }
  /** @internal — trigger one poll cycle (bypasses interval). */
  __pollOnce(): void { this.pollOnce() }
  /** @internal — has destroy() been called? */
  __isDestroyed(): boolean { return this.destroyed }
  /** @internal — current realtimeConfig (for assertions). */
  __getRealtimeConfig(): RealtimeEndpointConfig { return this.realtimeConfig }
  /** @internal — current clientScriptUrl (for assertions). */
  __getClientScriptUrl(): string { return this.clientScriptUrl }
}
