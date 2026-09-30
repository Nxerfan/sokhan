#!/usr/bin/env node
/**
 * Sync the postgres-flavoured Prisma schema from the sqlite-flavoured one.
 *
 * The two schemas are identical except for the `provider` value in the
 * `datasource db` block. We keep them in sync programmatically to avoid
 * drift — run this after editing `prisma/schema.prisma`:
 *
 *   bun run sync-prisma-schemas
 *
 * What it does:
 *   1. Reads `prisma/schema.prisma` (the canonical source — sqlite).
 *   2. Replaces `provider = "sqlite"` with `provider = "postgresql"`.
 *   3. Replaces the sqlite header comment with the postgres header.
 *   4. Writes the result to `prisma/schema.postgres.prisma`.
 *
 * It also runs `prisma validate` on both schemas to catch syntax errors
 * before they reach the build.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const sqlitePath = resolve(root, 'prisma/schema.prisma')
const postgresPath = resolve(root, 'prisma/schema.postgres.prisma')

const sqliteSchema = readFileSync(sqlitePath, 'utf8')

// Replace the provider line.
let postgresSchema = sqliteSchema.replace(
  /provider\s*=\s*"sqlite"/,
  'provider = "postgresql"',
)

// Replace the header comment so the file is self-documenting.
const sqliteHeader = `// Live Chat SaaS — Module 1+2 schema (default SQLITE variant for dev/Docker Lite)
//
// The postgresql-flavoured mirror lives at \`prisma/schema.postgres.prisma\`
// and is used on Vercel and Docker Full. Keep them in sync via:
//
//   bun run sync-prisma-schemas
//
// Tenant isolation is enforced in the application layer via a Prisma client
// extension (see src/lib/db.ts) PLUS explicit tenantId on every write.`

const postgresHeader = `// Live Chat SaaS — Module 1+2 schema (POSTGRESQL variant for Vercel/Docker Full)
//
// This file is the postgresql-flavoured mirror of \`prisma/schema.prisma\`
// (which defaults to sqlite for dev/Docker Lite). Keep them in sync via:
//
//   bun run sync-prisma-schemas
//
// Tenant isolation is enforced in the application layer via a Prisma client
// extension (see src/lib/db.ts) PLUS explicit tenantId on every write.`

// Only replace the header if it matches the expected sqlite header — this
// avoids drift if the source has been edited. If the source header has
// drifted, we still produce a valid postgres schema (just with whatever
// header the source had, with the provider line swapped).
if (sqliteSchema.startsWith(sqliteHeader)) {
  postgresSchema = postgresSchema.replace(sqliteHeader, postgresHeader)
}

writeFileSync(postgresPath, postgresSchema, 'utf8')
console.log('[sync-prisma-schemas] wrote prisma/schema.postgres.prisma')

// Validate both schemas. The postgres validation requires a postgres-formatted
// DATABASE_URL — we use a placeholder that satisfies the URL-format check
// (Prisma does NOT actually connect during `prisma validate`).
try {
  execSync(`bunx prisma validate --schema=${sqlitePath}`, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'file:/tmp/sukhan-validate.db' },
  })
  console.log('[sync-prisma-schemas] sqlite schema validates ✓')
} catch {
  console.error('[sync-prisma-schemas] sqlite schema failed to validate!')
  process.exit(1)
}
try {
  execSync(`bunx prisma validate --schema=${postgresPath}`, {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Use a syntactically-valid Postgres URL for validation. Prisma
      // validate does NOT actually connect — it only checks the URL format.
      DATABASE_URL: process.env.DATABASE_URL?.startsWith('postgres')
        ? process.env.DATABASE_URL
        : 'postgresql://user:password@localhost:5432/sukhan-validate',
    },
  })
  console.log('[sync-prisma-schemas] postgres schema validates ✓')
} catch {
  console.error('[sync-prisma-schemas] postgres schema failed to validate!')
  process.exit(1)
}
