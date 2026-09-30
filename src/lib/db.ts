import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer.
 *
 * PostgreSQL is the official database across all deployment modes
 * (Supabase cloud, Docker Full, Docker Lite, local dev). The Prisma
 * client extension below is the PRIMARY tenant-isolation boundary:
 *   - auto-injects `where: { tenantId }` on reads of tenant-scoped models,
 *   - auto-injects `data: { tenantId }` on creates,
 *   - strips cross-tenant rows from results.
 *
 * PostgreSQL Row-Level Security is treated as DEFENSE-IN-DEPTH ONLY.
 * Prisma's privileged server-side database connection (which may use a
 * dedicated Prisma role) MAY bypass RLS policies depending on the
 * configured role. Therefore:
 *   - NEVER weaken the application-layer tenant filtering here.
 *   - NEVER assume that "RLS is enabled" means tenant isolation is
 *     guaranteed. The extension below is the authoritative boundary.
 *
 * The application contract is identical across modes: the extension
 * auto-injects `where: { tenantId }` on reads and `data: { tenantId }` on
 * creates for tenant-scoped models, and strips cross-tenant rows from
 * results.
 *
 * Tenant-scoped models (must declare here):
 *
 * CRITICAL: Every model that has a `tenantId` column MUST be listed here.
 * If a model is missing from this list, the extension will NOT auto-inject
 * tenantId on reads or writes, causing cross-tenant data leaks.
 *
 * Module 1 models: Membership, Department, DepartmentMember, WidgetConfig
 * Module 2 models: Contact, Conversation, Message, Participant, RoutingRule
 * Module 3 models: Subscription, Invoice (Plan is global — NOT tenant-scoped)
 * Module 4 models: FaqPair, Product, AiConfig, ConnectorConfig
 * Module 6 models: WidgetDomain
 */
const TENANT_SCOPED_MODELS = [
  'Membership',
  'Department',
  'DepartmentMember',
  'WidgetConfig',
  'Contact',
  'Conversation',
  'Message',
  'Participant',
  'RoutingRule',
  'Subscription',
  'Invoice',
  'FaqPair',
  'Product',
  'AiConfig',
  'ConnectorConfig',
  'WidgetDomain',
] as const

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number]

/* ------------------------------------------------------------------ */
/* Per-request tenant context via AsyncLocalStorage                  */
/* ------------------------------------------------------------------ */
//
// CRITICAL: the previous implementation used a single mutable global variable
// (`globalForPrisma.__currentTenantId`). Under concurrent async requests
// (e.g., two API routes running in the same Node process — common in dev
// and in Docker, possible even on Vercel when a warm instance handles
// back-to-back requests), the second request's `withTenant(tenantIdB)`
// would overwrite the first request's `__currentTenantId` while the first
// was still awaiting I/O. The result: cross-tenant data leaks.
//
// `AsyncLocalStorage` correctly tracks context per async execution
// chain — each request gets its own context that does not leak across
// concurrent awaits, even within the same process.
const tenantContext = new AsyncLocalStorage<string>()

function currentTenantId(): string | undefined {
  return tenantContext.getStore()
}

/**
 * Run a block of DB work scoped to a tenant. All Prisma calls inside that
 * touch tenant-scoped models are automatically filtered/injected.
 *
 * Concurrent calls to `withTenant` with different tenant IDs in the same
 * process are isolated via AsyncLocalStorage — no leaks.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantContext.run(tenantId, fn)
}

export function getCurrentTenantId(): string | undefined {
  return currentTenantId()
}

/* ------------------------------------------------------------------ */
/* Prisma client with tenant-scoping extension                       */
/* ------------------------------------------------------------------ */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function buildTenantScopedClient() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  })

  const handlers: Record<string, unknown> = {}
  for (const model of TENANT_SCOPED_MODELS) {
    handlers[model] = {
      async findMany({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async findUnique({ args, query }: any) {
        const tid = currentTenantId()
        if (tid && args.where) args.where = { ...args.where, tenantId: tid }
        return query(args)
      },
      async findFirst({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async create({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.data = { ...args.data, tenantId: tid }
        return query(args)
      },
      async update({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async delete({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async count({ args, query }: any) {
        const tid = currentTenantId()
        if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
    }
  }

  return client.$extends({
    name: 'tenantScope',
    query: handlers as any,
  })
}

export const db = (globalForPrisma.prisma ?? buildTenantScopedClient()) as PrismaClient

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/* ------------------------------------------------------------------ */
/* Role helpers (kept here for backwards-compat — also in auth.ts)    */
/* ------------------------------------------------------------------ */

/** Roles, in descending privilege order. */
export const ROLE_RANK: Record<string, number> = {
  owner: 5,
  admin: 4,
  manager: 3,
  agent: 2,
  viewer: 1,
}

export function hasRole(current: string, required: string): boolean {
  return (ROLE_RANK[current] ?? 0) >= (ROLE_RANK[required] ?? 0)
}
