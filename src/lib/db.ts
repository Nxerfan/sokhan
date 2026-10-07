import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer — FAIL-CLOSED.
 *
 * PostgreSQL is the official database across all deployment modes.
 * The Prisma client extension below is the PRIMARY tenant-isolation boundary.
 *
 * FAIL-CLOSED contract:
 *   For models in TENANT_SCOPED_MODELS, if there is no current tenant context
 *   (set via withTenant), the extension THROWS TenantContextRequiredError
 *   BEFORE the query reaches the database. A caller must NOT be able to
 *   bypass tenant isolation by manually supplying tenantId in the query.
 *
 * Trusted/background operations must use:
 *   withTenant(tenantId, async () => { ... })
 *
 * Tenant-scoped models (must have a `tenantId` column in the schema):
 *   Membership, Department, WidgetConfig, Contact, Conversation, Message,
 *   Participant, RoutingRule, Subscription, Invoice, FaqPair, Product,
 *   AiConfig, ConnectorConfig, WidgetDomain
 *
 * NOTE: DepartmentMember has NO tenantId column — it is NOT listed here.
 * Its tenant scoping is implicit through Department.tenantId.
 */

export class TenantContextRequiredError extends Error {
  constructor(model: string) {
    super(`Tenant context required for ${model} operation. Wrap in withTenant(tenantId, fn).`)
    this.name = 'TenantContextRequiredError'
  }
}

const TENANT_SCOPED_MODELS = [
  'Membership',
  'Department',
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
/* Prisma client with tenant-scoping extension (FAIL-CLOSED)         */
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
      // ─── Reads ──────────────────────────────────────────────
      async findMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async findFirst({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async findFirstOrThrow({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async findUnique({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        // findUnique uses compound unique keys — only inject if where exists
        if (args.where) args.where = { ...args.where, tenantId: tid }
        return query(args)
      },
      async findUniqueOrThrow({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        if (args.where) args.where = { ...args.where, tenantId: tid }
        return query(args)
      },
      async count({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async aggregate({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async groupBy({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },

      // ─── Creates ────────────────────────────────────────────
      async create({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        // FORCE tenantId from context — override any caller-supplied value
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
          args.data = { ...args.data, tenantId: tid }
        }
        return query(args)
      },
      async createMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        // Stamp every row with current tenantId
        if (Array.isArray(args.data)) {
          args.data = args.data.map((row: any) => ({ ...row, tenantId: tid }))
        } else if (args.data && typeof args.data === 'object') {
          args.data = { ...args.data, tenantId: tid }
        }
        return query(args)
      },

      // ─── Updates ────────────────────────────────────────────
      async update({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async updateMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async upsert({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        // Scope the where clause
        if (args.where) args.where = { ...args.where, tenantId: tid }
        // Force tenantId on create
        if (args.create) args.create = { ...args.create, tenantId: tid }
        return query(args)
      },

      // ─── Deletes ────────────────────────────────────────────
      async delete({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        return query(args)
      },
      async deleteMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
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
/* Role helpers                                                       */
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
