// Verifies FKs + uniqueness constraints in the Neon database.
// Uses pg_class.relname (case-sensitive string match) instead of ::regclass::text.

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'

const dbUrl = readFileSync('/home/z/.neon-creds/database_url', 'utf8').trim() + '&pgbouncer=true'
const directUrl = readFileSync('/home/z/.neon-creds/direct_url', 'utf8').trim()

process.env.DATABASE_URL = dbUrl
process.env.DIRECT_URL = directUrl

const prisma = new PrismaClient({ log: ['error'] })

async function main() {
  // All FK constraints in the public schema.
  const fks = await prisma.$queryRaw`
    SELECT c.conname,
           cl.relname AS table_name,
           cr.relname AS ref_table
    FROM pg_constraint c
    JOIN pg_class cl ON c.conrelid = cl.oid
    JOIN pg_class cr ON c.confrelid = cr.oid
    JOIN pg_namespace n ON c.connamespace = n.oid
    WHERE c.contype = 'f' AND n.nspname = 'public'
    ORDER BY cl.relname, c.conname
  `
  console.log('Foreign keys (' + fks.length + '):')
  for (const fk of fks) console.log('  - ' + fk.table_name + ' → ' + fk.ref_table + ' (' + fk.conname + ')')

  // All UNIQUE constraints (excluding PKs) in the public schema.
  const uniques = await prisma.$queryRaw`
    SELECT c.conname, cl.relname AS table_name
    FROM pg_constraint c
    JOIN pg_class cl ON c.conrelid = cl.oid
    JOIN pg_namespace n ON c.connamespace = n.oid
    WHERE c.contype = 'u' AND n.nspname = 'public'
    ORDER BY cl.relname, c.conname
  `
  console.log('\nUniqueness constraints (' + uniques.length + '):')
  for (const u of uniques) console.log('  - ' + u.table_name + ' (' + u.conname + ')')

  // All indexes (non-PK) in the public schema — a sample on tenant-scoped tables.
  const indexes = await prisma.$queryRaw`
    SELECT i.tablename, i.indexname
    FROM pg_indexes i
    WHERE i.schemaname = 'public'
      AND i.indexname NOT LIKE '%_pkey'
      AND i.tablename IN ('Conversation', 'Message', 'Contact', 'RoutingRule', 'Subscription')
    ORDER BY i.tablename, i.indexname
  `
  console.log('\nIndexes on tenant-scoped tables (' + indexes.length + '):')
  for (const idx of indexes) console.log('  - ' + idx.tablename + '.' + idx.indexname)

  // Verify default values are set (Tenant.plan defaults to 'free', Conversation.status to 'open').
  const defaults = await prisma.$queryRaw`
    SELECT table_name, column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('Tenant', 'Conversation', 'Message')
      AND column_default IS NOT NULL
    ORDER BY table_name, column_name
  `
  console.log('\nDefault values (' + defaults.length + '):')
  for (const d of defaults) console.log('  - ' + d.table_name + '.' + d.column_name + ' = ' + d.column_default)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e.message.split('\n')[0])
  process.exit(1)
})
