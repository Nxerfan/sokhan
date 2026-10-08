# sukhan-widget

> Bilingual (Persian / English) live-chat widget for the [Sukhan](https://sukhan.chat) platform.

Embeddable as an NPM package **or** as a single `<script>` tag. Auto-initializes
in any browser environment and is a no-op on the server (SSR-safe — safe to
import in Next.js server components without guards).

- RTL-aware from day one (the widget reads `defaultDirection` from your
  tenant config; both `rtl` and `ltr` are first-class).
- Real-time messaging over Socket.IO with a polling fallback (only when
  the socket is disconnected).
- Plan-gated styling: **free-plan widgets get locked styling** — a small
  "Powered by Sukhan" badge and no white-label. Pro / Business / Enterprise
  tenants get full white-label.
- No framework dependency. The widget is rendered with vanilla DOM.

---

## Runtime contract (Task W)

The widget's runtime contract was hardened in Task W (PR
`fix/widget-inbox-realtime-reliability`). Key points:

### Hosted Sukhan (default)

- Default `apiUrl`: `https://app.sukhan.chat` (the hosted Sukhan canonical
  origin).
- The host page origin (`window.location.origin`) is **NOT** used as the
  Sukhan backend by default. The NPM widget is shipped to third-party
  sites that have nothing to do with Sukhan — the widget must always talk
  to the Sukhan backend, never the host page origin.
- The realtime endpoint config (Socket.IO URL + path + transports +
  `addTrailingSlash`) is provided by the **backend** in its
  `GET /api/widget/<slug>/config` response (additive `realtime` field).
  On the hosted Vercel deployment, the backend returns:
  `{ url: '', path: '/api/realtime', transports: ['websocket'], addTrailingSlash: false }`.
  The widget resolves the empty `url` against `apiUrl` → the Sukhan origin.

### Self-host (explicit `apiUrl`)

Self-hosted deployments MUST pass `apiUrl` explicitly:

```ts
initSukhan({
  apiKey: 'sk_your-workspace-slug',
  apiUrl: 'https://sukhan.your-domain.com', // explicit
})
```

The backend at that origin returns its own `realtime` field in the widget
config response; the widget uses it. If the self-hosted backend hasn't yet
been upgraded to return the `realtime` field, the widget falls back to the
documented hosted default (`/api/realtime` + WebSocket-only). To override
the backend-supplied config, pass `realtime` explicitly:

```ts
initSukhan({
  apiKey: 'sk_your-workspace-slug',
  apiUrl: 'https://sukhan.your-domain.com',
  realtime: {
    url: 'https://sukhan.your-domain.com',
    path: '/',
    transports: ['websocket', 'polling'],
    addTrailingSlash: false,
  },
})
```

### What was removed

- **`window.__sukhan_api_url`** — the widget no longer writes this global,
  and the socket no longer reads it. The socket receives its config
  explicitly via `SukhanSocketOptions` (constructor argument).
- **Hardcoded `/?XTransformPort=3003` + `path: '/'`** in the NPM socket —
  deployment topology now comes from the backend `config.realtime`
  response (or the explicit `SukhanOptions.realtime` override).
- **`window.location.origin` fallback** in `resolveApiUrl` — the hosted
  canonical default (`https://app.sukhan.chat`) is used instead. The host
  page origin is never the Sukhan backend.

### Reliability features

- **Single-flight script load**: ONE shared Promise keyed by absolute
  script URL. Two concurrent `connect()` calls share one `<script>`
  element. Failure resets the cache so a later retry can re-attempt.
- **Single-flight token refresh**: at most ONE refresh operation is in
  flight when multiple `connect_error` events arrive while a token is
  expired. Refresh failure is bounded — capped retries (5 by default),
  no infinite loop. `membership_inactive` is terminal (no retry).
- **Reconnect gap recovery**: on reconnect, the widget (1) re-emits
  `conversation:join` for the current conversation, (2) fetches /
  reconciles history once (dedup by `Message.id`).
- **Central message merge**: ONE `mergeMessages` function keyed by
  `Message.id` is used for ALL ingestion paths (POST response, socket
  `message:new`, polling, history reload). Same id appears exactly once.
  A server-updated copy of the same id replaces the stale local copy.
  Stable chronological ordering by `createdAt` then `id`.
- **Polling as a REAL fallback**: polling only runs when the socket is
  disconnected. On reconnect, polling stops and one immediate history
  reconcile happens. Never creates multiple intervals. `destroy()` clears
  the interval.
- **`destroy()` is idempotent**: calling twice is a no-op. Clears polling,
  typing timer, socket, DOM root. Every async callback checks a
  `destroyed` flag — a delayed `fetch().then()` after `destroy()` does
  NOT remount / update a destroyed widget.

---

## Install

```bash
bun add sukhan-widget
# or
npm install sukhan-widget
```

## Quick start (3 steps)

### 1. Install the package

```bash
bun add sukhan-widget
```

### 2. Set the environment variable

```bash
# .env.local (Next.js) or .env (Vite / webpack)
SUKHAN_API_KEY=sk_your-workspace-slug
```

> Find your API key in the Sukhan dashboard → **Widget → Embed**. The `sk_`
> prefix is optional and stripped at runtime; the underlying identifier is
> your workspace slug.

### 3. Import + render

```tsx
// app/chat.tsx (Next.js client component) — or any client-side entry point
'use client'
import { useEffect } from 'react'
import { initSukhan } from 'sukhan-widget'

export function Chat() {
  useEffect(() => {
    const instance = initSukhan({
      apiKey: process.env.NEXT_PUBLIC_SUKHAN_API_KEY,
      // apiUrl defaults to https://app.sukhan.chat (hosted Sukhan).
      // Pass apiUrl explicitly for self-hosted deployments.
    })
    return () => instance.destroy()
  }, [])
  return null
}
```

For Next.js, expose the env var to the client by also defining
`NEXT_PUBLIC_SUKHAN_API_KEY`:

```bash
# .env.local
NEXT_PUBLIC_SUKHAN_API_KEY=sk_your-workspace-slug
```

---

## HTML / script-tag method (no NPM)

For non-React sites (plain HTML, WordPress, custom CMS), use the
script-tag alternative:

```html
<script
  async
  defer
  src="https://app.sukhan.chat/api/widget/v1/sukhan.js"
  data-api-key="sk_your-workspace-slug"
></script>
```

---

## Configuration

`initSukhan(options)` accepts:

| Option          | Type                | Default                       | Description |
| --------------- | ------------------- | ----------------------------- | ----------- |
| `apiKey`        | `string`            | env                           | The tenant API key (workspace slug, optionally `sk_`-prefixed). Falls back to `process.env.SUKHAN_API_KEY` then `window.SUKHAN_API_KEY`. |
| `apiUrl`        | `string`            | `https://app.sukhan.chat`     | Sukhan backend base URL. NEVER defaults to `window.location.origin` — the host page origin is NOT the Sukhan backend. Pass `apiUrl` explicitly for self-hosted deployments. |
| `realtime`      | `RealtimeEndpointConfig` | (backend `config.realtime`) | Optional override for the realtime endpoint config. Takes priority over the backend-supplied `config.realtime`. |
| `container`     | `HTMLElement`       | body                          | Where to mount the widget. Defaults to `document.body`. |
| `locale`        | `'fa' \| 'en'`      | tenant                        | Force a UI locale. Defaults to the tenant's `defaultLocale`. |
| `direction`     | `'rtl' \| 'ltr'`    | tenant                        | Force a text direction. Defaults to the tenant's `defaultDirection`. |
| `visitor`       | `{ name?, email?, visitorId? }` | —                | Pre-identify the visitor with a name / email / custom visitor ID. |
| `disablePolling`| `boolean`          | `false`                       | Suppress the polling fallback. **Test-only.** |

> **Free plan is LOCKED.** On the free plan the widget renders a small
> "Powered by Sukhan" badge at the bottom of the panel and the launcher uses
> the neutral ink color (#0E1116). Accent-color theming, white-label, and
> removing the badge require a paid plan (Pro / Business / Enterprise).

---

## API reference

The widget talks to four public endpoints on the Sukhan backend. All are
CORS-enabled (`Access-Control-Allow-Origin: *`) and rate-limited.

| Method | Path                                | Auth                | Description |
| ------ | ----------------------------------- | ------------------- | ----------- |
| GET    | `/api/widget/<slug>/config`        | none                | Fetch the widget configuration (accent, shape, position, greeting, locale, direction, **realtime** endpoint config). |
| POST   | `/api/widget/<slug>/contact`        | none                | Identify the visitor. Body: `{ visitorId, email?, name? }`. Returns `{ contactId, conversationId, realtimeToken, locale, direction }`. |
| GET    | `/api/widget/<slug>/messages`       | `Bearer <token>`    | Load the visitor's conversation history. Query: `?conversationId=...`. |
| POST   | `/api/widget/<slug>/messages`       | `Bearer <token>`    | Send a visitor message. Body: `{ text }`. Returns `{ message, conversationId }`. |
| POST   | `/api/widget/<slug>/csat`           | `Bearer <token>`    | Submit a CSAT rating. Body: `{ conversationId, rating: 1-5, comment? }`. |

The realtime (Socket.IO) endpoint config comes from the backend
`config.realtime` field:

| Deployment | `url` | `path` | `transports` | `addTrailingSlash` |
| ---------- | ----- | ------ | ------------ | ------------------ |
| Hosted Vercel | `''` (resolved to Sukhan origin) | `/api/realtime` | `['websocket']` | `false` |
| Docker / dev (Caddy) | `/?XTransformPort=3003` | `/` | `['websocket', 'polling']` | `false` |
| Self-host (explicit) | (returned by backend) | (returned by backend) | (returned by backend) | (returned by backend) |

The Socket.IO client script is loaded from `<apiUrl>/socket.io.min.js`
(URL semantics — `new URL('/socket.io.min.js', apiUrl)`).

### Auth model

The visitor's realtime token is a short-lived JWT signed with the Sukhan
backend's `NEXTAUTH_SECRET`. It encodes `{ type: 'visitor', contactId,
tenantId, slug }`. The token is sent as `Authorization: Bearer <token>` on
REST requests and as `auth: { token }` on the Socket.IO handshake.

---

## Troubleshooting

### The widget doesn't appear on my page

1. Check the browser console for `[sukhan]` errors. The most common is a
   missing API key.
2. Verify `SUKHAN_API_KEY` (or `NEXT_PUBLIC_SUKHAN_API_KEY` for Next.js)
   is set in your environment AND exposed to the client.
3. Confirm the Sukhan backend is reachable:
   `curl https://app.sukhan.chat/api/widget/<your-slug>/config`
   should return JSON, not a 404.

### Real-time messages don't arrive

The widget uses Socket.IO as the primary delivery path, with a polling
fallback (only when the socket is disconnected). If you see messages
arriving only via polling (10s delay), check:

1. **`NEXTAUTH_SECRET` mismatch** between the Next.js app and the realtime
   service. Both processes must use the same secret.
2. **Reverse proxy** stripping the WebSocket upgrade headers or the
   `?XTransformPort=3003` query param (Docker / dev deployment).
3. **Ad blockers** blocking `/socket.io.min.js`. The polling fallback
   handles this gracefully — messages arrive in 10s instead of sub-second.
4. **Backend `config.realtime` field** — confirm the backend returns the
   additive `realtime` field in the widget config response. Without it,
   the widget falls back to the hosted default (`/api/realtime` +
   WebSocket-only).

### Cross-origin embedding fails with CORS errors

All public widget endpoints set `Access-Control-Allow-Origin: *`, so CORS
shouldn't be an issue. If you see CORS errors:

1. You may be hitting a dashboard endpoint (e.g. `/api/conversations`)
   which is same-origin only. The widget endpoints are all under
   `/api/widget/<slug>/`.
2. Your reverse proxy may be stripping the `Access-Control-Allow-Origin`
   header.

### Self-hosted deployment

Pass `apiUrl` explicitly:

```ts
initSukhan({
  apiKey: 'sk_your-workspace-slug',
  apiUrl: 'https://sukhan.your-domain.com',
})
```

The backend at that origin returns its own `realtime` field; the widget
uses it. The host page origin is NOT used as the Sukhan backend.

---

## License

AGPL-3.0. © Sukhan. See [https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html).
