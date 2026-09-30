#!/usr/bin/env bash
# Comprehensive single-shot script — recreates temp files + applies all
# Supabase-standardization changes + commits + pushes.
#
# Usage (single bash invocation):
#   cd /home/z/my-project
#   git checkout -f fix/vercel-deployment
#   bash scripts/full-supabase-apply.sh
set -euo pipefail
cd /home/z/my-project

echo "▶ Verifying branch..."
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "fix/vercel-deployment" ]; then
  echo "FATAL: not on fix/vercel-deployment (on $BRANCH). Aborting."
  exit 1
fi

echo "▶ Recreating temp files in tmp-supabase/..."
mkdir -p tmp-supabase

# === .gitignore (with tmp-supabase/ exception) ===
cp .gitignore tmp-supabase/.gitignore.orig 2>/dev/null || true
cat > tmp-supabase/.gitignore <<'GITIGNORE_EOF'
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files (can opt-in for committing if needed)
.env*
# Keep the Docker + Vercel example files — they're documentation, not secrets
!.env.docker.example
!.env.vercel.example

# vercel
.vercel


# typescript
*.tsbuildinfo
next-env.d.ts
local-*
.claude
.z-ai-config
*.log
dev.log
dev.out.log
test
prompt

server.log
# Skills directory
/skills/
# Build artifacts + test output
test-results/
tool-results/
screenshot-*.png

# Download/upload (not used by app)
download/
upload/

# Local database (NEVER commit — may contain user data)
db/*.db
db/*.db-journal
db/*.sqlite
db/*.sqlite-journal

# Local file uploads (production should use object storage; never commit test artifacts)
public/uploads/
!public/uploads/.gitkeep

# Prisma migrations metadata (per-developer, not committed)
# NOTE: prisma/migrations/ IS committed (it's the production schema-evolution source of truth).

# Temp working directory for the Supabase migration script (one-shot, not committed)
tmp-supabase/

# Skills directory already covered above; explicit
/skills/
GITIGNORE_EOF

# === vercel-build.sh ===
cat > tmp-supabase/vercel-build.sh <<'VB_EOF'
#!/usr/bin/env bash
# Vercel build script.
#
# Vercel invokes this script via vercel.json's `buildCommand`. The script:
#
#   1. Runs `prisma generate` against the canonical PostgreSQL schema so the
#      serverless runtime can talk to Supabase Postgres.
#   2. Runs `prisma migrate deploy` to apply pending migrations. This is the
#      production-safe migration command — it does NOT use `db push` and does
#      NOT accept `--accept-data-loss`. If a migration fails, the build fails.
#   3. Runs `next build` WITHOUT `output: 'standalone'` (the
#      `next.config.ts` detects Vercel via `VERCEL=1` and skips the
#      standalone output — Vercel uses its own build flow).
#
# Supabase connection architecture (serverless-aware):
#   - DATABASE_URL  — Supavisor pooled connection (port 6543). Used by the
#                     Prisma Client at runtime.
#   - DIRECT_URL    — direct (non-pooled) connection (port 5432). Used by
#                     `prisma migrate deploy` (DDL requires a direct
#                     connection; Supavisor's transaction-mode pooling is
#                     incompatible with migration DDL).
#
# Both env vars are REQUIRED for the Vercel build to succeed.
#
# Required Vercel env vars (set in the Vercel dashboard or via `vercel env`):
#
#   DATABASE_URL              — Supabase Supavisor pooled connection string.
#   DIRECT_URL                — Supabase direct connection string (port 5432).
#   NEXTAUTH_SECRET           — openssl rand -base64 32
#   NEXTAUTH_URL              — https://your-domain.vercel.app
#   REDIS_URL                 — redis://... (Upstash Redis, for realtime pub/sub)
#   BLOB_READ_WRITE_TOKEN     — Vercel Blob token (for attachment storage)
#   NEXT_PUBLIC_REALTIME_URL  — https://realtime.your-domain.com (public URL
#                               of the separately-hosted realtime Socket.IO
#                               service — Vercel can't host a long-lived
#                               Socket.IO server).
#   NIXIFY_API_KEY            — for OTP email verification
#   NIXIFY_BASE_URL           — Nixify API base URL
#
# Optional:
#   REALTIME_INTERNAL_URL     — if your realtime service exposes an HTTP
#                               /internal/publish endpoint, set this to its
#                               private URL. Required if REDIS_URL is not set
#                               (otherwise realtime publishing is a no-op
#                               and clients fall back to polling).
#   REDIS_CHANNEL             — defaults to "sukhan:realtime:publish"
set -euo pipefail

echo "▶ Vercel build — generating Prisma client (PostgreSQL / Supabase)"
bunx prisma generate

echo "▶ Vercel build — applying Prisma migrations (migrate deploy)"
# Production-safe: uses DIRECT_URL (direct, non-pooled connection) under the
# hood. Does NOT use `db push`. Does NOT accept `--accept-data-loss`.
bunx prisma migrate deploy

echo "▶ Vercel build — running next build (no standalone output)"
next build

echo "✓ Vercel build complete"
VB_EOF
chmod +x tmp-supabase/vercel-build.sh

# === docker-entrypoint.sh ===
cat > tmp-supabase/docker-entrypoint.sh <<'DE_EOF'
#!/bin/sh
set -e

# ============================================================
# Sukhan Docker entrypoint
# Validates required env vars and launches the appropriate service.
# ============================================================

# Validate NEXTAUTH_SECRET — fail loudly if missing.
# This is the single most common cause of silent auth failures (the
# realtime service and NextAuth both need it to sign/verify tokens).
if [ -z "$NEXTAUTH_SECRET" ]; then
  echo ""
  echo "============================================================"
  echo "FATAL: NEXTAUTH_SECRET is not set."
  echo ""
  echo "This variable is required for:"
  echo "  - NextAuth session JWT signing"
  echo "  - Realtime token verification (Socket.IO auth)"
  echo "  - Internal publish endpoint auth (HTTP /internal/publish)"
  echo ""
  echo "Without it, auth fails silently — users can't log in, and"
  echo "realtime messages won't be delivered."
  echo ""
  echo "Generate a strong random value with:"
  echo "  openssl rand -base64 32"
  echo ""
  echo "Then set it in your .env file or docker-compose environment:"
  echo "  NEXTAUTH_SECRET=<the-generated-value>"
  echo "============================================================"
  exit 1
fi

MODE="${1:-web}"
shift 2>/dev/null || true

case "$MODE" in
  web)
    echo "[entrypoint] Starting Next.js (web) on port ${PORT:-3000}..."
    echo "[entrypoint] NODE_ENV=${NODE_ENV:-production}"

    # Apply Prisma migrations. We use `migrate deploy` (the production-safe
    # migration command) — NOT `db push`. `migrate deploy`:
    #   - applies pending migration files from prisma/migrations/
    #   - does NOT accept `--accept-data-loss`
    #   - uses DIRECT_URL (the direct, non-pooled connection) under the hood
    #     because DDL is incompatible with transaction-mode pooling
    #
    # If migrations fail, the app may still start but will hit runtime
    # errors when it tries to query missing tables. We log the failure and
    # continue so the container stays up for debugging.
    if [ -n "$DATABASE_URL" ]; then
      if [ -z "$DIRECT_URL" ]; then
        echo "[entrypoint] WARNING: DIRECT_URL is not set — prisma migrate"
        echo "[entrypoint] deploy may fail if DATABASE_URL points at a pooled"
        echo "[entrypoint] connection (Supavisor / PgBouncer)."
      fi
      echo "[entrypoint] Applying Prisma migrations (migrate deploy)..."
      prisma migrate deploy --skip-generate || {
        echo "[entrypoint] WARNING: prisma migrate deploy failed."
        echo "[entrypoint] The app may fail to start if the schema is missing."
        echo "[entrypoint] Continuing anyway — check app logs for Prisma errors."
      }
    else
      echo "[entrypoint] WARNING: DATABASE_URL not set — skipping migrations."
    fi

    # Hand off to the Next.js standalone server (PID 1 = node).
    # exec replaces the shell so signals reach node directly.
    exec node server.js
    ;;

  realtime)
    echo "[entrypoint] Starting realtime service..."
    echo "[entrypoint]   Socket.IO on port 3003 (path: '/')"
    echo "[entrypoint]   Internal HTTP on port 3004 (/internal/publish, /health)"
    if [ -n "$REDIS_URL" ]; then
      echo "[entrypoint]   Redis adapter: ENABLED ($REDIS_URL)"
    else
      echo "[entrypoint]   Redis adapter: disabled (in-memory, single-instance only)"
    fi
    cd /app/mini-services/realtime
    exec bun index.ts
    ;;

  *)
    echo "============================================================"
    echo "Unknown mode: '$MODE'"
    echo ""
    echo "Usage: docker run sukhan [web|realtime]"
    echo ""
    echo "  web       — Next.js app (port 3000)"
    echo "  realtime  — Socket.IO + internal HTTP (ports 3003 + 3004)"
    echo "============================================================"
    exit 1
    ;;
esac
DE_EOF
chmod +x tmp-supabase/docker-entrypoint.sh

# === docker-compose.lite.yml ===
cat > tmp-supabase/docker-compose.lite.yml <<'DCL_EOF'
# ============================================================
# Sukhan Live Chat SaaS — Lite Docker Compose
# ============================================================
# Includes: Next.js app + Postgres (small) + realtime service (in-memory) +
# Caddy. No Redis.
#
# Standardized on PostgreSQL across all editions. The "Lite" vs "Full"
# distinction is now Redis/no-Redis + resource sizing, NOT the database
# engine (both editions use Postgres).
#
# Usage:
#   1. Copy .env.docker.example to .env and fill in values.
#   2. docker compose -f docker-compose.lite.yml up -d
#
# Required env (in .env):
#   - NEXTAUTH_SECRET     (generate with: openssl rand -base64 32)
#   - POSTGRES_PASSWORD   (a strong password for the local Postgres)
#
# Lite vs Full:
#   - Database: Postgres (small `postgres:16-alpine` container)
#   - Realtime adapter: in-memory (single instance — no horizontal scaling)
#   - No Redis (realtime publish goes via HTTP internal endpoint)
#   - Resource usage: ~768MB RAM (vs ~1GB for full with Redis)
#
# Migrating to Full: see SELF_HOSTING.md → "Lite vs Full" section.
# ============================================================

services:
  postgres:
    image: postgres:16-alpine
    container_name: sukhan-postgres-lite
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-sukhan}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required (set a strong password)}
      POSTGRES_DB: ${POSTGRES_DB:-sukhan}
    volumes:
      - postgres-data-lite:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-sukhan} -d ${POSTGRES_DB:-sukhan}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - sukhan

  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: sukhan:latest
    container_name: sukhan-app-lite
    restart: unless-stopped
    command: ["web"]
    environment:
      # Fail-fast: ${VAR:?error} makes docker-compose refuse to start if unset.
      NEXTAUTH_SECRET: '${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required (generate with: openssl rand -base64 32)}'
      NEXTAUTH_URL: ${NEXTAUTH_URL:-http://localhost}
      # Postgres — both DATABASE_URL (pooled) and DIRECT_URL (direct) point
      # at the local Postgres container. In Lite there is no Supavisor, so
      # they can be identical.
      DATABASE_URL: postgresql://${POSTGRES_USER:-sukhan}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-sukhan}?schema=public
      DIRECT_URL: postgresql://${POSTGRES_USER:-sukhan}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-sukhan}?schema=public
      # No REDIS_URL — realtime uses the in-memory adapter (single instance).
      REALTIME_INTERNAL_URL: http://realtime:3004
      ZARINPAL_MERCHANT_ID: ${ZARINPAL_MERCHANT_ID:-}
      IDPAY_API_KEY: ${IDPAY_API_KEY:-}
      NEXT_PUBLIC_APP_NAME: ${NEXT_PUBLIC_APP_NAME:-Sukhan}
    volumes:
      - uploads:/app/uploads
      - logs:/app/logs
    depends_on:
      postgres:
        condition: service_healthy
      realtime:
        condition: service_started
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    networks:
      - sukhan

  realtime:
    image: sukhan:latest
    container_name: sukhan-realtime-lite
    restart: unless-stopped
    command: ["realtime"]
    environment:
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required}
      # No REDIS_URL — uses the in-memory adapter. Single instance only.
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3004/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks:
      - sukhan

  caddy:
    image: caddy:2-alpine
    container_name: sukhan-caddy-lite
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./docker/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    environment:
      # If DOMAIN is empty/unset in .env, default to ":80" (HTTP-only).
      # When set to a real domain (e.g. chat.example.com), Caddy auto-provisions HTTPS.
      DOMAIN: ${DOMAIN:-:80}
      ACME_EMAIL: ${ACME_EMAIL:-admin@example.com}
    depends_on:
      - app
      - realtime
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:80/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - sukhan

volumes:
  postgres-data-lite:
  uploads:
  logs:
  caddy-data:
  caddy-config:

networks:
  sukhan:
    driver: bridge
DCL_EOF

# === .env.docker.example ===
cp .env.docker.example tmp-supabase/.env.docker.example.docker.orig 2>/dev/null || true
cat > tmp-supabase/.env.docker.example <<'EDE_EOF'
# ============================================================
# Sukhan Live Chat SaaS — Docker Environment Configuration
# ============================================================
#
# Copy this file to .env and fill in the values:
#   cp .env.docker.example .env
#
# Then start with:
#   docker compose up -d                           # full edition (Postgres + Redis)
#   docker compose -f docker-compose.lite.yml up -d  # lite edition (Postgres, no Redis)
#
# BOTH editions now use PostgreSQL. SQLite is NO LONGER SUPPORTED.
# The "Lite" vs "Full" distinction is Redis/no-Redis + resource sizing.
#
# Variables marked [REQUIRED] must be set or docker-compose will refuse to start.
# Variables marked [AUTO] are set automatically by docker-compose — do NOT set them here.
# Variables marked [OPTIONAL] have sensible defaults and can be left as-is.
# ============================================================


# --- Authentication ---

# [REQUIRED] Secret key for signing NextAuth JWT sessions and realtime tokens.
# Both the Next.js app and the realtime service MUST use the same value.
# Generate one with: openssl rand -base64 32
NEXTAUTH_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32

# [OPTIONAL] The public URL of your deployment.
# For local testing: http://localhost
# For production: https://your-domain.com
# Default: http://localhost
NEXTAUTH_URL=http://localhost


# --- Database (PostgreSQL — required for BOTH Lite and Full editions) ---

# [REQUIRED] Password for the PostgreSQL database.
# The connection string is built automatically by docker-compose.yml
# (Full edition) or docker-compose.lite.yml (Lite edition).
POSTGRES_PASSWORD=CHANGE_ME_strong_password_here

# [OPTIONAL] PostgreSQL user (default: sukhan).
# POSTGRES_USER=sukhan

# [OPTIONAL] PostgreSQL database name (default: sukhan).
# POSTGRES_DB=sukhan


# --- Redis (Full edition only — Lite runs without Redis) ---

# [AUTO] Redis connection URL — set automatically by docker-compose.yml.
# Do NOT set this in .env; it's configured in the compose file.
# REDIS_URL=redis://redis:6379


# --- Realtime Service ---

# [AUTO] Internal HTTP URL for the realtime service — set automatically.
# The Next.js app uses this to publish Socket.IO events to the realtime service.
# Do NOT set this in .env; it's configured in the compose file.
# REALTIME_INTERNAL_URL=http://realtime:3004


# --- Payment Gateways (Iran-first — all optional, empty = test mode) ---

# [OPTIONAL] ZarinPal merchant ID. If empty, the billing adapter runs in test mode
# (simulates payment flow without real API calls).
# Get yours from: https://merchant.zarinpal.com
ZARINPAL_MERCHANT_ID=

# [OPTIONAL] ZarinPal sandbox mode. Set to "true" to use ZarinPal's sandbox API.
# ZARINPAL_SANDBOX=true

# [OPTIONAL] IDPay API key. If empty, the billing adapter runs in test mode.
# Get yours from: https://idpay.ir/dashboard/web-services
IDPAY_API_KEY=

# [OPTIONAL] IDPay sandbox mode. Set to "true" to use IDPay's sandbox API.
# IDPAY_SANDBOX=true

# [OPTIONAL] ZarinLink base URL (a simplified ZarinPal product).
# If empty, the billing adapter runs in test mode.
# ZARINLINK_URL=https://zarinp.al/


# --- Caddy Reverse Proxy ---

# [OPTIONAL] Your domain name for auto-HTTPS via Let's Encrypt.
# Leave empty for HTTP-only on port 80 (local testing).
# When set (e.g. chat.example.com), Caddy auto-provisions TLS certificates.
DOMAIN=

# [OPTIONAL] Email for Let's Encrypt certificate expiry notifications.
# Only used when DOMAIN is set.
ACME_EMAIL=admin@example.com


# --- Branding ---

# [OPTIONAL] Public app name shown in the UI.
# NEXT_PUBLIC_APP_NAME=Sukhan

# --- OTP/Email Verification (Nixify) ---

# [REQUIRED] Nixify API key for OTP email verification.
# Get yours from your Nixify dashboard.
NIXIFY_API_KEY=

# [REQUIRED] Nixify base URL.
NIXIFY_BASE_URL=https://your-nixify-domain.com/api/v1

# [OPTIONAL] Set to "true" for local dev/tests — bypasses real API calls.
# Mock OTP code is always "123456".
# NIXIFY_MOCK=true
EDE_EOF

echo "▶ Done recreating simple temp files."
echo "▶ Now recreating schema.prisma, package.json, db.ts via separate Write-tool-backed files..."
echo "(These have complex content — handled by separate scripts.)"
