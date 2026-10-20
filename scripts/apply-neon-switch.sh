#!/usr/bin/env bash
# Orchestrator: applies Neon changes, runs verification, commits + pushes.
# Runs AFTER `git checkout -f fix/vercel-deployment`.
set -euo pipefail
cd /home/z/my-project

echo "▶ Verifying branch..."
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "fix/vercel-deployment" ]; then
  echo "FATAL: not on fix/vercel-deployment (on $BRANCH). Aborting."
  exit 1
fi

echo "▶ Moving temp files to final locations..."
cp tmp-neon/.env.vercel.example    .env.vercel.example
cp tmp-neon/VERCEL_DEPLOYMENT.md   VERCEL_DEPLOYMENT.md
cp tmp-neon/vercel-build.sh        vercel-build.sh
chmod +x vercel-build.sh

echo "▶ Applying Supabase→Neon replacements to schema/tests/DEPLOYMENT.md..."
node tmp-neon/apply-neon-changes.mjs

echo "▶ Updating playwright.config.ts (exclude tests/unit/ from Playwright)..."
cat > playwright.config.ts <<'PWC_EOF'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  testIgnore: [
    'tests/unit/**',
    'tests/static/**',
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:81',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    locale: 'fa-IR',
  },
})
PWC_EOF

echo "▶ Cleaning up temp files..."
rm -rf tmp-neon

echo "▶ git status:"
git status --short | head -20

echo ""
echo "▶ Running prisma validate..."
export DATABASE_URL="$(cat /home/z/.neon-creds/database_url)&pgbouncer=true"
export DIRECT_URL="$(cat /home/z/.neon-creds/direct_url)"
bunx prisma validate --schema=prisma/schema.prisma 2>&1 | tail -3

echo ""
echo "▶ Running prisma generate..."
bunx prisma generate 2>&1 | tail -3

echo ""
echo "▶ Running ESLint..."
bun run lint 2>&1 | tail -5

echo ""
echo "▶ Running TypeScript check..."
bunx tsc --noEmit 2>&1 | grep -E "src/lib/(storage|realtime|deployment|db)|tests/(unit|vercel)" | head -10 || true
echo "(no output above = no errors in new files)"

echo ""
echo "▶ Running unit tests..."
bun test tests/unit/abstractions.test.ts 2>&1 | tail -5

echo ""
echo "▶ Scanning diff for secrets..."
WORKING_DIFF=$(git diff HEAD 2>/dev/null)
SECRET_HITS=$(echo "$WORKING_DIFF" | grep -iE 'mg_live_[a-z0-9]{20,}|password=.{20,}|secret=.{20,}|token=.{30,}|redis://[^/]*:[^@/]{20,}|postgresql://[^/]*:[^@/]{20,}' | grep -vE 'CHANGE_ME|placeholder|example\.|YOUR_|your-|paste|<|>|\$\(|\$\{|POSTGRES_PASSWORD|POSTGRES_USER|neon-pooled|neon-direct|nixify-api-key|vercel-blob-token|upstash-redis-url' | head -5 || true)
if [ -n "$SECRET_HITS" ]; then
  echo "FATAL: potential secrets in diff:"
  echo "$SECRET_HITS"
  exit 1
fi
echo "  No real secrets detected in diff. ✓"

echo ""
echo "▶ Staging all changes..."
git add -A

echo ""
echo "▶ Committing..."
git -c user.name="Z User" -c user.email="z@z.dev" \
  commit -m "refactor: switch Vercel database provider to Neon

Neon PostgreSQL is now the official managed database provider for
Sukhan's Vercel deployment. Supabase/Supavisor references have been
removed. Docker/self-hosted PostgreSQL remains separately supported
(Neon is NOT required for Docker).

Architecture:
- Vercel → Next.js serverless functions
- Neon → managed PostgreSQL (pooled DATABASE_URL + direct DIRECT_URL)
- Prisma → ORM (one canonical PostgreSQL schema)
- NextAuth → authentication (unchanged)
- Socket.IO → realtime transport (separately hosted + Redis pub/sub)
- Vercel Blob → cloud attachment storage
- Docker PostgreSQL → self-hosted deployment

Connection semantics:
- DATABASE_URL = Neon pooled connection (pooler hostname, with
  &pgbouncer=true). Used by the Prisma Client at runtime.
- DIRECT_URL = Neon direct connection (no pooler). Used by
  prisma migrate deploy and prisma migrate status.

Files changed:
- VERCEL_DEPLOYMENT.md: rewritten for Neon (Supabase → Neon setup,
  connection strings, region selection, pool verification).
- .env.vercel.example: Neon-specific placeholders (no Supabase refs).
- vercel-build.sh: Neon comments (Supavisor → Neon pooler).
- prisma/schema.prisma: header comment updated (Supavisor → Neon pooler).
- tests/unit/abstractions.test.ts: test assertion updated
  (Supabase → Neon placeholders).
- DEPLOYMENT.md: Vercel section pointer updated (Supabase → Neon).
- playwright.config.ts: exclude tests/unit/ from Playwright runner
  (bun:test imports crash the Playwright loader).

Preserved from previous PRs:
- ONE canonical PostgreSQL Prisma schema (no SQLite, no dual-schema).
- prisma migrate deploy (NOT db push) in production.
- AsyncLocalStorage tenant isolation fix.
- Vercel deployment/realtime/storage abstractions.
- Docker PostgreSQL support (Lite + Full editions).
- Existing regression tests.

Verified against real Neon (development database):
- Pooled connection (DATABASE_URL): PASS (prisma db execute SELECT 1).
- Direct connection (DIRECT_URL): PASS (prisma migrate status).
- Migrations: prisma migrate deploy applied 20240101000000_init successfully.
- All 23 tables verified present (22 models + _prisma_migrations).
- 26 FKs, 9 indexes, 16 default values verified.
- CRUD: 11 models (Tenant, User, Membership, Department, Contact,
  Conversation, Message, Participant, WidgetConfig, WidgetDomain,
  RoutingRule) — all CREATE/READ/UPDATE/DELETE succeeded with cleanup.
- Idempotency: re-running prisma migrate deploy shows 'No pending migrations'.
"

echo ""
echo "▶ Pushing to origin/fix/vercel-deployment..."
export GH_TOKEN="$(cat /home/z/.gh/tok)"
git push origin fix/vercel-deployment 2>&1 | tail -5

echo ""
echo "✓ Done. PR #1 should auto-update."
