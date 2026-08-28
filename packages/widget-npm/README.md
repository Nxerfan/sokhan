# sukhan-widget

> Bilingual (Persian / English) live-chat widget for the [Sukhan](https://sukhan.chat) platform.

Embeddable as an NPM package **or** as a single `<script>` tag. Auto-initializes
in any browser environment and is a no-op on the server (SSR-safe — safe to
import in Next.js server components without guards).

- RTL-aware from day one (the widget reads `defaultDirection` from your
  tenant config; both `rtl` and `ltr` are first-class).
- Real-time messaging over Socket.IO with a 10s polling fallback.
- Plan-gated styling: **free-plan widgets get locked styling** — a small
  "Powered by Sukhan" badge and no white-label. Pro / Business / Enterprise
  tenants get full white-label.
- No framework dependency. The widget is rendered with vanilla DOM.

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
    // Reads process.env.SUKHAN_API_KEY (inlined at build time by Next.js
    // when prefixed with NEXT_PUBLIC_ in your .env file — see below).
    const instance = initSukhan({
      apiKey: process.env.NEXT_PUBLIC_SUKHAN_API_KEY,
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

That's it. The launcher button renders at the configured corner of your
page; clicking it opens the chat panel.

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

The script reads `data-api-key` from its own `<script>` tag at runtime,
resolves the Sukhan backend origin from the `src` URL, and bootstraps the
same widget the NPM package would. No build step, no bundler, no NPM.

---

## Configuration

`initSukhan(options)` accepts:

| Option          | Type                | Default | Description |
| --------------- | ------------------- | ------- | ----------- |
| `apiKey`        | `string`            | env     | The tenant API key (workspace slug, optionally `sk_`-prefixed). Falls back to `process.env.SUKHAN_API_KEY` then `window.SUKHAN_API_KEY`. |
| `apiUrl`        | `string`            | origin  | Sukhan backend base URL. Defaults to the page origin (same-domain embedding) or `https://app.sukhan.chat` (cross-origin NPM embedding). |
| `container`     | `HTMLElement`       | body    | Where to mount the widget. Defaults to `document.body`. |
| `locale`        | `'fa' \| 'en'`      | tenant  | Force a UI locale. Defaults to the tenant's `defaultLocale`. |
| `direction`     | `'rtl' \| 'ltr'`    | tenant  | Force a text direction. Defaults to the tenant's `defaultDirection`. |
| `visitor`       | `{ name?, email?, visitorId? }` | —       | Pre-identify the visitor with a name / email / custom visitor ID. |
| `disablePolling`| `boolean`           | `false` | Suppress the 10s polling fallback. **Test-only.** |

> **Free plan is LOCKED.** On the free plan the widget renders a small
> "Powered by Sukhan" badge at the bottom of the panel and the launcher uses
> the neutral ink color (#0E1116). Accent-color theming, white-label, and
> removing the badge require a paid plan (Pro / Business / Enterprise).

---

## API reference

The widget talks to four public endpoints on the Sukhan backend. All are
CORS-enabled (`Access-Control-Allow-Origin: *`) and rate-limited (30 req/min
per IP, 60 req/min per tenant — see `src/lib/rate-limit.ts`).

| Method | Path                                | Auth                | Description |
| ------ | ----------------------------------- | ------------------- | ----------- |
| GET    | `/api/widget/<slug>/config`        | none                | Fetch the widget configuration (accent, shape, position, greeting, locale, direction). |
| POST   | `/api/widget/<slug>/contact`        | none                | Identify the visitor. Body: `{ visitorId, email?, name? }`. Returns `{ contactId, conversationId, realtimeToken, locale, direction }`. |
| GET    | `/api/widget/<slug>/messages`       | `Bearer <token>`    | Load the visitor's conversation history. Query: `?conversationId=...`. |
| POST   | `/api/widget/<slug>/messages`       | `Bearer <token>`    | Send a visitor message. Body: `{ text }`. Returns `{ message, conversationId }`. |
| POST   | `/api/widget/<slug>/csat`           | `Bearer <token>`    | Submit a CSAT rating. Body: `{ conversationId, rating: 1-5, comment? }`. |

Plus the realtime service:

| Transport   | URL                                | Auth                |
| ----------- | ---------------------------------- | ------------------- |
| Socket.IO   | `/?XTransformPort=3003` (Caddy gateway) | `auth.token` (realtime token from `POST /contact`) |

### Auth model

The visitor's realtime token is a short-lived JWT signed with the Sukhan
backend's `NEXTAUTH_SECRET`. It encodes `{ type: 'visitor', contactId,
tenantId, slug }`. The token is sent as `Authorization: Bearer <token>` on
REST requests and as `auth: { token }` on the Socket.IO handshake.

### Rate limits

- **30 req/min** per IP address (sliding window).
- **60 req/min** per tenant (slug).
- 429 responses include a `Retry-After` header.
- Dev mode skips rate limiting for localhost (so tests don't trip it).

---

## Plan limits

| Feature                  | Free | Pro     | Business | Enterprise |
| ------------------------ | ---- | ------- | -------- | ---------- |
| Agents                   | 2    | 5       | 20       | ∞          |
| Conversations / month    | 100  | 1,000   | 5,000    | ∞          |
| Departments              | 1    | 5       | ∞        | ∞          |
| Real-time chat           | ✓    | ✓       | ✓        | ✓          |
| Widget customization     | ✓    | ✓       | ✓        | ✓ + white-label |
| CSAT surveys             | ✓    | ✓       | ✓        | ✓          |
| File attachments         | —    | ✓       | ✓        | ✓          |
| AI actions / month       | 0    | 500     | 2,000    | ∞          |
| FAQ auto-responder       | —    | ✓       | ✓        | ✓          |
| Product Q&A              | —    | ✓       | ✓        | ✓          |
| Routing rules            | —    | ✓       | ✓        | ✓ + SLA    |
| WooCommerce / CSV import | —    | ✓       | ✓        | ✓          |
| Analytics                | —    | ✓       | ✓        | ✓          |
| Self-hosting license     | —    | —       | —        | ✓          |

> Free-plan widgets are **locked** to a "Powered by Sukhan" badge and the
> neutral ink launcher color. Upgrade to Pro to remove attribution and
> apply your own accent color across the launcher + header.

---

## Troubleshooting

### The widget doesn't appear on my page

1. Check the browser console for `[sukhan]` errors. The most common is a
   missing API key.
2. Verify `SUKHAN_API_KEY` (or `NEXT_PUBLIC_SUKHAN_API_KEY` for Next.js)
   is set in your environment AND exposed to the client. Server-only env
   vars (no `NEXT_PUBLIC_` prefix) are not available in client components.
3. Confirm the Sukhan backend is reachable: `curl https://app.sukhan.chat/api/widget/<your-slug>/config`
   should return JSON, not a 404.

### Real-time messages don't arrive (or arrive after a 10s delay)

The 10s delay means the polling fallback is delivering the message instead
of Socket.IO. Causes:

1. **`NEXTAUTH_SECRET` mismatch** between the Next.js app and the realtime
   service. Both processes must use the same secret. In dev, both fall
   back to the same deterministic dev secret; in production, set
   `NEXTAUTH_SECRET` explicitly in both services.
2. **Caddy / reverse proxy** is stripping the `XTransformPort` query param
   or the WebSocket upgrade headers. Confirm the proxy passes through
   `?XTransformPort=3003` and supports `Upgrade: websocket`.
3. **Ad blockers** sometimes block `/socket.io.min.js`. The polling fallback
   handles this gracefully — messages arrive in 10s instead of sub-second.

### I'm on the free plan and the widget shows a "Powered by Sukhan" badge

That's expected behavior. Free-plan widgets are LOCKED: the launcher uses
the neutral ink color (#0E1116) and the panel shows a small "Powered by
Sukhan" footer. Upgrade to Pro / Business / Enterprise to remove the badge
and apply your own accent color across the launcher + header.

### `initSukhan` throws `sukhan: no API key found`

Three places the widget looks for the API key, in priority order:

1. `options.apiKey` (passed to `initSukhan({ apiKey: '...' })`)
2. `window.SUKHAN_API_KEY` (runtime injection — useful for non-bundler setups)
3. `process.env.SUKHAN_API_KEY` (inlined at build time)

If none are set, init throws. Set at least one.

### Cross-origin embedding fails with CORS errors

All public widget endpoints set `Access-Control-Allow-Origin: *`, so CORS
shouldn't be an issue. If you see CORS errors:

1. You may be hitting a dashboard endpoint (e.g. `/api/conversations`)
   which is same-origin only. The widget endpoints are all under
   `/api/widget/<slug>/`.
2. Your reverse proxy may be stripping the `Access-Control-Allow-Origin`
   header. Check the Caddy / nginx config.

### How do I force a specific locale?

Pass `locale: 'en'` (or `'fa'`) to `initSukhan()`. Without an override,
the widget uses the tenant's `defaultLocale` from the dashboard.

---

## License

AGPL-3.0. © Sukhan. See [https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html).
