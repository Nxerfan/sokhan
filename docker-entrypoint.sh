#!/bin/sh
set -e

# ============================================================
# Sukhan Docker entrypoint
# Validates required env vars and launches the appropriate service.
# ============================================================

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
  echo "Generate a strong random value with:"
  echo "  openssl rand -base64 32"
  echo "============================================================"
  exit 1
fi

MODE="${1:-web}"
shift 2>/dev/null || true

case "$MODE" in
  web)
    echo "[entrypoint] Starting Next.js (web) on port ${PORT:-3000}..."
    echo "[entrypoint] NODE_ENV=${NODE_ENV:-production}"

    # Apply Prisma migrations via `migrate deploy` — the production-safe
    # migration command. Applies pending migration files from
    # prisma/migrations/. Never destructively reconciles the schema at
    # runtime. Uses DIRECT_URL (direct, non-pooled connection) under the
    # hood because DDL is incompatible with transaction-mode pooling.
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
    echo "  web       — Next.js app (port 3000)"
    echo "  realtime  — Socket.IO + internal HTTP (ports 3003 + 3004)"
    echo "============================================================"
    exit 1
    ;;
esac
