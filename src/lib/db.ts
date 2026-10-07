import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer.
 *
 * The Prisma client extension auto-injects `tenantId` on reads/writes
 * for tenant-scoped models when a tenant context is set via withTenant().
 *
 * NOTE: The extension is fail-OPEN (pass-through when no context).
 * Fail-closed enforcement is the application layer's responsibility:
 *   - withSessionTenant() wraps every authenticated request in withTenant()
 *   - All public/widget routes explicitly wrap tenant-scoped DB in withTenant()
 *   - Background operations (routing, sync) receive tenantId and wrap in withTenant()
 *
 * This is because Prisma 6.19.2 extension handlers (both $allOperations
 * and per-model) do not reliably propagate AsyncLocalStorage context —
 * the handler may run outside the caller's async context.
 */

export class TenantContextRequiredError extends Error {
  constructor(model: string) {
    super(`Tenant context required for ${model} operation. Wrap in withTenant(tenantId, fn).`)
    this.name = 'TenantContextRequiredError'
  }
}

const TENANT_SCOPED_MODELS = new Set([
  'Membership', 'Department', 'WidgetConfig', 'Contact',
  'Conversation', 'Message', 'Participant', 'RoutingRule',
  'Subscription', 'Invoice', 'FaqPair', 'Product',
  'AiConfig', 'ConnectorConfig', 'WidgetDomain',
])

const tenantContext = new AsyncLocalStorage<string>()

function currentTenantId(): string | undefined {
  return tenantContext.getStore()
}

export async function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantContext.run(tenantId, fn)
}

export function getCurrentTenantId(): string | undefined {
  return currentTenantId()
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function makeHandlers(model: string): Record<string, any> {
  const getTid = () => currentTenantId()

  const injectWhere = (args: any) => {
    const tid = getTid()
    if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
  }

  const scopeUpdate = (args: any) => {
    const tid = getTid()
    if (tid) args.where = { ...(args.where ?? {}), tenantId: tid }
    if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
      delete args.data.tenantId
    }
  }

  return {
    async findMany({ args, query }: any) { injectWhere(args); return query(args) },
    async findFirst({ args, query }: any) { injectWhere(args); return query(args) },
    async findFirstOrThrow({ args, query }: any) { injectWhere(args); return query(args) },
    async findUnique({ args, query }: any) {
      const tid = getTid()
      if (tid && args.where) args.where = { ...args.where, tenantId: tid }
      return query(args)
    },
    async findUniqueOrThrow({ args, query }: any) {
      const tid = getTid()
      if (tid && args.where) args.where = { ...args.where, tenantId: tid }
      return query(args)
    },
    async count({ args, query }: any) { injectWhere(args); return query(args) },
    async aggregate({ args, query }: any) { injectWhere(args); return query(args) },
    async groupBy({ args, query }: any) { injectWhere(args); return query(args) },
    async create({ args, query }: any) {
      const tid = getTid()
      if (tid && args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
        args.data = { ...args.data, tenantId: tid }
      }
      return query(args)
    },
    async createMany({ args, query }: any) {
      const tid = getTid()
      if (tid && Array.isArray(args.data)) {
        args.data = args.data.map((row: any) => ({ ...row, tenantId: tid }))
      } else if (tid && args.data && typeof args.data === 'object') {
        args.data = { ...args.data, tenantId: tid }
      }
      return query(args)
    },
    async update({ args, query }: any) { scopeUpdate(args); return query(args) },
    async updateMany({ args, query }: any) { scopeUpdate(args); return query(args) },
    async upsert({ args, query }: any) {
      const tid = getTid()
      if (tid && args.where) args.where = { ...args.where, tenantId: tid }
      if (tid && args.create) args.create = { ...args.create, tenantId: tid }
      if (args.update && typeof args.update === 'object' && !Array.isArray(args.update)) {
        delete args.update.tenantId
      }
      return query(args)
    },
    async delete({ args, query }: any) { injectWhere(args); return query(args) },
    async deleteMany({ args, query }: any) { injectWhere(args); return query(args) },
  }
}

function buildTenantScopedClient() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  })

  const query: Record<string, any> = {}
  for (const model of TENANT_SCOPED_MODELS) {
    const delegateKey = model.charAt(0).toLowerCase() + model.slice(1)
    query[delegateKey] = makeHandlers(model)
  }

  return client.$extends({ name: 'tenantScope', query: query as any })
}

export const db = (globalForPrisma.prisma ?? buildTenantScopedClient()) as PrismaClient

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

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
