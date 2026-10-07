import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer — FAIL-CLOSED.
 *
 * Uses per-model Prisma Client query extensions with the correct Prisma
 * client delegate keys (camelCase). The $allModels/$allOperations pattern
 * was tested but does not correctly propagate AsyncLocalStorage context
 * in Prisma 6.19.2 — the handler runs outside the caller's async context.
 *
 * Per-model handlers are called synchronously from the Prisma client,
 * preserving the caller's AsyncLocalStorage context.
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

/** Build a single operation handler for a tenant-scoped model. */
function makeHandlers(model: string): Record<string, any> {
  const requireTid = () => {
    const tid = currentTenantId()
    if (!tid) throw new TenantContextRequiredError(model)
    return tid
  }

  const injectWhere = (args: any) => {
    const tid = requireTid()
    args.where = { ...(args.where ?? {}), tenantId: tid }
  }

  const scopeUpdate = (args: any) => {
    const tid = requireTid()
    args.where = { ...(args.where ?? {}), tenantId: tid }
    if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
      delete args.data.tenantId
    }
  }

  return {
    async findMany({ args, query }: any) { injectWhere(args); return query(args) },
    async findFirst({ args, query }: any) { injectWhere(args); return query(args) },
    async findFirstOrThrow({ args, query }: any) { injectWhere(args); return query(args) },
    async findUnique({ args, query }: any) {
      const tid = requireTid()
      if (args.where) args.where = { ...args.where, tenantId: tid }
      return query(args)
    },
    async findUniqueOrThrow({ args, query }: any) {
      const tid = requireTid()
      if (args.where) args.where = { ...args.where, tenantId: tid }
      return query(args)
    },
    async count({ args, query }: any) { injectWhere(args); return query(args) },
    async aggregate({ args, query }: any) { injectWhere(args); return query(args) },
    async groupBy({ args, query }: any) { injectWhere(args); return query(args) },
    async create({ args, query }: any) {
      const tid = requireTid()
      if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
        args.data = { ...args.data, tenantId: tid }
      }
      return query(args)
    },
    async createMany({ args, query }: any) {
      const tid = requireTid()
      if (Array.isArray(args.data)) {
        args.data = args.data.map((row: any) => ({ ...row, tenantId: tid }))
      } else if (args.data && typeof args.data === 'object') {
        args.data = { ...args.data, tenantId: tid }
      }
      return query(args)
    },
    async update({ args, query }: any) { scopeUpdate(args); return query(args) },
    async updateMany({ args, query }: any) { scopeUpdate(args); return query(args) },
    async upsert({ args, query }: any) {
      const tid = requireTid()
      if (args.where) args.where = { ...args.where, tenantId: tid }
      if (args.create) args.create = { ...args.create, tenantId: tid }
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

  // Use correct Prisma client delegate keys (camelCase, not PascalCase)
  const query: Record<string, any> = {}
  for (const model of TENANT_SCOPED_MODELS) {
    // Convert PascalCase model name to camelCase delegate key
    const delegateKey = model.charAt(0).toLowerCase() + model.slice(1)
    query[delegateKey] = makeHandlers(model)
  }

  return client.$extends({ name: "tenantScope", query: query as any })
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
