import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import { validateAiConfigPatch } from '@/lib/ai/ai-config-policy'

/**
 * GET /api/ai-config — return the current tenant's AI feature flags.
 *
 * - Requires an authenticated workspace (withSessionTenant).
 * - Returns flags defaulted OFF when no configuration exists.
 * - Uses upsert (atomic create-or-noop) to avoid races in default creation.
 * - Do not leak another tenant's configuration (tenant context is fail-closed).
 * - Repeated GET behavior is stable (upsert returns the existing row).
 */
export async function GET() {
  const result = await withSessionTenant(async () => {
    const tid = getCurrentTenantId()!
    // Atomic upsert — no find-then-create race. `update: {}` is a no-op when
    // the row already exists; `create` seeds default-OFF flags when missing.
    const config = await db.aiConfig.upsert({
      where: { tenantId: tid },
      create: { tenantId: tid, faqEnabled: false, productQaEnabled: false },
      update: {},
    })
    return config
  })
  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ config: result.result })
}

/**
 * PATCH /api/ai-config — update AI feature toggles with atomic TRUE-PATCH
 * semantics (no lost updates under concurrency).
 *
 * - Requires admin-or-higher authorization (hasRole 'admin').
 * - Parses JSON safely (malformed / absent body → 400).
 * - Validates using validateAiConfigPatch (strict booleans, no coercion,
 *   no unknown keys, no prototype pollution, no accessor execution).
 * - Atomic TRUE-PATCH: the Prisma `upsert.update` write set contains ONLY
 *   the keys explicitly supplied in the validated payload (`{ ...validated }`).
 *   An omitted flag is NEVER written, so a concurrent PATCH setting the
 *   other flag cannot be overwritten by a stale read of this request.
 *   There is no read/merge/full-update race — the handler does NOT load
 *   the current snapshot before writing.
 * - Both flags default OFF only when a configuration row does not exist
 *   (the `create` branch uses `validated.X ?? false`).
 * - Never trusts client-supplied tenant or quota fields (tenantId,
 *   aiActionCount, aiActionResetAt are not in the mutable key set).
 * - Concurrent creation does not create multiple records (upsert is atomic).
 * - Uses current authenticated tenant binding (getCurrentTenantId).
 */
export async function PATCH(req: NextRequest) {
  const result = await withSessionTenant(async ({ session }) => {
    if (!hasRole(session.user.role, 'admin')) {
      return { forbidden: true as const }
    }

    // Parse JSON safely — malformed or absent body is a 400, never a crash.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return { invalid: true as const }
    }

    // Early validation (no DB call for invalid patches). `validated` is a
    // Partial<AiConfigFlags> containing ONLY the mutable keys that were
    // present and valid in the payload (actual booleans, no unknown keys).
    const validated = validateAiConfigPatch(body)
    if (!validated) {
      return { invalid: true as const }
    }

    const tid = getCurrentTenantId()!

    // Atomic TRUE-PATCH — NO stale read/merge before the write.
    //
    // The `update` write set is `{ ...validated }` — ONLY the keys the
    // client explicitly supplied. Prisma's update applies only the fields
    // present in this object, so an omitted flag is never written and a
    // concurrent PATCH setting the other flag cannot be clobbered by a
    // stale snapshot from this request.
    //
    // The `create` branch (row does not exist yet) seeds BOTH flags: the
    // supplied ones from `validated`, and the omitted ones default OFF
    // (`?? false`). This preserves default-OFF behavior for new records
    // while still writing only the supplied keys on existing records.
    //
    // tenantId is bound to the authenticated tenant; aiActionCount and
    // aiActionResetAt are never written by this handler.
    const config = await db.aiConfig.upsert({
      where: { tenantId: tid },
      create: {
        tenantId: tid,
        faqEnabled: validated.faqEnabled ?? false,
        productQaEnabled: validated.productQaEnabled ?? false,
      },
      update: {
        ...validated,
      },
    })
    return { config } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('invalid' in result.result) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  return NextResponse.json({ config: result.result.config })
}
