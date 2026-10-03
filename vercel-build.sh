#!/usr/bin/env bash
# Vercel build script.
#
# Vercel invokes this script via vercel.json's `buildCommand`. The script:
#
#   1. Runs `prisma generate` against the canonical PostgreSQL schema so the
#      serverless runtime can talk to Neon Postgres.
#   2. Runs `prisma migrate deploy` to apply pending migrations. This is the
#      production-safe migration command — it applies the migration files
#      from prisma/migrations/ and never destructively reconciles the schema
#      at runtime. If a migration fails, the build fails.
#   3. Exports NEXT_PUBLIC_VERCEL=1 and runs `next build` WITHOUT
#      `output: 'standalone'` (next.config.ts detects Vercel via VERCEL=1
#      and skips the standalone output — Vercel uses its own build flow).
#
# Neon connection architecture (serverless-aware):
#   - DATABASE_URL  — Neon pooled connection (pooler hostname, with
#                     &pgbouncer=true). Used by the Prisma Client at
#                     runtime.
#   - DIRECT_URL    — Neon direct connection (no pooler). Used by
#                     `prisma migrate deploy` (DDL requires a direct
#                     connection; Neon's transaction-mode pooling is
#                     incompatible with migration DDL).
#
# Both env vars are REQUIRED for the Vercel build to succeed.
set -euo pipefail

# DIRECT_URL is required by prisma migrate deploy (the schema references
# env("DIRECT_URL") on line 44). If the Vercel project has DATABASE_URL
# set but not DIRECT_URL, fall back to DATABASE_URL. This works for:
#   - Supabase (single connection string — pooled and direct are the same)
#   - Neon with DATABASE_URL set to the DIRECT (non-pooled) connection
# For Neon with DATABASE_URL set to the POOLED connection, set DIRECT_URL
# separately to the direct (non-pooled) connection for migration DDL.
if [ -z "${DIRECT_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DIRECT_URL="$DATABASE_URL"
  echo "▶ DIRECT_URL not set — falling back to DATABASE_URL"
fi

echo "▶ Vercel build — generating Prisma client (PostgreSQL / Neon)"
bunx prisma generate

echo "▶ Vercel build — applying Prisma migrations (migrate deploy)"
bunx prisma migrate deploy

echo "▶ Vercel build — running next build (no standalone output)"
export NEXT_PUBLIC_VERCEL="1"
next build

echo "✓ Vercel build complete"
