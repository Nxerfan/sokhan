#!/usr/bin/env bash
# Vercel build script.
#
# Vercel invokes this script via vercel.json's `buildCommand`. The script:
#
#   1. Runs `prisma generate` against the canonical PostgreSQL schema so the
#      serverless runtime can talk to Supabase Postgres.
#   2. Runs `prisma migrate deploy` to apply pending migrations. This is the
#      production-safe migration command — it applies the migration files
#      from prisma/migrations/ and never destructively reconciles the schema
#      at runtime. If a migration fails, the build fails.
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
set -euo pipefail

echo "▶ Vercel build — generating Prisma client (PostgreSQL / Supabase)"
bunx prisma generate

echo "▶ Vercel build — applying Prisma migrations (migrate deploy)"
bunx prisma migrate deploy

echo "▶ Vercel build — running next build (no standalone output)"
next build

echo "✓ Vercel build complete"
