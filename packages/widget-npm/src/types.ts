/**
 * Sukhan Widget — TypeScript type definitions.
 * @packageDocumentation
 */

export type {
  RealtimeTransport,
  RealtimeEndpointConfig,
} from './realtime-resolve'

export interface WidgetConfig {
  slug: string
  name: string
  accentColor: string
  launcherShape: 'tab' | 'rounded' | 'pill'
  position: 'bottom-start' | 'bottom-end'
  avatarUrl?: string | null
  logoUrl?: string | null
  greetingTexts: Record<string, string>
  defaultLocale: string
  defaultDirection: 'rtl' | 'ltr'
  plan?: 'free' | 'pro' | 'business' | 'enterprise'
  /**
   * Backend-supplied realtime endpoint config (additive field). The widget
   * uses this as the PRIMARY runtime source. Older backends omit the
   * field; the widget falls back to the documented hosted default.
   */
  realtime?: import('./realtime-resolve').RealtimeEndpointConfig
}

export type SenderType = 'agent' | 'contact' | 'ai' | 'system'

export interface MessageAttachment {
  url: string
  type: 'image' | 'file'
  name: string
}

export interface MessageContent {
  text?: string
  attachments?: MessageAttachment[]
}

export interface Message {
  id: string
  conversationId: string
  senderType: SenderType
  contentType: 'text' | 'image' | 'file' | 'system'
  content: MessageContent
  status?: 'sent' | 'delivered' | 'read'
  createdAt: string
}

export interface IdentifyResponse {
  contactId: string
  conversationId: string | null
  realtimeToken: string
  locale: string
  direction: 'rtl' | 'ltr'
}

/**
 * Explicit realtime/socket configuration accepted by `SukhanSocket`.
 * The socket does NOT read any global state (`window.__sukhan_api_url`,
 * etc.) — it receives everything via this interface.
 */
export interface SukhanSocketOptions {
  token: string
  clientScriptUrl: string
  realtimeUrl: string
  realtimePath: string
  transports: import('./realtime-resolve').RealtimeTransport[]
  addTrailingSlash: boolean
}

export interface SukhanOptions {
  apiKey?: string
  /**
   * The base URL of the Sukhan backend. Defaults to the hosted Sukhan
   * canonical origin `https://app.sukhan.chat`. NEVER defaults to
   * `window.location.origin` — the host page origin is NOT the Sukhan
   * backend by default.
   */
  apiUrl?: string
  /**
   * Optional override for the realtime endpoint config. Takes priority
   * over the backend-supplied `config.realtime`.
   */
  realtime?: import('./realtime-resolve').RealtimeEndpointConfig
  container?: HTMLElement
  locale?: 'fa' | 'en'
  direction?: 'rtl' | 'ltr'
  /** @internal — suppresses the polling fallback. Test-only. */
  disablePolling?: boolean
  visitor?: { name?: string; email?: string; visitorId?: string }
}

export type SocketEvent =
  | 'connect'
  | 'disconnect'
  | 'reconnect'
  | 'message:new'
  | 'conversation:updated'
  | 'typing:start'
  | 'typing:stop'

export type SocketHandler = (payload: unknown) => void

export interface SukhanInstance {
  open(): void
  close(): void
  toggle(): void
  send(text: string): Promise<void>
  destroy(): void
  config: WidgetConfig | null
}
