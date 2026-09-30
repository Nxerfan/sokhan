# Sukhan — Vercel + Supabase Deployment Guide

This guide covers deploying Sukhan on **Vercel** (Next.js application) with **Supabase PostgreSQL** (database), **Upstash Redis** (realtime pub/sub), **Vercel Blob** (attachment storage), and a separately-hosted **realtime Socket.IO service**.

For Docker / self-hosted deployments, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Architecture (Vercel mode)

| Component       | Docker                              | Vercel                                       |
|-----------------|-------------------------------------|----------------------------------------------|
| Next.js app     | Standalone Node process             | Vercel serverless functions                  |
| Database        | PostgreSQL (Docker Full) or PostgreSQL (Docker Lite) | **Supabase PostgreSQL** (via Supavisor pooling) |
| ORM             | Prisma                              | Prisma                                       |
| Migrations      | `prisma migrate deploy` (at container start) | `prisma migrate deploy` (at Vercel build time) |
| Realtime        | In-process Socket.IO (port 3003)    | Separately-hosted Socket.IO (Railway / Render / Fly / VPS) |
| Realtime pub    | HTTP to localhost:3004              | Redis PUBLISH (Upstash)                      |
| Object storage  | Local filesystem (`public/uploads`) | Vercel Blob                                  |
| Reverse proxy   | Caddy                               | Vercel platform proxy                        |
| Authentication  | NextAuth (credentials + OTP via Nixify) | NextAuth (unchanged)                    |

**Supabase is the official managed database provider for Sukhan.** Other Postgres providers are NOT supported by the Vercel deployment path.

---

## Supabase Database Setup

### 1. Create a Supabase project

1. Sign in to [Supabase](https://supabase.com) → New Project.
2. Choose a **region close to your Vercel deployment region** (default: `iad1` — see `vercel.json`). Supabase regions: [Supabase docs](https://supabase.com/docs/guides/getting-started/regions).
3. Set a strong database password. **Store this password securely** — you will need it for the connection strings.
4. Wait for the project to provision.

### 2. Obtain the Supavisor connection strings

Supabase provides TWO connection strings (Dashboard → Project Settings → Database → Connection string):

#### Pooled connection (Supavisor, port 6543)
- Used by the Prisma Client at runtime (Vercel serverless functions).
- Format: `postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`
- Append `?pgbouncer=true&connection_limit=1` for Prisma serverless best practices.

#### Direct connection (port 5432)
- Used by `prisma migrate deploy` and `prisma migrate status`.
- Format: `postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres`
- **DO NOT** add `?pgbouncer=true` — DDL is incompatible with transaction-mode pooling.

### 3. (Recommended) Create a dedicated Prisma database role

Supabase recommends a dedicated role for Prisma to limit privileges. This is OPTIONAL — the `postgres` superuser works — but it's a security best practice.

In the Supabase SQL Editor (Dashboard → SQL Editor), run:

```sql
-- Create a role for Prisma (replace 'sukhan_prisma' and 'YOUR_STRONG_PASSWORD').
CREATE ROLE sukhan_prisma WITH LOGIN PASSWORD 'YOUR_STRONG_PASSWORD';

-- Grant only what Prisma needs.
-- CONNECT on the database:
GRANT CONNECT ON DATABASE postgres TO sukhan_prisma;

-- Create schema + tables (needed by prisma migrate deploy):
GRANT CREATE ON SCHEMA public TO sukhan_prisa;

-- Full DML on the public schema:
GRANT ALL ON SCHEMA public TO sukhan_prisma;
GRANT ALL ON ALL TABLES IN SCHEMA public TO sukhan_prisma;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sukhan_prisma;

-- Default privileges for future tables created by Prisma:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sukhan_prisma;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sukhan_prisma;
```

Then use the Prisma role's credentials in the connection strings:

- `postgresql://sukhan_prisma:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1` (pooled, runtime)
- `postgresql://sukhan_prisma:[password]@db.[project-ref].supabase.co:5432/postgres` (direct, migrations)

**NEVER** expose the Prisma role's password to the browser. The connection strings are server-side only (Vercel env vars).

### 4. Configure Vercel environment variables

In Vercel → Project → Settings → Environment Variables, add:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | Pooled connection string (port 6543) | Runtime Prisma Client — used by serverless functions |
| `DIRECT_URL` | Direct connection string (port 5432) | Prisma Migrate — used at build time by `vercel-build.sh` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` | Shared with realtime service |
| `NEXTAUTH_URL` | `https://your-sukhan-app.vercel.app` | Canonical Vercel domain |
| `REDIS_URL` | Upstash Redis URL | Realtime pub/sub (see below) |
| `NEXT_PUBLIC_REALTIME_URL` | `https://realtime.your-domain.com` | Public URL of separately-hosted realtime service |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token | Attachment storage |
| `NIXIFY_API_KEY` | `mg_live_...` | OTP email verification |
| `NIXIFY_BASE_URL` | `https://your-nixify-domain.com/api/v1` | Nixify API base |

### 5. Run the baseline migration

The first time you deploy, the `vercel-build.sh` script runs `prisma migrate deploy` against your Supabase database. This applies all migrations in `prisma/migrations/`. The baseline migration creates all tables.

For the FIRST deployment, you can verify the migration by running it locally first:

```bash
# Set DATABASE_URL and DIRECT_URL to your Supabase strings (with the
# Prisma role if you created one).
export DIRECT_URL="postgresql://sukhan_prisma:password@db.YOUR_REF.supabase.co:5432/postgres"
bunx prisma migrate status          # shows pending migrations
bunx prisma migrate deploy          # applies them (production-safe)
```

If `prisma migrate status` shows no pending migrations, the database is up-to-date.

### 6. Verify database connectivity

After the first deployment:

```bash
# Verify Prisma can connect.
bunx prisma migrate status

# Verify the schema is present (should list all 14+ tables).
bunx prisma db execute --stdin <<< "\\dt"

# Verify tenant isolation (manually — see "Tenant Isolation" below).
```

### 7. Verify tenant isolation

Sukhan enforces tenant isolation at the application layer via:
1. The Prisma client extension (`src/lib/db.ts`) — auto-injects `tenantId` on all reads/writes of tenant-scoped models.
2. AsyncLocalStorage — each request gets its own tenant context that does NOT leak across concurrent requests.
3. Explicit `tenantId` filters in every API route handler.

PostgreSQL RLS is treated as DEFENSE-IN-DEPTH ONLY. The Prisma connection (which uses a privileged role) MAY bypass RLS depending on the configured role.

To verify tenant isolation:
1. Sign up two tenants (Tenant A, Tenant B).
2. Create a conversation as Tenant A's visitor.
3. Sign in as Tenant B and verify Tenant B's `/api/conversations` returns 0 conversations.
4. Verify Tenant B cannot read Tenant A's conversation by ID (404 or empty).
5. Run the regression tests: `bun test tests/unit/abstractions.test.ts` (the `withTenant isolates tenant context` tests).

### 8. Verify Prisma CRUD against Supabase

```bash
# From the deployed Vercel function URL:
curl https://your-sukhan-app.vercel.app/api        # → 200 OK
curl https://your-sukhan-app.vercel.app/api/widget/SLUG/config  # → themed JSON
```

---

## Region Selection

The Vercel function region (configured in `vercel.json` → `regions`) should be geographically close to the Supabase database region. The default in `vercel.json` is `iad1` (Washington, DC, USA).

- If your Supabase project is in `us-east-1` / `us-east-2` → use Vercel `iad1`.
- If your Supabase project is in `eu-west-1` / `eu-central-1` → use Vercel `fra1` (Frankfurt) or `cdg1` (Paris).
- If your Supabase project is in `ap-southeast-1` → use Vercel `sin1` (Singapore).

Mismatched regions add 50–200ms of latency per database query, which compounds quickly in a serverless environment with multiple queries per request.

To change the Vercel region, edit `vercel.json`:
```json
{
  "regions": ["fra1"]
}
```

---

## Redis (Upstash) — Realtime Pub/Sub

Vercel can't host a long-lived Socket.IO server. The realtime service runs on a separate host (Railway / Render / Fly / VPS) and subscribes to Redis for events published by the Next.js serverless functions.

1. Create an Upstash Redis database — choose the SAME region as your Vercel + Supabase.
2. Copy the public URL → `REDIS_URL` on Vercel AND on the realtime service.
3. The Next.js serverless functions publish to channel `sukhan:realtime:publish` (configurable via `REDIS_CHANNEL`).
4. The realtime service subscribes to the same channel and emits to connected Socket.IO clients.

If `REDIS_URL` is unset, the app falls back to the 10-second polling safety net (messages persist to DB, just not real-time).

---

## Realtime Service (Separately Hosted)

The realtime service lives at `mini-services/realtime/index.ts`. Host it on any long-lived Node.js runtime:

- **Railway** — easiest, supports environment variables and health checks.
- **Render** — free tier available.
- **Fly.io** — generous free tier, supports multiple regions.
- **VPS** — most control, requires manual setup.

Set the same env vars on the realtime service as on Vercel:
- `NEXTAUTH_SECRET` (same value — used for Socket.IO token verification)
- `REDIS_URL` (same value — used for pub/sub subscription)

Expose the realtime service at a public URL (e.g. `https://realtime.your-domain.com`). Set `NEXT_PUBLIC_REALTIME_URL` on Vercel to this URL. The dashboard and widget clients connect to it directly with `path: '/'`.

---

## Object Storage (Vercel Blob)

1. In Vercel → Storage → Create → Blob.
2. Copy the read-write token → `BLOB_READ_WRITE_TOKEN`.

The `@vercel/blob` package is already a dependency. The storage abstraction (`src/lib/storage/index.ts`) auto-selects the Vercel Blob adapter when `BLOB_READ_WRITE_TOKEN` is set.

Attachment uploads are tenant-namespaced: `BLOB_STORE/<tenantId>/<uuid><ext>`. This prevents cross-tenant file collisions in a shared Blob store.

---

## Nixify (OTP / Email Verification)

Same as Docker — set `NIXIFY_API_KEY` + `NIXIFY_BASE_URL` on Vercel.

---

## Vercel Project Setup

1. Push the GitHub repo (the `fix/vercel-deployment` branch from PR #1).
2. In Vercel → New Project → import the GitHub repo.
3. Vercel auto-detects Next.js and uses `vercel.json`'s `buildCommand` (`bash vercel-build.sh`). The build script:
   - Runs `prisma generate` against the canonical PostgreSQL schema.
   - Runs `prisma migrate deploy` against `DIRECT_URL` (production-safe — does NOT use `db push`).
   - Runs `next build` WITHOUT `output: 'standalone'` (Vercel uses its own build flow).
4. Add all env vars from [Step 4](#4-configure-vercel-environment-variables).
5. Deploy.

---

## Verification After Deployment

```bash
# Health endpoint (Vercel serverless function).
curl https://your-sukhan-app.vercel.app/api
# Expected: 200 OK

# Widget config (public, no auth).
curl https://your-sukhan-app.vercel.app/api/widget/SLUG/config
# Expected: themed JSON with accentColor, defaultDirection

# Realtime service health (separately-hosted).
curl https://realtime.your-domain.com/health
# Expected: {"ok": true, "connections": N, "redis": true}

# Prisma migration status (run locally with DIRECT_URL set).
export DIRECT_URL="postgresql://..."
bunx prisma migrate status
# Expected: "Database schema is up to date"
```

---

## Connection Pool Verification (Serverless)

Vercel creates multiple concurrent serverless function instances. The Prisma Client is configured to:

1. **Reuse a single PrismaClient per Node process** (via `globalForPrisma` caching in `src/lib/db.ts`). This avoids creating a new client per request, which would exhaust the connection pool.
2. **Use the pooled connection string** (`DATABASE_URL` with `?pgbouncer=true&connection_limit=1`) for runtime queries. Supavisor handles connection multiplexing.
3. **Use the direct connection string** (`DIRECT_URL`) for migrations only. This is required because DDL (CREATE TABLE, ALTER TABLE) is incompatible with transaction-mode pooling.

Prepared statements: with `?pgbouncer=true`, Prisma automatically disables prepared statements for the runtime connection. This is the correct behavior for Supavisor.

---

## Supabase Data API / PostgREST — NOT Used

Sukhan uses Prisma directly. It does NOT use the Supabase Data API / PostgREST for normal application CRUD. The `@supabase/supabase-js` package is NOT a dependency and is NOT imported anywhere.

This is a deliberate decision:
- Prisma already provides a typed ORM with migrations, relations, and tenant-scoping.
- The Supabase Data API exposes tables to anonymous/public clients by default, which is a security risk for a multi-tenant SaaS.
- Sukhan's internal Prisma-managed tables should NOT be exposed to public clients.

If you need to expose specific tables via the Supabase Data API in the future, review the current Supabase security recommendations and ensure NO accidental public access is created.

---

## Docker Compatibility

The Vercel deployment mode is INDEPENDENT of the Docker deployment — they share the same application code, but the abstractions select different adapters based on the deployment mode:

- `src/lib/deployment.ts` detects Vercel via `VERCEL=1`.
- `src/lib/realtime/index.ts` selects Redis publisher when `REDIS_URL` is set.
- `src/lib/storage/index.ts` selects Vercel Blob adapter when `BLOB_READ_WRITE_TOKEN` is set.
- `next.config.ts` skips `output: 'standalone'` in Vercel mode.
- `prisma/schema.prisma` is the canonical PostgreSQL schema (used by BOTH Docker and Vercel — see "Schema Changes" below).
- `vercel-build.sh` runs `prisma migrate deploy` (production-safe).
- `docker-entrypoint.sh` also runs `prisma migrate deploy` (NOT `db push`).

Existing Docker / self-hosted deployments use the same canonical PostgreSQL schema and the same Prisma migrations. The Lite edition now uses a small `postgres:16-alpine` container (instead of SQLite).

---

## Known Limitations

1. **In-memory rate limiter** — `src/lib/rate-limit.ts` uses `Map`s in process memory. Won't work across Vercel's serverless instances (each instance has its own Map). Out of scope for this PR; would need a Redis-backed rate limiter for production Vercel.
2. **Realtime service must be separately hosted on Vercel** — Vercel can't host a long-lived Socket.IO server. Users must deploy the realtime service (`mini-services/realtime/index.ts`) on Railway / Render / Fly / a VPS.
3. **Git history still contains the leaked `.env`** — `git rm --cached` removes the file from future commits but does NOT rewrite history. The leaked Nixify key is still in historical commits until the repo owner runs `git filter-repo` to clean history.

---

## Security Warning

> **A LIVE Nixify production API key (`mg_live_...`) was committed to git history in `.env`. The PR removes `.env` from the tracked tree, but the key remains in historical commits.**
> **The repo owner MUST:**
> 1. **Rotate/revoke the leaked Nixify key immediately.**
> 2. **Audit Nixify logs for unauthorized usage from the time of the first commit until rotation.**
> 3. **Optionally clean git history with `git filter-repo` to remove the leaked `.env` from old commits.**
