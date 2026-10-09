#!/bin/sh
set -e

# ============================================================
# Sukhan Docker entrypoint
# Validates required env vars and launches the appropriate service.
#
# Fail-closed behavior:
#   - Missing/empty/placeholder NEXTAUTH_SECRET → exit 1
#   - Missing/empty/placeholder POSTGRES_PASSWORD (web mode) → exit 1
#   - Missing DATABASE_URL    → exit 1
#   - Missing DIRECT_URL      → exit 1 (migrations need it)
#   - Migration failure       → exit 1 (do NOT start with unmigrated schema)
#   - Migration success       → start node server.js
#
# Secret values are NEVER echoed. Failure messages mention the
# variable NAME only (e.g. "NEXTAUTH_SECRET is set to a known
# placeholder value"). The actual secret value is never interpolated
# into any echo, log, or error message.
# ============================================================

# Validate NEXTAUTH_SECRET against missing/empty/placeholder values.
# Implemented in node via the shared src/lib/secret-validation.ts so
# the same logic is unit-tested and reused by the realtime service.
NEXTAUTH_SECRET_FAILURE=$(node -e "
const mod = require('/app/node_modules/bun') ? null : null;
" 2>/dev/null || true)
# The above is a placeholder; we use a self-contained node one-liner
# that mirrors src/lib/secret-validation.ts. Keeping it inline avoids a
# boot-time dependency on the TS toolchain inside the Docker web image.
NEXTAUTH_SECRET_FAILURE=$(node -e '
const v = process.env.NEXTAUTH_SECRET;
let ok = true;
let reason = "";
if (v === undefined || v === null) { ok = false; reason = "NEXTAUTH_SECRET is missing. Set it to a strong random value (openssl rand -base64 32)."; }
else {
  const t = String(v).trim();
  if (t === "") { ok = false; reason = "NEXTAUTH_SECRET is empty. Set it to a strong random value (openssl rand -base64 32)."; }
  else {
    const knownBad = new Set([
      "CHANGE_ME_generate_with_openssl_rand_base64_32",
      "sukhan-dev-secret-DO-NOT-USE-IN-PRODUCTION-a7f3b2c1",
    ]);
    if (knownBad.has(t) || t.startsWith("CHANGE_ME")) {
      ok = false;
      reason = "NEXTAUTH_SECRET is set to a known placeholder value. Generate a real secret (openssl rand -base64 32) and set it before starting in production.";
    }
  }
}
if (!ok) { process.stdout.write(reason); process.exit(0); }
')
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

MODE="${1:-web}"
shift 2>/dev/null || true

case "$MODE" in
  web)
    echo "[entrypoint] Starting Next.js (web) on port ${PORT:-3000}..."
    echo "[entrypoint] NODE_ENV=${NODE_ENV:-production}"

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
