/**
 * Sukhan Widget — API communication layer.
 *
 * Wraps the four public widget endpoints behind a typed client. The `apiKey`
 * is treated as the tenant slug for routing purposes — the same public
 * identifier used by the existing script-tag widget at
 * `/api/widget/<slug>/script`.
 *
 * Endpoints (relative to `apiUrl`):
 *   GET  /api/widget/<slug>/config      — fetch widget config (theme, plan)
 *   POST /api/widget/<slug>/contact     — identify visitor, get realtime token
 *   GET  /api/widget/<slug>/messages    — load conversation history
 *   POST /api/widget/<slug>/messages     — send a visitor message
 *   POST /api/widget/<slug>/csat        — submit CSAT rating
 *
 * All requests are CORS-enabled (`Access-Control-Allow-Origin: *` on the
 * backend) so they can be called from any host origin.
 */

import type {
  WidgetConfig,
  IdentifyResponse,
  Message,
} from './types'

/** Strip the optional `sk_` prefix from an API key. */
export function normalizeApiKey(key: string): string {
  return key.startsWith('sk_') ? key.slice(3) : key
}

/** Resolve the API base URL: explicit option → window.location.origin → fallback. */
export function resolveApiUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin
  }
  // SSR or non-browser bundler context — caller must pass `apiUrl` explicitly
  // when initializing. This fallback is only a sensible default for the
  // public Sukhan SaaS deployment.
  return 'https://app.sukhan.chat'
}

/**
 * Typed API client for the Sukhan widget endpoints.
 *
 * Construct one per widget instance. The `slug` is resolved from the API key
 * (the `sk_` prefix is stripped if present). The base URL defaults to the
 * page origin — for cross-origin embedding (e.g. embedding the widget on a
 * customer's site via the NPM package), pass `apiUrl` explicitly.
 */
export class ApiClient {
  readonly slug: string
  readonly apiUrl: string

  constructor(apiKey: string, apiUrl?: string) {
    this.slug = normalizeApiKey(apiKey)
    this.apiUrl = resolveApiUrl(apiUrl)
  }

  /** GET /api/widget/<slug>/config */
  async fetchConfig(): Promise<WidgetConfig> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/config`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`sukhan: config fetch failed (${res.status})`)
    }
    return (await res.json()) as WidgetConfig
  }

  /** POST /api/widget/<slug>/contact — identifies the visitor. */
  async identifyVisitor(input: {
    visitorId: string
    email?: string
    name?: string
  }): Promise<IdentifyResponse> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      throw new Error(`sukhan: identify failed (${res.status})`)
    }
    return (await res.json()) as IdentifyResponse
  }

  /** GET /api/widget/<slug>/messages?conversationId=... */
  async loadMessages(token: string, conversationId: string): Promise<Message[]> {
    if (!conversationId) return []
    const res = await fetch(
      `${this.apiUrl}/api/widget/${this.slug}/messages?conversationId=${encodeURIComponent(conversationId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { messages?: Message[] }
    return data.messages ?? []
  }

  /** POST /api/widget/<slug>/messages — send a visitor message. */
  async sendMessage(token: string, text: string): Promise<{
    message?: Message
    conversationId?: string
  }> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      throw new Error(`sukhan: send failed (${res.status})`)
    }
    return (await res.json()) as { message?: Message; conversationId?: string }
  }

  /** POST /api/widget/<slug>/csat — submit a CSAT rating. */
  async submitCsat(
    token: string,
    conversationId: string,
    rating: number,
    comment?: string | null,
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.apiUrl}/api/widget/${this.slug}/csat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ conversationId, rating, comment: comment ?? null }),
    })
    if (!res.ok) {
      throw new Error(`sukhan: csat failed (${res.status})`)
    }
    return (await res.json()) as { ok: boolean }
  }
}
