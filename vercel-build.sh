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
#   3. Runs `export NEXT_PUBLIC_VERCEL="1"
next build` WITHOUT `output: 'standalone'` (the
#      `next.config.ts` detects Vercel via `VERCEL=1` and skips the
#      standalone output — Vercel uses its own build flow).
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

echo "▶ Vercel build — generating Prisma client (PostgreSQL / Neon)"
bunx prisma generate

echo "▶ Vercel build — applying Prisma migrations (migrate deploy)"
bunx prisma migrate deploy

echo "▶ Vercel build — running export NEXT_PUBLIC_VERCEL="1"
next build (no standalone output)"
export NEXT_PUBLIC_VERCEL="1"
next build

echo "✓ Vercel build complete"
