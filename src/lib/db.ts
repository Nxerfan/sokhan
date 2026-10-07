import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

export class TenantContextRequiredError extends Error {
  constructor(model: string) {
    super(`Tenant context required for ${model} operation. Wrap in withTenant(tenantId, fn).`)
    this.name = 'TenantContextRequiredError'
  }
}

const TENANT_SCOPED_MODELS = [
  'Membership', 'Department', 'WidgetConfig', 'Contact',
  'Conversation', 'Message', 'Participant', 'RoutingRule',
  'Subscription', 'Invoice', 'FaqPair', 'Product',
  'AiConfig', 'ConnectorConfig', 'WidgetDomain',
] as const

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

function buildTenantScopedClient() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  })

  const handlers: Record<string, any> = {}

  for (const model of TENANT_SCOPED_MODELS) {
    handlers[model] = {
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
      async create({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
          args.data = { ...args.data, tenantId: tid }
        }
        return query(args)
      },
      async createMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        if (Array.isArray(args.data)) {
          args.data = args.data.map((row: any) => ({ ...row, tenantId: tid }))
        } else if (args.data && typeof args.data === 'object') {
          args.data = { ...args.data, tenantId: tid }
        }
        return query(args)
      },
      async update({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
          delete args.data.tenantId
        }
        return query(args)
      },
      async updateMany({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        args.where = { ...(args.where ?? {}), tenantId: tid }
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
          delete args.data.tenantId
        }
        return query(args)
      },
      async upsert({ args, query }: any) {
        const tid = currentTenantId()
        if (!tid) throw new TenantContextRequiredError(model)
        if (args.where) args.where = { ...args.where, tenantId: tid }
        if (args.create) args.create = { ...args.create, tenantId: tid }
        if (args.update && typeof args.update === 'object' && !Array.isArray(args.update)) {
          delete args.update.tenantId
        }
        return query(args)
      },
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
    query: handlers,
  })
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
