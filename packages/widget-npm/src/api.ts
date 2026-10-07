/**
 * Sukhan Widget — API communication layer.
 *
 * Wraps the four public widget endpoints behind a typed client. The base
 * URL (`apiUrl`) resolution lives in `./realtime-resolve.ts`
 * (`resolveApiUrl`) — a pure function with no env access. Re-exported
 * here for backwards compatibility with consumers that import from
 * `'./api'`.
 */

import type {
  WidgetConfig,
  IdentifyResponse,
  Message,
} from './types'

// Re-export for backwards compat with `import { resolveApiUrl } from './api'`.
export { resolveApiUrl, HOSTED_API_URL } from './realtime-resolve'
import { resolveApiUrl } from './realtime-resolve'

/** Strip the optional `sk_` prefix from an API key. */
export function normalizeApiKey(key: string): string {
  return key.startsWith('sk_') ? key.slice(3) : key
}

/**
 * Typed API client for the Sukhan widget endpoints.
 *
 * The base URL defaults to the hosted Sukhan canonical origin
 * `https://app.sukhan.chat`; pass `apiUrl` explicitly for self-hosted
 * deployments.
 */
export class ApiClient {
  readonly slug: string
  readonly apiUrl: string

  constructor(apiKey: string, apiUrl?: string) {
    this.slug = normalizeApiKey(apiKey)
    this.apiUrl = resolveApiUrl(apiUrl)
  }

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
