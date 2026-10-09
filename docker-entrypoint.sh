#!/bin/sh
set -e

# ============================================================
# Sukhan Docker entrypoint
# Validates required env vars and launches the appropriate service.
#
# Fail-closed behavior:
#   - Missing/empty/placeholder NEXTAUTH_SECRET → exit 1
#     (validated for BOTH web + realtime modes — both need it)
#   - Missing/empty/placeholder POSTGRES_PASSWORD (web mode) → exit 1
#   - Missing DATABASE_URL    → exit 1
#   - Missing DIRECT_URL      → exit 1 (migrations need it)
#   - Migration failure       → exit 1 (do NOT start with unmigrated schema)
#   - Migration success       → start node server.js
#
# Secret validation is performed by `bun /app/scripts/validate-secrets.ts`,
# which imports the SAME canonical validators (`validateNextAuthSecret`,
# `validatePostgresPassword`) from `src/lib/secret-validation.ts` that the
# unit tests exercise. This keeps the runtime path synchronized with the
# tested module — there is no mirrored/duplicated validation logic.
#
# Secret values are NEVER echoed. Failure messages mention the
# variable NAME only (e.g. "NEXTAUTH_SECRET is set to a known
# placeholder value"). The actual secret value is never interpolated
# into any echo, log, or error message.
# ============================================================

# Determine the mode first so we know whether POSTGRES_PASSWORD is
# required (web mode needs it; realtime mode does not).
MODE="${1:-web}"
shift 2>/dev/null || true

# --- NEXTAUTH_SECRET (required for BOTH web + realtime modes) -------
# Capture stderr (where validate-secrets.ts writes its failure message)
# without printing it if the validation succeeds (exit 0 → empty output).
NEXTAUTH_SECRET_FAILURE=$(bun /app/scripts/validate-secrets.ts nextauth 2>&1) || true
if [ -n "$NEXTAUTH_SECRET_FAILURE" ]; then
  echo ""
  echo "============================================================"
  echo "FATAL: $NEXTAUTH_SECRET_FAILURE"
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

case "$MODE" in
  web)
    echo "[entrypoint] Starting Next.js (web) on port ${PORT:-3000}..."
    echo "[entrypoint] NODE_ENV=${NODE_ENV:-production}"

    # --- POSTGRES_PASSWORD (required for web mode only) --------------
    # Web mode touches the database directly (Prisma migrations + the
    # Next.js app runtime). POSTGRES_PASSWORD is passed in by
    # docker-compose.yml / docker-compose.lite.yml as a standalone env
    # var on the `app` service (NOT parsed back out of DATABASE_URL —
    # the entrypoint reads the env var directly).
    #
    # Docker Compose's ${POSTGRES_PASSWORD:?...} guard catches missing
    # /empty values at compose-interpolation time. This runtime check
    # ADDITIONALLY rejects known-bad placeholder values (e.g.
    # `CHANGE_ME_strong_password_here`) that would otherwise pass the
    # compose guard because they are non-empty.
    POSTGRES_PASSWORD_FAILURE=$(bun /app/scripts/validate-secrets.ts postgres 2>&1) || true
    if [ -n "$POSTGRES_PASSWORD_FAILURE" ]; then
      echo ""
      echo "============================================================"
      echo "FATAL: $POSTGRES_PASSWORD_FAILURE"
      echo ""
      echo "This variable is required for:"
      echo "  - PostgreSQL database authentication (web mode)"
      echo "  - DATABASE_URL / DIRECT_URL connection string"
      echo ""
      echo "Generate a strong random value with:"
      echo "  openssl rand -hex 24"
      echo "============================================================"
      exit 1
    fi

    # Validate required env vars for web mode
    if [ -z "$DATABASE_URL" ]; then
      echo "============================================================"
      echo "FATAL: DATABASE_URL is not set."
      echo "  Required for Prisma Client runtime connections."
      echo "============================================================"
      exit 1
    fi

    if [ -z "$DIRECT_URL" ]; then
      echo "============================================================"
      echo "FATAL: DIRECT_URL is not set."
      echo "  Required for prisma migrate deploy (DDL needs a direct,"
      echo "  non-pooled connection). Set it to the same value as"
      echo "  DATABASE_URL when using a local PostgreSQL without a pooler."
      echo "============================================================"
      exit 1
    fi

    # Apply Prisma migrations via `migrate deploy` — the production-safe
    # migration command. Applies pending migration files from
    # prisma/migrations/. Never destructively reconciles the schema at
    # runtime. Uses DIRECT_URL (direct, non-pooled connection) under the
    # hood because DDL is incompatible with transaction-mode pooling.
    #
    # FAIL-CLOSED: if migration fails, the container exits with non-zero.
    # The app must NOT start against an unmigrated schema.
    echo "[entrypoint] Applying Prisma migrations (migrate deploy)..."
    prisma migrate deploy

    exec node server.js
    ;;

  realtime)
    echo "[entrypoint] Starting realtime service..."
    echo "[entrypoint]   Socket.IO on port 3003 (path: '/')"
    echo "[entrypoint]   Internal HTTP on port 3004 (/internal/publish, /health)"
    if [ -n "$REDIS_URL" ]; then
      echo "[entrypoint]   Redis adapter: ENABLED"
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
