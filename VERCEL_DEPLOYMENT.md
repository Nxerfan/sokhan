# Sukhan — Vercel + Neon Deployment Guide

This guide covers deploying Sukhan on **Vercel** (Next.js application) with **Neon PostgreSQL** (managed database), **Upstash Redis** (realtime pub/sub), **Vercel Blob** (attachment storage), and a separately-hosted **realtime Socket.IO service**.

For Docker / self-hosted deployments, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Architecture (Vercel mode)

| Component       | Docker                              | Vercel                                       |
|-----------------|-------------------------------------|----------------------------------------------|
| Next.js app     | Standalone Node process             | Vercel serverless functions                  |
| Database        | PostgreSQL (Docker Full/Lite)       | **Neon PostgreSQL** (pooled + direct)       |
| ORM             | Prisma                              | Prisma                                       |
| Migrations      | `prisma migrate deploy` (startup)   | `prisma migrate deploy` (build time)         |
| Realtime        | In-process Socket.IO (port 3003)    | Separately-hosted Socket.IO + Redis pub/sub  |
| Object storage  | Local filesystem (`public/uploads`) | Vercel Blob                                  |
| Authentication  | NextAuth (credentials + OTP)        | NextAuth (unchanged)                         |

**Neon PostgreSQL is the official managed database provider for Sukhan's Vercel deployment.** Other Postgres providers are NOT supported by the Vercel deployment path. Docker/self-hosted PostgreSQL remains separately supported.

---

## Neon PostgreSQL Setup

### 1. Create a Neon project

1. Sign in to [Neon](https://neon.tech) → Create New Project.
2. Choose a **region close to your Vercel deployment region** (default: `iad1` — see `vercel.json`).
3. Set a strong database password. Store it securely.

### 2. Obtain the Neon connection strings

Neon provides TWO connection strings (Neon Console → Project → Connection Details):

#### Pooled connection (Neon pooler, `-pooler` in hostname)
- Used by the Prisma Client at runtime.
- Format: `postgresql://<user>:<password>@ep-<project>-pooler.<region>.aws.neon.tech/<db>?sslmode=require&channel_binding=require`
- Append `&pgbouncer=true` so Prisma disables prepared statements.
- Final: `postgresql://...?sslmode=require&channel_binding=require&pgbouncer=true`

#### Direct connection (no `-pooler` in hostname)
- Used by `prisma migrate deploy` and `prisma migrate status`.
- Format: `postgresql://<user>:<password>@ep-<project>.<region>.aws.neon.tech/<db>?sslmode=require&channel_binding=require`
- DO NOT add `&pgbouncer=true` — DDL is incompatible with transaction-mode pooling.

### 3. Configure Vercel environment variables

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | Pooled connection (with `&pgbouncer=true`) | Runtime Prisma Client |
| `DIRECT_URL` | Direct connection (no pooler) | Prisma Migrate |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` | Shared with realtime service |
| `NEXTAUTH_URL` | `https://your-sukhan-app.vercel.app` | Canonical Vercel domain |
| `REDIS_URL` | Upstash Redis URL | Realtime pub/sub |
| `NEXT_PUBLIC_REALTIME_URL` | `https://realtime.your-domain.com` | Public URL of realtime service |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token | Attachment storage |
| `NIXIFY_API_KEY` | Nixify API key | OTP email verification |
| `NIXIFY_BASE_URL` | Nixify base URL | Nixify API base |

**Pooled connection:** application runtime / Vercel serverless functions.
**Direct connection:** Prisma migrations / schema administration.

NEVER expose either connection string to the browser. Both are server-side only.

### 4. Run the baseline migration

The first time you deploy, `vercel-build.sh` runs `prisma migrate deploy` against your Neon database (using `DIRECT_URL`). The baseline migration creates all tables.

To verify locally first:

```bash
export DIRECT_URL="postgresql://..."
bunx prisma migrate status
bunx prisma migrate deploy
```

### 5. Verify database connectivity

```bash
bunx prisma migrate status
# Expected: "Database schema is up to date!"
```

### 6. Verify tenant isolation

Sukhan enforces tenant isolation at the application layer via:
1. Prisma client extension (`src/lib/db.ts`) — auto-injects `tenantId`.
2. AsyncLocalStorage — each request gets its own tenant context.
3. Explicit `tenantId` filters in every API route handler.

PostgreSQL RLS is defense-in-depth ONLY.

### 7. Verify Prisma CRUD against Neon

```bash
curl https://your-sukhan-app.vercel.app/api
# Expected: 200 OK
```

---

## Region Selection

The Vercel function region (`vercel.json` → `regions`, default `iad1`) should be close to the Neon database region.

- Neon `us-east-1` / `us-east-2` → Vercel `iad1`.
- Neon `eu-west-1` / `eu-central-1` → Vercel `fra1` or `cdg1`.
- Neon `ap-southeast-1` → Vercel `sin1`.

To change the Vercel region, edit `vercel.json`:
```json
{ "regions": ["fra1"] }
```

---

## Redis (Upstash) — Realtime Pub/Sub

Vercel can't host a long-lived Socket.IO server. The realtime service runs on a separate host and subscribes to Redis.

1. Create an Upstash Redis database — same region as Vercel + Neon.
2. Copy `REDIS_URL` to Vercel AND the realtime service.
3. The Next.js serverless functions publish to `sukhan:realtime:publish`.
4. The realtime service subscribes and emits to connected Socket.IO clients.

If `REDIS_URL` is unset, the app falls back to the 10-second polling safety net.

---

## Realtime Service (Separately Hosted)

The realtime service lives at `mini-services/realtime/index.ts`. Host it on Railway / Render / Fly.io / a VPS.

Set the same `NEXTAUTH_SECRET` and `REDIS_URL` on the realtime service as on Vercel.

Expose at a public URL → set `NEXT_PUBLIC_REALTIME_URL` on Vercel.

---

## Object Storage (Vercel Blob)

1. Vercel → Storage → Create → Blob.
2. Copy `BLOB_READ_WRITE_TOKEN` to Vercel.

The `@vercel/blob` package is already a dependency. The storage abstraction auto-selects the Vercel Blob adapter when `BLOB_READ_WRITE_TOKEN` is set.

---

## Nixify (OTP / Email Verification)

Same as Docker — set `NIXIFY_API_KEY` + `NIXIFY_BASE_URL` on Vercel.

---

## Vercel Project Setup

1. Push the GitHub repo (`fix/vercel-deployment` branch from PR #1).
2. In Vercel → New Project → import the GitHub repo.
3. Vercel auto-detects Next.js and uses `vercel.json`'s `buildCommand` (`bash vercel-build.sh`).
4. Add all env vars from Step 3.
5. Deploy.

---

## Verification After Deployment

```bash
curl https://your-sukhan-app.vercel.app/api
# Expected: 200 OK

curl https://your-sukhan-app.vercel.app/api/widget/SLUG/config
# Expected: themed JSON

curl https://realtime.your-domain.com/health
# Expected: {"ok": true, ...}

export DIRECT_URL="postgresql://..."
bunx prisma migrate status
# Expected: "Database schema is up to date"
```

---

## Connection Pool Verification (Serverless)

Vercel creates multiple concurrent serverless function instances. The Prisma Client is configured to:

1. **Reuse a single PrismaClient per Node process** via `globalForPrisma` caching.
2. **Use the pooled connection string** (`DATABASE_URL` with `&pgbouncer=true`) for runtime.
3. **Use the direct connection string** (`DIRECT_URL`) for migrations only.

Prepared statements: with `pgbouncer=true`, Prisma disables them for the runtime connection. Correct behavior for Neon's pooler.

---

## Docker Compatibility

The Vercel deployment mode is INDEPENDENT of Docker — they share the same application code.

- `src/lib/deployment.ts` detects Vercel via `VERCEL=1`.
- `src/lib/realtime/index.ts` selects Redis publisher when `REDIS_URL` is set.
- `src/lib/storage/index.ts` selects Vercel Blob adapter when `BLOB_READ_WRITE_TOKEN` is set.
- `next.config.ts` skips `output: 'standalone'` in Vercel mode.
- `prisma/schema.prisma` is the canonical PostgreSQL schema (BOTH Docker and Vercel).
- `vercel-build.sh` runs `prisma migrate deploy` (production-safe).
- `docker-entrypoint.sh` also runs `prisma migrate deploy`.

Docker/self-host mode does NOT require Neon — it uses its own local Postgres container.

---

## Known Limitations

1. **In-memory rate limiter** — won't work across Vercel's serverless instances.
2. **Realtime service must be separately hosted on Vercel**.
3. **Git history still contains the leaked `.env`** — needs `git filter-repo` cleanup.

---

## Security Warning

> **A LIVE Nixify production API key was committed to git history in `.env`. The PR removes `.env` from the tracked tree, but the key remains in historical commits. The repo owner MUST rotate/revoke the leaked Nixify key and optionally clean git history.**
