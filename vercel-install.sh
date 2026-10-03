#!/usr/bin/env bash
set -euo pipefail

echo "▶ Vercel install — installing dependencies"
bun install

# DIRECT_URL is required by prisma migrate deploy (the schema references
# env("DIRECT_URL")). Use DATABASE_URL_UNPOOLED (Neon direct, non-pooled,
# auto-synced by the Neon Vercel integration) if DIRECT_URL is not set.
# NEVER fall back to DATABASE_URL (pooled) — Neon's transaction-mode
# pooling is incompatible with migration DDL.
if [ -z "${DIRECT_URL:-}" ] && [ -n "${DATABASE_URL_UNPOOLED:-}" ]; then
  export DIRECT_URL="$DATABASE_URL_UNPOOLED"
  echo "▶ DIRECT_URL not set — using DATABASE_URL_UNPOOLED (Neon direct)"
fi

if [ -z "${DIRECT_URL:-}" ]; then
  echo "✗ DIRECT_URL or DATABASE_URL_UNPOOLED is required for Prisma migrations" >&2
  exit 1
fi

echo "▶ Vercel install — generating Prisma client"
bunx prisma generate

echo "▶ Vercel install — applying Prisma migrations"
bunx prisma migrate deploy

echo "✓ Vercel install + setup complete"
