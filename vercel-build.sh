#!/usr/bin/env bash
# Vercel build script.
#
# Vercel invokes this script instead of `next build` because it is named
# `vercel-build` (a Vercel convention). The script:
#
#   1. Selects the postgres-flavoured Prisma schema (Vercel always uses
#      Postgres via Neon / Supabase / etc.).
#   2. Generates the Prisma client against the postgres schema so the
#      serverless runtime can talk to Postgres.
#   3. Runs `next build` WITHOUT `output: 'standalone'` (the
#      `next.config.ts` detects Vercel via `VERCEL=1` and skips the
#      standalone output).
#
# Required Vercel env vars (set in the Vercel dashboard or via `vercel env`):
#
#   DATABASE_URL              — postgresql://...  (Neon / Supabase / etc.)
#   NEXTAUTH_SECRET           — openssl rand -base64 32
#   NEXTAUTH_URL              — https://your-domain.vercel.app
#   REDIS_URL                 — redis://...       (Upstash Redis)
#   BLOB_READ_WRITE_TOKEN     — Vercel Blob token
#   NEXT_PUBLIC_REALTIME_URL  — https://realtime.your-domain.com (the public
#                               URL of the separately-hosted realtime service)
#
# Optional:
#   REALTIME_INTERNAL_URL     — if your realtime service exposes an HTTP
#                               /internal/publish endpoint, set this to its
#                               private URL. Required if REDIS_URL is not set.
#   REDIS_CHANNEL             — defaults to "sukhan:realtime"
set -euo pipefail

echo "▶ Vercel build — selecting postgres Prisma schema"
bun run sync-prisma-schemas

echo "▶ Vercel build — generating Prisma client (postgres)"
bunx prisma generate --schema=prisma/schema.postgres.prisma

echo "▶ Vercel build — running next build (no standalone output)"
next build

echo "✓ Vercel build complete"
