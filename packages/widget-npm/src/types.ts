/**
 * Sukhan Widget — TypeScript type definitions.
 *
 * These types describe the widget configuration returned by the Sukhan API,
 * the messages exchanged between visitor and agent, and the options accepted
 * by the widget initialization function.
 *
 * @packageDocumentation
 */

/** The widget's visual configuration, as returned by GET /api/widget/<slug>/config. */
export interface WidgetConfig {
  /** Tenant slug — also acts as the public API key for the widget. */
  slug: string
  /** Display name (shown in the widget header). */
  name: string
  /** Hex accent color, e.g. "#E09A2B". */
  accentColor: string
  /** Launcher shape — controls the launcher button silhouette. */
  launcherShape: 'tab' | 'rounded' | 'pill'
  /** Position on the page. */
  position: 'bottom-start' | 'bottom-end'
  /** Optional agent avatar URL. */
  avatarUrl?: string | null
  /** Optional brand logo URL. */
  logoUrl?: string | null
  /** Per-locale greeting text shown when the widget opens. */
  greetingTexts: Record<string, string>
  /** Default UI locale: "fa" or "en". */
  defaultLocale: string
  /** Default text direction: "rtl" or "ltr". */
  defaultDirection: 'rtl' | 'ltr'
  /**
   * Tenant plan slug. Used to apply plan-gated styling — free plan widgets
   * get locked (small "Powered by Sukhan" badge, no white-label).
   */
  plan?: 'free' | 'pro' | 'business' | 'enterprise'
}

/** Sender type for a chat message. */
export type SenderType = 'agent' | 'contact' | 'ai' | 'system'

/** An attachment on a message (image, file, etc.). */
export interface MessageAttachment {
  url: string
  type: 'image' | 'file'
  name: string
}

/** The content payload of a message. */
export interface MessageContent {
  text?: string
  attachments?: MessageAttachment[]
}

/** A chat message in a conversation. */
export interface Message {
  id: string
  conversationId: string
  senderType: SenderType
  contentType: 'text' | 'image' | 'file' | 'system'
  content: MessageContent
  status?: 'sent' | 'delivered' | 'read'
  createdAt: string
}

/** The response from POST /api/widget/<slug>/contact — identifies a visitor. */
export interface IdentifyResponse {
  contactId: string
  conversationId: string | null
  realtimeToken: string
  locale: string
  direction: 'rtl' | 'ltr'
}

/** Options accepted by the widget initializer. */
export interface SukhanOptions {
  /**
   * The tenant API key. In the current implementation this is the tenant's
   * public slug. The `sk_` prefix is optional and stripped if present.
   *
   * Required for `initSukhan()`. If omitted, the value of `SUKHAN_API_KEY`
   * env var (inlined at build time) or `window.SUKHAN_API_KEY` is used.
   */
  apiKey?: string
  /**
   * The base URL of the Sukhan backend. Defaults to the same origin as the
   * page (works when the widget is loaded from the Sukhan domain) or
   * `https://app.sukhan.chat` when explicitly imported in a Node bundler.
   */
  apiUrl?: string
  /**
   * Optional container element to mount the widget into. Defaults to
   * `document.body`.
   */
  container?: HTMLElement
  /**
   * Override the locale detected from the widget config. Useful when the host
   * page wants to force a specific language regardless of tenant default.
   */
  locale?: 'fa' | 'en'
  /**
   * Override the text direction. Useful for embedding in pages whose own
   * direction differs from the tenant's default.
   */
  direction?: 'rtl' | 'ltr'
  /**
   * When true, suppresses the polling fallback so Socket.IO is the only
   * delivery path. Useful in test environments.
   * @internal
   */
  disablePolling?: boolean
  /**
   * Visitor metadata to attach on identification (name, email).
   */
  visitor?: { name?: string; email?: string; visitorId?: string }
}

/** Events emitted by the SukhanSocket. */
export type SocketEvent =
  | 'connect'
  | 'disconnect'
  | 'message:new'
  | 'conversation:updated'
  | 'typing:start'
  | 'typing:stop'

/** Event handler signature. */
export type SocketHandler = (payload: unknown) => void

/** Public API of the initialized widget. Returned by `initSukhan()`. */
export interface SukhanInstance {
  /** Open the widget panel. */
  open(): void
  /** Close the widget panel. */
  close(): void
  /** Toggle the widget panel open/closed. */
  toggle(): void
  /** Send a text message from the visitor. */
  send(text: string): Promise<void>
  /** Destroy the widget instance — removes DOM nodes, disconnects socket. */
  destroy(): void
  /** The resolved widget config (null until config is fetched). */
  config: WidgetConfig | null
}
