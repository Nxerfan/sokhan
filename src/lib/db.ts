import { PrismaClient, type Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Tenant isolation layer — FAIL-CLOSED.
 *
 * Uses the documented Prisma Client Extension $allModels + $allOperations
 * boundary to intercept EVERY query on tenant-scoped models.
 *
 * FAIL-CLOSED contract:
 *   For models in TENANT_SCOPED_MODELS, if there is no current tenant context
 *   (set via withTenant), the extension THROWS TenantContextRequiredError
 *   BEFORE the query reaches the database.
 *
 * Trusted/background operations must use:
 *   withTenant(tenantId, async () => { ... })
 */

export class TenantContextRequiredError extends Error {
  constructor(model: string) {
    super(`Tenant context required for ${model} operation. Wrap in withTenant(tenantId, fn).`)
    this.name = 'TenantContextRequiredError'
  }
}

const TENANT_SCOPED_MODELS = new Set([
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

/* ------------------------------------------------------------------ */
/* Per-request tenant context via AsyncLocalStorage                  */
/* ------------------------------------------------------------------ */

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

  return client.$extends({
    name: 'tenantScope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          // Skip non-tenant-scoped models entirely
          if (!TENANT_SCOPED_MODELS.has(model)) {
            return query(args)
          }

          const tid = currentTenantId()
          if (!tid) {
            throw new TenantContextRequiredError(model)
          }

          // ─── Operation-specific enforcement ────────────────────

          switch (operation) {
            // ─── Reads: inject tenantId into where ───────────────
            case 'findMany':
            case 'findFirst':
            case 'findFirstOrThrow':
            case 'findUnique':
            case 'findUniqueOrThrow':
            case 'count':
            case 'aggregate':
            case 'groupBy':
              args.where = { ...(args.where ?? {}), tenantId: tid }
              break

            // ─── Creates: force tenantId from context ─────────────
            case 'create':
              if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
                args.data = { ...args.data, tenantId: tid }
              }
              break

            case 'createMany':
              if (Array.isArray(args.data)) {
                args.data = args.data.map((row: any) => ({ ...row, tenantId: tid }))
              } else if (args.data && typeof args.data === 'object') {
                args.data = { ...args.data, tenantId: tid }
              }
              break

            // ─── Updates: scope where + strip tenantId from data ─
            case 'update':
              args.where = { ...(args.where ?? {}), tenantId: tid }
              if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
                delete args.data.tenantId
              }
              break

            case 'updateMany':
              args.where = { ...(args.where ?? {}), tenantId: tid }
              if (args.data && typeof args.data === 'object' && !Array.isArray(args.data)) {
                delete args.data.tenantId
              }
              break

            case 'upsert':
              if (args.where) args.where = { ...args.where, tenantId: tid }
              if (args.create) args.create = { ...args.create, tenantId: tid }
              if (args.update && typeof args.update === 'object' && !Array.isArray(args.update)) {
                delete args.update.tenantId
              }
              break

            // ─── Deletes: scope where ─────────────────────────────
            case 'delete':
            case 'deleteMany':
              args.where = { ...(args.where ?? {}), tenantId: tid }
              break
          }

          return query(args)
        },
      },
    },
  })
}

export const db = (globalForPrisma.prisma ?? buildTenantScopedClient()) as PrismaClient

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/* ------------------------------------------------------------------ */
/* Role helpers                                                       */
/* ------------------------------------------------------------------ */

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
