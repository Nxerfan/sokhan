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

    # Apply the Prisma schema to the database. We use `db push` (not
    # `migrate deploy`) because this repo doesn't ship migration files —
    # the schema is the source of truth and `db push` reconciles it.
    # For SQLite this is instant; for Postgres it creates tables if they
    # don't exist. `--accept-data-loss` only drops columns/tables that
    # were removed from the schema — it does NOT drop existing data in
    # unchanged columns.
    if [ -n "$DATABASE_URL" ]; then
      echo "[entrypoint] Applying database schema (prisma db push)..."
      prisma db push --accept-data-loss --skip-generate || {
        echo "[entrypoint] WARNING: prisma db push failed."
        echo "[entrypoint] The app may fail to start if the schema is missing."
        echo "[entrypoint] Continuing anyway — check app logs for Prisma errors."
      }
    else
      echo "[entrypoint] WARNING: DATABASE_URL not set — skipping schema apply."
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
