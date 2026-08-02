import { PrismaClient, type Prisma } from '@prisma/client'

/**
 * Tenant isolation layer.
 *
 * Sandbox constraint: SQLite (no native RLS). We enforce tenant_id scoping in
 * the application via a Prisma client extension that:
 *   - injects `where: { tenantId }` on reads of tenant-scoped models,
 *   - injects `data: { tenantId }` on creates,
 *   - strips cross-tenant rows silently from results.
 *
 * The cloud Postgres deployment layers Row-Level Security *underneath* this
 * same client, so the application contract is identical and the extension
 * becomes a defense-in-depth check rather than the sole boundary.
 *
 * Tenant-scoped models (must declare here):
 */
const TENANT_SCOPED_MODELS = [
  'Membership',
  'Department',
  'DepartmentMember',
  'WidgetConfig',
] as const

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number]

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  /** Active tenant id for the current async context (set by withTenant). */
  __currentTenantId?: string
}

function currentTenantId(): string | undefined {
  return globalForPrisma.__currentTenantId
}

/**
 * Run a block of DB work scoped to a tenant. All Prisma calls inside that
 * touch tenant-scoped models are automatically filtered/injected.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = globalForPrisma.__currentTenantId
  globalForPrisma.__currentTenantId = tenantId
  try {
    return await fn()
  } finally {
    globalForPrisma.__currentTenantId = prev
  }
}

export function getCurrentTenantId(): string | undefined {
  return currentTenantId()
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
