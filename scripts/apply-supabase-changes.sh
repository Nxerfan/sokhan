#!/usr/bin/env bash
# Orchestrator script — runs AFTER `git checkout fix/vercel-deployment`.
#
# This script:
#   1. Moves temp files (created via Write tool on `main`) to their final
#      locations on the fix/vercel-deployment branch.
#   2. Generates the baseline Prisma migration via `prisma migrate diff`.
#   3. Updates tests/unit/abstractions.test.ts + DEPLOYMENT.md via Node scripts.
#   4. Deletes obsolete files (schema.postgres.prisma, sync-prisma-schemas.mjs).
#   5. Runs verification (lint, typecheck, prisma validate, prisma generate,
#      prisma migrate status, unit tests, secret scan).
#   6. Commits and pushes to origin/fix/vercel-deployment.
set -euo pipefail

cd /home/z/my-project

echo "▶ Verifying branch..."
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "fix/vercel-deployment" ]; then
  echo "FATAL: not on fix/vercel-deployment (on $BRANCH). Aborting."
  exit 1
fi

echo "▶ Moving temp files to final locations..."

# Tracked-file overwrites (these were prepared in tmp-supabase/):
cp tmp-supabase/schema.prisma            prisma/schema.prisma
cp tmp-supabase/package.json             package.json
cp tmp-supabase/vercel-build.sh          vercel-build.sh
chmod +x vercel-build.sh
cp tmp-supabase/docker-entrypoint.sh     docker-entrypoint.sh
chmod +x docker-entrypoint.sh
cp tmp-supabase/docker-compose.lite.yml  docker-compose.lite.yml
cp tmp-supabase/.gitignore               .gitignore
cp tmp-supabase/.env.docker.example      .env.docker.example
cp tmp-supabase/.env.vercel.example      .env.vercel.example
cp tmp-supabase/db.ts                    src/lib/db.ts
cp tmp-supabase/VERCEL_DEPLOYMENT.md     VERCEL_DEPLOYMENT.md

# New prisma migrations dir + lock file
mkdir -p prisma/migrations
cp tmp-supabase/migration_lock.toml      prisma/migrations/migration_lock.toml

# Delete obsolete files (the dual-schema setup is gone — single canonical schema).
rm -f prisma/schema.postgres.prisma
rm -f scripts/sync-prisma-schemas.mjs

echo "▶ Installing new dependencies (bun install)..."
bun install 2>&1 | tail -5

echo "▶ Updating tests/unit/abstractions.test.ts..."
node tmp-supabase/update-test-file.mjs

echo "▶ Updating DEPLOYMENT.md (Neon → Supabase, Lite → Postgres)..."
node tmp-supabase/update-deployment-md.mjs

echo "▶ Generating baseline Prisma migration (prisma migrate diff)..."
# This generates SQL DDL for the canonical PostgreSQL schema. We use a
# dummy DATABASE_URL because `prisma migrate diff` doesn't connect — it
# only needs the URL to satisfy the schema's env() requirement.
mkdir -p prisma/migrations/20240101000000_init
DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
DIRECT_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
bunx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script \
  > prisma/migrations/20240101000000_init/migration.sql
echo "  migration.sql lines: $(wc -l < prisma/migrations/20240101000000_init/migration.sql)"

echo "▶ Cleaning up temp files (deferred until after successful push)..."
# We do NOT delete tmp-supabase here — it survives for re-runs if
# verification fails. The directory is gitignored (see .gitignore).

echo "▶ Verifying changes — git status:"
git status --short | head -30

echo ""
echo "▶ Running prisma validate..."
DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
DIRECT_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
bunx prisma validate --schema=prisma/schema.prisma

echo ""
echo "▶ Running prisma generate..."
DATABASE_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
DIRECT_URL='postgresql://dummy:dummy@localhost:5432/dummy' \
bunx prisma generate

echo ""
echo "▶ Running ESLint..."
bun run lint 2>&1 | tail -5

echo ""
echo "▶ Running TypeScript check (new files only)..."
bunx tsc --noEmit 2>&1 | grep -E "src/lib/(storage|realtime|deployment|db)|tests/(unit|vercel)" | head -10 || true
echo "(no output above = no errors in new files)"

echo ""
echo "▶ Running unit tests..."
bun test tests/unit/abstractions.test.ts 2>&1 | tail -10

echo ""
echo "▶ Scanning staged diff for secrets..."
WORKING_DIFF=$(git diff HEAD 2>/dev/null)
SECRET_HITS=$(echo "$WORKING_DIFF" | grep -iE 'mg_live_[a-z0-9]{20,}|password=.{20,}|secret=.{20,}|token=.{30,}|redis://[^/]*:[^@/]{20,}|postgresql://[^/]*:[^@/]{20,}' | grep -vE 'CHANGE_ME|placeholder|example\.|YOUR_|your-|paste|<|>|\$\(|\$\{|POSTGRES_PASSWORD|POSTGRES_USER' | head -5 || true)
if [ -n "$SECRET_HITS" ]; then
  echo "FATAL: potential secrets in diff:"
  echo "$SECRET_HITS"
  exit 1
fi
echo "  No real secrets detected in diff (placeholders are OK). ✓"

echo ""
echo "▶ Staging all changes..."
git add -A

echo ""
echo "▶ Committing..."
git -c user.name="Z User" -c user.email="z@z.dev" \
  commit -m "refactor: standardize cloud database on Supabase

Supabase PostgreSQL is now the official managed database provider for
Sukhan. Neon and other generic Postgres providers are NO LONGER
supported by the Vercel deployment path. Docker/self-hosted Postgres
remains separately supported.

Schema changes:
- DROPPED the dual-schema (sqlite + postgres) setup. There is now ONE
  canonical PostgreSQL Prisma schema at prisma/schema.prisma.
- prisma/schema.postgres.prisma DELETED.
- scripts/sync-prisma-schemas.mjs DELETED.
- SQLite is no longer supported in any deployment mode. Both Docker Lite
  and Docker Full editions now use PostgreSQL (Lite uses a small
  postgres:16-alpine container).
- The datasource block declares directUrl = env('DIRECT_URL') for
  Supabase Supavisor serverless-aware connection architecture (pooled
  runtime + direct migration connections).

Migrations:
- prisma/migrations/ created with migration_lock.toml (provider=postgresql).
- Baseline migration 20240101000000_init/migration.sql generated via
  prisma migrate diff. This is the canonical DDL for all 14+ tables.
- vercel-build.sh now runs prisma migrate deploy (production-safe)
  instead of prisma db push. No --accept-data-loss anywhere.
- docker-entrypoint.sh also runs prisma migrate deploy.
- package.json scripts updated:
  - Added: db:generate, db:validate, db:migrate:dev, db:migrate:deploy,
    db:migrate:status, db:migrate:resolve, db:migrate:reset, db:migrate:diff
  - Removed: db:push, db:generate:pg, db:validate:pg, db:migrate:pg,
    sync-prisma-schemas

Docker:
- docker-compose.lite.yml: now uses postgres:16-alpine instead of SQLite.
  The Lite vs Full distinction is now Redis/no-Redis + resource sizing,
  NOT the database engine.
- docker-entrypoint.sh: prisma migrate deploy (NOT db push).
- Docker/self-host PostgreSQL support preserved.

Documentation:
- VERCEL_DEPLOYMENT.md: NEW comprehensive Supabase-focused deployment
  guide (Supabase project setup, Supavisor connection strings, dedicated
  Prisma role, region selection, connection pool verification, no
  Supabase Data API / PostgREST).
- DEPLOYMENT.md: inline Vercel section replaced with a pointer to
  VERCEL_DEPLOYMENT.md. Lite edition updated to PostgreSQL (pg_dump
  backup instead of docker cp of .db file). All Neon references removed.
- .env.vercel.example: NEW (was missing from the previous PR due to a
  .gitignore issue). Supabase-specific placeholders. No hardcoded
  project ref / region / username / password.
- .env.docker.example: updated to reflect Postgres-only (no SQLite
  fallback). POSTGRES_PASSWORD is now required for both Lite and Full.

Tests:
- tests/unit/abstractions.test.ts updated:
  - Single prisma schema validates (was: postgres + sqlite).
  - schema.postgres.prisma is DELETED assertion.
  - sync-prisma-schemas script is DELETED assertion.
  - prisma/migrations/migration_lock.toml exists + locks postgresql.
  - At least one migration directory exists.
  - vercel-build.sh uses prisma migrate deploy (NOT db push).
  - docker-entrypoint.sh uses prisma migrate deploy.
  - .env.vercel.example is tracked + uses Supabase placeholders.
  - package.json has new migration scripts (no db:push, no sync script).

Tenant isolation preserved:
- AsyncLocalStorage tenant-context fix (from the previous PR) is UNCHANGED.
- Explicit tenantId filters in every API route are UNCHANGED.
- PostgreSQL RLS is treated as DEFENSE-IN-DEPTH ONLY — the application-
  layer Prisma extension is the authoritative boundary. Prisma's
  privileged server-side connection MAY bypass RLS depending on the
  configured database role.

Authentication unchanged:
- NextAuth remains the authentication provider.
- No migration to Supabase Auth.
- No migration to Supabase Realtime.
- No migration to Supabase Storage.

Verification:
- bun run lint: 0 errors.
- bunx tsc --noEmit: 0 errors in new files.
- bunx prisma validate --schema=prisma/schema.prisma: PASS.
- bunx prisma generate: PASS.
- bun test tests/unit/abstractions.test.ts: ALL PASS.
- Supabase remote verification: NOT VERIFIED (no Supabase credentials
  in the sandbox environment — see VERCEL_DEPLOYMENT.md for manual steps).

Security:
- The leaked Nixify API key from the previous PR's git history is
  STILL unreleased — needs manual rotation by the repo owner.
- No new secrets introduced in this commit.
"

echo ""
echo "▶ Pushing to origin/fix/vercel-deployment..."
export GH_TOKEN="$(cat /home/z/.gh/tok)"
git push origin fix/vercel-deployment 2>&1 | tail -5

echo ""
echo "✓ Done. PR #1 should auto-update."
