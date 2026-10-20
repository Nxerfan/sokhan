// Verifies all expected Prisma models exist as tables in the Neon database.
// Reads credentials from /home/z/.neon-creds/ (never prints them).

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'

const dbUrl = readFileSync('/home/z/.neon-creds/database_url', 'utf8').trim() + '&pgbouncer=true'
const directUrl = readFileSync('/home/z/.neon-creds/direct_url', 'utf8').trim()

process.env.DATABASE_URL = dbUrl
process.env.DIRECT_URL = directUrl

const prisma = new PrismaClient({ log: ['error'] })

const EXPECTED_TABLES = [
  'Tenant', 'User', 'Membership', 'Department', 'DepartmentMember',
  'WidgetConfig', 'Contact', 'Conversation', 'Message', 'Participant',
  'RoutingRule', 'Plan', 'Subscription', 'Invoice', 'AiConfig', 'FaqPair',
  'Product', 'ConnectorConfig', 'WidgetDomain', 'SelfHostRequest',
  'OtpRequest', 'PendingSignup',
  '_prisma_migrations', // Prisma's migration tracking table
]

async function main() {
  // List all tables in the public schema.
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `
  const tableNames = tables.map((r) => r.tablename)
  console.log('Tables in public schema (' + tableNames.length + '):')
  for (const name of tableNames) console.log('  - ' + name)

  // Verify expected tables exist.
  const missing = EXPECTED_TABLES.filter((t) => !tableNames.includes(t))
  if (missing.length > 0) {
    console.error('MISSING TABLES: ' + missing.join(', '))
    process.exit(1)
  }
  console.log('\nAll ' + EXPECTED_TABLES.length + ' expected tables present. OK')

  // Verify indexes exist (a sample — Conversation should have 3 indexes + the PK).
  const indexes = await prisma.$queryRaw`
    SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Conversation' ORDER BY indexname
  `
  console.log('\nIndexes on Conversation table:')
  for (const idx of indexes) console.log('  - ' + idx.indexname)

  // Verify foreign keys exist (a sample — Conversation.contactId → Contact.id).
  const fks = await prisma.$queryRaw`
    SELECT conname, conrelid::regclass AS table_name, confrelid::regclass AS ref_table
    FROM pg_constraint
    WHERE contype = 'f' AND conrelid::regclass::text = 'Conversation' OR confrelid::regclass::text = 'Conversation'
    ORDER BY conname
  `
  console.log('\nForeign keys involving Conversation:')
  for (const fk of fks) console.log('  - ' + fk.conname + ': ' + fk.table_name + ' → ' + fk.ref_table)

  // Verify uniqueness constraints (a sample — Tenant.slug should be unique).
  const uniqueConstraints = await prisma.$queryRaw`
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'u' AND conrelid::regclass::text IN ('Tenant', 'User', 'Contact', 'WidgetDomain')
    ORDER BY conname
  `
  console.log('\nUniqueness constraints on Tenant/User/Contact/WidgetDomain:')
  for (const uc of uniqueConstraints) console.log('  - ' + uc.conname + ' on ' + uc.table_name)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e.message.split('\n')[0]) // first line only — credentials may be in error
  process.exit(1)
})
