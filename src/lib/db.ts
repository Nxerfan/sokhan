import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer — FAIL-CLOSED by construction.
 *
 * DESIGN CONTRACT (PR #3):
 *   1. The Prisma query extension does NOT read AsyncLocalStorage inside
 *      the query callback. Prisma 6.19.2 extension handlers can run
 *      outside the caller's async context (confirmed under the Docker
 *      Node runtime), so an ALS read inside the handler is unreliable.
 *      Instead, `createTenantClient(tenantId)` builds an extended client
 *      whose query handlers CLOSE OVER `tenantId` directly. The tenant id
 *      is captured at client-construction time — it can never be
 *      "missing" inside a handler because it is a closure variable, not a
 *      context lookup.
 *   2. The exported `db` is a Proxy. Accessing a tenant-scoped model
 *      delegate (e.g. `db.product`, `db.contact`, `db.conversation`)
 *      WITHOUT an active tenant context throws `TenantContextRequiredError`
 *      IMMEDIATELY — before any query reaches the database. There is NO
 *      exported path where `db.product.findMany()` can silently execute
 *      an unscoped query.
 *   3. `withTenant(tenantId, fn)` activates the tenant context (via ALS,
 *      which IS reliable in application code — the unreliable part is only
 *      the ALS read *inside the Prisma extension handler*). Inside `fn`,
 *      `db.<tenantScopedModel>` resolves to the cached per-tenant extended
 *      client (tenantId captured in its handlers' closure).
 *   4. Global models (Tenant, User, Plan, OtpRequest, PendingSignup,
 *      SelfHostRequest, DepartmentMember) are never tenant-scoped. They
 *      route to the shared base client and need no tenant context.
 *      `globalDb` (the raw base PrismaClient) is exported for explicit
 *      bootstrap/migration/seed paths that must operate outside any tenant
 *      context (e.g. signup-complete creating the first Membership row).
 *
 * MANDATORY PROPERTY: NO tenantId → NO tenant-scoped client/query.
 */

export class TenantContextRequiredError extends Error {
  constructor(model: string) {
    super(
      `Tenant context required for ${model} operation. ` +
        `Wrap the call in withTenant(tenantId, fn) or use createTenantClient(tenantId).`,
    )
    this.name = 'TenantContextRequiredError'
  }
}

/** Models that carry a `tenantId` column and therefore REQUIRE a tenant scope. */
const TENANT_SCOPED_MODELS = new Set<string>([
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
])

/** Prisma delegate keys (camelCase) for tenant-scoped models. */
const TENANT_SCOPED_DELEGATES = new Set<string>(
  Array.from(TENANT_SCOPED_MODELS, (m) => m.charAt(0).toLowerCase() + m.slice(1)),
)

/**
 * Active tenant id for the current async context. Reliable in application
 * code (the code that calls `db.X`); NOT reliable inside Prisma extension
 * handlers, which is exactly why the handlers capture `tenantId` in their
 * closure instead of reading this.
 */
const tenantContext = new AsyncLocalStorage<string>()

export function getCurrentTenantId(): string | undefined {
  return tenantContext.getStore()
}

export async function withTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantContext.run(tenantId, fn)
}

const globalForPrisma = globalThis as unknown as {
  prismaBase: PrismaClient | undefined
  tenantClients: Map<string, PrismaClient> | undefined
}

/** Shared, un-extended base PrismaClient (one connection pool for the process). */
function getBaseClient(): PrismaClient {
  if (globalForPrisma.prismaBase) return globalForPrisma.prismaBase
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  })
  globalForPrisma.prismaBase = client
  return client
}

/**
 * Build the query-extension handlers for ONE tenant. `tenantId` is a
 * closure parameter — every handler reads the captured value, never ALS.
 *
 * Because `tenantId` is always present here, the handlers ALWAYS inject the
 * scope (no "if (tid)" guard). This is the fail-closed-by-construction
 * guarantee at the extension level.
 */
function makeTenantQueryHandlers(tenantId: string): Record<string, any> {
  const injectWhere = (args: any) => {
    args.where = { ...(args?.where ?? {}), tenantId }
  }
  const scopeUpdate = (args: any) => {
    args.where = { ...(args?.where ?? {}), tenantId }
    if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
      delete args.data.tenantId
    }
  }
  const handlers: Record<string, any> = {}
  for (const model of TENANT_SCOPED_MODELS) {
    const delegateKey = model.charAt(0).toLowerCase() + model.slice(1)
    handlers[delegateKey] = {
      async findMany({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async findFirst({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async findFirstOrThrow({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async findUnique({ args, query }: any) {
        if (args.where) args.where = { ...args.where, tenantId }
        return query(args)
      },
      async findUniqueOrThrow({ args, query }: any) {
        if (args.where) args.where = { ...args.where, tenantId }
        return query(args)
      },
      async count({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async aggregate({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async groupBy({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async create({ args, query }: any) {
        if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
          args.data = { ...args.data, tenantId }
        }
        return query(args)
      },
      async createMany({ args, query }: any) {
        if (Array.isArray(args.data)) {
          args.data = args.data.map((row: any) => ({ ...row, tenantId }))
        } else if (args.data && typeof args.data === 'object') {
          args.data = { ...args.data, tenantId }
        }
        return query(args)
      },
      async update({ args, query }: any) {
        scopeUpdate(args)
        return query(args)
      },
      async updateMany({ args, query }: any) {
        scopeUpdate(args)
        return query(args)
      },
      async upsert({ args, query }: any) {
        if (args.where) args.where = { ...args.where, tenantId }
        if (args.create) args.create = { ...args.create, tenantId }
        if (args.update && typeof args.update === 'object' && !Array.isArray(args.update)) {
          delete args.update.tenantId
        }
        return query(args)
      },
      async delete({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
      async deleteMany({ args, query }: any) {
        injectWhere(args)
        return query(args)
      },
    }
  }
  return handlers
}

/**
 * Build a tenant-bound Prisma client. The extension closes over `tenantId`.
 * Wraps the SAME shared base client (no extra connection pool).
 */
export function createTenantClient(tenantId: string): PrismaClient {
  const base = getBaseClient()
  return base.$extends({
    name: 'tenantScope',
    query: makeTenantQueryHandlers(tenantId) as any,
  }) as unknown as PrismaClient
}

/** Per-tenant extended-client cache (lightweight wrappers over the base pool). */
function getTenantClient(tenantId: string): PrismaClient {
  let cache = globalForPrisma.tenantClients
  if (!cache) {
    cache = new Map()
    globalForPrisma.tenantClients = cache
  }
  let client = cache.get(tenantId)
  if (!client) {
    client = createTenantClient(tenantId)
    cache.set(tenantId, client)
  }
  return client
}

const baseClient = getBaseClient()

/**
 * Raw, un-extended base PrismaClient. Use ONLY for explicit bootstrap /
 * migration / seed paths that must operate outside any tenant context
 * (e.g. signup-complete creating the first Tenant + User + Membership in a
 * single transaction, before a tenant context can exist).
 *
 * NEVER use `globalDb` for normal tenant-scoped application work — it does
 * NOT inject or enforce tenantId. All normal application code must go
 * through the exported `db` (which is fail-closed).
 */
export const globalDb = baseClient

/**
 * The application-facing PrismaClient. FAIL-CLOSED:
 *
 *   - `db.<tenantScopedModel>` (e.g. `db.product`) outside `withTenant` →
 *     throws `TenantContextRequiredError` before any query runs.
 *   - `db.<tenantScopedModel>` inside `withTenant(tenantId, ...)` → routes
 *     to the cached per-tenant extended client whose handlers captured
 *     `tenantId` in their closure.
 *   - `db.<globalModel>` (e.g. `db.tenant`, `db.user`) → routes to the
 *     shared base client (no tenant context needed). When a tenant context
 *     IS active, global models still route through the per-tenant extended
 *     client (which has no handlers for global models → passthrough), so
 *     `db.$transaction([...])` stays on ONE client and remains atomic.
 *   - `db.$transaction` / `db.$queryRaw` / `db.$disconnect` → route to the
 *     per-tenant client when a context is active (so the transaction shares
 *     the same extended client as the delegates), else to the base client.
 */
export const db = new Proxy(baseClient, {
  get(_target: PrismaClient, prop: string | symbol, receiver: any) {
    const key = typeof prop === 'string' ? prop : ''
    const tid = tenantContext.getStore()
    // Fail-closed: tenant-scoped delegate without an active context → reject
    // before any database access.
    if (tid === undefined && key && TENANT_SCOPED_DELEGATES.has(key)) {
      throw new TenantContextRequiredError(key)
    }
    // Resolve the source client: per-tenant extended client when a context is
    // active (so $transaction + delegates share one extended client), else
    // the shared base client for global models and global transactions.
    const source = tid !== undefined ? getTenantClient(tid) : baseClient
    const value = Reflect.get(source, prop, source)
    // Bind methods (e.g. $transaction, $disconnect) to the resolved client so
    // `this` is the real client, not the Proxy receiver.
    if (typeof value === 'function') {
      return (value as (...args: any[]) => any).bind(source)
    }
    return value
  },
}) as unknown as PrismaClient

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
