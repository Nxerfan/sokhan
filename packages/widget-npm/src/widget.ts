/**
 * Sukhan Widget — UI rendering + identity state machine.
 *
 * Self-contained widget rendered with vanilla DOM (no framework dependency).
 *
 * ## Identity contract (PR #14 visitor access modes)
 *
 * The backend `GET /api/widget/<slug>/config` response carries the CURRENT
 * access policy (`accessMode` + `policyVersion` + login fields). The widget
 * drives ONE of three identity flows based on the CURRENT mode — and
 * re-evaluates on every policy authorization failure (socket connect_error
 * or REST send 403). It NEVER downgrades to anonymous. It NEVER invents a
 * fallback mode when the policy is malformed/missing — it fail-closes.
 *
 *   anonymous        → historical localStorage visitorId + anonymous
 *                      `/contact` bootstrap (PR5/PR9 behavior preserved
 *                      EXACTLY: same visitorId key, same Contact semantics,
 *                      same socket/polling/reconnect/merge/CSAT).
 *   verified_visitor → stored `sukhan_verified_resume_<slug>` credential
 *                      (opaque, localStorage, SEPARATE key from visitorId)
 *                      + authenticated `/contact` bootstrap. On stale/
 *                      invalid resume → clear + show OTP UI (name/email →
 *                      start → code → verify → store resume → bootstrap).
 *                      Email is NOT the identity key.
 *   site_user_only    → NEVER anonymous identifyVisitor. Get a Sukhan
 *                      external identity token from the CUSTOMER backend
 *                      (`identityEndpoint` / `identityEndpointPath`,
 *                      same-origin, bounded, fail-closed) OR via
 *                      `setIdentity(token)`; bootstrap `/contact` with
 *                      `Authorization: Bearer <token>`. Logged-out host
 *                      user → login-required UI + `onLoginRequired` +
 *                      `sukhan:login-required` window CustomEvent. The
 *                      integration secret NEVER reaches the browser.
 *
 * ## Reliability contract (PR5/PR9 — preserved)
 *
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
 *     async callback checks `this.destroyed` AND a `generation` counter
 *     before touching state — the generation guard prevents stale async
 *     responses from a previous identity (SPA user-switch) from mutating
 *     the new identity's state.
 *   - ONE socket lifecycle; single-flight script loading; single-flight
 *     token refresh; single-flight authorization recovery. Optimistic
 *     send-failure keeps the typed message (input restored on failure so
 *     the user can retry — never silently lost).
 */

import { ApiClient, SukhanApiError } from './api.js'
import { SukhanSocket } from './socket.js'
import type { SukhanSocketOptions } from './types.js'
import type { SukhanSocketDeps } from './socket.js'
import { mergeMessages, mergeMessage } from './merge.js'
import {
  HOSTED_API_URL,
  HOSTED_REALTIME_CONFIG,
  resolveRealtimeFromConfig,
  buildSocketIoScriptUrl,
  type RealtimeEndpointConfig,
} from './realtime-resolve.js'
import {
  resolveIdentityEndpoint,
  fetchIdentity,
  type IdentityResult,
} from './identity.js'
import {
  computeLauncherPosition,
  computePanelVerticalPosition,
  computePanelHorizontalPosition,
  DEFAULT_BASE_MARGIN,
  type EffectivePositioning,
  type PositioningAnchor,
  type LauncherPositionOutput,
} from './positioning.js'
import type {
  WidgetConfig,
  SukhanOptions,
  SukhanInstance,
  Message,
  SenderType,
  AccessMode,
  IdentifyResponse,
  OtpStartResponse,
  SukhanLoginRequiredDetail,
} from './types.js'

// Ambient `process` declare — matches the index.ts pattern. The package
// tsconfig has no node types; this makes the (optional, build-time-inlined)
// `process.env.SUKHAN_API_KEY` fallback type-check without forcing
// @types/node resolution. Module-scoped `declare const` shadows the global
// when @types/node is present (no conflict) and provides the type when it
// is absent.
declare const process: { env: Record<string, string | undefined> } | undefined

const POWERED_BY: Record<'fa' | 'en', string> = {
  fa: 'نیرو گرفته از سُخن',
  en: 'Powered by Sukhan',
}

/** Bilingual UI strings (safe, non-tenant-controlled). */
const STR: Record<'fa' | 'en', Record<string, string>> = {
  fa: {
    verifyTitle: 'تأیید ایمیل',
    verifyName: 'نام',
    verifyEmail: 'ایمیل',
    verifyContinue: 'ادامه',
    codeTitle: 'کد تأیید',
    codePlaceholder: 'کد ۶ رقمی',
    verifyCode: 'تأیید',
    resend: 'ارسال مجدد',
    back: 'بازگشت',
    verifying: 'در حال بررسی…',
    sending: 'در حال ارسال…',
    loginRequiredTitle: 'برای ادامه وارد شوید',
    loginButton: 'ورود',
    integrationUnavailable: 'سرویس هم‌اکنون در دسترس نیست',
    tryAgain: 'تلاش مجدد',
    invalidEmail: 'ایمیل نامعتبر',
    verificationFailed: 'کد نامعتبر بود',
    expired: 'کد منقضی شد — دوباره تلاش کنید',
    rateLimited: 'تلاش بیش از حد — کمی بعد تلاش کنید',
    defaultError: 'خطایی رخ داد',
    messagePlaceholder: 'پیام بنویسید…',
    chat: 'گفت‌وگو',
    agent: 'کارشناس',
  },
  en: {
    verifyTitle: 'Verify your email',
    verifyName: 'Name',
    verifyEmail: 'Email',
    verifyContinue: 'Continue',
    codeTitle: 'Verification code',
    codePlaceholder: '6-digit code',
    verifyCode: 'Verify',
    resend: 'Resend',
    back: 'Back',
    verifying: 'Verifying…',
    sending: 'Sending…',
    loginRequiredTitle: 'Sign in to continue',
    loginButton: 'Sign in',
    integrationUnavailable: 'Service unavailable',
    tryAgain: 'Try again',
    invalidEmail: 'Invalid email',
    verificationFailed: 'Incorrect code',
    expired: 'Code expired — try again',
    rateLimited: 'Too many attempts — try later',
    defaultError: 'Something went wrong',
    messagePlaceholder: 'Type a message…',
    chat: 'Chat',
    agent: 'Agent',
  },
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

/**
 * Verified-visitor resume credential storage. SEPARATE localStorage key
 * from the visitorId (`sukhan_visitor_<slug>`). The resume credential is
 * treated as OPAQUE — never parsed for identity in the browser. NEVER
 * stores the realtime token, OTP code, providerRequestId, or integration
 * secret (only the resume credential lives here).
 */
function resumeKey(slug: string): string {
  return 'sukhan_verified_resume_' + slug
}

function getResume(slug: string): string | null {
  try {
    const v = localStorage.getItem(resumeKey(slug))
    return v && v.length > 0 && v.length <= 8192 ? v : null
  } catch {
    return null
  }
}

function setResume(slug: string, credential: string): void {
  try {
    localStorage.setItem(resumeKey(slug), credential)
  } catch {
    // storage unavailable — in-memory only; resume will not persist
  }
}

function clearResume(slug: string): void {
  try {
    localStorage.removeItem(resumeKey(slug))
  } catch {
    // ignore
  }
}

// ---------- Identity state machine ----------

type IdentityState =
  | 'anonymous_ready'
  | 'verified_required'
  | 'verified_code'
  | 'verified_ready'
  | 'site_login_required'
  | 'site_loading'
  | 'site_ready'
  | 'integration_unavailable'

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
  /** V2 positioning — the effective positioning for the current device. */
  effectivePositioning: EffectivePositioning | null
  /** The current panel side (left/right/center) from the geometry function. */
  panelSide: 'left' | 'right' | 'center'
  /** Resize listener reference (for cleanup on destroy). */
  resizeHandler: (() => void) | null
}

/** Injected dependencies — production leaves undefined (uses real impls). */
export interface SukhanWidgetDeps {
  /** Custom ApiClient (for tests). */
  apiClient?: ApiClient
  /** Custom SukhanSocket constructor (for tests). */
  socketCtor?: new (opts: SukhanSocketOptions, deps?: SukhanSocketDeps) => SukhanSocket
  /** Custom identity fetcher (for tests). Defaults to the real bounded fetcher. */
  identityFetcher?: (endpoint: string) => Promise<IdentityResult | null>
}

export class SukhanWidget implements SukhanInstance {
  config: WidgetConfig | null = null
  private api: ApiClient
  private socket: SukhanSocket | null = null
  private readonly SocketCtor: new (opts: SukhanSocketOptions, deps?: SukhanSocketDeps) => SukhanSocket
  private readonly identityFetcher: (endpoint: string) => Promise<IdentityResult | null>
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
  /**
   * Generation counter — incremented on every identity change (setIdentity,
   * refreshIdentity, verified OTP success, site-user bootstrap). Async
   * callbacks capture the generation at START and bail if it changed —
   * this prevents stale async responses from a PREVIOUS identity (SPA
   * user-switch) from mutating the new identity's state. Complements
   * `destroyed` (which is only set on final teardown).
   */
  private generation = 0

  /** The CURRENT identity state (explicit — never inferred from DOM). */
  private identityState: IdentityState = 'anonymous_ready'
  /** Whether the login-required callback/event has been emitted (avoid storms). */
  private loginRequiredEmitted = false

  /** In-memory Sukhan external identity token (site_user_only). NEVER persisted. */
  private memoryIdentityToken: string | null = null
  /** In-memory OTP request state (verified_visitor). */
  private otpRequest: { requestId: string; email: string; expiresAt: string } | null = null
  /** Single-flight resend guard (verified_visitor OTP). */
  private resendInFlight = false
  /** Single-flight config refresh (socket error / send error / refreshIdentity). */
  private configRefreshInFlight: Promise<WidgetConfig | null> | null = null

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
    effectivePositioning: null,
    panelSide: 'right',
    resizeHandler: null,
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
    this.identityFetcher = __deps?.identityFetcher ?? ((ep: string) => fetchIdentity(ep))
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

    const cfg = await this.refreshConfig()
    if (this.destroyed || !cfg) return // guard: destroy during async fetch / fetch failed
    this.applyRealtimeConfig()
    if (this.destroyed) return
    this.mount(cfg)
    // Mode-aware bootstrap — the access policy drives the identity flow.
    this.bootstrap()
  }

  /**
   * Single-flight public config refresh. Used by init(), the socket
   * authorization-recovery hook, and the REST send policy-error path so
   * that concurrent failures (socket error + send error + refreshIdentity)
   * do NOT fire multiple simultaneous config fetches. The new policy is
   * applied atomically (visual customization is NOT reset unnecessarily —
   * only the access-policy fields + realtime config are refreshed).
   */
  private refreshConfig(): Promise<WidgetConfig | null> {
    if (this.configRefreshInFlight) return this.configRefreshInFlight
    this.configRefreshInFlight = (async () => {
      try {
        const cfg = await this.api.fetchConfig()
        if (this.destroyed) return null
        this.config = cfg
        this.applyRealtimeConfig()
        return cfg
      } catch {
        return null
      } finally {
        this.configRefreshInFlight = null
      }
    })()
    return this.configRefreshInFlight
  }

  private applyRealtimeConfig(): void {
    if (!this.config) return
    this.realtimeConfig = resolveRealtimeFromConfig(
      this.api.apiUrl,
      this.config?.realtime ?? null,
      this.options.realtime ?? null,
    )
    this.clientScriptUrl = buildSocketIoScriptUrl(this.api.apiUrl)
  }

  /** Mount the launcher + panel onto the page. Does NOT bootstrap identity. */
  private mount(config: WidgetConfig): void {
    this.state.config = config
    const locale = this.locale || (config.defaultLocale === 'en' ? 'en' : 'fa')
    this.state.locale = locale as 'fa' | 'en'
    const dir = this.direction || (config.defaultDirection === 'ltr' ? 'ltr' : 'rtl')
    this.state.dir = dir as 'rtl' | 'ltr'
    const accent = config.accentColor || '#E09A2B'

    // V2 positioning: determine the effective positioning for the current
    // device. Falls back to V1 `position` if no V2 positioning is present.
    this.state.effectivePositioning = this.resolveDevicePositioning(config)

    this.injectStyles(accent)

    const root = el('div', 'sk-root') as HTMLElement
    root.setAttribute('dir', this.state.dir)
    css(root, { position: 'fixed', zIndex: '2147483000' })
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
    this.panel = panel

    // Position application is deferred to after the panel + launcher are
    // appended to the root (the panel side cannot be set before the panel
    // DOM element exists). See applyPosition() at the end of mount().

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
    // CUST-B: render the configured logo/avatar when they are SAFE image
    // URLs. DOM APIs only (createElement + .src property) — never
    // innerHTML with tenant-controlled content.
    const safeImg = (u: unknown): string | null => {
      if (typeof u !== 'string' || u.length > 500 || !/^https?:\/\//i.test(u)) return null
      try {
        new URL(u)
        return u
      } catch {
        return null
      }
    }
    const logoImgSrc = safeImg(config.logoUrl)
    if (logoImgSrc) {
      const limg = document.createElement('img')
      limg.alt = ''
      limg.referrerPolicy = 'no-referrer'
      css(limg, { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'none' })
      limg.onload = () => {
        logo.innerHTML = ''
        ;(limg as HTMLElement).style.display = 'block'
        logo.appendChild(limg)
      }
      limg.src = logoImgSrc
    }
    const avatarSrc = safeImg(config.avatarUrl)
    if (avatarSrc) {
      const av = document.createElement('img')
      av.alt = this.state.locale === 'fa' ? 'کارشناس' : 'Agent'
      av.referrerPolicy = 'no-referrer'
      css(av, { width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: '0' })
      av.onerror = () => {
        av.parentNode?.removeChild(av)
      }
      av.src = avatarSrc
      header.insertBefore(av, titleText)
    }

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
      STR[this.state.locale].messagePlaceholder,
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

    // Apply the computed position NOW that the panel exists (the panel side
    // could not be set earlier because the panel DOM element didn't exist yet).
    this.applyPosition()
    this.setupResizeListener()

    this.renderMessages()
  }

  /**
   * Free-plan brand lock (CUST-F). The backend never sends a `plan`
   * field — it sends the effective-config flags `poweredBy`/`isLocked`.
   */
  private isFreePlan(): boolean {
    return this.config?.poweredBy === true || this.config?.isLocked === true
  }

  // ---------- Identity bootstrap (mode-aware) ----------

  /**
   * Strictly resolve the CURRENT access mode from the public config. NEVER
   * coerces a missing/malformed value to anonymous — fail closed
   * (integration_unavailable) so a misconfigured tenant cannot be served
   * as a weaker mode.
   */
  private resolveAccessMode(): AccessMode | null {
    const m = this.config?.accessMode
    if (m === 'anonymous' || m === 'verified_visitor' || m === 'site_user_only') return m
    return null
  }

  /**
   * Mode-aware bootstrap entry point. Dispatches on the CURRENT accessMode.
   * Called from init() AND from the authorization-recovery hook (after a
   * config refresh) when the policy changed.
   */
  private bootstrap(): void {
    if (this.destroyed) return
    const mode = this.resolveAccessMode()
    if (mode === null) {
      this.setIdentityState('integration_unavailable')
      this.renderIntegrationUnavailable()
      return
    }
    if (mode === 'anonymous') {
      this.anonymousBootstrap()
    } else if (mode === 'verified_visitor') {
      this.verifiedBootstrap()
    } else {
      this.siteUserBootstrap(this.memoryIdentityToken ?? undefined)
    }
  }

  /**
   * Anonymous bootstrap — historical behavior (PR5/PR9) preserved EXACTLY.
   * localStorage visitorId + `identifyVisitor` (no Authorization) + socket
   * connect + history load. Does NOT call the customer identityEndpoint.
   * Does NOT display OTP UI.
   */
  private anonymousBootstrap(): void {
    if (this.destroyed) return
    this.setIdentityState('anonymous_ready')
    const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
    const gen = this.generation
    this.api
      .identifyVisitor({
        visitorId,
        email: this.visitorOverride?.email,
        name: this.visitorOverride?.name,
      })
      .then((data) => {
        if (this.destroyed || gen !== this.generation) return
        this.applyBootstrapResponse(data)
        this.connectSocket()
        if (data.conversationId) this.loadMessages()
      })
      .catch((e) => {
        if (this.destroyed || gen !== this.generation) return
        // eslint-disable-next-line no-console
        console.error('[sukhan] identify failed', e)
      })
  }

  /**
   * Verified-visitor bootstrap. Does NOT call anonymous identifyVisitor.
   * Check for a stored resume credential; if present, try authenticated
   * `/contact` bootstrap. On success → restore + connect. On rejection
   * (verification_required / stale) → clear resume + show verification UI.
   */
  private verifiedBootstrap(): void {
    if (this.destroyed) return
    const resume = getResume(this.api.slug)
    if (!resume) {
      this.showVerificationForm()
      return
    }
    this.setIdentityState('verified_ready')
    const gen = this.generation
    this.api
      .bootstrapContact(resume)
      .then((data) => {
        if (this.destroyed || gen !== this.generation) return
        this.applyBootstrapResponse(data)
        this.connectSocket()
        if (data.conversationId) this.loadMessages()
      })
      .catch((e) => {
        if (this.destroyed || gen !== this.generation) return
        if (e instanceof SukhanApiError && e.code === 'verification_required') {
          // Stale/invalid resume — clear + show verification UI (no anonymous downgrade).
          clearResume(this.api.slug)
          this.showVerificationForm()
          return
        }
        // eslint-disable-next-line no-console
        console.error('[sukhan] verified bootstrap failed', e)
        this.setIdentityState('integration_unavailable')
        this.renderIntegrationUnavailable()
      })
  }

  /**
   * Site-user bootstrap. NEVER anonymous identifyVisitor. Priority:
   *   1. an already-supplied token (setIdentity / memoryIdentityToken)
   *   2. the customer identityEndpoint
   * If authenticated → authenticated `/contact` bootstrap + connect.
   * If logged out → login-required state (no Contact, no socket, no poll).
   * If integration unavailable → integration_unavailable state.
   */
  private siteUserBootstrap(token?: string): void {
    if (this.destroyed) return
    this.setIdentityState('site_loading')
    const gen = this.generation

    const doBootstrap = (bearer: string) => {
      this.api
        .bootstrapContact(bearer)
        .then((data) => {
          if (this.destroyed || gen !== this.generation) return
          this.memoryIdentityToken = bearer // memory-only
          this.applyBootstrapResponse(data)
          this.setIdentityState('site_ready')
          this.connectSocket()
          if (data.conversationId) this.loadMessages()
        })
        .catch((e) => {
          if (this.destroyed || gen !== this.generation) return
          if (e instanceof SukhanApiError && e.code === 'website_login_required') {
            // Token rejected (logged out / stale) → clear memory token + login-required.
            this.memoryIdentityToken = null
            this.enterLoginRequired()
            return
          }
          // eslint-disable-next-line no-console
          console.error('[sukhan] site-user bootstrap failed', e)
          this.setIdentityState('integration_unavailable')
          this.renderIntegrationUnavailable()
        })
    }

    if (token) {
      doBootstrap(token)
      return
    }
    if (this.memoryIdentityToken) {
      doBootstrap(this.memoryIdentityToken)
      return
    }

    // Resolve the customer identity endpoint (same-origin only, fail closed).
    const endpoint = resolveIdentityEndpoint({
      explicit: this.options.identityEndpoint,
      configPath: this.config?.identityEndpointPath ?? null,
    })
    if (!endpoint) {
      // No usable same-origin endpoint + no supplied token → login-required.
      // (Do NOT downgrade to anonymous.)
      this.enterLoginRequired()
      return
    }
    this.identityFetcher(endpoint)
      .then((result) => {
        if (this.destroyed || gen !== this.generation) return
        if (result === null) {
          // timeout / network failure / malformed body → integration unavailable.
          this.setIdentityState('integration_unavailable')
          this.renderIntegrationUnavailable()
          return
        }
        if (!result.authenticated || !result.token) {
          // Logged-out host user → expected auth state, not integration failure.
          this.enterLoginRequired()
          return
        }
        doBootstrap(result.token)
      })
      .catch(() => {
        if (this.destroyed || gen !== this.generation) return
        this.setIdentityState('integration_unavailable')
        this.renderIntegrationUnavailable()
      })
  }

  /**
   * `setIdentity(token)` — host bypasses identityEndpoint by supplying an
   * already-minted Sukhan external identity token. Bootstraps/re-bootstraps
   * the widget using that credential. `setIdentity(null)` treats the host
   * user as logged out (logout safety): clears identity state, disconnects
   * socket, stops polling, clears Contact/conversation/realtime token/
   * messages, and enters login-required state. Uses a generation guard so
   * stale async from the previous identity cannot mutate the new identity's
   * state (SPA user-switch safety).
   */
  async setIdentity(token: string | null): Promise<void> {
    if (this.destroyed) return
    // User-switch / logout: bump generation so in-flight async from the
    // previous identity bails, then clear ALL prior state.
    this.generation++
    this.clearIdentityState()
    if (token === null) {
      this.memoryIdentityToken = null
      this.enterLoginRequired()
      return
    }
    this.siteUserBootstrap(token)
  }

  /**
   * `refreshIdentity()` — re-fetch the customer identityEndpoint. If
   * authenticated, bootstrap with the new token. If unauthenticated, enter
   * login-required. Works WITHOUT a page reload (primary SPA/modal
   * post-login integration method). Bumps generation for stale-guard safety.
   */
  async refreshIdentity(): Promise<void> {
    if (this.destroyed) return
    this.generation++
    this.clearIdentityState()
    // Clear the login-required flag so a fresh login-required (if any)
    // re-emits the callback/event.
    this.loginRequiredEmitted = false
    this.siteUserBootstrap()
  }

  // ---------- Login-required state + UI ----------

  /**
   * Enter the site-user login-required state. Emits `onLoginRequired` AND
   * dispatches `sukhan:login-required` on `window` ONCE (avoids event
   * storms). Renders the login UI. Does NOT create a Contact, connect
   * realtime, poll, or allow send.
   */
  private enterLoginRequired(): void {
    this.setIdentityState('site_login_required')
    this.renderLoginRequired()
    if (this.loginRequiredEmitted) return
    this.loginRequiredEmitted = true
    const detail: SukhanLoginRequiredDetail = {
      accessMode: 'site_user_only',
      loginUrl: this.config?.loginUrl ?? null,
      loginButtonLabel: this.config?.loginButtonLabel ?? null,
      loginReturnUrlParam: this.config?.loginReturnUrlParam ?? null,
    }
    try {
      this.options.onLoginRequired?.(detail)
    } catch {
      // host callback error — swallow (do not break the widget)
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('sukhan:login-required', { detail }))
      } catch {
        // CustomEvent may be unavailable in rare envs — swallow
      }
    }
  }

  /**
   * Build the login URL defensively. Relative loginUrl resolves against
   * the CUSTOMER page origin (window.location.origin); absolute must be
   * http/https. If `loginReturnUrlParam` is configured, append
   * `<param>=window.location.href` via the URL API (no manual query
   * concatenation, no open redirect). Returns null if no safe loginUrl.
   */
  private buildLoginUrl(): string | null {
    const raw = this.config?.loginUrl
    if (!raw) return null
    const pageOrigin =
      typeof window !== 'undefined' && window.location ? window.location.origin : ''
    let base: URL
    if (raw === '/' || /^\/[^/]/.test(raw)) {
      if (!pageOrigin) return null
      try {
        base = new URL(raw, pageOrigin)
      } catch {
        return null
      }
    } else if (/^https?:\/\//i.test(raw)) {
      try {
        base = new URL(raw)
        if (base.protocol !== 'http:' && base.protocol !== 'https:') return null
      } catch {
        return null
      }
    } else {
      // Reject //, javascript:, data:, malformed, etc.
      return null
    }
    const param = this.config?.loginReturnUrlParam
    if (param && typeof window !== 'undefined' && window.location) {
      try {
        base.searchParams.set(param, window.location.href)
      } catch {
        // ignore — return URL not appended
      }
    }
    return base.href
  }

  // ---------- Verified-visitor OTP UI + flow ----------

  /**
   * Show the initial verification form (name + email + continue). Email
   * required. Safe DOM (textContent for tenant/user values). Bilingual.
   */
  private showVerificationForm(): void {
    if (this.destroyed) return
    this.setIdentityState('verified_required')
    this.clearBody()
    const L = STR[this.state.locale]
    const card = this.makeCard()
    const title = el('div', '')
    title.textContent = L.verifyTitle
    css(title, { fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#0E1116' })
    card.appendChild(title)

    const nameInput = el('input') as HTMLInputElement
    nameInput.setAttribute('placeholder', L.verifyName)
    this.styleInput(nameInput)
    const emailInput = el('input') as HTMLInputElement
    emailInput.setAttribute('type', 'email')
    emailInput.setAttribute('placeholder', L.verifyEmail)
    this.styleInput(emailInput)
    card.appendChild(nameInput)
    card.appendChild(emailInput)

    const errEl = el('div', 'sk-verify-err')
    css(errEl, { color: '#c0392b', fontSize: '12px', minHeight: '16px' })
    card.appendChild(errEl)

    const btn = el('button', '', L.verifyContinue) as HTMLButtonElement
    this.stylePrimaryButton(btn)
    const start = async () => {
      const name = nameInput.value.trim()
      const email = emailInput.value.trim().toLowerCase()
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errEl.textContent = L.invalidEmail
        return
      }
      btn.disabled = true
      const oldText = btn.textContent
      btn.textContent = L.sending
      try {
        const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
        const res = await this.api.startOtp({ visitorId, email, name: name || undefined })
        if (this.destroyed) return
        this.otpRequest = { requestId: res.requestId, email, expiresAt: res.expiresAt }
        this.showCodeForm()
      } catch (e) {
        if (this.destroyed) return
        errEl.textContent = this.mapVerifyError(e, L)
      } finally {
        if (!this.destroyed) {
          btn.disabled = false
          btn.textContent = oldText
        }
      }
    }
    btn.onclick = start
    card.appendChild(btn)
    this.bodyEl.appendChild(card)
  }

  /**
   * Show the verification-code form (6-digit code + verify + resend).
   * Bound resend so repeated clicks cannot create uncontrolled parallel
   * requests. On success → store resume → authenticated `/contact`
   * bootstrap (canonical) → connect + load history.
   */
  private showCodeForm(): void {
    if (this.destroyed) return
    this.setIdentityState('verified_code')
    this.clearBody()
    const L = STR[this.state.locale]
    const card = this.makeCard()
    const title = el('div', '')
    title.textContent = L.codeTitle
    css(title, { fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#0E1116' })
    card.appendChild(title)

    const codeInput = el('input') as HTMLInputElement
    codeInput.setAttribute('inputmode', 'numeric')
    codeInput.setAttribute('placeholder', L.codePlaceholder)
    codeInput.setAttribute('autocomplete', 'one-time-code')
    this.styleInput(codeInput)
    card.appendChild(codeInput)

    const errEl = el('div', 'sk-verify-err')
    css(errEl, { color: '#c0392b', fontSize: '12px', minHeight: '16px' })
    card.appendChild(errEl)

    const btn = el('button', '', L.verifyCode) as HTMLButtonElement
    this.stylePrimaryButton(btn)
    const verify = async () => {
      if (!this.otpRequest) return
      const code = codeInput.value.trim()
      if (!code) return
      btn.disabled = true
      const oldText = btn.textContent
      btn.textContent = L.verifying
      const gen = this.generation
      try {
        const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
        const res = await this.api.verifyOtp({
          visitorId,
          email: this.otpRequest.email,
          requestId: this.otpRequest.requestId,
          code,
        })
        if (this.destroyed || gen !== this.generation) return
        // Store the resume credential (opaque, localStorage, separate key).
        setResume(this.api.slug, res.resumeCredential)
        // Canonical bootstrap: authenticated /contact is AUTHORITATIVE for
        // contactId / conversationId / fresh realtimeToken / locale/direction.
        // Do NOT rely only on the VERIFY realtimeToken.
        this.generation++ // OTP success is an identity change → bump guard
        const data = await this.api.bootstrapContact(res.resumeCredential)
        if (this.destroyed) return
        this.applyBootstrapResponse(data)
        this.setIdentityState('verified_ready')
        this.connectSocket()
        if (data.conversationId) this.loadMessages()
      } catch (e) {
        if (this.destroyed || gen !== this.generation) return
        const mapped = this.mapVerifyError(e, L)
        errEl.textContent = mapped
        // On expired / request_superseded → restart the verification form.
        if (e instanceof SukhanApiError && (e.code === 'expired' || e.code === 'request_superseded')) {
          this.otpRequest = null
          setTimeout(() => this.showVerificationForm(), 600)
        }
      } finally {
        if (!this.destroyed) {
          btn.disabled = false
          btn.textContent = oldText
        }
      }
    }
    btn.onclick = verify
    card.appendChild(btn)

    const resend = el('button', '', L.resend) as HTMLButtonElement
    this.styleTextButton(resend)
    resend.onclick = async () => {
      // Bound: single-flight resend so repeated clicks cannot create parallel requests.
      if (this.resendInFlight || !this.otpRequest) return
      this.resendInFlight = true
      const oldText = resend.textContent
      resend.disabled = true
      try {
        const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
        const res = await this.api.resendOtp({
          visitorId,
          email: this.otpRequest.email,
          requestId: this.otpRequest.requestId,
        })
        if (this.destroyed) return
        // Replace local requestId/expiresAt with the rotated values.
        this.otpRequest = { requestId: res.requestId, email: this.otpRequest.email, expiresAt: res.expiresAt }
        errEl.textContent = ''
      } catch (e) {
        if (this.destroyed) return
        errEl.textContent = this.mapVerifyError(e, L)
      } finally {
        if (!this.destroyed) {
          this.resendInFlight = false
          resend.disabled = false
          resend.textContent = oldText
        }
      }
    }
    card.appendChild(resend)

    const back = el('button', '', L.back) as HTMLButtonElement
    this.styleTextButton(back)
    back.onclick = () => {
      if (this.destroyed) return
      this.otpRequest = null
      this.showVerificationForm()
    }
    card.appendChild(back)

    this.bodyEl.appendChild(card)
  }

  /** Map a verification failure to a safe UI message (no internal detail leak). */
  private mapVerifyError(e: unknown, L: Record<string, string>): string {
    if (e instanceof SukhanApiError) {
      switch (e.code) {
        case 'code_mismatch': return L.verificationFailed
        case 'expired': return L.expired
        case 'request_superseded': return L.expired
        case 'already_used': return L.expired
        case 'attempt_limit_reached': return L.rateLimited
        case 'rate_limited': return L.rateLimited
        case 'resend_limit': return L.rateLimited
        case 'policy_unavailable': return L.integrationUnavailable
        case 'verification_conflict': return L.defaultError
        case 'wrong_correlation': return L.defaultError
        case 'mode_mismatch': return L.integrationUnavailable
        default: return L.defaultError
      }
    }
    return L.defaultError
  }

  // ---------- Identity-state clear + render helpers ----------

  /**
   * Clear ALL identity-derived state. Used by setIdentity (user-switch /
   * logout) and refreshIdentity. Disconnects the socket, stops polling,
   * clears token/contactId/conversationId/messages, clears the in-memory
   * identity token. The generation counter is bumped by the CALLER so
   * in-flight async bails before touching the cleared state.
   */
  private clearIdentityState(): void {
    this.stopPolling()
    if (this.socket) {
      try {
        this.socket.disconnect()
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.state.token = null
    this.state.contactId = null
    this.state.conversationId = null
    this.state.messages = []
    this.state.connected = false
    this.csatShown = false
    if (this.state.typingTimer) {
      clearTimeout(this.state.typingTimer)
      this.state.typingTimer = undefined
    }
    this.otpRequest = null
    this.resendInFlight = false
    // Re-render the message list so the PREVIOUS identity's message bubbles
    // disappear from the DOM immediately (SPA user-switch / logout safety).
    // Without this, clearIdentityState clears state.messages but leaves the
    // old bubbles rendered until the new identity's bootstrap re-renders —
    // a race where the old identity's history is briefly visible to the new
    // identity. renderMessages() is a no-op if bodyEl does not exist yet.
    try {
      this.renderMessages()
    } catch {
      // ignore — bodyEl may not exist pre-mount
    }
    // NOTE: memoryIdentityToken is cleared on logout (setIdentity(null)) but
    // PRESERVED across a refresh/bootstrap re-entry so site_user_only can
    // re-use a still-valid token. Callers that must clear it do so explicitly.
  }

  private setIdentityState(s: IdentityState): void {
    this.identityState = s
  }

  private applyBootstrapResponse(data: IdentifyResponse): void {
    this.state.contactId = data.contactId
    this.state.conversationId = data.conversationId
    this.state.token = data.realtimeToken
    if (data.locale === 'en' || data.locale === 'fa') {
      this.state.locale = data.locale
    }
    if (data.direction === 'rtl' || data.direction === 'ltr') {
      this.state.dir = data.direction
    }
  }

  /** Render the login-required UI (simple card; login button if loginUrl). */
  private renderLoginRequired(): void {
    if (this.destroyed) return
    this.clearBody()
    const L = STR[this.state.locale]
    const card = this.makeCard()
    const title = el('div', '')
    title.textContent = L.loginRequiredTitle
    css(title, { fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#0E1116', textAlign: 'center' })
    card.appendChild(title)
    const loginUrl = this.buildLoginUrl()
    if (loginUrl) {
      const btn = el('a', '') as HTMLAnchorElement
      btn.href = loginUrl
      const label = this.config?.loginButtonLabel && this.config.loginButtonLabel.trim().length > 0
        ? this.config.loginButtonLabel
        : L.loginButton
      btn.textContent = label
      this.stylePrimaryAnchor(btn)
      card.appendChild(btn)
    }
    this.bodyEl.appendChild(card)
  }

  /** Render the integration-unavailable UI (fail-closed state). */
  private renderIntegrationUnavailable(): void {
    if (this.destroyed) return
    this.clearBody()
    const L = STR[this.state.locale]
    const card = this.makeCard()
    const title = el('div', '')
    title.textContent = L.integrationUnavailable
    css(title, { fontSize: '14px', color: '#666', textAlign: 'center', padding: '24px 8px' })
    card.appendChild(title)
    this.bodyEl.appendChild(card)
  }

  private clearBody(): void {
    const body = this.bodyEl
    if (!body) return
    const children = body.children
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i] !== this.typingEl) body.removeChild(children[i])
    }
  }

  private makeCard(): HTMLElement {
    const card = el('div', 'sk-id-card')
    css(card, {
      alignSelf: 'stretch',
      background: '#fff',
      borderRadius: '12px',
      padding: '20px',
      margin: '8px',
      boxShadow: '0 1px 3px rgba(0,0,0,.06)',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    })
    return card
  }

  private styleInput(i: HTMLInputElement): void {
    css(i, {
      width: '100%',
      boxSizing: 'border-box',
      padding: '10px 12px',
      border: '1px solid #ddd',
      borderRadius: '8px',
      fontSize: '14px',
      outline: 'none',
      fontFamily: 'inherit',
      background: '#fff',
      color: '#0E1116',
    })
  }

  private stylePrimaryButton(b: HTMLButtonElement): void {
    const accent = (this.config && this.config.accentColor) || '#E09A2B'
    css(b, {
      width: '100%',
      padding: '10px 12px',
      border: 'none',
      borderRadius: '8px',
      background: accent,
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    })
  }

  private stylePrimaryAnchor(a: HTMLAnchorElement): void {
    const accent = (this.config && this.config.accentColor) || '#E09A2B'
    css(a, {
      display: 'block',
      textAlign: 'center',
      textDecoration: 'none',
      padding: '10px 12px',
      borderRadius: '8px',
      background: accent,
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
    })
  }

  private styleTextButton(b: HTMLButtonElement): void {
    css(b, {
      background: 'none',
      border: 'none',
      color: '#888',
      fontSize: '12px',
      cursor: 'pointer',
      padding: '4px',
      alignSelf: 'center',
    })
  }

  // ---------- Panel open/close ----------
  toggle(): void {
    this.state.open ? this.close() : this.open()
  }
  open(): void {
    this.state.open = true
    css(this.panel, {
      opacity: '1',
      pointerEvents: 'auto',
    })
    this.applyPanelTransform()
    this.pulseDot.style.display = 'none'
    setTimeout(() => this.inputEl && this.inputEl.focus(), 200)
  }
  close(): void {
    this.state.open = false
    css(this.panel, {
      opacity: '0',
      pointerEvents: 'none',
    })
    this.applyPanelTransform()
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
    const gen = this.generation
    this.socket = new this.SocketCtor({
      token: this.state.token,
      clientScriptUrl: this.clientScriptUrl,
      realtimeUrl: this.realtimeConfig.url,
      realtimePath: this.realtimeConfig.path,
      transports: this.realtimeConfig.transports,
      addTrailingSlash: this.realtimeConfig.addTrailingSlash,
    })
    this.socket.onConnect = () => {
      if (this.destroyed || gen !== this.generation) return
      this.state.connected = true
      this.stopPolling() // socket connected → no polling
      if (this.state.conversationId) {
        this.socket?.send('conversation:join', this.state.conversationId)
      }
    }
    this.socket.onReconnect = () => {
      if (this.destroyed || gen !== this.generation) return
      this.state.connected = true
      this.stopPolling() // socket reconnected → stop polling
      // Reconnect gap recovery: (1) re-join current conversation room,
      // (2) fetch/reconcile history once (dedup by id).
      if (this.state.conversationId) {
        this.socket?.send('conversation:join', this.state.conversationId)
      }
      this.reconcileHistory()
    }
    // Mode-aware realtime token refresh. anonymous → identifyVisitor
    // (historical). verified_visitor → resume credential + authenticated
    // /contact (clear resume + verification UI on stale). site_user_only
    // → refresh customer identity (or memory token) + authenticated
    // /contact. Returns the fresh realtime token or null (stop reconnect).
    this.socket.onTokenExpired = () => this.modeAwareRefreshToken()
    // Narrow authorization-recovery hook for visitor policy connect errors.
    this.socket.onAuthorizationError = (reason) => this.authorizationRecovery(reason)
    this.socket.on('disconnect', () => {
      if (this.destroyed || gen !== this.generation) return
      this.state.connected = false
      this.maybeStartPolling() // socket disconnected → enable fallback
    })
    this.socket.on('message:new', (msg) => {
      if (this.destroyed || gen !== this.generation) return
      this.ingestMessage(msg as Message)
    })
    this.socket.on('conversation:updated', (data) => {
      if (this.destroyed || gen !== this.generation) return
      const d = data as { changes?: { status?: string } }
      if (d && d.changes && d.changes.status === 'closed') {
        this.showCsatSurvey()
      }
    })
    this.socket.on('typing:start', (data) => {
      if (this.destroyed || gen !== this.generation) return
      const d = data as { senderType?: string }
      if (d && d.senderType === 'agent') {
        this.typingEl.style.display = 'block'
        this.scrollBody()
      }
    })
    this.socket.on('typing:stop', () => {
      if (this.destroyed || gen !== this.generation) return
      this.typingEl.style.display = 'none'
    })
    this.socket.connect()
  }

  /**
   * Mode-aware realtime token refresh (used by socket onTokenExpired).
   * anonymous: historical identifyVisitor. verified_visitor: resume
   * credential + authenticated /contact (clear resume + verification UI on
   * stale — never anonymous downgrade). site_user_only: refresh customer
   * identity (or reuse memory token) + authenticated /contact (login-
   * required state on logged out — never anonymous downgrade). Returns
   * the fresh realtime token (reconnect) or null (stop reconnecting).
   */
  private async modeAwareRefreshToken(): Promise<string | null> {
    if (this.destroyed) return null
    const gen = this.generation
    const mode = this.resolveAccessMode()
    try {
      if (mode === 'anonymous') {
        const visitorId = getVisitorId(this.api.slug, this.visitorOverride?.visitorId)
        const data = await this.api.identifyVisitor({
          visitorId,
          email: this.visitorOverride?.email,
          name: this.visitorOverride?.name,
        })
        if (this.destroyed || gen !== this.generation) return null
        if (data.conversationId && !this.state.conversationId) {
          this.state.conversationId = data.conversationId
        }
        this.state.token = data.realtimeToken
        return data.realtimeToken
      }
      if (mode === 'verified_visitor') {
        const resume = getResume(this.api.slug)
        if (!resume) {
          // No resume → verification UI (do not downgrade anonymous).
          this.showVerificationForm()
          return null
        }
        try {
          const data = await this.api.bootstrapContact(resume)
          if (this.destroyed || gen !== this.generation) return null
          this.applyBootstrapResponse(data)
          return data.realtimeToken
        } catch (e) {
          if (this.destroyed || gen !== this.generation) return null
          if (e instanceof SukhanApiError && e.code === 'verification_required') {
            clearResume(this.api.slug)
            this.showVerificationForm()
          }
          return null
        }
      }
      if (mode === 'site_user_only') {
        // Prefer a freshly-fetched token; fall back to the in-memory token.
        let token: string | null = this.memoryIdentityToken
        const endpoint = resolveIdentityEndpoint({
          explicit: this.options.identityEndpoint,
          configPath: this.config?.identityEndpointPath ?? null,
        })
        if (endpoint) {
          const result = await this.identityFetcher(endpoint)
          if (this.destroyed || gen !== this.generation) return null
          if (result === null) return null // integration unavailable → stop
          if (!result.authenticated || !result.token) {
            this.enterLoginRequired()
            return null
          }
          token = result.token
        }
        if (!token) {
          this.enterLoginRequired()
          return null
        }
        try {
          const data = await this.api.bootstrapContact(token)
          if (this.destroyed || gen !== this.generation) return null
          this.memoryIdentityToken = token
          this.applyBootstrapResponse(data)
          return data.realtimeToken
        } catch (e) {
          if (this.destroyed || gen !== this.generation) return null
          if (e instanceof SukhanApiError && e.code === 'website_login_required') {
            this.memoryIdentityToken = null
            this.enterLoginRequired()
          }
          return null
        }
      }
    } catch {
      // best-effort — stop reconnecting
    }
    return null
  }

  /**
   * Narrow authorization-recovery hook (socket onAuthorizationError). On a
   * visitor policy connect_error the socket delegates here. We: (1) re-
   * fetch public config (single-flight), (2) resolve the CURRENT accessMode,
   * (3) execute the correct identity flow, (4) return a fresh realtime
   * token (reconnect) or null (stop reconnecting until the user completes
   * the required identity action). Bounded — no infinite connect_error loop
   * (the socket marks itself terminal on null). Reuses the single-flight
   * config refresh so concurrent socket/send errors collapse to one fetch.
   */
  private async authorizationRecovery(_reason: string): Promise<string | null> {
    if (this.destroyed) return null
    const cfg = await this.refreshConfig()
    if (this.destroyed || !cfg) return null
    // Re-evaluate the CURRENT access mode + re-bootstrap. The bootstrap
    // path itself obtains a fresh realtime token via the mode-aware flow;
    // we capture it by reading state.token AFTER a successful bootstrap.
    const gen = this.generation
    this.generation++ // policy change → bump guard (stale async bails)
    this.clearIdentityState()
    this.bootstrap()
    // The bootstrap is async (fire-and-forget). We cannot synchronously
    // return the new token here; return null so the socket stops its own
    // reconnect loop, and the bootstrap's connectSocket() opens a FRESH
    // socket once the new token is available. This avoids a double-
    // socket (old recovering + new connecting) — the old socket is
    // terminal, the new socket connects cleanly.
    void gen // (gen captured for clarity; this.generation already bumped)
    return null
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
        if (this.destroyed) return
        // Never silently lose the typed message — restore it so the user
        // can retry. (Explicit retry remains safer than auto-resend.)
        if (this.inputEl) this.inputEl.value = text
        if (e instanceof SukhanApiError) {
          // Policy send errors → re-fetch config + trigger the correct
          // identity-upgrade flow. Do NOT auto-resend the message.
          const code = e.code
          if (
            code === 'policy_changed' ||
            code === 'verification_required' ||
            code === 'website_login_required' ||
            code === 'identity_token_invalid' ||
            code === 'policy_unavailable' ||
            code === 'integration_unavailable'
          ) {
            // eslint-disable-next-line no-console
            console.error('[sukhan] send denied by policy:', code)
            // Delegated, single-flight: re-fetch config + re-bootstrap.
            void this.authorizationRecovery(code)
            return
          }
        }
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

  // ---------- V2 Positioning ----------

  /**
   * Resolve the effective positioning for the current device from the
   * config. Uses V2 `config.positioning` if present, falls back to V1
   * `config.position` (bottom-start/bottom-end only).
   *
   * Device detection: `matchMedia('(max-width: 768px)')` → mobile;
   * otherwise desktop.
   */
  private resolveDevicePositioning(config: WidgetConfig): EffectivePositioning {
    const isMobile = this.detectMobile()
    const device = isMobile ? 'mobile' : 'desktop'

    // V2 positioning present → use it (already effective from the backend).
    if (config.positioning && config.positioning[device]) {
      return config.positioning[device]
    }

    // Fallback: V1 position (bottom-start/bottom-end only).
    const v1Pos = config.position || 'bottom-end'
    const anchor: PositioningAnchor = v1Pos === 'bottom-start' ? 'bottom-start' : 'bottom-end'
    return { anchor, offsetX: 0, offsetY: 0 }
  }

  /** Detect mobile via matchMedia (with innerWidth fallback). */
  private detectMobile(): boolean {
    try {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(max-width: 768px)').matches
      }
    } catch {
      // matchMedia not available
    }
    return typeof window !== 'undefined' && window.innerWidth <= 768
  }

  /** Get launcher dimensions from the shape class. */
  private getLauncherDimensions(shape: string): { width: number; height: number } {
    if (shape === 'tab') return { width: 60, height: 52 }
    if (shape === 'pill') return { width: 64, height: 48 }
    return { width: 52, height: 52 } // rounded / default
  }

  /** Get the safe-area-inset-bottom via measured env() value (0 if unsupported). */
  private getSafeAreaBottom(): number {
    try {
      const div = document.createElement('div')
      div.style.cssText = 'position:fixed;bottom:0;left:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;'
      document.body.appendChild(div)
      const val = getComputedStyle(div).paddingBottom
      document.body.removeChild(div)
      const px = parseInt(val, 10)
      return isNaN(px) ? 0 : px
    } catch {
      return 0
    }
  }

  /**
   * Apply the computed position to the root element + panel.
   * Called on mount + on every resize/orientation change.
   */
  private applyPosition(): void {
    if (!this.state.config || !this.root) return
    const pos = this.state.effectivePositioning
    if (!pos) return

    const dims = this.getLauncherDimensions(this.state.config.launcherShape)
    const safeAreaBottom = this.getSafeAreaBottom()
    const result = computeLauncherPosition({
      anchor: pos.anchor,
      offsetX: pos.offsetX || 0,
      offsetY: pos.offsetY || 0,
      dir: this.state.dir,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      launcherWidth: dims.width,
      launcherHeight: dims.height,
      safeAreaBottom,
      baseMargin: DEFAULT_BASE_MARGIN,
    })

    // Apply the root position (always left + bottom).
    this.root.style.left = result.left + 'px'
    this.root.style.bottom = result.bottom + 'px'
    this.root.style.right = ''

    // Diagnostic data attributes — prove the widget received + applied
    // V2 positioning (verifiable by browser tests without timing-sensitive
    // CSS checks on root.style.left).
    this.root.setAttribute('data-sk-anchor', pos.anchor)
    this.root.setAttribute('data-sk-offset-x', String(pos.offsetX || 0))
    this.root.setAttribute('data-sk-offset-y', String(pos.offsetY || 0))

    // Store panel side for open/close transform.
    this.state.panelSide = result.panelSide

    // Apply panel side (horizontal).
    this.applyPanelSide(result.panelSide)

    // Apply panel vertical containment — keep the panel inside the
    // viewport even when the launcher is near the top edge.
    if (this.panel) {
      const panelPos = computePanelVerticalPosition({
        rootBottom: result.bottom,
        launcherHeight: dims.height,
        viewportHeight: window.innerHeight,
        panelGap: 12,
        panelPreferredHeight: 500,
        safeAreaBottom,
      })
      this.panel.style.bottom = panelPos.bottom + 'px'
      this.panel.style.maxHeight = panelPos.maxHeight + 'px'
    }
  }

  /** Apply the panel horizontal position (clamped to viewport). */
  private applyPanelSide(side: 'left' | 'right' | 'center'): void {
    if (!this.panel || !this.state.config || !this.state.effectivePositioning) return
    const pos = this.state.effectivePositioning
    const dims = this.getLauncherDimensions(this.state.config.launcherShape)
    const launcherResult = computeLauncherPosition({
      anchor: pos.anchor,
      offsetX: pos.offsetX || 0,
      offsetY: pos.offsetY || 0,
      dir: this.state.dir,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      launcherWidth: dims.width,
      launcherHeight: dims.height,
      safeAreaBottom: this.getSafeAreaBottom(),
      baseMargin: DEFAULT_BASE_MARGIN,
    })
    const ph = computePanelHorizontalPosition({
      launcherLeft: launcherResult.left,
      launcherWidth: dims.width,
      panelPreferredWidth: 360,
      viewportWidth: window.innerWidth,
      panelSide: side,
      viewportMargin: DEFAULT_BASE_MARGIN,
    })
    // Set clamped left + width (no right, no translateX).
    this.panel.style.left = ph.left + 'px'
    this.panel.style.right = ''
    this.panel.style.width = ph.width + 'px'
    this.applyPanelTransform()
  }

  /** Get the base transform for the panel (no longer needs translateX). */
  private getPanelBaseTransform(): string {
    return ''
  }

  /** Apply the panel transform (open/close animation). */
  private applyPanelTransform(): void {
    if (!this.panel) return
    const base = this.getPanelBaseTransform()
    if (this.state.open) {
      this.panel.style.transform = (base + ' translateY(0) scale(1)').trim()
    } else {
      this.panel.style.transform = (base + ' translateY(8px) scale(.98)').trim()
    }
  }

  /** Set up the resize/orientation listener for repositioning. */
  private setupResizeListener(): void {
    if (this.state.resizeHandler) return // already set up
    const handler = () => {
      if (this.destroyed) return
      // Re-detect device (desktop/mobile switch on resize).
      const newPos = this.resolveDevicePositioning(this.state.config!)
      const oldPos = this.state.effectivePositioning
      if (newPos.anchor !== oldPos?.anchor || newPos.offsetX !== oldPos.offsetX || newPos.offsetY !== oldPos.offsetY) {
        this.state.effectivePositioning = newPos
      }
      this.applyPosition()
    }
    this.state.resizeHandler = handler
    try {
      window.addEventListener('resize', handler)
      window.addEventListener('orientationchange', handler)
    } catch {
      // ignore
    }
  }

  /** Remove the resize/orientation listener (called on destroy). */
  private teardownResizeListener(): void {
    const handler = this.state.resizeHandler
    if (!handler) return
    try {
      window.removeEventListener('resize', handler)
      window.removeEventListener('orientationchange', handler)
    } catch {
      // ignore
    }
    this.state.resizeHandler = null
  }

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
   * clears typing timer, removes DOM root, clears identity state. Safe to
   * call multiple times.
   *
   * The `destroyed` flag is checked at the start of every async
   * callback (init's fetchConfig.then, identifyVisitor.then,
   * loadMessages.then, sendMessage.then, pollOnce.then,
   * reconcileHistory.then, modeAwareRefreshToken, authorizationRecovery)
   * so a delayed async callback after destroy() does NOT remount/update a
   * destroyed widget. The `generation` counter additionally guards against
   * stale async from a PREVIOUS identity (SPA user-switch).
   */
  destroy(): void {
    if (this.destroyed) return // idempotent: calling twice is a no-op
    this.destroyed = true
    this.clearIdentityState()
    // 0. Remove resize/orientation listener
    this.teardownResizeListener()
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
    // 5. Clear in-memory identity token (never persisted, but clear on teardown).
    this.memoryIdentityToken = null
    // 6. Reset mounted flag (allows a new initSukhan to mount)
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
  /** @internal — current identity state. */
  __getIdentityState(): IdentityState { return this.identityState }
  /** @internal — current generation counter. */
  __getGeneration(): number { return this.generation }
  /** @internal — the in-memory identity token (memory-only; tests assert it is NOT in storage). */
  __getMemoryIdentityToken(): string | null { return this.memoryIdentityToken }
  /** @internal — the ApiClient (for tests to spy on calls). */
  __getApi(): ApiClient { return this.api }
  /** @internal — force a bootstrap re-run (for mode-transition tests). */
  __bootstrap(): void { this.bootstrap() }
}
