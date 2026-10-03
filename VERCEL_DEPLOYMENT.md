# Sukhan — Vercel Deployment Guide

## Architecture

```
Browser / Widget
    ↓ Socket.IO (websocket)
/api/realtime
    ↓
root api/realtime.ts Vercel Function
    ↓
Socket.IO rooms (tenant-isolated)
```

Application event publishing (messages, typing, read receipts):
```
Next.js API route
    ↓ Redis PUBLISH sukhan:realtime:publish
api/realtime.ts Redis subscriber
    ↓ Socket.IO room emit
    → connected clients receive event
```

Redis is **required** for events emitted from Next.js serverless function
invocations to reach connected Socket.IO clients on the `api/realtime.ts`
Vercel Function. Without Redis, messages are persisted to the database but
not delivered in real-time (clients fall back to 10-second polling).

## Key Socket.IO Client Settings

All Vercel clients (dashboard + widget) use:

```ts
io(origin, {
  path: '/api/realtime',
  addTrailingSlash: false,
  transports: ['websocket'],
  auth: { token },
})
```

`addTrailingSlash: false` is **required** — Socket.IO otherwise appends `/`
to the path, causing `/api/realtime/` which triggers Next.js's 308
trailing-slash redirect. WebSocket upgrade requests cannot follow HTTP
redirects, so the connection would fail without this setting.

## Reconnect Behavior

On reconnect, the client automatically re-emits `conversation:join` for
the currently open conversation. The server's room state is lost on
disconnect (Vercel functions are stateless between invocations), so
re-joining is required to resume receiving events.

## Tenant / Contact Authorization

- **Agents** join `tenant:<id>` + `agent:<id>` rooms automatically.
- **Visitors** only receive events for their own conversations.
- `conversation:join` is authorized via a database check:
  - Agent: must match `tenantId`
  - Visitor: must match `tenantId` AND `contactId`
- Cross-tenant and cross-contact joins are silently rejected.

## Environment Variables

See `.env.vercel.example` for the complete list. Key variables:

| Variable | Purpose |
|---|---|
| `NEXTAUTH_SECRET` | JWT + realtime token signing |
| `DATABASE_URL` | Neon pooled (runtime Prisma) |
| `DIRECT_URL` / `DATABASE_URL_UNPOOLED` | Neon direct (migrations) |
| `REDIS_URL` | Redis pub/sub for realtime |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob for attachments |
| `NEXT_PUBLIC_VERCEL` | Set to `1` (client-side Vercel detection) |

## Build Process

Vercel uses `installCommand: "bash vercel-install.sh"` from `vercel.json`.
This script:
1. Runs `bun install`
2. Sets `DIRECT_URL` from `DATABASE_URL_UNPOOLED` (if not set)
3. Runs `prisma generate`
4. Runs `prisma migrate deploy`

Then Vercel's default Next.js build runs automatically. The root-level
`api/realtime.ts` is deployed as a Vercel Function alongside Next.js
API routes.

## Docker / Self-Hosted

Docker uses a separate realtime service (`mini-services/realtime/index.ts`)
with Socket.IO path `/` and websocket+polling transport. Caddy reverse-proxies
via `?XTransformPort=3003`. This is unchanged and fully compatible.
