#!/usr/bin/env bash
# Vercel install + setup script.
#
# This runs as Vercel's `installCommand` (see vercel.json). It replaces
# the default `bun install` so we can run Prisma setup steps BEFORE
# Vercel's default Next.js build.
#
# Why installCommand (not buildCommand):
#   When a custom `buildCommand` is set, Vercel skips its default framework
#   build process — which means root-level `api/` files (like
#   `api/realtime.ts`, the WebSocket handler) are NOT detected and deployed
#   as Vercel Functions. By using `installCommand` instead and letting
#   Vercel use the default Next.js build, both Next.js API routes AND
#   root-level `api/` functions are deployed.
#
# The script:
#   1. Installs dependencies (`bun install`).
#   2. Sets DIRECT_URL fallback (falls back to DATABASE_URL if not set —
#      needed by prisma migrate deploy which validates env("DIRECT_URL")).
#   3. Runs `prisma generate` so the Prisma Client is available at runtime.
#   4. Runs `prisma migrate deploy` to apply pending migrations. This is
#      the production-safe migration command — it applies migration files
#      from prisma/migrations/ and never destructively reconciles the
#      schema at runtime.
#
# Vercel's default Next.js build (`next build`) runs AFTER this script.
# `NEXT_PUBLIC_VERCEL=1` is set as a Vercel env var (not here) so the
# client-side code can detect Vercel mode.
set -euo pipefail

echo "▶ Vercel install — installing dependencies"
bun install

# DIRECT_URL is required by prisma migrate deploy (the schema references
# env("DIRECT_URL")). If the Vercel project has DATABASE_URL set but not
# DIRECT_URL, fall back to DATABASE_URL.
if [ -z "${DIRECT_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DIRECT_URL="$DATABASE_URL"
  echo "▶ DIRECT_URL not set — falling back to DATABASE_URL"
fi

echo "▶ Vercel install — generating Prisma client (PostgreSQL / Neon)"
bunx prisma generate

echo "▶ Vercel install — applying Prisma migrations (migrate deploy)"
bunx prisma migrate deploy

echo "✓ Vercel install + setup complete"
