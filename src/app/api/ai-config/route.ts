import { NextResponse, NextRequest } from 'next/server'
import { withSessionTenant, hasRole } from '@/lib/auth'
import { db, getCurrentTenantId } from '@/lib/db'
import {
  validateAiConfigPatch,
  mergeAiConfigPatch,
  type AiConfigFlags,
} from '@/lib/ai/ai-config-policy'

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
 * PATCH /api/ai-config — update AI feature toggles with TRUE-PATCH semantics.
 *
 * - Requires admin-or-higher authorization (hasRole 'admin').
 * - Parses JSON safely (malformed / absent body → 400).
 * - Validates using validateAiConfigPatch (strict booleans, no coercion,
 *   no unknown keys, no prototype pollution, no accessor execution).
 * - Applies TRUE-PATCH: only fields explicitly provided are updated; omitted
 *   flags preserve their currently stored value (mergeAiConfigPatch).
 * - Never trusts client-supplied tenant or quota fields (tenantId,
 *   aiActionCount, aiActionResetAt are not in the mutable key set).
 * - Concurrent creation does not create multiple records (upsert is atomic).
 * - Uses current authenticated tenant binding (getCurrentTenantId).
 * - Preserves default-OFF behavior (missing config → create with both OFF).
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

    // Early validation (no DB call for invalid patches).
    const validated = validateAiConfigPatch(body)
    if (!validated) {
      return { invalid: true as const }
    }

    const tid = getCurrentTenantId()!

    // Load the current stored flags (or default OFF if no record exists yet).
    const current = await db.aiConfig.findUnique({ where: { tenantId: tid } })
    const stored: AiConfigFlags = current
      ? { faqEnabled: current.faqEnabled, productQaEnabled: current.productQaEnabled }
      : { faqEnabled: false, productQaEnabled: false }

    // TRUE-PATCH merge — omitted flags preserve the stored value.
    // `validated` is already a valid partial; mergeAiConfigPatch re-validates
    // (defense in depth) and merges. This can only return null if the
    // validated partial is somehow malformed — which it can't be — so the
    // null check is a defensive guard.
    const merged = mergeAiConfigPatch(stored, validated)
    if (!merged) {
      return { invalid: true as const }
    }

    // Atomic upsert — concurrent creation does not create multiple records.
    // Only the two mutable flags are written; tenantId is bound to the
    // authenticated tenant, and aiActionCount / aiActionResetAt are never
    // touched by this handler.
    const config = await db.aiConfig.upsert({
      where: { tenantId: tid },
      create: {
        tenantId: tid,
        faqEnabled: merged.faqEnabled,
        productQaEnabled: merged.productQaEnabled,
      },
      update: {
        faqEnabled: merged.faqEnabled,
        productQaEnabled: merged.productQaEnabled,
      },
    })
    return { config } as const
  })

  if (!result) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if ('forbidden' in result.result) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if ('invalid' in result.result) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  return NextResponse.json({ config: result.result.config })
}
